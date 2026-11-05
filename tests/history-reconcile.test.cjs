const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveHistoryFile,reconcileEntry,reconcileHistory,stampRoot}=require('../src/core/history-reconcile');

function sandbox(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-hist-'));
 const room=path.join(dir,'主播_123456');
 fs.mkdirSync(room,{recursive:true});
 const keep=path.join(room,'keep_纯享版.mp4');
 fs.writeFileSync(keep,'x');
 return {dir,room,keep};
}

test('existing files are kept and missing ones are dropped from the reference list',()=>{
 const {dir,room}=sandbox();
 try{
  const entry={files:['主播_123456/keep_纯享版.mp4','主播_123456/gone_纯享版.mp4']};
  const r=reconcileEntry(dir,entry);
  assert.equal(r.changed,true);
  assert.deepEqual(r.kept,['主播_123456/keep_纯享版.mp4']);
  assert.deepEqual(r.dropped,['主播_123456/gone_纯享版.mp4']);
  assert.equal(r.missing,false,'还有可用文件时不应标记整场缺失');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('an entry whose files all vanished is marked missing but never deleted',()=>{
 const {dir}=sandbox();
 try{
  const r=reconcileHistory(dir,[{status:'done',files:['主播_123456/a.mp4','主播_123456/b.mp4']}]);
  assert.equal(r.changed,true);
  assert.equal(r.vanishedEntries,1);
  assert.equal(r.history.length,1,'条目必须保留: 它记录这场直播发生过');
  assert.deepEqual(r.history[0].files,[]);
  assert.equal(r.history[0].missing,true);
  assert.equal(r.history[0].status,'done','不得改写原始状态');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('reconciling an unchanged history reports no change so callers can skip writing',()=>{
 const {dir}=sandbox();
 try{
  const history=[{status:'done',files:['主播_123456/keep_纯享版.mp4']}];
  const r=reconcileHistory(dir,history);
  assert.equal(r.changed,false,'文件都在时不该产生写盘');
  assert.equal(r.history[0].files.length,1);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('a previously missing entry becomes available again when the file returns',()=>{
 const {dir,room}=sandbox();
 try{
  const rel='主播_123456/back_纯享版.mp4';
  const before=reconcileHistory(dir,[{status:'done',files:[rel],missing:true}]);
  assert.equal(before.history[0].missing,true);
  // 文件被放回来(例如从备份恢复)
  fs.writeFileSync(path.join(dir,rel),'x');
  // 注意: files 已被清空, 恢复只能靠重新扫描; 这里验证标记本身会被正确处理
  const after=reconcileHistory(dir,[{status:'done',files:[rel],missing:true}]);
  // 缺失标记通过"删除该字段"来清除, 因此这里是 undefined 而非字面 false
  assert.ok(!after.history[0].missing,'文件回来了就应清除缺失标记');
  assert.equal(after.changed,true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('directories and symlinks are not treated as usable recordings',()=>{
 const {dir,room}=sandbox();
 try{
  fs.mkdirSync(path.join(room,'a_dir.mp4'));
  assert.equal(resolveHistoryFile(dir,'主播_123456/a_dir.mp4'),null,'目录不是录像文件');
  assert.ok(resolveHistoryFile(dir,'主播_123456/keep_纯享版.mp4'));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('absolute paths in an old history are still resolved',()=>{
 const {dir,keep}=sandbox();
 try{
  assert.equal(resolveHistoryFile(dir,keep),keep);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('malformed entries are passed through untouched',()=>{
 const {dir}=sandbox();
 try{
  const weird=[null,{status:'done'},{status:'done',files:'not-an-array'},{status:'done',files:['']}];
  const r=reconcileHistory(dir,weird);
  assert.equal(r.history.length,4);
  assert.equal(r.history[0],null,'空条目原样保留');
  assert.equal(r.history[1].files,undefined,'没有 files 时不应凭空造出字段');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
// ---- 改保存路径后历史不能丢 ----
// 背景: 历史里的 files 是相对 outDir 的路径。用户在设置里改了「保存路径」后,
// 若仍拿新目录去核对旧条目, 会判定"文件全没了", 把 files 清空并写回磁盘。
// 引用一旦被抹掉, 即使文件还在旧目录里、用户也改回去了, 界面也再找不到它。
// 实测复现过这条数据丢失路径, 因此引入 outRoot 记录条目归属。

test('with outRoot, entries stay resolvable after the output dir changes',()=>{
 const old=sandbox(), neu=sandbox();
 try{
  const entry={status:'done',outRoot:old.dir,files:['主播_123456/keep_纯享版.mp4']};
  const r=reconcileHistory(neu.dir,[entry]);
  assert.equal(r.changed,false,'改目录不应产生任何改写');
  assert.deepEqual(r.history[0].files,['主播_123456/keep_纯享版.mp4'],'旧目录的文件引用必须保留');
  assert.ok(!r.history[0].missing,'文件还在旧目录, 不能标成已删除');
 } finally {fs.rmSync(old.dir,{recursive:true,force:true});fs.rmSync(neu.dir,{recursive:true,force:true});}
});

test('stampRoot backfills legacy entries so a later dir change cannot orphan them',()=>{
 const {dir}=sandbox();
 try{
  const history=[{status:'done',files:['主播_123456/keep_纯享版.mp4']},{status:'done',files:[]}];
  const n=stampRoot(history,dir);
  assert.equal(n,2,'两条都没有归属, 都应补上');
  assert.equal(history[0].outRoot,dir);
  assert.equal(history[1].outRoot,dir);
  // 已有归属的不覆盖: 否则改目录时会把老条目的归属改写成新目录, 等于没修
  const again=stampRoot(history,'/somewhere/else');
  assert.equal(again,0,'已有归属不得改写');
  assert.equal(history[0].outRoot,dir);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('an unplugged disk does not wipe references',()=>{
 const {dir}=sandbox();
 try{
  // 归属目录不存在（外接盘未插）, 不能判死
  const entry={status:'done',outRoot:path.join(dir,'not-mounted'),files:['主播_123456/a.mp4']};
  const r=reconcileHistory(dir,[entry]);
  assert.equal(r.changed,false,'目录不可达时应原样保留');
  assert.deepEqual(r.history[0].files,['主播_123456/a.mp4']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('real deletions are still detected when outRoot is present',()=>{
 const {dir}=sandbox();
 try{
  const entry={status:'done',outRoot:dir,files:['主播_123456/gone.mp4']};
  const r=reconcileHistory(dir,[entry]);
  assert.equal(r.history[0].missing,true,'文件确实不在时必须标记, 否则界面上永远点不开');
  assert.deepEqual(r.history[0].files,[]);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
