// 平台能力差异收敛点。
// 目标: 上层只问"能不能/怎么做", 不直接判断 process.platform,
// 这样新增平台时只需改这一个文件。
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

// 各平台支持的宿主能力。缺失的能力上层会优雅降级并提示, 而不是报错或静默失效。
const CAPABILITIES=Object.freeze({
  win32:{
    label:'Windows',
    // 计划任务 + 独立守护脚本(.ps1): 父进程被杀后能自动拉起
    independentGuardian:true,
    guardianScript:'independent-guardian.ps1',
    startScript:'independent-start.ps1',
    taskRunner:'schtasks.exe',
    // ntsuspend 原生模块: 真正挂起/恢复进程
    suspendProcess:true,
    launcherExtension:'.bat',
  },
  darwin:{
    label:'macOS',
    // 无计划任务/无 ntsuspend; 守护改由 app-watchdog.cjs(纯 Node)承担,
    // 进程挂起用 POSIX 信号 SIGSTOP/SIGCONT
    independentGuardian:false,
    suspendProcess:true,
    launcherExtension:'.command',
  },
  linux:{
    label:'Linux',
    independentGuardian:false,
    suspendProcess:true,
    launcherExtension:'.sh',
  },
});

function capabilities(platform=process.platform){
  return CAPABILITIES[platform]||{
    label:platform,
    independentGuardian:false,
    suspendProcess:true,
    launcherExtension:'.sh',
  };
}

// 应用内"开机自启"在三个平台都由 Electron app.setLoginItemSettings 承担,
// 这里只补充说明文字, 避免界面上出现平台无关的承诺。
function autoStartNote(platform=process.platform){
  if(platform==='win32')return '登录 Windows 后自动启动';
  if(platform==='darwin')return '登录 macOS 后自动启动（登录项）';
  return '登录系统后自动启动';
}

// 运行独立的守护进程(跨平台): Windows 走计划任务, 其他平台直接起 Node 子进程。
// 返回 {ok, reason}; 不抛异常, 由调用方决定是否提示用户。
function supportsIndependentGuardian(platform=process.platform){
  return !!capabilities(platform).independentGuardian;
}

// 该平台的启动器文件是否已随仓库提供
function launcherPath(root,platform=process.platform){
  const cap=capabilities(platform);
  const names={win32:'启动直播录制.bat',darwin:'启动直播录制.command',linux:'启动直播录制.sh'};
  const name=names[platform];
  return name?path.join(root,name):null;
}

module.exports={CAPABILITIES,capabilities,autoStartNote,supportsIndependentGuardian,launcherPath};