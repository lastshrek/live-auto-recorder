const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {Uploader}=require('../src/core/upload-queue');

// 迷你 WebDAV: 只实现 PUT / HEAD，够验证上传、校验与重试
function fakeDav({ failFirst = 0, denyAuth = false } = {}) {
  const store = new Map();
  const raw = new Map();
  let puts = 0;
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url);
    const rawUrl = req.url;
    if (req.method === 'PUT') puts += 1;
    if (denyAuth) { res.writeHead(403); res.end(); return; }
    if (req.method === 'PUT') {
      if (puts <= failFirst) { res.writeHead(500); res.end('boom'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { store.set(key, Buffer.concat(chunks)); raw.set(key, rawUrl); res.writeHead(201); res.end(); });
      return;
    }
    if (req.method === 'HEAD') {
      if (!store.has(key)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Length': store.get(key).length }); res.end();
      return;
    }
    res.writeHead(405); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, store, raw, port: server.address().port, puts: () => puts })));
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-upload-'));
  const recDir = path.join(dir, '主播_123456_20261116_101010');
  fs.mkdirSync(recDir, { recursive: true });
  const mp4 = path.join(recDir, '2026-11-16_主播_10-10-10_主题_纯享版.mp4');
  fs.writeFileSync(mp4, 'x'.repeat(2048));
  return { dir, recDir, mp4 };
}

const settings = (port) => ({
  upload115: true,
  upload115BaseUrl: `http://127.0.0.1:${port}/dav`,
  upload115User: 'admin',
  upload115Password: 'pw',
  upload115Root: '直播录制备份',
  upload115RetentionDays: 7,
});

test('上传后按大小校验记账，未变化的文件不会重复上传', async () => {
  const { server, store, raw, port, puts } = await fakeDav();
  const { dir, mp4 } = fixture();
  const statePath = path.join(dir, 'upload-state.json');
  const up = new Uploader({ settings: settings(port), roots: () => [dir], statePath, retryDelays: [10] });
  try {
    up.enqueueFile(mp4);
    await new Promise((r) => setTimeout(r, 400));
    const key = [...store.keys()][0];
    const rawUrl = [...raw.values()][0];
    assert.ok(rawUrl.includes(encodeURIComponent('直播录制备份')), '远端路径应带中文根目录: ' + rawUrl);
    assert.ok(rawUrl.endsWith(encodeURIComponent(path.basename(mp4))), '文件名需逐段编码: ' + rawUrl);
    assert.equal(store.get(key).length, 2048, '远端内容大小应与本地一致');
    assert.equal(up.state[mp4].size, 2048, '记账应记录大小');
    assert.equal(puts(), 1);
    assert.equal(up.enqueueFile(mp4), null, '已上传且未变化的不应重复入队');
  } finally { up.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('首次失败会重试并最终成功', async () => {
  const { server, store, port } = await fakeDav({ failFirst: 1 });
  const { dir, mp4 } = fixture();
  const up = new Uploader({ settings: settings(port), roots: () => [dir], statePath: path.join(dir, 's.json'), retryDelays: [20] });
  try {
    up.enqueueFile(mp4);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(store.size, 1, '重试后应成功写入远端');
    assert.ok(up.state[mp4], '成功后才记账');
  } finally { up.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('403 鉴权失败立即失败且不重试（cookie 过期要立刻暴露）', async () => {
  const { server, port, puts } = await fakeDav({ denyAuth: true });
  const { dir, mp4 } = fixture();
  const up = new Uploader({ settings: settings(port), roots: () => [dir], statePath: path.join(dir, 's.json'), retryDelays: [10, 10, 10] });
  try {
    up.enqueueFile(mp4);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(puts(), 0, '鉴权失败应在建目录阶段就拦下，连 PUT 都不发');
    assert.equal(up.state[mp4], undefined, '失败不能记账，否则会被误删');
    assert.match(up.items[0].error, /鉴权失败/);
  } finally { up.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保留天数清理只删已确认上传且大小一致的文件', async () => {
  const { server, port } = await fakeDav();
  const { dir, mp4 } = fixture();
  const other = path.join(dir, '主播_123456_20261116_101010', '2026-11-16_主播_11-11-11_未上传_纯享版.mp4');
  fs.writeFileSync(other, 'y'.repeat(100));
  const up = new Uploader({ settings: settings(port), roots: () => [dir], statePath: path.join(dir, 's.json'), retryDelays: [10] });
  try {
    up.enqueueFile(mp4);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(mp4));
    // 未到保留期不删
    assert.equal(up.cleanup(), 0);
    // 记账时间推到 8 天前
    up.state[mp4].at = Date.now() - 8 * 86400000;
    assert.equal(up.cleanup(), 1, '超过 7 天且已上传的应删除');
    assert.equal(fs.existsSync(mp4), false);
    assert.equal(fs.existsSync(other), true, '没上传过的文件绝不能删');
  } finally { up.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('录制进行中不上传，空转等待', async () => {
  const { server, store, port } = await fakeDav();
  const { dir, mp4 } = fixture();
  let busy = true;
  const up = new Uploader({ settings: settings(port), roots: () => [dir], statePath: path.join(dir, 's.json'), isBusy: () => busy, retryDelays: [10] });
  try {
    up.enqueueFile(mp4);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(store.size, 0, '录制中不应占用上行带宽');
    assert.equal(up.queue[0].status, 'waiting');
    busy = false;
    up._pump();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(store.size, 1, '录制结束后应自动续传');
  } finally { up.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
