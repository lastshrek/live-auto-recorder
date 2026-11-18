// 主播列表排序：在播/录制中的排前面，离线的沉底。
// 顺序只在状态变化时改动，同档内必须稳定，否则每秒刷新会来回跳。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { taskRank, sortTasks } = require('../src/core/scheduler');

test('列表顺序：录制中 > 直播中 > 主页监控 > 离线', () => {
  const list = [
    { rid: 'off1', state: 'idle', live: false },
    { rid: 'live1', state: 'idle', live: true },
    { rid: 'rec1', state: 'recording', live: true },
    { rid: 'watch1', state: 'idle', live: false, secWatch: true },
  ];
  assert.deepEqual(sortTasks(list).map((t) => t.rid), ['rec1', 'live1', 'watch1', 'off1']);
});

test('同档内保持添加顺序，刷新时不来回跳', () => {
  const list = [
    { rid: 'offA', state: 'idle', live: false },
    { rid: 'liveA', state: 'idle', live: true },
    { rid: 'offB', state: 'idle', live: false },
    { rid: 'liveB', state: 'idle', live: true },
  ];
  assert.deepEqual(sortTasks(list).map((t) => t.rid), ['liveA', 'liveB', 'offA', 'offB']);
});

test('正在封存 stopping 与录制中同档置顶', () => {
  const list = [
    { rid: 'live1', state: 'idle', live: true },
    { rid: 'stop1', state: 'stopping', live: true },
    { rid: 'rec1', state: 'recording', live: true },
  ];
  assert.deepEqual(sortTasks(list).map((t) => t.rid), ['stop1', 'rec1', 'live1']);
});

test('不修改传入数组，并容忍空条目', () => {
  const list = [{ rid: 'a', state: 'idle' }, null];
  const copy = list.slice();
  const out = sortTasks(list);
  assert.deepEqual(list, copy);
  assert.equal(out.length, 2);
  assert.equal(taskRank(null), 3);
  assert.equal(taskRank({ state: 'recording' }), 0);
  assert.equal(taskRank({ state: 'idle', live: true }), 1);
  assert.equal(taskRank({ state: 'idle', secWatch: true }), 2);
});
