'use strict';
/**
 * 回归测试：自动转写必须能从收尾结果里拿到真实成片路径。
 *
 * 历史 bug：_hookTranscribe 读 job.recorder.files，而 recorder 实例上
 * 从来没有这个字段，导致 pickTranscribableFiles([]) 恒为空 —— 自动转写
 * 静默不工作，界面开多少开关都没用，而且只影响「自动」，不影响手动点按钮。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler } = require('../src/core/scheduler');

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-autotx-'));
  return dir;
}

test('自动转写读取 videoFiles 而不是不存在的 recorder.files', () => {
  // 只验证取文件的来源：构造一个最小 rec + job，确认能从 publicationPlan 拿到路径
  const { videoFiles } = require('../src/core/video-names');
  const dir = makeTmp();
  const finalFile = path.join(dir, '2026-11-14_主播_20-00-00_标题_纯享版.mp4');
  fs.writeFileSync(finalFile, 'x');

  const rec = { part: 1, mp4Path: (n) => path.join(dir, `base_part${n}.mp4`) };
  const job = { publicationPlan: [{ source: path.join(dir, 'base_part1.mp4'), destination: finalFile }] };

  const files = videoFiles(rec, job);
  assert.deepEqual(files, [finalFile], '应当返回发布后的最终文件');
});

test('recorder 实例没有 files 字段（防止有人又把它当成数据来源）', () => {
  const { Recorder } = require('../src/core/recorder');
  const dir = makeTmp();
  const rec = new Recorder(path.join(dir, 'base'));
  assert.equal(rec.files, undefined, 'Recorder 上不应存在 files 字段');
});

test('pickTranscribableFiles 会过滤掉分片与中间文件', () => {
  const { pickTranscribableFiles } = require('../src/core/transcribe-queue');
  const dir = makeTmp();
  const final = path.join(dir, '2026-11-14_主播_20-00-00_标题_纯享版.mp4');
  const part = path.join(dir, 'base_part1.mp4');
  const pending = path.join(dir, 'base_part1.pending.mp4');
  for (const f of [final, part, pending]) fs.writeFileSync(f, 'x');

  const picked = pickTranscribableFiles([final, part, pending, path.join(dir, 'missing.mp4')]);
  assert.deepEqual(picked, [final], '只应保留最终成片，且文件必须存在');
});