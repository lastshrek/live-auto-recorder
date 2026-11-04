'use strict';
/**
 * 本地转写模块测试。
 *
 * 不做真实推理（那需要 850MB 模型，不适合放进常规测试），而是锁住
 * 容易出错且改坏了不会立刻报错的几处：SRT 时间格式、文本拼接、
 * wav 时长解析、以及环境缺失时的错误信息是否可操作。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT_PY = path.join(__dirname, '..', 'src', 'transcribe', 'run_asr.py');

/** 用 Python 侧的函数做验证：它们是纯函数，不需要模型。 */
function py(code) {
  return execFileSync('python3', ['-c',
    `import sys; sys.path.insert(0, ${JSON.stringify(path.dirname(SCRIPT_PY))});` +
    `import run_asr; ${code}`], { encoding: 'utf8', timeout: 30000 });
}

test('SRT 时间格式符合规范（毫秒进位与补零）', () => {
  const out = py(`
for s in [0, 1.5, 59.999, 60, 3599.5, 3600, 3661.234]:
    print(run_asr.fmt_srt_time(s))
`);
  assert.deepEqual(out.trim().split('\n'), [
    '00:00:00,000',
    '00:00:01,500',
    '00:00:59,999',
    '00:01:00,000',
    '00:59:59,500',
    '01:00:00,000',
    '01:01:01,234',
  ]);
});

test('SRT 时间格式：负数与浮点误差不会产出畸形时间码', () => {
  const out = py(`
for s in [-1, -0.001, 0.0005]:
    print(run_asr.fmt_srt_time(s))
`);
  // 负值钳到 0；亚毫秒四舍五入后仍是合法时间码，不能出现 "-1" 或 ",1000"
  for (const line of out.trim().split('\n')) {
    assert.match(line, /^\d{2}:\d{2}:\d{2},\d{3}$/, `非法时间码: ${line}`);
  }
});

test('SRT 条目连续编号且带空行分隔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-srt-'));
  try {
    const f = path.join(dir, 'a.srt');
    py(`run_asr.write_srt(${JSON.stringify(f)}, [
      {'start':0.0,'end':1.0,'text':'第一句'},
      {'start':1.0,'end':2.5,'text':'第二句'},
    ])`);
    const body = fs.readFileSync(f, 'utf8');
    assert.match(body, /^1\r?\n00:00:00,000 --> 00:00:01,000\r?\n第一句/);
    assert.match(body, /2\r?\n00:00:01,000 --> 00:00:02,500\r?\n第二句/);
    assert.ok(body.endsWith('\n'), 'SRT 应以换行结尾，否则部分播放器会漏掉最后一条');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文本输出默认逐句一行，便于人工校对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-txt-'));
  try {
    const f = path.join(dir, 'a.txt');
    py(`run_asr.write_txt(${JSON.stringify(f)}, [
      {'start':0,'end':1,'text':'甲'},
      {'start':1,'end':2,'text':'乙'},
    ])`);
    assert.equal(fs.readFileSync(f, 'utf8'), '甲\n乙\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('segmentsToText 支持逐句与整段两种拼法', () => {
  const { segmentsToText } = require('../src/core/transcribe');
  const segs = [{ text: '你好。' }, { text: '今天天气不错。' }];
  assert.equal(segmentsToText(segs, { paragraph: false }), '你好。\n今天天气不错。');
  assert.equal(segmentsToText(segs, { paragraph: true }), '你好。今天天气不错。');
  assert.equal(segmentsToText([], {}), '');
  assert.equal(segmentsToText(null), '');
});

test('wavDurationSeconds 对合法 wav 给出正确时长，对非 wav 返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-wav-'));
  try {
    const ok = path.join(dir, 'ok.wav');
    // 手工构造 44 字节头 + 2 秒 16k/16bit/单声道 的静音
    const dataLen = 16000 * 2 * 2;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);       // PCM
    buf.writeUInt16LE(1, 22);       // 单声道
    buf.writeUInt32LE(16000, 24);   // 采样率
    buf.writeUInt32LE(16000 * 2, 28); // byteRate
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataLen, 40);
    fs.writeFileSync(ok, buf);

    const { wavDurationSeconds } = require('../src/core/transcribe');
    const d = wavDurationSeconds(ok);
    assert.ok(Math.abs(d - 2) < 0.01, `期望约 2 秒，实际 ${d}`);

    const bad = path.join(dir, 'bad.bin');
    fs.writeFileSync(bad, 'not a wav');
    assert.equal(wavDurationSeconds(bad), null);
    assert.equal(wavDurationSeconds(path.join(dir, 'missing.wav')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('转写不存在的文件时给出明确错误，而不是崩溃', async () => {
  const { transcribeFile } = require('../src/core/transcribe');
  await assert.rejects(
    () => transcribeFile('/nonexistent/xxx.mp4', {}),
    /输入文件不存在/,
  );
});

test('缺少 Python 环境时错误信息可操作（不是裸 stack）', () => {
  const { diagnose } = require('../src/core/transcribe');
  // 指向一个必然不存在的 venv，迫使回退到系统 python
  const d = diagnose({ venvDir: '/nonexistent/venv' });
  assert.ok(Array.isArray(d.candidates));
  assert.equal(typeof d.ok, 'boolean');
  // 有 python 却缺 sherpa-onnx 时，hint 应指向安装脚本
  if (d.anyPython && !d.ok) {
    assert.match(d.hint, /安装|setup|sherpa/);
  }
});

test('安装脚本的路径常量在不同平台上都指向 venv 内可执行文件', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-transcribe.cjs'), 'utf8');
  // Windows 用 Scripts/python.exe，其它平台用 bin/python3 —— 两者都必须可推导
  assert.match(script, /Scripts['"],\s*['"]python\.exe/);
  assert.match(script, /['"]bin['"],\s*['"]python3['"]/);
});

test('CLI 无参数时输出用法提示', () => {
  const { spawnSync } = require('node:child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'transcribe-cli.cjs');
  const r = spawnSync('node', [cli], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /用法/);
  assert.match(r.stdout, /transcribe-cli/);
});