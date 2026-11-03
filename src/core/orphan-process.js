const path=require('node:path');
const {ffmpegPath}=require('./recorder');
const {queryFfmpegProcesses,isSameExecutable}=require('./process-query');
function busy(message){const e=new Error(message);e.code='LR_SOURCE_BUSY';return e;}
// 只处理本应用旧进程留在已知任务输出上的 FFmpeg；不按进程名批量结束。
// Windows 与 macOS 走同一套判定: 先核对可执行文件是本应用的 ffmpeg,
// 再核对命令行涉及本场录像的分片, 最后核对父进程归属。
async function stopOrphanWriter(job,{platform=process.platform,exec,query,log}={}){
  if(job.ownerPid===process.pid)return;
  let rows;
  try{
    rows=await (query?query({platform}):queryFfmpegProcesses({platform,exec}));
  }catch(e){
    if(e.code==='LR_SOURCE_BUSY')throw e;
    // 进程查询工具不可用(受限环境, 或 ps 被策略禁用)。
    // 历史上非 Windows 平台完全不做这项检查, 恢复照常进行;
    // 因此这里降级为"跳过检查并留下记录", 而不是把任务永久卡住。
    // 风险与旧行为一致: 若确有残留写入者, 其输出文件的可写校验会在
    // 后续 assertSpace/publish 阶段暴露, 不会静默产生损坏成品。
    const warn=(log&&log.warn)||console.warn;
    warn('[orphan] 无法查询残留进程，跳过本次核对:',e.message);
    return;
  }
  if(!Array.isArray(rows))throw busy('旧录像进程查询结果无效，暂缓恢复');
  const normalize=p=>path.resolve(p).toLowerCase();
  const base=normalize(job.base);
  for(const row of rows){
    if(row.pid===job.recorder?.processId&&(!row.exe||!row.command))throw busy('无法核验旧录像进程的身份，暂缓恢复');
    if(!row.exe||!isSameExecutable(row.exe,ffmpegPath,platform,row.command))continue;
    const last=String(row.command||'').match(/(?:"([^"\r\n]+)"|([^\s"]+))\s*$/);if(!last)continue;
    const output=last[1]||last[2];
    const isCapture=normalize(output).startsWith(base+'_part')&&/^_part\d+\.flv$/i.test(normalize(output).slice(base.length));
    const args=[...String(row.command||'').matchAll(/"([^"\r\n]*)"|([^\s"]+)/g)].map(m=>m[1]??m[2]);
    const knownInput=args.some(arg=>{try{const p=normalize(arg);return p.startsWith(base+'_part')&&/^_part\d+\.(flv|mp4)(?:\.pending\.mp4)?$/i.test(p.slice(base.length));}catch{return false;}});
    const isMedia=row.pid===job.recorder?.processingProcessId&&row.ppid===job.ownerPid&&knownInput;
    if(!isCapture&&!isMedia)continue;
    if(!job.ownerPid||(row.ppid!==job.ownerPid&&row.pid!==job.recorder?.processId)){
      throw busy('源文件仍由其他进程写入，等待该进程结束后恢复');
    }
    try{process.kill(row.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw new Error('旧录像进程尚未结束，暂缓处理源文件');}
    for(let i=0;i<50;i++){
      try{process.kill(row.pid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}
      if(i===49)throw new Error('旧录像进程仍在退出，暂缓处理源文件');
      await new Promise(r=>setTimeout(r,100));
    }
  }
}
module.exports={stopOrphanWriter};