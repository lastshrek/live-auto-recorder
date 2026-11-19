// 校验判定要区分「封装层时间戳抖动」与「真正的内容损坏」：
// dts 倒退/重复在断流边缘很常见，mp4 muxer 会自动微调继续写，解码兜底仍会拦住坏文件。
// 回归背景：2026-11-19 聚金阁场次因拼接产物 dts 抖动被误判「拼接完整性检查失败」。
// 注意：单分片内的 pts 倒退必须仍走重编码修复（见 timestamps.test.cjs），
// 所以 hasMediaErrors 保持严格，只有 onlyDtsWarnings 供拼接产物校验专用。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasMediaErrors, onlyDtsWarnings } = require('../src/core/media');

const DTS_MUXER = '[null @ 0x0] Application provided invalid, non monotonically increasing dts to muxer in stream 1: 207598608 >= 207598608';
const DTS_WARN = '[mp4 @ 0x0] Non-monotonic DTS in output stream 0:0; previous: 69264752, current: 69262896; changing to 69264753.';

test('hasMediaErrors 对 dts 抖动保持严格（修复路径不受影响）', () => {
  assert.equal(hasMediaErrors(DTS_MUXER + '\n    Last message repeated 11 times'), true);
  assert.equal(hasMediaErrors(DTS_WARN), true);
  assert.equal(hasMediaErrors('[h264 @ 0x0] corrupt decoded frame'), true);
  assert.equal(hasMediaErrors(''), false);
});

test('onlyDtsWarnings：纯 dts 抖动放行', () => {
  assert.equal(onlyDtsWarnings(DTS_MUXER), true);
  assert.equal(onlyDtsWarnings(DTS_MUXER + '\n    Last message repeated 11 times'), true);
  assert.equal(onlyDtsWarnings(DTS_MUXER + '\n' + DTS_WARN), true);
});

test('onlyDtsWarnings：混入真实错误不放行', () => {
  assert.equal(onlyDtsWarnings(DTS_MUXER + '\n[h264 @ 0x0] corrupt decoded frame'), false);
  assert.equal(onlyDtsWarnings('媒体处理超时'), false);
});

test('onlyDtsWarnings：空输出不放行（无告警说明没有抖动）', () => {
  assert.equal(onlyDtsWarnings(''), false);
});
