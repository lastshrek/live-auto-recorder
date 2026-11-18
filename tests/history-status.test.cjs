'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { statusFor, attach, _resetCache } = require('../src/core/history-status');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-st-')); }

test('产物齐全时显示已转录/已推送', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const mp4 = path.join(dir, '2026-11-18_主播_纯享版.mp4');
  const base = mp4.replace(/\.mp4$/, '');
  fs.writeFileSync(mp4, 'v');
  fs.writeFileSync(base + '.txt', '字幕');
  fs.writeFileSync(base + '.srt', '1\n字幕');
  fs.writeFileSync(base + '.摘要.md', '# 摘要');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const s = statusFor(entry, '/wrong', new Map());
  assert.equal(s.transcribe.status, 'done');
  assert.equal(s.transcribe.label, '已转录');
  assert.equal(s.summary.status, 'done');
  assert.equal(s.summary.label, '已推送');
});

test('只有录像没有产物时显示未转录/未生成', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '2026-11-18_主播_纯享版.mp4'), 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const s = statusFor(entry, '/wrong', new Map());
  assert.equal(s.transcribe.status, 'pending');
  assert.equal(s.transcribe.label, '未转录');
  assert.equal(s.summary.status, 'pending');
  assert.equal(s.summary.label, '未生成');
});

test('队列实时进度优先于产物判断', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const mp4 = path.join(dir, '2026-11-18_主播_纯享版.mp4');
  fs.writeFileSync(mp4, 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const live = new Map([[mp4, { status: 'processing', percent: 42, done: 280, total: 667, stage: '正在识别' }]]);
  const s = statusFor(entry, '/wrong', live);
  assert.equal(s.transcribe.status, 'processing');
  assert.equal(s.transcribe.label, '转录中 42%');
  assert.equal(s.transcribe.percent, 42);
  assert.equal(s.transcribe.segments, 280);
});

test('转录失败显示失败状态', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const mp4 = path.join(dir, '2026-11-18_主播_纯享版.mp4');
  fs.writeFileSync(mp4, 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const live = new Map([[mp4, { status: 'failed', error: '引擎崩了' }]]);
  const s = statusFor(entry, '/wrong', live);
  assert.equal(s.transcribe.status, 'failed');
  assert.equal(s.transcribe.label, '转录失败');
  assert.equal(s.transcribe.detail, '引擎崩了');
});

test('文件引用为空时安全降级，不抛错', () => {
  _resetCache();
  const s = statusFor({ files: [] }, '/wrong', new Map());
  assert.equal(s.transcribe.status, 'none');
  assert.equal(s.summary.status, 'none');
});

test('attach 给每条记录附加状态，不改原对象', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const base = path.join(dir, '2026-11-18_主播_纯享版');
  fs.writeFileSync(base + '.mp4', 'v');
  fs.writeFileSync(base + '.txt', '字幕');
  const history = [{ files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root }];
  const out = attach(history, '/wrong', { items: [], running: null });
  assert.equal(out[0].transcribeStatus.label, '已转录');
  assert.equal(out[0].summaryStatus.label, '未生成');
  assert.equal(history[0].transcribeStatus, undefined, '原对象未被修改');
});

test('界面渲染：statusCell 生成带状态类名的标签与进度条', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/app.js'), 'utf8');
  const source = app.slice(app.indexOf('function statusCell('), app.indexOf('function renderHistory('));
  const element = () => ({
    textContent: '', className: '', title: '', hidden: false, style: {}, children: [],
    appendChild(n) { this.children.push(n); }, append(...n) { this.children.push(...n); },
  });
  const ctx = { document: { createElement: element } };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);

  // 已完成
  const done = ctx.statusCell({ status: 'done', label: '已转录' }, 'transcribe');
  assert.equal(done.children[0].className, 'status-badge st-done');
  assert.equal(done.children[0].textContent, '已转录');

  // 转录中带进度条
  const run = ctx.statusCell({ status: 'processing', label: '转录中 42%', percent: 42 }, 'transcribe');
  assert.equal(run.children[0].className, 'status-badge st-processing');
  assert.equal(run.children[1].className, 'status-minibar');
  assert.equal(run.children[1].children[0].style.width, '42%');

  // 无状态显示占位
  const none = ctx.statusCell(null, 'summary');
  assert.equal(none.textContent, '—');
  assert.equal(none.children.length, 0);
});

test('上传状态：主录像在 upload-state 中显示已备份', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const mp4 = path.join(dir, '2026-11-18_主播_纯享版.mp4');
  fs.writeFileSync(mp4, 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const statePath = path.join(root, 'upload-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ [mp4]: { size: 1, at: Date.now() } }));
  const out = attach([entry], '/wrong', { items: [], running: null }, statePath);
  assert.equal(out[0].uploadStatus.status, 'done');
  assert.equal(out[0].uploadStatus.label, '已备份');
});

test('上传状态：未上传显示待备份（非失败）', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  const mp4 = path.join(dir, '2026-11-18_主播_纯享版.mp4');
  fs.writeFileSync(mp4, 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const statePath = path.join(root, 'upload-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ ['/other/file.mp4']: { size: 1 } }));
  const out = attach([entry], '/wrong', { items: [], running: null }, statePath);
  assert.equal(out[0].uploadStatus.status, 'pending');
  assert.equal(out[0].uploadStatus.label, '待备份');
});

test('上传状态文件缺失时安全降级为待备份', () => {
  _resetCache();
  const root = tmpdir();
  const dir = path.join(root, '主播_123');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '2026-11-18_主播_纯享版.mp4'), 'v');
  const entry = { files: ['主播_123/2026-11-18_主播_纯享版.mp4'], outRoot: root };
  const out = attach([entry], '/wrong', { items: [], running: null }, path.join(root, 'none.json'));
  assert.equal(out[0].uploadStatus.status, 'pending');
});
