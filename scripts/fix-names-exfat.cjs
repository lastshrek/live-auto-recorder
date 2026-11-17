#!/usr/bin/env node
/**
 * 成品命名修复工具（exFAT 等不支持硬链接的录制盘专用）
 *
 * 场景：应用内置代码用 link 实现命名，在 exFAT 盘上会 ENOTSUP，
 * 录像停留在 <base>_partN.mp4。本工具复用 src/core/video-names.js
 * 的 makePlan / applyPlan（含 exFAT 降级路径）补做命名，不复制数据。
 *
 * 用法：
 *   node scripts/fix-names-exfat.cjs --dir "/Volumes/DATA/抖音录制" --dry-run
 *   node scripts/fix-names-exfat.cjs --dir "/Volumes/DATA/抖音录制"
 *   node scripts/fix-names-exfat.cjs --dir "/Volumes/DATA/抖音录制" --watch
 *
 * 安全约束：只处理「任务已结束 + 分片 mp4 已存在 + 大小连续稳定 + 无进程占用」的录像，
 * 正在录制的会话一律跳过。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appData = path.join(process.env.HOME, 'Library/Application Support/直播自动录制');
const JOBS_FILE = path.join(appData, 'recording-jobs.json');

// 这些状态说明任务仍在推进，绝不能动它的文件
const ACTIVE = new Set(['recording', 'recovering', 'sealing', 'burning', 'processing', 'queued', 'waiting']);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const DIR = arg('--dir', '/Volumes/DATA/抖音录制');
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
const POLL_MS = Number(arg('--interval', '10000'));

const log = (...parts) => console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...parts);

function readJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    const jobs = Array.isArray(data) ? data : data.jobs ?? data;
    return Array.isArray(jobs) ? jobs : Object.values(jobs);
  } catch (error) {
    log('读取任务记录失败：', error.message);
    return [];
  }
}

function partsOf(base) {
  const dir = path.dirname(base);
  const name = path.basename(base);
  const found = [];
  let scanned = false;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const match = entry.match(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_part(\\d+)\\.mp4$'));
      if (match) { found.push(Number(match[1])); scanned = true; }
    }
  } catch { return null; }
  return scanned ? Math.max(...found) : 0;
}

function busy(file) {
  const result = spawnSync('lsof', ['-t', file], { encoding: 'utf8' });
  return Boolean((result.stdout || '').trim());
}

function pendingNearby(base) {
  const dir = path.dirname(base);
  const name = path.basename(base);
  try {
    return fs.readdirSync(dir).some((entry) => entry.startsWith(name) && entry.includes('.pending.'));
  } catch { return false; }
}

function sizeSnapshot(base, part) {
  const out = {};
  for (let i = 1; i <= part; i += 1) {
    try { const stat = fs.statSync(`${base}_part${i}.mp4`); out[i] = `${stat.size}:${stat.mtimeMs}`; }
    catch { out[i] = ''; }
  }
  return JSON.stringify(out);
}

// 连续两次采样一致才认为文件落定
const seen = new Map();

function candidates() {
  const list = [];
  for (const job of readJobs()) {
    if (!job?.base || ACTIVE.has(job.status)) continue;
    if (job.uploadParts && Object.keys(job.uploadParts).length) continue; // 超大原片拆分的命名涉及分片元数据，交给应用自己处理
    const part = partsOf(job.base);
    if (!part) continue;                       // 没有任何待命名分片
    if (pendingNearby(job.base)) continue;     // 仍在 remux
    list.push({ job, part });
  }
  return list;
}

function process_() {
  const { makePlan, applyPlan } = require('../src/core/video-names');
  let acted = 0;
  for (const { job, part } of candidates()) {
    const key = job.base;
    const snapshot = sizeSnapshot(job.base, part);
    const previous = seen.get(key);
    seen.set(key, snapshot);
    if (previous !== snapshot) continue;       // 还在写，下一轮再看

    const files = Array.from({ length: part }, (_, i) => `${job.base}_part${i + 1}.mp4`);
    if (!files.every((file) => fs.existsSync(file))) continue;
    if (files.some((file) => busy(file))) { log('跳过（文件被占用）：', path.basename(job.base)); continue; }

    const rec = { base: job.base, part, mp4Path: (i) => `${job.base}_part${i}.mp4`, startedAt: job.startedAt };
    const meta = { nickname: job.nickname, title: job.title, finishedAt: job.finishedAt };
    let plan;
    try { plan = makePlan(rec, meta); } catch (error) { log('规划失败：', path.basename(job.base), error.message); continue; }
    if (!plan.length) continue;

    if (DRY) {
      for (const entry of plan) log('[dry-run]', path.basename(entry.source), '→', path.basename(entry.destination));
      continue;
    }
    try {
      const done = applyPlan(rec, plan);
      acted += 1;
      for (const file of done) log('已命名：', path.basename(file));
    } catch (error) {
      log('命名失败：', path.basename(job.base), error.message);
    }
  }
  return acted;
}

function main() {
  if (!fs.existsSync(DIR)) { console.error('目录不存在：', DIR); process.exit(1); }
  log(`目标目录 ${DIR}${DRY ? '（dry-run）' : ''}${WATCH ? ' 监听中' : ''}`);
  process_();
  if (!WATCH) return;
  setInterval(() => { try { process_(); } catch (error) { log('轮询异常：', error.message); } }, POLL_MS);
}

main();
