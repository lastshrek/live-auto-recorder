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