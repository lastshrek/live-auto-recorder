const os=require('node:os');
const {capabilities}=require('../util/platform');
function control(child,action){
  if(!child||!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode)return false;
  if(process.platform==='win32'){
    // Windows 无 POSIX 信号, 依赖 ntsuspend 原生模块
    const native=require('ntsuspend');
    if(native[action](child.pid)!==true)throw Error(action==='suspend'?'无法暂停媒体进程':'无法恢复媒体进程');
  }else if(capabilities().suspendProcess){
    // macOS / Linux: SIGSTOP 挂起, SIGCONT 恢复, 均针对单进程
    if(!child.kill(action==='suspend'?'SIGSTOP':'SIGCONT'))throw Error('无法控制媒体进程');
  }else{
    throw Error('当前系统不支持暂停/恢复媒体进程');
  }
  return true;
}
// 降低进程优先级: 后处理不应抢占正在拉流录制的资源。
// 子进程由本进程创建, 各平台都允许对自己的子进程调整优先级。
function lowerPriority(child){try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}}
module.exports={control,lowerPriority};
