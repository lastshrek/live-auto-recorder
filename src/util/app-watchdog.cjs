const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
function restartAllowed(state,history,now=Date.now()){return !state?.expectedExit&&history.filter(at=>now-at<15*60000).length<3;}
function run(file,parent,executable,root,entry){
  const timer=setInterval(()=>{
    try{process.kill(parent,0);return;}catch(error){if(error.code!=='ESRCH')return;}
    clearInterval(timer);let state={},history=[];const historyFile=path.join(path.dirname(file),'restart-history.json');
    try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    try{history=JSON.parse(fs.readFileSync(historyFile,'utf8'));if(!Array.isArray(history))history=[];}catch{}
    const now=Date.now();history=history.filter(at=>now-at<15*60000);
    if(!restartAllowed(state,history,now))return;
    history.push(now);fs.writeFileSync(historyFile,JSON.stringify(history));
    fs.appendFileSync(path.join(path.dirname(file),'watchdog.log'),new Date().toISOString()+' abnormal exit pid='+parent+'; restarting\n');
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.LR_STDIO_CHILD;
    // entry 为空表示打包版: exe 自带应用路径, 不能再把数据目录当入口传进去。
    const args=entry?[entry]:[];
    const cwd=path.extname(root)?path.dirname(root):root;
    const child=spawn(executable,args,{cwd,env,detached:true,windowsHide:false,stdio:'ignore'});
    child.on('error',error=>fs.appendFileSync(path.join(path.dirname(file),'watchdog.log'),error.message+'\n'));child.unref();
  },2000);
}
if(require.main===module)run(process.argv[2],Number(process.argv[3]),process.argv[4],process.argv[5],process.argv[6]===undefined?process.argv[5]:process.argv[6]);
module.exports={restartAllowed,run};
