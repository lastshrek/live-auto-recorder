const os=require('node:os');
const {capabilities}=require('../util/platform');

// ntsuspend 是 optionalDependencies 里的原生模块，从 GitHub Release 下载
// 预编译二进制。国内网络下这个下载经常失败，npm 会静默跳过（构建仍成功）。
// 因此不能直接 require —— 那样会在调用暂停时抛未捕获的 MODULE_NOT_FOUND，
// 整个后处理队列跟着挂掉。改为惰性加载 + 明确报错，让调用方只失去
// 「暂停任务」这一个能力。
let ntsuspendLoaded = false;
let ntsuspend = null;
function loadNtsuspend() {
  if (ntsuspendLoaded) return ntsuspend;
  ntsuspendLoaded = true;
  try {
    ntsuspend = require('ntsuspend');
  } catch {
    ntsuspend = null;
  }
  return ntsuspend;
}

function control(child,action){
  if(!child||!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode)return false;
  if(process.platform==='win32'){
    // Windows 无 POSIX 信号, 依赖 ntsuspend 原生模块
    const native = loadNtsuspend();
    if (!native) {
      throw Error('当前环境缺少 ntsuspend 模块，无法暂停/恢复后处理任务（不影响录制；重装依赖可恢复该功能）');
    }
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
