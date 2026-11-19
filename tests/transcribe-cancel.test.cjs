'use strict';
/**
 * 转写任务取消测试。
 * 覆盖：排队中取消出队并记 canceled、重启恢复不重跑 canceled、
 * 进行中取消走中断并按 canceled 落账、未知/已结束 id 给明确错误。
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

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-cancel-'));
  return path.join(dir, 'state.json');
}

test('排队中的任务取消后移出队列，状态记为 canceled', async () => {
  const q = new TranscribeQueue({ run: async () => ({ segments: [] }), isBusy: () => true });
  const a = q.enqueue('/tmp/live-a.mp4', { nickname: '甲' });
  const b = q.enqueue('/tmp/live-b.mp4', { nickname: '乙' });
  assert.equal(q.snapshot().pending, 2);

  const r = q.cancel(b.id);
  assert.equal(r.ok, true);
  assert.equal(b.status, 'canceled');
  assert.equal(b.stage, '已取消');
  assert.equal(q.snapshot().pending, 1, '应只剩一个待转写');
  // 队列空闲后只会跑 a，b 不会被转写
  q.isBusy = () => false;
  assert.ok(await until(() => a.status === 'done'));
  assert.equal(b.status, 'canceled', '被取消的任务不应被转写');
  q.stop();
});

test('canceled 状态重启后不重新入队', () => {
  const statePath = tmpState();
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    items: [{ id: 'x1', file: '/tmp/gone-or-not.mp4', name: '甲', status: 'canceled', at: Date.now() }],
  }));
  const q = new TranscribeQueue({ run: async () => ({ segments: [] }), statePath });
  q.restore();
  const snap = q.snapshot();
  assert.equal(snap.pending, 0, 'canceled 不应续做');
  assert.equal(snap.items[0].status, 'canceled', '状态应保留为 canceled');
  q.stop();
});

test('进行中的任务取消会中断子进程并按已取消落账', async () => {
  let signalSeen = null;
  let resolveRun;
  const q = new TranscribeQueue({
    run: (file, item, onProgress, signal) => new Promise((resolve, reject) => {
      signalSeen = signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      resolveRun = resolve;
    }),
    isBusy: () => false,
  });
  const item = q.enqueue('/tmp/running.mp4', { nickname: '甲' });
  assert.ok(await until(() => item.status === 'processing'));

  const r = q.cancel(item.id);
  assert.equal(r.ok, true);
  assert.equal(r.wasRunning, true);
  assert.ok(signalSeen?.aborted, '应触发 AbortController');

  assert.ok(await until(() => item.status === 'canceled'));
  assert.equal(item.error, '', '已取消不记错误');
  assert.equal(q.running, null);
  q.stop();
});

test('未知 id 与已结束任务给明确错误', async () => {
  const q = new TranscribeQueue({ run: async () => ({ segments: [] }), isBusy: () => false });
  assert.deepEqual(q.cancel(''), { ok: false, error: '缺少任务 id' });
  assert.equal(q.cancel('nope').ok, false, '不存在的 id 应失败');

  const item = q.enqueue('/tmp/fin.mp4');
  assert.ok(await until(() => item.status === 'done'));
  const r = q.cancel(item.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /已结束/);
  q.stop();
});

test('取消后状态落盘，重启 restore 不再续做', async () => {
  const statePath = tmpState();
  const q = new TranscribeQueue({
    run: async () => ({ segments: [] }),
    isBusy: () => true,
    statePath,
  });
  const a = q.enqueue('/tmp/persist.mp4', { nickname: '甲' });
  const b = q.enqueue('/tmp/persist2.mp4', { nickname: '乙' });
  q.cancel(a.id);
  assert.ok(fs.existsSync(statePath), '取消应立即写盘');
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.items.find(i => i.id === a.id).status, 'canceled');
  q.stop();

  // 模拟重启：磁盘上 a=canceled、b=queued（b 文件真实存在才会续做）
  fs.writeFileSync('/tmp/persist2.mp4', 'x');
  const q2 = new TranscribeQueue({ run: async () => ({ segments: [] }), statePath });
  q2.restore();
  const snap = q2.snapshot();
  assert.equal(snap.pending, 1, '只有 b 续做');
  assert.equal(snap.items.find(i => i.id === a.id).status, 'canceled');
  assert.equal(snap.items.find(i => i.id === b.id).status, 'queued');
  q2.stop();
  fs.rmSync('/tmp/persist2.mp4', { force: true });
});
