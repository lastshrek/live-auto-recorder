// 历史条目的「转录 / 摘要推送」状态计算。
//
// 设计取舍：
//   - 状态以磁盘产物为准：同目录有 .txt/.srt 就算转录完成，有 .摘要.md 就算摘要已生成。
//     这样不依赖 lr-summarizer 的内部状态文件，两个程序各自独立、跨机器也成立。
//   - 转录进行中的实时进度优先用队列快照（有百分比）；队列里没有的，回落到产物文件判断。
//   - stat 结果按 (文件+产物mtime) 缓存 2 秒，避免每秒快照都扫磁盘。
//     产物生成时 mtime 会变，缓存自动失效，不需要主动通知。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CACHE_MS = 2000;
const _cache = new Map(); // key -> { at, value }

function _resetCache() { _cache.clear(); }

/** 把历史条目里的相对文件路径还原成绝对路径 */
function _resolve(entry, fallbackRoot) {
  const file = entry && Array.isArray(entry.files) ? entry.files.find(f => /\.(mp4|mkv|mov|webm|flv)$/i.test(f)) : '';
  if (!file) return '';
  const root = (entry && typeof entry.outRoot === 'string' && entry.outRoot.trim()) || fallbackRoot || '';
  if (!root) return '';
  return path.isAbsolute(file) ? file : path.join(root, file);
}

function _exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 计算单条历史的状态。
 * @param {object} entry 历史条目
 * @param {string} fallbackRoot 当前保存目录（老条目没有 outRoot 时兜底）
 * @param {object} runningMap 转录队列里 file(绝对路径)->item 的映射，含实时进度
 * @returns {{transcribe:{status,label,percent,segments,detail}, summary:{status,label,detail}}}
 */
function statusFor(entry, fallbackRoot, runningMap) {
  const video = _resolve(entry, fallbackRoot);
  if (!video) {
    return {
      transcribe: { status: 'none', label: '—', percent: 0, segments: 0, detail: '' },
      summary: { status: 'none', label: '—', detail: '' },
    };
  }

  const base = video.replace(/\.[^.]+$/, '');
  const txt = base + '.txt';
  const srt = base + '.srt';
  const md = base + '.摘要.md';

  // 缓存键带上三个产物的存在状态与 mtime，产物一生成/变化就失效
  const stamp = (p) => { try { const s = fs.statSync(p); return s.isFile() ? s.mtimeMs : 0; } catch { return 0; } };
  const key = [video, stamp(txt), stamp(srt), stamp(md)].join('|');
  let cached = _cache.get(key);
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const hasTxt = _exists(txt), hasSrt = _exists(srt), hasMd = _exists(md);
    cached = { at: Date.now(), value: { hasTxt, hasSrt, hasMd } };
    _cache.set(key, cached);
    // 缓存别无限涨
    if (_cache.size > 400) _cache.clear();
  }
  const { hasTxt, hasSrt, hasMd } = cached.value;

  // 转录状态：队列实时进度优先，其次看产物，再次看是否排队
  const live = (runningMap && runningMap.get(video)) || null;
  let transcribe;
  if (live && (live.status === 'processing' || live.status === 'waiting' || live.status === 'queued')) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(live.percent) || 0)));
    transcribe = {
      status: live.status,
      label: live.status === 'processing' ? `转录中 ${pct}%` : '待转录',
      percent: pct,
      segments: live.done || 0,
      detail: live.stage || '',
    };
  } else if (hasTxt || hasSrt) {
    transcribe = { status: 'done', label: '已转录', percent: 100, segments: 0, detail: '' };
  } else if (live && live.status === 'failed') {
    transcribe = { status: 'failed', label: '转录失败', percent: 0, segments: 0, detail: live.error || '' };
  } else {
    transcribe = { status: 'pending', label: '未转录', percent: 0, segments: 0, detail: '' };
  }

  // 摘要/推送状态：摘要文件存在即视为已生成并推送（推送紧随生成）
  const summary = hasMd
    ? { status: 'done', label: '已推送', detail: '' }
    : { status: 'pending', label: '未生成', detail: '' };

  return { transcribe, summary };
}

/** 把状态附加到 history 的每条记录上，返回新数组（不改原对象） */
function attach(history, fallbackRoot, transcriberSnapshot) {
  if (!Array.isArray(history)) return [];
  const runningMap = new Map();
  for (const it of ((transcriberSnapshot && transcriberSnapshot.items) || [])) {
    if (it && it.file) runningMap.set(it.file, it);
  }
  const run = transcriberSnapshot && transcriberSnapshot.running;
  if (run && run.file) runningMap.set(run.file, run);

  return history.map(h => {
    const s = statusFor(h, fallbackRoot, runningMap);
    return { ...h, transcribeStatus: s.transcribe, summaryStatus: s.summary };
  });
}

module.exports = { statusFor, attach, _resetCache };
