// 跨平台进程查询: Windows 用 PowerShell/CIM, macOS 与 Linux 用 ps。
// 只返回数据, 不做任何结束动作; 是否安全结束由调用方(orphan-process)判断。
const {execFile}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');

// 各平台默认的可执行文件名
const FFMPEG_NAMES=Object.freeze({win32:'ffmpeg.exe',darwin:'ffmpeg',linux:'ffmpeg'});

function ffmpegName(platform=process.platform){return FFMPEG_NAMES[platform]||'ffmpeg';}

// Windows: Get-CimInstance 提供 ExecutablePath 与 CommandLine, 可精确比对
function queryWindows({exec=execFile}={}){
  const script="Get-CimInstance Win32_Process -Filter \"name='ffmpeg.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve,reject)=>{
    exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024},(error,out)=>{
      if(error)return reject(error);
      try{
        const parsed=String(out||'').trim()?JSON.parse(out):[];
        const rows=Array.isArray(parsed)?parsed:[parsed];
        resolve(rows.map(row=>({
          pid:row.ProcessId,
          ppid:row.ParentProcessId,
          exe:row.ExecutablePath||'',
          command:row.CommandLine||'',
        })));
      }catch(e){reject(new Error('进程查询结果无法解析: '+e.message));}
    });
  });
}

// macOS / Linux: ps 输出 pid, ppid, 可执行路径, 完整命令行
// -ww 关闭列宽截断(macOS 上默认会按终端宽度截断, 导致命令行丢失)
function psArgs(platform){
  // macOS 的 ps 支持 -axo 与 -ww; Linux 用 -eo 更通用, 但 -axo 同样可用
  return platform==='darwin'?['-axo','pid=,ppid=,comm=,args=','-ww']:['-eo','pid=,ppid=,comm=,args=','-ww'];
}

function parsePsOutput(text){
  const rows=[];
  for(const line of String(text||'').split('\n')){
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if(!match)continue;
    rows.push({pid:+match[1],ppid:+match[2],exe:match[3],command:match[4]||''});
  }
  return rows;
}

function queryPosix({platform=process.platform,exec=execFile}={}){
  return new Promise((resolve,reject)=>{
    exec('ps',psArgs(platform),{timeout:15000,maxBuffer:4*1024*1024},(error,out)=>{
      if(error)return reject(error);
      resolve(parsePsOutput(out));
    });
  });
}

// 统一入口: 返回 [{pid, ppid, exe, command}]
function queryFfmpegProcesses({platform=process.platform,exec}={}){
  return platform==='win32'?queryWindows({exec}):queryPosix({platform,exec});
}

// 判断该进程是否就是本应用使用的 ffmpeg。
// 安全性优先: 宁可漏判(暂缓恢复)也不误判(错杀他人进程)。
// - Windows: ExecutablePath 完整, 大小写不敏感比较。
// - macOS/Linux: ps 的 comm 通常是绝对路径; 若是绝对路径则必须完全一致。
//   仅当 comm 只是裸文件名时才回退比较 basename, 并要求 args 首个 token
//   也指向同名程序 —— 系统 /usr/bin/ffmpeg 与本应用 ffmpeg 路径不同会被排除。
function isSameExecutable(exe,expected,platform=process.platform,command=''){
  if(!exe||!expected)return false;
  if(platform==='win32'){
    return path.resolve(exe).toLowerCase()===path.resolve(expected).toLowerCase();
  }
  const expectedResolved=path.resolve(expected);
  if(path.isAbsolute(exe)){
    const actual=path.resolve(exe);
    if(actual===expectedResolved)return true;
    // macOS 上通过符号链接/别名启动时, 允许 realpath 后一致
    try{if(fs.realpathSync(actual)===fs.realpathSync(expectedResolved))return true;}catch{}
    return false;
  }
  // 裸文件名: 必须与期望的文件名一致, 且命令行首 token 也指向同名程序
  if(path.basename(exe)!==path.basename(expectedResolved))return false;
  const firstToken=String(command||'').trim().match(/^(?:"([^"]+)"|(\S+))/);
  const invoked=firstToken?(firstToken[1]||firstToken[2]):'';
  return !invoked||path.basename(invoked)===path.basename(expectedResolved);
}

module.exports={ffmpegName,queryFfmpegProcesses,parsePsOutput,psArgs,isSameExecutable,queryWindows,queryPosix};