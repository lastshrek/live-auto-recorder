const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isInsideAsar, unpackedPath, dataRoot } = require('../src/util/app-paths');

test('asar 路径会被识别并映射到解包目录，开发期路径保持原样', () => {
  const packed = path.join('C:', 'app', 'resources', 'app.asar', 'src', 'transcribe', 'run_asr.py');
  assert.equal(isInsideAsar(packed), true);
  assert.equal(
    unpackedPath(packed),
    path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'src', 'transcribe', 'run_asr.py'),
  );
  // 已经解包的路径不能被二次改写
  const already = path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  assert.equal(unpackedPath(already), already);

  const dev = path.join(os.tmpdir(), 'repo', 'src', 'core', 'recorder.js');
  assert.equal(isInsideAsar(dev), false);
  assert.equal(unpackedPath(dev), dev);
});

test('LR_ROOT 优先作为可写数据根目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-root-'));
  const original = process.env.LR_ROOT;
  process.env.LR_ROOT = dir;
  try {
    assert.equal(dataRoot(), dir);
  } finally {
    if (original === undefined) delete process.env.LR_ROOT;
    else process.env.LR_ROOT = original;
  }
});

test('打包环境下 config/log 落到 LR_ROOT，而不是 app.asar 内', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-packed-'));
  const script = `
    const store = require(${JSON.stringify(path.resolve(__dirname, '../src/core/store.js'))});
    const log = require(${JSON.stringify(path.resolve(__dirname, '../src/util/log.js'))});
    log.info('packaged-root-test');
    console.log(JSON.stringify({ config: store.CONFIG_PATH, logs: require('node:path').join(process.env.LR_ROOT, 'logs') }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, LR_ROOT: dir },
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  assert.equal(path.resolve(out.config), path.join(dir, 'config.json'));
  assert.ok(fs.existsSync(path.join(dir, 'logs')), '日志目录应创建在 LR_ROOT 下');
  assert.ok(!out.config.includes('.asar'), '配置路径不能落在 asar 归档内');
});

test('打包启动不再把数据目录当应用入口传给 exe', () => {
  const { EventEmitter } = require('node:events');
  const { launchLogged } = require('../src/bootstrap.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-launch-'));
  const child = new EventEmitter();
  child.pid = 1;
  child.unref = () => {};
  let request = null;
  launchLogged(dir, 'app.exe', ['douyin://test'], (exe, args, options) => {
    request = { exe, args, options };
    return child;
  }, null);
  child.emit('spawn');
  assert.deepEqual(request.args, ['douyin://test'], '打包版只转发用户参数');
  assert.equal(request.options.cwd, dir, '工作目录必须是可写数据根');
});