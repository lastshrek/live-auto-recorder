'use strict';
/**
 * 自动转写队列测试。
 *
 * 这块的重点不是"能不能转"（真机验证过了），而是三个保护是否成立：
 * 1) 有录制时让路，不跟录制抢 CPU
 * 2) 转写失败不污染录像状态
 * 3) 不阻塞收尾队列
 *
 * 用假 run 函数测试，不真跑推理（那需要 850MB 模型且要 10 秒以上）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TranscribeQueue, pickTranscribableFiles } = require('../src/core/transcribe-queue');

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 轮询等待条件成立，避免依赖固定 sleep 时长 */
async function until(fn, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(stepMs);
  }
  return fn();
}

test('转写完成后状态为 done，并给出产物路径', async () => {
  const q = new TranscribeQueue({
    run: async () => ({ segments: [{ text: 'a' }, { text: 'b' }] }),
    isBusy: () => false,
  });
  const item = q.enqueue('/tmp/demo_主播_20261103.mp4');
  assert.ok(item, '应入队');
  assert.ok(await until(() => item.status === 'done'));
  assert.equal(item.segments, 2);
  assert.match(item.srtFile, /\.srt$/);
  assert.match(item.textFile, /\.txt$/);
  q.stop();
});

test('转写失败只标记自身，不抛出、不影响其它文件', async () => {
  let calls = 0;
  const q = new TranscribeQueue({
    run: async (file) => {
      calls++;
      if (file.includes('bad')) throw new Error('引擎崩了');
      return { segments: [1] };
    },
    isBusy: () => false,
  });
  const bad = q.enqueue('/tmp/bad.mp4');
  const good = q.enqueue('/tmp/good.mp4');
  assert.ok(await until(() => bad.status === 'failed'));
  assert.match(bad.error, /引擎崩了/);
  // 失败不阻断后续任务
  assert.ok(await until(() => good.status === 'done'), '失败后仍应继续处理下一个');
  assert.equal(calls, 2);
  q.stop();
});

test('有录制在进行时让路，状态标为等待而不是硬跑', async () => {
  let busy = true;
  let ran = false;
  const q = new TranscribeQueue({
    run: async () => { ran = true; return { segments: [] }; },
    isBusy: () => busy,
  });
  const item = q.enqueue('/tmp/wait.mp4');
  await wait(200);
  assert.equal(ran, false, '录制中不应开始转写');
  assert.equal(item.status, 'waiting');
  assert.match(item.stage, /等待录制/);

  // 录制结束后应自动接上（队列内部 30s 重试太慢，这里手动触发一次检查）
  busy = false;
  q._pump();
  assert.ok(await until(() => item.status === 'done'), '空闲后应继续');
  q.stop();
});

test('同一文件重复入队会被忽略，避免恢复流程重复收尾时转两遍', async () => {
  const q = new TranscribeQueue({
    run: async () => { await wait(100); return { segments: [] }; },
    isBusy: () => false,
  });
  const a = q.enqueue('/tmp/dup.mp4');
  const b = q.enqueue('/tmp/dup.mp4');
  assert.ok(a);
  assert.equal(b, null, '重复入队应返回 null');
  await until(() => a.status === 'done');
  const c = q.enqueue('/tmp/dup.mp4');
  // 已完成的不再拦（用户可能想重转），此处仅确认不会并发重复
  assert.ok(c);
  q.stop();
});

test('非音视频文件不入队', () => {
  const q = new TranscribeQueue({ run: async () => ({}), isBusy: () => false });
  assert.equal(q.enqueue('/tmp/a.txt'), null);
  assert.equal(q.enqueue('/tmp/a.srt'), null);
  assert.equal(q.enqueue(''), null);
  assert.equal(q.enqueue(null), null);
  q.stop();
});

test('pickTranscribableFiles 排除中间文件与分片', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-pick-'));
  try {
    const mk = n => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); return p; };
    const final = mk('场次_纯享版.mp4');
    const pending = mk('场次_part1.mp4.pending.mp4');
    const part = mk('场次_part1.mp4');
    const txt = mk('场次.txt');
    const picked = pickTranscribableFiles([final, pending, part, txt, '/nonexistent.mp4']);
    assert.deepEqual(picked, [final], '只应留下最终成片');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot 给出界面需要的字段且不泄漏内部状态', async () => {
  const q = new TranscribeQueue({
    run: async () => ({ segments: [1, 2, 3] }),
    isBusy: () => false,
  });
  const item = q.enqueue('/tmp/snap.mp4', { nickname: '主播甲' });
  await until(() => item.status === 'done');
  const snap = q.snapshot();
  assert.equal(typeof snap.pending, 'number');
  assert.ok(Array.isArray(snap.items));
  const first = snap.items[0];
  assert.equal(first.name, '主播甲');
  assert.equal(first.status, 'done');
  assert.equal(first.segments, 3);
  // 不应该把 run 函数之类的内部字段暴露给渲染进程
  assert.equal(first.run, undefined);
  q.stop();
});

test('stop 之后不再处理队列', async () => {
  const q = new TranscribeQueue({
    run: async () => ({ segments: [] }),
    isBusy: () => true,   // 一直忙，让它停在队列里
  });
  q.enqueue('/tmp/a.mp4');
  q.stop();
  assert.equal(q.queue.length, 0);
});