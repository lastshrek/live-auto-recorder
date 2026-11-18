'use strict';
/**
 * 自动转写调度：录制收尾完成后，按需把成片转成字幕。
 *
 * 设计上的三个约束，都来自"不能影响录制"这个前提：
 *
 * 1) 不阻塞后处理。转写要跑几分钟，若塞进 postprocess 队列，会把
 *    "正在收尾"的任务卡在那里，界面上看起来像卡死。所以独立成队列。
 *
 * 2) 录制期间不抢 CPU。转写是 CPU 密集型（4 小时约 8-15 分钟 4 线程），
 *    而录制链路在做 -c copy 直拷、以及收尾转封装。同时跑会让录制容易
 *    出问题。这里在「有录制任务进行中」时直接延后，等空闲再说。
 *
 * 3) 失败绝不污染录像状态。录像已经成功落盘了，字幕只是附加产物。
 *    转写失败只写日志与自身状态，不改 recorder/history 的 status。
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('../util/log');
const { writeJson } = require('../util/atomic-json');

/** 串行队列，避免多场同时收尾时把 CPU 打满 */
class TranscribeQueue {
  constructor({ run, isBusy, onUpdate, resolveOutDir, statePath } = {}) {
    this.run = run;                  // (file, opts) => Promise<result>
    this.isBusy = isBusy || (() => false);
    this.onUpdate = onUpdate || (() => {});
    this.resolveOutDir = resolveOutDir || (() => process.cwd());
    this.statePath = statePath || '';
    this.queue = [];                 // {file, nickname, at, status}
    this.running = null;
    this.items = [];                 // 供 GUI 展示的最近状态
    this._seq = 0;
    this._timer = null;
    this._stopped = false;
    this._controller = null;         // 当前任务的 AbortController，退出时中断子进程
  }

  /** 原子写盘。statePath 未配置时静默跳过（单元测试不需要落盘）。 */
  _save() {
    if (!this.statePath) return;
    try {
      writeJson(this.statePath, {
        version: 1,
        updatedAt: Date.now(),
        items: this.items.slice(0, 50).map(i => ({
          id: i.id, file: i.file, name: i.name, reason: i.reason,
          status: i.status, stage: i.stage, percent: i.percent || 0,
          done: i.done || 0, total: i.total || 0,
          at: i.at, updatedAt: i.updatedAt || i.at, startedAt: i.startedAt || 0,
          error: i.error || '', segments: i.segments || 0,
          textFile: i.textFile || '', srtFile: i.srtFile || '',
        })),
      });
    } catch (e) {
      log.warn('[transcribe] 状态保存失败:', e.message);
    }
  }

  /**
   * 启动时恢复。进程中断时正在转写的条目重新入队；已产出字幕的补记为完成。
   * 不自动重试已 failed 的条目，避免每次启动都重跑一个必然失败的任务。
   */
  restore() {
    if (!this.statePath) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('[transcribe] 状态读取失败，按空状态继续:', e.message);
      return;
    }
    const records = Array.isArray(saved?.items) ? saved.items : [];
    let resumed = 0, completed = 0;
    for (const rec of records) {
      if (!rec || typeof rec.file !== 'string') continue;
      const item = {
        id: rec.id || 'r' + (++this._seq),
        file: rec.file,
        name: rec.name || path.basename(rec.file),
        reason: rec.reason || 'auto',
        status: ['queued', 'waiting', 'processing', 'done', 'failed'].includes(rec.status) ? rec.status : 'queued',
        stage: rec.stage || '等待转写',
        percent: Number.isFinite(rec.percent) ? rec.percent : 0,
        done: rec.done || 0, total: rec.total || 0,
        at: rec.at || Date.now(), updatedAt: rec.updatedAt || rec.at || Date.now(),
        startedAt: rec.startedAt || 0,
        error: rec.error || '', segments: rec.segments || 0,
        textFile: rec.textFile || '', srtFile: rec.srtFile || '',
      };
      this.items.push(item);
      if (item.status === 'done' || item.status === 'failed') continue;
      if (!fs.existsSync(item.file)) {
        item.status = 'failed';
        item.stage = '源文件已不存在';
        item.error = '源文件已移除，无法继续转写';
        continue;
      }
      const srt = item.file.replace(/\.[^.]+$/, '.srt');
      if (fs.existsSync(srt)) {
        // 中断前其实已写完字幕，只是没来得及记状态
        item.status = 'done';
        item.stage = '已完成';
        item.percent = 100;
        item.srtFile = srt;
        item.textFile = item.file.replace(/\.[^.]+$/, '.txt');
        completed++;
        continue;
      }
      item.status = 'queued';
      item.stage = '重新启动，继续转写';
      item.percent = 0;
      item.done = 0;
      item.updatedAt = Date.now();
      this.queue.push(item);
      resumed++;
    }
    if (this.items.length > 50) this.items.length = 50;
    if (resumed || completed) {
      log.info(`[transcribe] 启动恢复：续做 ${resumed} 个，补记完成 ${completed} 个`);
      this.onUpdate();
      if (resumed) this._schedule(3000);  // 让启动流程先跑完，别抢资源
    }
    this._save();
  }

  /** 把成片加入待转写队列。file 必须是最终 MP4 路径。 */
  enqueue(file, { nickname = '', reason = 'auto' } = {}) {
    if (!file || typeof file !== 'string') return null;
    if (!/\.(mp4|mkv|mov|webm|flv)$/i.test(file)) return null;
    // 同一条目重复入队没有意义（恢复流程可能重复收尾）
    if (this.queue.some(q => q.file === file) || this.running?.file === file) return null;

    const item = {
      id: 't' + (++this._seq),
      file,
      name: nickname || path.basename(file),
      reason,
      status: 'queued',   // queued | waiting | processing | done | failed
      stage: '等待转写',
      at: Date.now(),
      updatedAt: Date.now(),
      startedAt: 0,
      percent: 0,
      done: 0,
      total: 0,
      error: '',
    };
    this.queue.push(item);
    this.items.unshift(item);
    if (this.items.length > 50) this.items.length = 50;  // 只留最近 50 条给界面
    this.onUpdate();
    this._save();
    this._schedule(0);
    return item;
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._pump();
    }, delayMs);
    // 不阻止进程退出：转写是附加任务，退出时丢掉也无妨
    if (this._timer.unref) this._timer.unref();
  }

  _pump() {
    if (this._stopped || this.running || !this.queue.length) return;

    // 有录制在进行：延后，不抢 CPU。这里不用等到完全没录制，
    // 因为直播可能连播数小时，无限等下去等于不转。策略是
    // 「录制数达到上限的一半以上时让路」，否则照常跑。
    if (this.isBusy()) {
      const head = this.queue[0];
      if (head.status !== 'waiting') {
        head.status = 'waiting';
        head.stage = '等待录制空闲';
        head.updatedAt = Date.now();
        this.onUpdate();
        this._save();
      }
      this._schedule(30_000);
      return;
    }

    const item = this.queue.shift();
    this.running = item;
    item.status = 'processing';
    item.stage = '正在转写';
    item.startedAt = Date.now();
    item.updatedAt = Date.now();
    item.percent = 0;
    this.onUpdate();
    this._save();

    // 引擎推来的进度：{stage:'extract'|'transcribe', percent, done, total}
    // 只在真正前进时广播，避免每秒几十次刷新界面
    const report = (p) => {
      if (!p || !this.running) return;
      if (p.stage === 'extract') {
        if (item.stage === '正在抽取音频') return;
        item.stage = '正在抽取音频';
      } else if (p.stage === 'transcribe') {
        item.stage = '正在识别';
        item.done = p.done || 0;
        item.total = p.total || 0;
        const pct = Number.isFinite(p.percent) ? p.percent
          : (p.total > 0 ? Math.round(p.done / p.total * 100) : 0);
        if (pct <= (item.percent || 0)) return;
        item.percent = pct;
      } else {
        return;
      }
      item.updatedAt = Date.now();
      this.onUpdate();
      if (item.percent === 100 || item.percent % 10 === 0) this._save();
    };

    this._controller = new AbortController();
    const signal = this._controller.signal;

    Promise.resolve()
      .then(() => this.run(item.file, item, report, signal))
      .then(result => {
        item.status = 'done';
        item.stage = '已完成';
        item.percent = 100;
        item.done = item.total || item.done;
        item.segments = result?.segments?.length ?? 0;
        item.textFile = item.file.replace(/\.[^.]+$/, '.txt');
        item.srtFile = item.file.replace(/\.[^.]+$/, '.srt');
        item.updatedAt = Date.now();
        log.info(`[transcribe] 完成 ${path.basename(item.file)}：${item.segments} 段`);
        this._save();
      })
      .catch(e => {
        // 只记在自己身上，不动录像的任何状态
        item.status = 'failed';
        item.stage = '转写失败';
        item.error = String(e && e.message || e).slice(0, 200);
        item.updatedAt = Date.now();
        log.warn(`[transcribe] 失败 ${path.basename(item.file)}：${item.error}`);
        this._save();
      })
      .finally(() => {
        this.running = null;
        this._controller = null;
        this.onUpdate();
        // 稍等再跑下一个，避免连续占满 CPU
        this._schedule(1500);
      });
  }

  /** 供 GUI 快照 */
  snapshot() {
    return {
      pending: this.queue.length + (this.running ? 1 : 0),
      running: this.running ? {
        name: this.running.name, file: this.running.file,
        percent: this.running.percent || 0,
        done: this.running.done || 0, total: this.running.total || 0,
        stage: this.running.stage, startedAt: this.running.startedAt || 0,
      } : null,
      items: this.items.slice(0, 20).map(i => ({
        id: i.id, name: i.name, file: i.file, status: i.status, stage: i.stage,
        error: i.error, segments: i.segments || 0, at: i.at,
        percent: i.percent || 0, done: i.done || 0, total: i.total || 0,
        updatedAt: i.updatedAt || i.at, startedAt: i.startedAt || 0,
      })),
    };
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    // 中断正在跑的引擎子进程，避免退出后留下孤儿进程继续写同一个字幕
    if (this._controller) { try { this._controller.abort(); } catch {} }
    // 未开始的任务留在 items 里写盘，下次启动会重新入队
    for (const q of this.queue) {
      q.status = 'queued';
      q.stage = '应用退出，等待续做';
      q.updatedAt = Date.now();
    }
    this.queue.length = 0;
    this._save();
  }
}

/**
 * 从后处理结果推导要转写的文件。
 * 只取最终成片：排除 .pending. 中间文件与 _partN 分片（合并后不该再转分片）。
 */
function pickTranscribableFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter(f =>
    typeof f === 'string'
    && /\.(mp4|mkv|mov|webm)$/i.test(f)
    && !/\.pending\./i.test(f)
    && !/_part\d+\./i.test(f)
    && fs.existsSync(f),
  );
}

module.exports = { TranscribeQueue, pickTranscribableFiles };