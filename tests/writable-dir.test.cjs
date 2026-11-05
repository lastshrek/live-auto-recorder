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
