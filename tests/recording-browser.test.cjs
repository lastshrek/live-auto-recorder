const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {recordingPath,listRecordings,openRecording}=require('../src/util/recording-browser');

function sandbox(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-browse-'));
 const room=path.join(dir,'主播_123456');
 fs.mkdirSync(room,{recursive:true});
 fs.writeFileSync(path.join(room,'a_纯享版.mp4'),'x');
 fs.writeFileSync(path.join(room,'b.danmaku.jsonl'),'{}');
 fs.writeFileSync(path.join(dir,'.DS_Store'),'junk');
 return {dir,room};
}

test('a deleted recording reports a readable reason, not a raw ENOENT with the full path',async()=>{
 const {dir}=sandbox();
 try{
  await assert.rejects(
   recordingPath(dir,'主播_123456/已删除_纯享版.mp4'),
   e=>{
    assert.doesNotMatch(e.message,/ENOENT|realpath|no such file or directory/,'不应把系统错误直接抛给用户');
    assert.doesNotMatch(e.message,new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'不应暴露完整绝对路径');
    assert.match(e.message,/已不存在/);
    return true;
   });
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('a missing output directory is distinguished from a missing recording',async()=>{
 const {dir}=sandbox();
 const gone=path.join(dir,'不在的目录');
 try{
  await assert.rejects(recordingPath(gone,'x.mp4'),e=>{
   assert.match(e.message,/录像目录不存在/);
   return true;
  });
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('path traversal is rejected as illegal access, not reported as missing',async()=>{
 const {dir}=sandbox();
 try{
  for(const bad of ['../../etc/passwd','/etc/passwd','..']){
   await assert.rejects(recordingPath(dir,bad),e=>{
    assert.match(e.message,/只能浏览录像目录内的文件/,'越界应给出权限语义: '+bad);
    assert.doesNotMatch(e.message,/已不存在/);
    return true;
   });
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('system files never appear in the recording browser',async()=>{
 const {dir}=sandbox();
 try{
  const root=await listRecordings(dir,'');
  assert.equal(root.entries.some(e=>e.name==='.DS_Store'),false,'.DS_Store 不应出现在列表里');
  const room=await listRecordings(dir,'主播_123456');
  const names=room.entries.map(e=>e.name);
  assert.ok(names.includes('a_纯享版.mp4'));
  assert.ok(names.includes('b.danmaku.jsonl'),'弹幕记录文件应可见');
  assert.equal(room.entries.find(e=>e.name==='a_纯享版.mp4').playable,true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('opening a vanished recording fails gracefully for the caller',async()=>{
 const {dir}=sandbox();
 const shell={openPath:async()=>''};
 try{
  await assert.rejects(openRecording(dir,'主播_123456/删掉了.mp4',shell),e=>{
   assert.match(e.message,/已不存在/);
   return true;
  });
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('jobs whose recording was deleted are recognised instead of retried forever',async()=>{
 const {RecoveryController}=require('../src/core/recovery');
 const rc=Object.create(RecoveryController.prototype);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-zombie-'));
 try{
  const base=path.join(dir,'主播_123456_20261103_100000');

  // 用户手动删掉整个录像目录: 记录里有过分片, 应判定为丢失
  const deleted={base,recorder:{part:1,partStarts:[0,1],lastProgressAt:1}};
  assert.equal(rc.sourceStillPresent(deleted),false,'目录被删后应识别为源文件已消失');

  // 同目录下仍有分片: 必须判为存在, 不能误杀
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(base+'_part1.flv','x');
  assert.equal(rc.sourceStillPresent(deleted),true);

  // 从未开始过的任务(part=0)即使目录不存在也不能结案
  fs.rmSync(base+'_part1.flv');
  const fresh={base:path.join(dir,'另一场_123456_20261103_110000'),recorder:{part:0,partStarts:[0]}};
  assert.equal(rc.sourceStillPresent(fresh),true,'未开始的任务不应被判为丢失');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
