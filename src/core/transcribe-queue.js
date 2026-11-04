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

/** 串行队列，避免多场同时收尾时把 CPU 打满 */
class TranscribeQueue {
  constructor({ run, isBusy, onUpdate, resolveOutDir } = {}) {
    this.run = run;                  // (file, opts) => Promise<result>
    this.isBusy = isBusy || (() => false);
    this.onUpdate = onUpdate || (() => {});
    this.resolveOutDir = resolveOutDir || (() => process.cwd());
    this.queue = [];                 // {file, nickname, at, status}
    this.running = null;
    this.items = [];                 // 供 GUI 展示的最近状态
    this._seq = 0;
    this._timer = null;
    this._stopped = false;
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
      error: '',
    };
    this.queue.push(item);
    this.items.unshift(item);
    if (this.items.length > 50) this.items.length = 50;  // 只留最近 50 条给界面
    this.onUpdate();
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
        this.onUpdate();
      }
      this._schedule(30_000);
      return;
    }

    const item = this.queue.shift();
    this.running = item;
    item.status = 'processing';
    item.stage = '正在转写';
    this.onUpdate();

    Promise.resolve()
      .then(() => this.run(item.file, item))
      .then(result => {
        item.status = 'done';
        item.stage = '已完成';
        item.segments = result?.segments?.length ?? 0;
        item.textFile = item.file.replace(/\.[^.]+$/, '.txt');
        item.srtFile = item.file.replace(/\.[^.]+$/, '.srt');
        log.info(`[transcribe] 完成 ${path.basename(item.file)}：${item.segments} 段`);
      })
      .catch(e => {
        // 只记在自己身上，不动录像的任何状态
        item.status = 'failed';
        item.stage = '转写失败';
        item.error = String(e && e.message || e).slice(0, 200);
        log.warn(`[transcribe] 失败 ${path.basename(item.file)}：${item.error}`);
      })
      .finally(() => {
        this.running = null;
        this.onUpdate();
        // 稍等再跑下一个，避免连续占满 CPU
        this._schedule(1500);
      });
  }

  /** 供 GUI 快照 */
  snapshot() {
    return {
      pending: this.queue.length + (this.running ? 1 : 0),
      running: this.running ? { name: this.running.name, file: this.running.file } : null,
      items: this.items.slice(0, 20).map(i => ({
        id: i.id, name: i.name, status: i.status, stage: i.stage,
        error: i.error, segments: i.segments || 0, at: i.at,
      })),
    };
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.queue.length = 0;
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