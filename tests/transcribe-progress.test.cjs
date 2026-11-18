'use strict';
/**
 * 转写进度与断点续做测试。
 * 覆盖三件事：进度能上报到 snapshot、状态能写盘、启动能恢复未完成任务。
 * 用假 run 函数，不真跑推理。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TranscribeQueue } = require('../src/core/transcribe-queue');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (fn()) return true; await wait(stepMs); }
  return fn();
}

test('进度通过 onProgress 上报，snapshot 带百分比与段数', async () => {
  const q = new TranscribeQueue({
    run: async (file, item, onProgress) => {
      onProgress({ stage: 'extract', seconds: 12 });
      onProgress({ stage: 'transcribe', done: 50, total: 100, percent: 50 });
      onProgress({ stage: 'transcribe', done: 100, total: 100, percent: 100 });
      return { segments: [1, 2] };
    },
    isBusy: () => false,
  });
  const item = q.enqueue('/tmp/prog.mp4', { nickname: '主播' });
  assert.ok(await until(() => item.status === 'done'));
  assert.equal(item.percent, 100);
  assert.equal(item.done, 100);
  assert.equal(item.total, 100);
  const first = q.snapshot().items[0];
  assert.equal(first.percent, 100);
  assert.equal(first.done, 100);
  assert.equal(first.total, 100);
  assert.ok(first.startedAt > 0, '应记录开始时间供估算剩余');
  q.stop();
});

test('进度只前进不回退，避免界面跳动', async () => {
  let captured;
  const q = new TranscribeQueue({
    run: async (file, item, onProgress) => {
      onProgress({ stage: 'transcribe', done: 80, total: 100, percent: 80 });
      onProgress({ stage: 'transcribe', done: 30, total: 100, percent: 30 });
      captured = item.percent;
      return { segments: [] };
    },
    isBusy: () => false,
  });
  q.enqueue('/tmp/back.mp4');
  await until(() => captured !== undefined);
  assert.equal(captured, 80, '回退的进度应被忽略');
  q.stop();
});

test('状态写盘：入队与完成都落盘，含进度字段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tstate-'));
  const statePath = path.join(dir, 'transcribe-state.json');
  try {
    const q = new TranscribeQueue({
      run: async () => ({ segments: [{}, {}, {}] }),
      isBusy: () => false,
      statePath,
    });
    q.enqueue('/tmp/save.mp4', { nickname: '主播甲' });
    await until(() => q.snapshot().items[0]?.status === 'done');
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0].status, 'done');
    assert.equal(saved.items[0].percent, 100);
    assert.equal(saved.items[0].segments, 3);
    q.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动恢复：中断的重新入队，字幕已存在的补记为完成', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-trestore-'));
  const statePath = path.join(dir, 'transcribe-state.json');
  const withSrt = path.join(dir, '甲.mp4');
  const withoutSrt = path.join(dir, '乙.mp4');
  fs.writeFileSync(withSrt, 'x');
  fs.writeFileSync(withoutSrt, 'x');
  fs.writeFileSync(path.join(dir, '甲.srt'), '1\n00:00:00,000 --> 00:00:01,000\n词\n');
  try {
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, items: [
      { id: 'a', file: withSrt, name: '甲', status: 'processing', percent: 60, at: Date.now() },
      { id: 'b', file: withoutSrt, name: '乙', status: 'processing', percent: 30, at: Date.now() },
      { id: 'c', file: '/tmp/old.mp4', name: '旧', status: 'done', segments: 9, at: Date.now() },
    ] }));
    let ran = null;
    const q = new TranscribeQueue({
      run: async (file) => { ran = file; return { segments: [] }; },
      isBusy: () => false,
      statePath,
    });
    q.restore();
    const map = new Map(q.snapshot().items.map(i => [i.name, i]));
    assert.equal(map.get('甲').status, 'done', '字幕已存在应补记完成');
    assert.equal(map.get('甲').percent, 100);
    assert.equal(map.get('乙').status, 'queued', '未完成应重新入队');
    assert.equal(q.queue.length, 1);
    assert.ok(await until(() => ran === withoutSrt), '应自动续做未完成的那个');
    q.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动恢复：已失败的不自动重试，源文件丢失的标记为失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tfail-'));
  const statePath = path.join(dir, 'transcribe-state.json');
  const gone = path.join(dir, 'gone.mp4');
  try {
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, items: [
      { id: 'a', file: '/tmp/failed.mp4', name: '失败场次', status: 'failed', error: '引擎崩了', at: Date.now() },
      { id: 'b', file: gone, name: '源文件丢失', status: 'queued', at: Date.now() },
    ] }));
    const q = new TranscribeQueue({ run: async () => ({ segments: [] }), isBusy: () => false, statePath });
    q.restore();
    assert.equal(q.queue.length, 0, '失败与源文件丢失都不应重试');
    const map = new Map(q.snapshot().items.map(i => [i.name, i]));
    assert.equal(map.get('失败场次').status, 'failed');
    assert.match(map.get('源文件丢失').error, /源文件已移除/);
    q.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('界面渲染：running 进度写入进度条，空闲时显示上次结果', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname, '../src/gui/app.js'), 'utf8');
  // 截取 renderTranscribe 函数本体，用 DOM mock 验证真实渲染逻辑
  const source = app.slice(app.indexOf('function renderTranscribe('), app.indexOf('function renderPost('));
  const element = () => ({
    textContent: '', title: '', hidden: false, style: {}, dataset: {}, children: [],
    setAttribute(n, v) { this[n] = v; },
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return this._track || (this._track = element()); },
    appendChild(n) { this.children.push(n); }, append(...n) { this.children.push(...n); },
  });
  const elements = {};
  const ctx = {
    state: {},
    $: id => elements[id] || (elements[id] = element()),
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);

  const now = Date.now();
  ctx.state = { transcribe: {
    pending: 2,
    running: { name: '天津&杨哥', stage: '正在识别', done: 500, total: 1000, percent: 50, startedAt: now - 30000 },
    items: [],
  } };
  const result = ctx.renderTranscribe();
  assert.equal(result.pct, 50);
  assert.equal(result.pending, 2);
  assert.equal(elements.transcribeStrip.hidden, false);
  assert.match(elements.tsName.textContent, /天津&杨哥/);
  assert.match(elements.tsMeta.textContent, /500\/1000 段/);
  assert.match(elements.tsMeta.textContent, /50%/);
  assert.equal(elements.tsBar.style.width, '50%');
  assert.match(elements.tsEta.textContent, /预计/);

  // 空闲 + 上次失败：显示失败提示而不是进度
  ctx.state = { transcribe: {
    pending: 0, running: null,
    items: [{ name: '聚金阁', status: 'failed', error: '引擎崩了', percent: 30 }],
  } };
  ctx.renderTranscribe();
  assert.equal(elements.tsBar.style.width, '100%');
  assert.match(elements.tsMeta.textContent, /上次失败/);
  assert.match(elements.tsMeta.textContent, /引擎崩了/);
});
