const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {assertWritableDir}=require('../src/util/writable-dir');

// 背景: 用户在设置里改「保存路径」时, fs.mkdirSync 成功不代表能写文件。
// 只读盘、权限不足、网盘掉线、路径被安全软件锁住, mkdir 都可能通过,
// 却等到真正开录才失败 —— 那时直播已经开始了, 白丢一场。
// 所以改设置时就落探针文件实测。

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'lr-wd-'));}

test('accepts an existing writable directory',()=>{
 const d=tmp();
 try{ assert.equal(assertWritableDir(d),true); }
 finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('creates nested directories that do not exist yet',()=>{
 const d=tmp();
 const deep=path.join(d,'a','b','c');
 try{
  assert.equal(assertWritableDir(deep),true);
  assert.ok(fs.existsSync(deep));
 } finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('rejects an empty path with an actionable message',()=>{
 assert.throws(()=>assertWritableDir(''),/不能为空/);
 assert.throws(()=>assertWritableDir('   '),/不能为空/);
});

test('rejects relative paths instead of guessing a location',()=>{
 // 相对路径的解析基准是程序安装目录, 由调用方负责拼成绝对路径。
 // 这里若默默接受, 同一份配置在 CLI 与 GUI 下可能指向不同位置。
 assert.throws(()=>assertWritableDir('recordings'),/绝对路径/);
});

test('rejects a path that exists but is a file',()=>{
 const d=tmp();
 const f=path.join(d,'notadir.txt');
 fs.writeFileSync(f,'x');
 try{
  assert.throws(()=>assertWritableDir(f),/不是目录/);
 } finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('leaves no probe file behind on success',()=>{
 const d=tmp();
 try{
  assertWritableDir(d);
  const left=fs.readdirSync(d).filter(n=>n.startsWith('.lr-write-test'));
  assert.deepEqual(left,[],'探针文件必须清理干净, 否则会污染录像目录');
 } finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('detects a read-only directory',()=>{
 if(process.platform==='win32')return; // Windows 的权限模型不同, 该断言仅适用于 POSIX
 const d=tmp();
 const ro=path.join(d,'ro');
 fs.mkdirSync(ro);
 fs.chmodSync(ro,0o500);
 try{
  assert.throws(()=>assertWritableDir(ro),/没有写入权限|只读/);
 } finally{
  try{fs.chmodSync(ro,0o700);}catch{}
  fs.rmSync(d,{recursive:true,force:true});
 }
});

// ---- 录制期间禁止改保存位置 ----
// 正在写的文件路径在开录那一刻就定了（rec.base 是绝对路径），改配置不会让它
// 跟着走：配置写着新目录、文件却落在旧目录，用户按新路径找不到东西。
// 所以在 updateSettings 里直接拒绝，而不是做"下一场生效"的半吊子切换。
// 注意 stopping 也算在写——那时 ffmpeg 还在收尾、把缓冲区写盘。

const {Scheduler}=require('../src/core/scheduler');
const {load}=require('../src/core/store');

function withScheduler(fn){
 const s=new Scheduler(load());
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'lrlk-'));
 try{ return fn(s,d); }
 finally{
  s.tasks.clear();
  try{ s.updateSettings({outputDir:'recordings'}); }catch{}
  fs.rmSync(d,{recursive:true,force:true});
 }
}
function fake(state,name){return {rid:'123456',state,lastInfo:{nickname:name},item:{nickname:name},rec:null};}

test('changing the output dir is allowed when nothing is recording',()=>{
 withScheduler((s,d)=>{
  s.updateSettings({outputDir:d});
  assert.equal(s.outDir,d);
 });
});

test('changing the output dir is refused while recording',()=>{
 withScheduler((s,d)=>{
  s.tasks.set('a',fake('recording','主播甲'));
  assert.throws(()=>s.updateSettings({outputDir:d}),(e)=>e.code==='LR_RECORDING_ACTIVE');
  assert.notEqual(s.outDir,d,'拒绝后目录不得变更');
 });
});

test('a task that is still stopping also blocks the change',()=>{
 // stopping 阶段 ffmpeg 还在写盘, 必须算作"正在写"
 withScheduler((s,d)=>{
  s.tasks.set('b',fake('stopping','主播乙'));
  assert.throws(()=>s.updateSettings({outputDir:d}),(e)=>e.code==='LR_RECORDING_ACTIVE');
 });
});

test('saving other settings during recording is not blocked',()=>{
 // 界面保存时总会带上 outputDir（哪怕没改）。若不做"仅路径变化才检查"的判断,
 // 录制期间连改轮询间隔都会被拒 —— 这是误伤。
 withScheduler((s,d)=>{
  s.tasks.set('a',fake('recording','主播甲'));
  assert.doesNotThrow(()=>s.updateSettings({pollIntervalSec:5,outputDir:'recordings'}));
  assert.equal(s.cfg.settings.pollIntervalSec,5);
 });
});

test('the refusal message says which streams are writing',()=>{
 withScheduler((s,d)=>{
  s.tasks.set('a',fake('recording','主播甲'));
  s.tasks.set('b',fake('recording','主播乙'));
  try{ s.updateSettings({outputDir:d}); assert.fail('应当抛错'); }
  catch(e){
   assert.match(e.message,/正在录制/);
   assert.match(e.message,/主播甲/);
   assert.match(e.message,/主播乙/);
   assert.match(e.message,/停止录制后|等录制结束后|录制结束后/);
  }
 });
});
