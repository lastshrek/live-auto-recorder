const { freeBytes: queryFreeBytes } = require('../util/disk-free');
class DiskSpaceError extends Error{
  constructor(message){super(message);this.code='LR_DISK_SPACE';}
}
// 查不到时返回 null（由 assertSpace 跳过检查），不要返回 0 ——
// 0 会被上层当成"磁盘已满"直接拒绝录制，且报错文案误导用户。
function freeBytes(dir){return queryFreeBytes(dir);}
function assertSpace(dir,reserve,extra=0,phase='处理',available){
  const free = available ? available() : freeBytes(dir);
  const needed=Math.max(16*1024**2,Number(reserve)||0)+Math.max(0,Number(extra)||0);
  // 无法确定剩余空间时放行：宁可让录制可能写满，也不要因为查不到就拒绝录制。
  // 真有磁盘问题，ffmpeg 写入时会自己报错，那时错误信息更准确。
  if(free===null||free===undefined)return;
  if(free<needed)throw new DiskSpaceError(`${phase}等待磁盘空间：可用${(free/1024**3).toFixed(2)}GB，需要约${(needed/1024**3).toFixed(2)}GB；源文件已保留`);
}
module.exports={DiskSpaceError,assertSpace,freeBytes};
