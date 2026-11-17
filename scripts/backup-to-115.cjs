#!/usr/bin/env node
'use strict';
/**
 * 把已有录像批量备份到 115（经本机 OpenList 的 WebDAV）。
 *
 * 与应用的自动上传共用同一个状态文件，所以：
 *   - 应用传过的，这里会跳过；这里传完的，应用也不会重复传
 *   - 中途中断（断电/退出/网络断）重跑即可，已完成的不会重来
 *
 * 用法：
 *   node scripts/backup-to-115.cjs                       # 默认传 /Volumes/DATA/抖音录制
 *   node scripts/backup-to-115.cjs --dir "/xxx"          # 指定目录
 *   node scripts/backup-to-115.cjs --dry-run             # 只列出要传什么
 */

const fs = require('node:fs');
const path = require('node:path');
const { Uploader } = require('../src/core/upload-queue');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DIR = arg('--dir', '/Volumes/DATA/抖音录制');
const STATE = arg('--state', path.join(process.env.HOME, 'Library/Application Support/直播自动录制/upload-state.json'));
const DRY = process.argv.includes('--dry-run');
const CONCURRENCY = Math.max(1, Math.min(8, Number(arg('--concurrency', '6')) || 6));

// 允许 _纯享版.摘要.md 这类双后缀
const FILE_RE = /_纯享版[^/\\]*\.(mp4|srt|txt|md)$/i;
const fmt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${(b / 1048576).toFixed(1)} MB`);

function collect() {
  const out = [];
  for (const dir of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(DIR, dir.name);
    for (const f of fs.readdirSync(full, { withFileTypes: true })) {
      // ._xxx 是 macOS 的 AppleDouble 元数据文件，不是真录像
      if (!f.isFile() || f.name.startsWith('._') || f.name.startsWith('.') || !FILE_RE.test(f.name)) continue;
      const file = path.join(full, f.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      out.push({ file, size: st.size, mtime: st.mtimeMs });
    }
  }
  // 新的优先：万一中途停掉，先保住最近的场次
  return out.sort((a, b) => b.mtime - a.mtime);
}

const settings = {
  upload115: true,
  upload115BaseUrl: arg('--base-url', 'http://127.0.0.1:5244/dav'),
  upload115Mount: arg('--mount', '115'),
  upload115User: arg('--user', 'admin'),
  upload115Password: arg('--password', 'LiveRec2026'),
  upload115Root: arg('--root', '直播录制备份'),
  upload115RetentionDays: 0,           // 这个脚本只上传，绝不删本地
};

function main() {
  const all = collect();
  if (!all.length) { console.log('没有找到待传文件:', DIR); return; }

  const up = new Uploader({ settings, roots: () => [DIR], statePath: STATE, concurrency: CONCURRENCY });
  const todo = all.filter(({ file, size }) => {
    const rec = up.state[file];
    return !(rec && rec.size === size);
  });
  const totalBytes = todo.reduce((a, b) => a + b.size, 0);
  console.log(`共 ${all.length} 个成品文件，其中已传 ${all.length - todo.length} 个，待传 ${todo.length} 个（${fmt(totalBytes)}），并发 ${CONCURRENCY}`);

  if (DRY) {
    for (const t of todo) console.log(`  ${fmt(t.size).padStart(9)}  ${path.relative(DIR, t.file)}`);
    return;
  }
  if (!todo.length) { console.log('全部已上传，无需操作'); return; }

  // 先把目录全部建好，再并发上传：否则建目录会和上传抢存储锁(423)
  up.prepareDirs(todo.map((t) => t.file)).then(() => {
    for (const t of todo) up.enqueueFile(t.file);
  }).catch((e) => console.error('预建目录失败:', e.message));

  const t0 = Date.now();
  const totalLanded = () => {
    let bytes = 0, count = 0;
    for (const t of todo) {
      const rec = up.state[t.file];
      if (rec && rec.size === t.size) { bytes += t.size; count += 1; }
    }
    return { bytes, count };
  };
  let prev = { bytes: totalLanded().bytes, at: Date.now() };
  let lastLog = 0;
  const timer = setInterval(() => {
    const s = up.snapshot();
    const now = Date.now();
    const { bytes, count } = totalLanded();
    const dt = (now - prev.at) / 1000;
    const speed = dt > 5 ? (bytes - prev.bytes) / dt : 0;
    if (dt > 60) prev = { bytes, at: now };
    const eta = speed > 20000 ? `${((totalBytes - bytes) / speed / 3600).toFixed(1)} 小时` : '计算中';
    console.log(
      `[${((now - t0) / 3600000).toFixed(1)}h] 完成 ${count}/${todo.length} · ${fmt(bytes)} / ${fmt(totalBytes)}` +
      ` · ${(speed / 1048576).toFixed(2)} MB/s · 剩余约 ${eta}` +
      (s.running ? ` · 正在传 ${s.running.name.slice(-26)}` : ''),
    );
    s.items.filter((i) => i.status === 'failed' && i.at > lastLog).forEach((f) => {
      console.log(`  ！失败 ${f.name.slice(-30)}：${f.error}`);
    });
    lastLog = now;
    if (s.pending === 0) {
      clearInterval(timer);
      const bad = s.items.filter((i) => i.status === 'failed').length;
      console.log(`\n结束：本次成功 ${count} 个，失败 ${bad} 个，耗时 ${((Date.now() - t0) / 60000).toFixed(0)} 分钟`);
      process.exit(bad ? 1 : 0);
    }
  }, 30_000);
}

main();
