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

// 返回 {changed, kept, dropped, missing}
//   kept    仍在磁盘上的文件引用(保持原有相对路径写法)
//   dropped 已消失的引用
//   missing 是否整场都没文件了
function reconcileEntry(outDir,entry){
  const files=Array.isArray(entry?.files)?entry.files.filter(f=>typeof f==='string'&&f):[];
  if(!files.length)return {changed:false,kept:[],dropped:[],missing:!!entry?.missing};
  const kept=[],dropped=[];
  for(const file of files){
    if(resolveHistoryFile(outDir,file))kept.push(file);else dropped.push(file);
  }
  const missing=kept.length===0;
  const changed=kept.length!==files.length||!!entry.missing!==missing;
  return {changed,kept,dropped,missing};
}

// 就地收敛整份历史; 返回 {history, changed, removedFiles, vanishedEntries}
// 不删除任何条目, 只更新 files 与 missing 标记。
function reconcileHistory(outDir,history){
  if(!Array.isArray(history))return {history:[],changed:false,removedFiles:0,vanishedEntries:0};
  let changed=false,removedFiles=0,vanishedEntries=0;
  const next=history.map(entry=>{
    if(!entry||typeof entry!=='object')return entry;
    const r=reconcileEntry(outDir,entry);
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

module.exports={resolveHistoryFile,reconcileEntry,reconcileHistory};