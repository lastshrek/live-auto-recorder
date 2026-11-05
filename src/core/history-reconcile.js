// 历史记录与磁盘的一致性维护。
// 设计取舍:
//   - 录像被删除/过期清理后, 历史条目本身保留 —— 它记录的是"这场直播发生过",
//     属于日志性质, 不应因为文件没了就抹掉。
//   - 但条目里的文件引用必须收敛到"磁盘上真实存在"的集合, 否则界面会显示
//     "2 个"却一个都打不开, 属于误导。
//   - 全部文件都不在了, 就打上 missing 标记, 界面据此显示"文件已删除"。
const fs=require('node:fs');
const path=require('node:path');

// 历史里的路径是相对 outDir 的 Posix 风格字符串
function resolveHistoryFile(outDir,file){
  if(typeof file!=='string'||!file)return null;
  const target=path.isAbsolute(file)?file:path.join(outDir,file);
  try{
    // 只认普通文件: 目录/符号链接都不算可用录像
    if(!fs.statSync(target).isFile())return null;
    return target;
  }catch{return null;}
}

// 条目所属的录像目录。老条目没有 outRoot 字段, 退回调用方传入的当前目录。
//
// 为什么要存这个字段: files 是相对路径, 只有配上当时的根目录才定位得到。
// 用户改了保存路径后, 若仍拿"当前目录"去核对旧条目, 会判定全部文件消失,
// 打上 missing 并写回磁盘 —— 引用被永久抹掉, 即使文件还在旧目录里,
// 改回原路径也找不回来。实测复现过这个数据丢失。
//
// 老条目(本字段引入前写入的)没有归属, 由调用方保证"改目录前先把旧目录补写进去"
// (见 scheduler.updateSettings), 所以这里回退到当前目录即可 —— 这与改动前的
// 行为一致, 不会让"文件真被删了"这种情况漏标。
function entryRoot(entry,fallback){
  const r=entry&&typeof entry.outRoot==='string'?entry.outRoot.trim():'';
  return r||fallback||'';
}

// 返回 {changed, kept, dropped, missing}
//   kept    仍在磁盘上的文件引用(保持原有相对路径写法)
//   dropped 已消失的引用
//   missing 是否整场都没文件了
function reconcileEntry(outDir,entry){
  const files=Array.isArray(entry?.files)?entry.files.filter(f=>typeof f==='string'&&f):[];
  if(!files.length)return {changed:false,kept:[],dropped:[],missing:!!entry?.missing};
  const root=entryRoot(entry,outDir);
  // 归属目录不存在时(如外接盘未插)不能判死: 直接放行, 保留原引用。
  // 否则插拔一次硬盘就把整份历史抹成"已删除"。
  if(!root||!fs.existsSync(root))return {changed:false,kept:files,dropped:[],missing:!!entry?.missing};
  const kept=[],dropped=[];
  for(const file of files){
    if(resolveHistoryFile(root,file))kept.push(file);else dropped.push(file);
  }
  const missing=kept.length===0;
  const changed=kept.length!==files.length||!!entry.missing!==missing;
  return {changed,kept,dropped,missing};
}

// 就地收敛整份历史; 返回 {history, changed, removedFiles, vanishedEntries}
// 不删除任何条目, 只更新 files 与 missing 标记。
// currentDir 仅作为老条目(无 outRoot)的兜底根目录。
function reconcileHistory(currentDir,history){
  if(!Array.isArray(history))return {history:[],changed:false,removedFiles:0,vanishedEntries:0};
  let changed=false,removedFiles=0,vanishedEntries=0;
  const next=history.map(entry=>{
    if(!entry||typeof entry!=='object')return entry;
    const r=reconcileEntry(currentDir,entry);
    if(!r.changed)return entry;
    changed=true;
    removedFiles+=r.dropped.length;
    if(r.missing&&!entry.missing)vanishedEntries+=1;
    const copy={...entry,files:r.kept};
    if(r.missing)copy.missing=true;else delete copy.missing;
    return copy;
  });
  return {history:next,changed,removedFiles,vanishedEntries};
}

// 给还没有归属的老条目补上 outRoot（改保存路径前必须调用）。
// 返回补写了几条; 有变化时由调用方负责落盘。
function stampRoot(history,root){
  if(!Array.isArray(history)||!root)return 0;
  let n=0;
  for(const e of history){
    if(!e||typeof e!=='object')continue;
    if(typeof e.outRoot==='string'&&e.outRoot.trim())continue;
    e.outRoot=root;
    n+=1;
  }
  return n;
}

module.exports={resolveHistoryFile,reconcileEntry,reconcileHistory,entryRoot,stampRoot};