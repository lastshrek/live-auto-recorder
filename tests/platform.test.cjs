const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {capabilities,supportsIndependentGuardian,autoStartNote,launcherPath}=require('../src/util/platform');
const {parsePsOutput,psArgs,isSameExecutable,ffmpegName}=require('../src/core/process-query');
const {makeTrayIconPng}=require('../src/util/mkicon');

test('each supported platform declares its own capabilities',()=>{
 const win=capabilities('win32'),mac=capabilities('darwin'),linux=capabilities('linux');
 assert.equal(win.independentGuardian,true,'Windows 有独立守护(计划任务)');
 assert.equal(mac.independentGuardian,false,'macOS 无计划任务, 守护由 Node watcher 承担');
 assert.equal(linux.independentGuardian,false);
 // 三个平台都能挂起/恢复媒体进程
 for(const cap of [win,mac,linux])assert.equal(cap.suspendProcess,true);
 assert.equal(supportsIndependentGuardian('win32'),true);
 assert.equal(supportsIndependentGuardian('darwin'),false);
});

test('unknown platforms fall back to a safe capability set instead of throwing',()=>{
 const cap=capabilities('freebsd');
 assert.equal(cap.independentGuardian,false);
 assert.equal(cap.suspendProcess,true);
 assert.ok(cap.label);
 assert.ok(autoStartNote('freebsd').length>0);
});

test('auto-start hints name the platform the user is on',()=>{
 assert.match(autoStartNote('win32'),/Windows/);
 assert.match(autoStartNote('darwin'),/macOS/);
 assert.match(autoStartNote('linux'),/系统/);
});

test('launcher path matches the platform convention',()=>{
 assert.ok(launcherPath('/r','win32').endsWith('.bat'));
 assert.ok(launcherPath('/r','darwin').endsWith('.command'));
 assert.ok(launcherPath('/r','linux').endsWith('.sh'));
});

test('ps output is parsed into pid, ppid, executable and full command line',()=>{
 const rows=parsePsOutput([
  '  101   1 /opt/app /opt/app --flag',
  '  202   101 /opt/ffmpeg /opt/ffmpeg -i http://x/live.flv -c copy /tmp/a_part1.flv',
  '',
  'not a process line',
 ].join('\n'));
 assert.equal(rows.length,2);
 assert.deepEqual(rows[1],{pid:202,ppid:101,exe:'/opt/ffmpeg',command:'/opt/ffmpeg -i http://x/live.flv -c copy /tmp/a_part1.flv'});
});

test('ps is invoked without column truncation so long command lines survive',()=>{
 for(const platform of ['darwin','linux']){
  const args=psArgs(platform);
  assert.ok(args.includes('-ww'),platform+' 必须关闭列宽截断');
  assert.ok(args.some(a=>a.includes('pid=,ppid=,comm=,args=')));
 }
});

test('only the application ffmpeg is accepted, never an unrelated binary',()=>{
 const mine=path.join(os.tmpdir(),'app','ffmpeg');
 assert.equal(isSameExecutable(mine,mine,'darwin',mine+' -i x'),true,'同一绝对路径');
 assert.equal(isSameExecutable('/usr/bin/ffmpeg',mine,'darwin','/usr/bin/ffmpeg -i x'),false,'系统 ffmpeg 路径不同, 必须拒绝');
 assert.equal(isSameExecutable('ffmpeg',mine,'darwin','ffmpeg -i x'),true,'裸名且命令行一致时接受');
 assert.equal(isSameExecutable('python3',mine,'darwin','python3 x'),false,'不同程序');
 assert.equal(isSameExecutable('/usr/bin/ffmpeg',mine,'darwin'),false,'缺少命令行时不得仅凭 basename 放行');
 // Windows 路径大小写不敏感
 assert.equal(isSameExecutable('C:\\A\\FFMPEG.EXE','c:\\a\\ffmpeg.exe','win32'),true);
 assert.equal(isSameExecutable('C:\\b\\ffmpeg.exe','c:\\a\\ffmpeg.exe','win32'),false);
});

test('ffmpeg executable name follows the platform',()=>{
 assert.equal(ffmpegName('win32'),'ffmpeg.exe');
 assert.equal(ffmpegName('darwin'),'ffmpeg');
 assert.equal(ffmpegName('linux'),'ffmpeg');
});

test('tray icon is rendered at the density each platform expects',()=>{
 const readSize=buf=>({w:buf.readUInt32BE(16),h:buf.readUInt32BE(20)});
 const mac=readSize(makeTrayIconPng('darwin'));
 assert.deepEqual(mac,{w:32,h:32},'macOS 菜单栏需要 2x 位图, 否则 Retina 下发虚');
 const win=readSize(makeTrayIconPng('win32'));
 assert.deepEqual(win,{w:16,h:16});
 // 仍是合法 PNG
 for(const buf of [makeTrayIconPng('darwin'),makeTrayIconPng('win32')])
  assert.equal(buf.subarray(1,4).toString('ascii'),'PNG');
});

test('orphan writer skips the check instead of blocking recovery when the query tool is unavailable',async()=>{
 const {stopOrphanWriter}=require('../src/core/orphan-process');
 const warnings=[];
 // 模拟受限环境: ps/powershell 无法执行
 await stopOrphanWriter(
  {base:path.join(os.tmpdir(),'x'),ownerPid:12345,recorder:{}},
  {platform:'darwin',query:async()=>{throw Object.assign(Error('spawn EPERM'),{code:'EPERM'});},
   log:{warn:(...a)=>warnings.push(a.join(' '))}}
 );
 assert.equal(warnings.length,1,'必须留下可追溯记录');
 assert.match(warnings[0],/无法查询残留进程/);
});

test('orphan writer never touches another process when owner already matches',async()=>{
 const {stopOrphanWriter}=require('../src/core/orphan-process');
 let queried=false,killed=false;
 const realKill=process.kill;
 process.kill=()=>{killed=true;return true;};
 try{
  await stopOrphanWriter({base:path.join(os.tmpdir(),'y'),ownerPid:process.pid,recorder:{}},
   {platform:'darwin',query:async()=>{queried=true;return [];}});
 } finally { process.kill=realKill; }
 assert.equal(queried,false,'同进程无需查询');
 assert.equal(killed,false);
});
// ---- 可选依赖缺失的降级 ----
// ntsuspend 是 optionalDependencies，从 GitHub Release 下预编译二进制，
// 国内网络下经常装不上。npm 不会因此中断安装，所以运行时必须能优雅处理
// 缺失，而不是抛未捕获的 MODULE_NOT_FOUND 把后处理队列带崩。

test('ntsuspend 缺失时暂停功能给出可读错误，而不是 MODULE_NOT_FOUND', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'process-control.js'), 'utf8');

  // 必须是惰性加载：裸 require 会在模块加载阶段就抛错，
  // 让「暂停」这一个功能拖垮整个 process-control 模块
  assert.ok(/function loadNtsuspend/.test(src), '应惰性加载 ntsuspend');
  assert.ok(!/\bconst\s+native\s*=\s*require\(['"]ntsuspend['"]\)/.test(src),
    '不应在函数体内裸 require ntsuspend');
  assert.ok(/缺少 ntsuspend/.test(src), '缺失时应给出明确中文提示');
  assert.ok(/不影响录制/.test(src), '提示应说明不影响录制，避免用户误以为整个程序坏了');
});

test('即使 ntsuspend 不可用，模块本身仍能正常加载', () => {
  const Module = require('node:module');
  const orig = Module.prototype.require;
  const fs = require('node:fs');
  const p = path.join(__dirname, '..', 'src', 'core', 'process-control.js');

  Module.prototype.require = function (id) {
    if (id === 'ntsuspend') {
      const e = new Error("Cannot find module 'ntsuspend'");
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(p)];
    // 加载不应抛错
    const mod = require(p);
    assert.equal(typeof mod.control, 'function');
    assert.equal(typeof mod.lowerPriority, 'function');
  } finally {
    Module.prototype.require = orig;
    delete require.cache[require.resolve(p)];
  }
});

// ---- 磁盘空间查询的 null 语义 ----
// 背景：早先 freeBytes 失败时返回 0。上层判断是 `free < minFreeGB`，
// 0 会被当成"磁盘已满"，直接拒绝开始录制，而且错误文案写的是
// "等待磁盘空间" —— 用户完全猜不到其实是查询失败。
// 现在改为返回 null，语义是"查不到，跳过检查"。

test('freeBytes 查不到时返回 null 而不是 0', () => {
  const { freeBytes } = require('../src/util/disk-free');
  assert.equal(freeBytes('/nonexistent/definitely/not/here'), null,
    '不能返回 0：0 会被上层当成磁盘已满');
});

test('freeBytes 在正常目录上返回正数', () => {
  const { freeBytes } = require('../src/util/disk-free');
  const n = freeBytes(process.cwd());
  assert.ok(typeof n === 'number' && n > 0, `应返回正数字节数，实际 ${n}`);
});

test('assertSpace 在空间未知时放行，不误判为磁盘满', () => {
  const { assertSpace } = require('../src/core/disk-space');
  // 传一个必然失败的 available()，模拟"查不到"
  assert.doesNotThrow(
    () => assertSpace('/anywhere', 999 * 1024 ** 3, 0, '测试', () => null),
    '空间未知时不应抛错，否则录制无法开始',
  );
});

test('assertSpace 在确实空间不足时仍然抛错', () => {
  const { assertSpace, DiskSpaceError } = require('../src/core/disk-space');
  assert.throws(
    () => assertSpace('/anywhere', 100 * 1024 ** 3, 0, '测试', () => 1024),
    (e) => e.code === 'LR_DISK_SPACE',
    '真的不足时必须拦住',
  );
});

test('scheduler.freeBytes 与 disk-free 语义一致（null 透传）', () => {
  const { Scheduler } = require('../src/core/scheduler');
  const { load } = require('../src/core/store');
  const s = new Scheduler(load());
  // 正常目录应有值
  assert.ok(typeof s.freeBytes(process.cwd()) === 'number');
  // 不存在的目录应是 null，而不是 0
  assert.equal(s.freeBytes('/nonexistent/xyz'), null);
});

// ---- 转写安装脚本的健壮性 ----
// 实测发现两个问题，都用测试锁住：
// 1) 装完只检查 pip 退出码，没有验证能否真的 import。pip 返回 0 但
//    模块导入失败（ABI 不匹配、源码编译静默失败）时，用户要到点
//    「转字幕」才发现。
// 2) --check 把 os.freemem() 标成"磁盘可用"，会让人误以为磁盘快满了。

test('安装脚本在装完依赖后验证能否真的 import', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-transcribe.cjs'), 'utf8');
  assert.ok(/import sherpa_onnx, numpy/.test(src), '应实际执行一次 import 验证');
  assert.ok(/无法导入/.test(src), '导入失败时应有明确报错');
});

test('--check 区分内存与磁盘，不把内存标成磁盘', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-transcribe.cjs'), 'utf8');
  assert.ok(!/磁盘可用: \$\{Math\.round\(os\.freemem/.test(src),
    '不应再用 freemem 冒充磁盘空间');
  assert.ok(/内存: 空闲/.test(src), '应单独显示内存');
  assert.ok(/磁盘\(/.test(src), '应单独显示磁盘');
});

test('安装失败提示包含 Python 版本建议与镜像地址', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-transcribe.cjs'), 'utf8');
  // 失败信息必须可操作：要么换镜像，要么换 Python 版本
  assert.ok(/LR_PIP_INDEX/.test(src), '应提示镜像用法');
  assert.ok(/3\.10~3\.13|Python 3\.1/.test(src), '应提示可用的 Python 版本区间');
});
