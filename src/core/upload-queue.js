'use strict';
/**
 * 115 备份上传（经本机 OpenList 的 WebDAV）。
 *
 * 为什么是"扫描式"而不是挂钩子：
 * 成片和字幕不是同时出现的（转写字幕晚几分钟、摘要更晚），如果在上传
 * 收尾钩子里一次性打包上传，后到的 .srt/.txt/.md 永远没机会补传。
 * 这里改成按"每个文件是否已上传且大小一致"判断，定时扫描：
 *   - 应用重启、上传中断、字幕晚到，都会在下一轮扫描自动补齐
 *   - 不需要依赖任何钩子的调用时机
 *
 * 三条硬约束：
 * 1) 绝不影响录像。上传失败只写自己的状态与日志，不动 recorder/history。
 * 2) 只在确认远端大小一致后才记账，记账过的才允许按保留天数删除本地。
 * 3) 录制进行中不传（避免和直拷/转封装抢 IO 与上行带宽）。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const log = require('../util/log');
const { writeJson } = require('../util/atomic-json');

const SIDECAR_RE = /\.(srt|txt|md)$/i;
const MEDIA_RE = /_纯享版\.mp4$/i;
const RETRY_DELAYS = [5_000, 30_000, 120_000];

function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
}

/** 逐段编码，避免中文/空格/emoji 把 URL 拼坏 */
function encodePath(segments) {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

function requestOnce(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (chunks.length < 32) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 8000) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('上传超时（无数据）')));
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

class Uploader {
  constructor({ settings, roots, statePath, isBusy, onEvent, intervalMs = 120_000, retryDelays = RETRY_DELAYS, concurrency = 2 } = {}) {
    this.settings = settings;
    this.roots = roots || (() => []);
    this.statePath = statePath;
    this.isBusy = isBusy || (() => false);
    this.onEvent = onEvent || (() => {});
    this.intervalMs = intervalMs;
    this.retryDelays = retryDelays;
    // 115 对非会员是账号级总限速（实测单连接约 1.1MB/s、4 并发约 1.9MB/s），
    // 所以并发 2 能吃到大部分收益，再多只是把总带宽切得更碎。
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.active = [];
    this.state = this._loadState();
    this.queue = [];
    this.items = [];
    this._seq = 0;
    this._timer = null;
    this._stopped = false;
    this._lastSweep = 0;
  }

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('[upload] 状态文件读取失败，按空状态继续:', e.message);
    }
    return {};
  }

  _saveState() {
    try {
      writeJson(this.statePath, this.state);
    } catch (e) {
      log.warn('[upload] 状态文件写入失败:', e.message);
    }
  }

  remoteUrlFor(file) {
    const root = String(this.settings.upload115Root || '直播录制备份').replace(/^\/+|\/+$/g, '');
    const base = String(this.settings.upload115BaseUrl || 'http://127.0.0.1:5244/dav').replace(/\/+$/, '');
    // 远端目录结构沿用本地的相对路径：<root>/<相对目录>/<文件名>
    const mount = String(this.settings.upload115Mount || '115').replace(/^\/+|\/+$/g, '');
    const rootDir = (this.roots()[0] || path.dirname(file));
    const rel = path.relative(rootDir, file);
    // 远端结构：<OpenList 挂载路径>/<目标目录>/<本地相对路径>/<文件名>
    const segments = [...mount.split('/').filter(Boolean), root, ...rel.split(path.sep).filter(Boolean)];
    return `${base}/${encodePath(segments)}`;
  }

  /** 单个文件上传，带重试。返回 {ok, status, error} */
  async _put(file, { expectSize }) {
    const url = this.remoteUrlFor(file);
    const auth = basicAuth(this.settings.upload115User || '', this.settings.upload115Password || '');
    let lastError = '';
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
      try {
        // OpenList 的 WebDAV 不会自动创建中间目录，直接 PUT 会 409 Conflict
        await this._serial(() => this._ensureDirs(url, auth));
        const putRes = await this._putOnce(url, file, auth, expectSize);
        if (putRes.status >= 200 && putRes.status < 300) {
          const remoteSize = await this._remoteSize(url, auth);
          if (remoteSize !== null && remoteSize !== expectSize) {
            lastError = `远端大小不一致（本地 ${expectSize} / 远端 ${remoteSize}）`;
          } else {
            return { ok: true, status: putRes.status, remote: url, size: expectSize };
          }
        } else if (putRes.status === 401 || putRes.status === 403) {
          // 凭据/权限问题重试没有意义，直接失败并给出明确原因
          return { ok: false, status: putRes.status, error: '鉴权失败（cookie 过期或 WebDAV 管理权限未开）' };
        } else {
          lastError = `HTTP ${putRes.status} ${putRes.body || ''}`.trim();
        }
      } catch (e) {
        if (e.auth) return { ok: false, status: 403, error: e.message };
        lastError = e.message;
        // 本机 OpenList 崩了/重启中：等它回来再继续，别把重试次数烧光
        if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE') {
          const back = await this._waitServer();
          if (back) { attempt -= 1; continue; }
        }
      }
      if (attempt < this.retryDelays.length) {
        log.warn(`[upload] 重试 ${attempt + 1}/${this.retryDelays.length} ${path.basename(file)}：${lastError}`);
        await new Promise((r) => setTimeout(r, this.retryDelays[attempt]));
      }
    }
    return { ok: false, error: lastError || '未知错误' };
  }

  /** 登录 OpenList 拿管理员 token（用于原生建目录接口） */
  async _ensureToken(origin) {
    if (this._apiToken) return true;
    if (this._apiTried) return false;
    this._apiTried = true;
    try {
      const res = await requestOnce(origin + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.settings.upload115User || '', password: this.settings.upload115Password || '' }),
        timeoutMs: 30_000,
      });
      const json = JSON.parse(res.body);
      if (json && json.data && json.data.token) { this._apiToken = json.data.token; return true; }
    } catch { /* 落回 WebDAV 方案 */ }
    return false;
  }

  /**
   * 逐级创建远端目录。
   *
   * 默认走 OpenList 原生 /api/fs/mkdir，而不是 WebDAV 的 MKCOL：
   * MKCOL 会先查 OpenList 的目录缓存，缓存一旦记录过这个路径就返回 405
   * （"已存在"），但 115 上其实并没有这个目录，随后 PUT 必然 409 Conflict，
   * 而且重试也不会自愈（实测只有重启 OpenList 才恢复）。
   * 原生 mkdir 直连驱动、对已存在目录幂等，没有这个问题。
   */
  async _ensureDirs(url, auth) {
    const target = new URL(url);
    const parts = target.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length <= 2) return;                 // /dav/<file> 不需要建目录
    this._madeDirs = this._madeDirs || new Set();
    const useApi = await this._ensureToken(target.origin);

    for (let i = 1; i < parts.length - 1; i += 1) {
      // 原生接口用的是 OpenList 的文件树路径，不含 WebDAV 的 /dav 前缀
      const plain = '/' + parts.slice(1, i + 1).join('/');
      if (this._madeDirs.has(plain)) continue;

      if (useApi) {
        let res = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          res = await requestOnce(target.origin + '/api/fs/mkdir', {
            method: 'POST',
            headers: { Authorization: this._apiToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: plain }),
            timeoutMs: 30_000,
          });
          const ok = res.status >= 200 && res.status < 300 && /"code"\s*:\s*200/.test(res.body);
          if (ok) { this._madeDirs.add(plain); res = null; break; }
          // OpenList 重启会让签发的 token 失效，清掉缓存下一轮重新登录
          if (/token|unauthor|invalid/i.test(res.body)) { this._apiToken = null; this._apiTried = false; }
          if (res.status !== 423) break;      // 423 Locked 是存储忙，等一下再来
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
        if (!res) continue;
        log.warn('[upload] 原生建目录失败，回退 WebDAV:', plain, res.status);
      }

      // 兜底：WebDAV MKCOL
      const encoded = target.origin + '/' + parts.slice(0, i + 1).map((x) => encodeURIComponent(x)).join('/');
      let key2 = encoded;
      let r = await requestOnce(key2, { method: 'MKCOL', headers: { Authorization: auth }, timeoutMs: 30_000 });
      if (r.status === 307 || r.status === 308) {
        const loc = r.headers.location || (key2 + '/');
        key2 = loc.startsWith('http') ? loc : target.origin + loc;
        r = await requestOnce(key2, { method: 'MKCOL', headers: { Authorization: auth }, timeoutMs: 30_000 });
      }
      if ([200, 201, 204, 301, 405].includes(r.status)) this._madeDirs.add(plain);
      else if (r.status === 401 || r.status === 403) {
        const e = new Error('鉴权失败（cookie 过期或 WebDAV 管理权限未开）');
        e.auth = true;
        throw e;
      } else {
        throw new Error(`创建远端目录失败 HTTP ${r.status} ${r.body || ''}`.trim());
      }
    }
  }

  /** OpenList 掉线后等待其恢复（最多 10 分钟），恢复则继续，避免整批被判失败 */
  async _waitServer() {
    const origin = (() => { try { return new URL(this.settings.upload115BaseUrl || '').origin; } catch { return null; } })();
    if (!origin) return false;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        const res = await requestOnce(origin + '/api/public/settings', { method: 'GET', headers: {}, timeoutMs: 5_000 });
        if (res.status === 200) {
          log.info('[upload] OpenList 已恢复，继续上传');
          this._apiToken = null; this._apiTried = false;   // token 随重启失效
          return true;
        }
      } catch { /* 还没起来 */ }
    }
    return false;
  }

  /** 建目录必须串行：并发调原生 mkdir 会让 OpenList 对同一存储加锁(423) */
  _serial(fn) {
    const run = (this._dirQueue || Promise.resolve()).then(fn, fn);
    this._dirQueue = run.catch(() => {});
    return run;
  }

  _putOnce(url, file, auth, size) {    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.request(target, {
        method: 'PUT',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { if (chunks.length < 32) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 200) }));
        res.on('error', reject);
      });
      req.setTimeout(10 * 60_000, () => req.destroy(new Error('上传超时')));
      req.on('error', reject);
      fs.createReadStream(file).on('error', reject).pipe(req);
    });
  }

  async _remoteSize(url, auth) {
    try {
      const res = await requestOnce(url, { method: 'HEAD', headers: { Authorization: auth }, timeoutMs: 30_000 });
      if (res.status >= 200 && res.status < 300) {
        const len = Number(res.headers['content-length']);
        return Number.isFinite(len) ? len : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 把某条录像的成片和字幕（成片在后，字幕可能还没生成）收进队列 */
  enqueueFile(file, { reason = 'auto' } = {}) {
    if (!file || typeof file !== 'string') return null;
    if (!MEDIA_RE.test(file) && !SIDECAR_RE.test(file)) return null;
    if (!fs.existsSync(file)) return null;
    if (this.queue.some((q) => q.file === file) || this.active.some((a) => a.file === file)) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const done = this.state[file];
    if (done && done.size === stat.size && done.mtimeMs === Math.round(stat.mtimeMs)) return null;

    const item = {
      id: 'u' + (++this._seq), file, reason,
      name: path.basename(file),
      size: stat.size,
      status: 'queued', stage: '等待上传', at: Date.now(), error: '',
    };
    this.queue.push(item);
    this.items.unshift(item);
    if (this.items.length > 50) this.items.length = 50;
    this.onEvent(this.snapshot());
    this._pump();
    return item;
  }

  get running() { return this.active[0] || null; }

  _pump() {
    if (this._stopped || !this.queue.length) return;
    if (this.isBusy()) {
      this.queue[0].status = 'waiting';
      this.queue[0].stage = '等待录制结束';
      this.onEvent(this.snapshot());
      return;
    }
    while (this.active.length < this.concurrency && this.queue.length) {
      this._start(this.queue.shift());
    }
  }

  _start(item) {
    item.status = 'processing';
    item.stage = '上传中';
    this.active.push(item);
    this.onEvent(this.snapshot());
    const startedAt = Date.now();
    this._put(item.file, { expectSize: item.size })
      .then((result) => {
        if (result.ok) {
          let stat;
          try { stat = fs.statSync(item.file); } catch { stat = null; }
          this.state[item.file] = {
            size: item.size,
            mtimeMs: stat ? Math.round(stat.mtimeMs) : null,
            remote: result.remote,
            at: Date.now(),
          };
          this._saveState();
          item.status = 'done';
          item.stage = '已上传';
          item.seconds = Math.round((Date.now() - startedAt) / 1000);
          log.info(`[upload] 完成 ${item.name} (${(item.size / 1048576).toFixed(1)}MB, ${item.seconds}s)`);
        } else {
          item.status = 'failed';
          item.stage = '上传失败';
          item.error = result.error || `HTTP ${result.status}`;
          log.warn(`[upload] 失败 ${item.name}：${item.error}`);
        }
      })
      .catch((e) => {
        item.status = 'failed';
        item.stage = '上传失败';
        item.error = String(e && e.message || e).slice(0, 200);
        log.warn(`[upload] 失败 ${item.name}：${item.error}`);
      })
      .finally(() => {
        this.active = this.active.filter((a) => a !== item);
        this.onEvent(this.snapshot());
        setTimeout(() => this._pump(), 1000).unref?.();
      });
  }

  /**
   * 预先建好所有目标目录。
   *
   * 必须在开始上传前做完：OpenList 在上传大文件期间会锁住该存储，
   * 此时再调建目录接口会拿到 423 Locked，进而触发退避重试，整条队列被拖死。
   * 串行建完并记进 _madeDirs 后，后续 PUT 里的 _ensureDirs 直接命中缓存。
   */
  async prepareDirs(files) {
    if (!this.settings.upload115) return;
    const auth = basicAuth(this.settings.upload115User || '', this.settings.upload115Password || '');
    for (const file of files) {
      try { await this._ensureDirs(this.remoteUrlFor(file), auth); }
      catch (e) { log.warn('[upload] 预建目录失败:', path.basename(file), e.message); }
    }
  }

  /** 扫描成片与字幕，把未上传或已变化的收进队列 */
  sweep() {
    if (this._stopped) return 0;
    this._lastSweep = Date.now();
    if (!this.settings.upload115) return 0;
    let added = 0;
    for (const root of this.roots()) {
      let dirs = [];
      try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of dirs) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
          let files = [];
          try { files = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
          for (const f of files) {
            if (!f.isFile()) continue;
            const file = path.join(full, f.name);
            if (!MEDIA_RE.test(f.name) && !SIDECAR_RE.test(f.name)) continue;
            // 刚落盘的文件先放一放，避免传到一半还在写
            try { if (Date.now() - fs.statSync(file).mtimeMs < 90_000) continue; } catch { continue; }
            if (this.enqueueFile(file)) added += 1;
          }
        }
      }
    }
    return added;
  }

  /**
   * 本地保留：只删「已确认上传（大小/时间戳都对得上）」且超过保留天数的文件。
   * 绝不动没上传成功的文件——那等于丢数据。
   */
  cleanup() {
    const days = Number(this.settings.upload115RetentionDays) || 0;
    if (!days) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const [file, rec] of Object.entries(this.state)) {
      if (!rec || rec.at > cutoff) continue;
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.size !== rec.size) continue;                       // 变化过，不删
      if (rec.mtimeMs && Math.round(stat.mtimeMs) !== rec.mtimeMs) continue;
      try {
        fs.unlinkSync(file);
        delete this.state[file];
        removed += 1;
        log.info('[upload] 保留期已过，删除本地:', path.basename(file));
      } catch (e) {
        log.warn('[upload] 删除失败:', path.basename(file), e.message);
      }
    }
    if (removed) this._saveState();
    return removed;
  }

  start() {
    if (this._timer) return;
    const tick = () => {
      if (this._stopped) return;
      try {
        this.sweep();
        this.cleanup();
      } catch (e) {
        log.warn('[upload] 扫描异常:', e.message);
      }
      this._timer = setTimeout(tick, this.intervalMs);
      if (this._timer.unref) this._timer.unref();
    };
    // 启动后先跑一次，补齐上次没传完的
    this._timer = setTimeout(tick, 20_000);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.queue.length = 0;
    this.active.length = 0;
  }

  snapshot() {
    return {
      pending: this.queue.length + (this.running ? 1 : 0),
      running: this.running ? { name: this.running.name, size: this.running.size } : null,
      uploaded: Object.keys(this.state).length,
      items: this.items.slice(0, 20).map((i) => ({
        id: i.id, name: i.name, status: i.status, stage: i.stage,
        size: i.size, error: i.error, seconds: i.seconds || 0, at: i.at,
      })),
    };
  }
}

module.exports = { Uploader, MEDIA_RE, SIDECAR_RE };
