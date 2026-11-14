const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {dataRoot}=require('./util/app-paths');

// Capture native/V8 stderr at process creation; JavaScript error handlers cannot
// intercept a fatal heap failure. The short-lived launcher exits after spawn.
// root 必须是真实可写目录(打包后 app.asar 是文件, 不能作 cwd/日志目录);
// appPath 只有开发期需要(electron.exe <appPath>), 打包后 exe 自带应用路径,
// 再传数据目录会被当成应用入口, 因此传 null。
function launchLogged(root,executable,argv=[],launch=spawn,appPath=root){
  const directory=path.join(root,'logs','startup');fs.mkdirSync(directory,{recursive:true});
  const logFile=path.join(directory,'main-'+Date.now()+'-'+process.pid+'.log'),fd=fs.openSync(logFile,'a');
  const args=appPath?[appPath,...argv]:argv;
  let child;
  try{child=launch(executable,args,{cwd:root,env:{...process.env,LR_STDIO_CHILD:'1'},detached:true,windowsHide:false,stdio:['ignore',fd,fd]});}
  catch(error){fs.closeSync(fd);throw error;}
  child.once('spawn',()=>{try{fs.writeSync(fd,new Date().toISOString()+' main pid='+child.pid+'\n');}finally{fs.closeSync(fd);}});
  child.once('error',()=>{try{fs.closeSync(fd);}catch{}});child.unref();return {child,logFile};
}
function launchScheduled(root,launch=spawn){
  // 计划任务(独立启动)是 Windows 专属能力; 其他平台回落到普通启动,
  // 避免在 macOS/Linux 上因缺少 schtasks 而启动失败。
  if(process.platform!=='win32')return launchLogged(root,process.execPath,[]);
  const marker=JSON.parse(fs.readFileSync(path.join(root,'logs','lifecycle','independent-start.json'),'utf8'));
  if(marker.taskName!=='LiveRecorder-Independent-Start'||path.resolve(marker.root)!==path.resolve(root))throw Error('独立启动配置无效');
  const child=launch('schtasks.exe',['/Run','/TN',marker.taskName],{cwd:root,windowsHide:true,stdio:'ignore'});
  return {child};
}
// Electron's application loader keeps require.main pointing at its own loader.
if(require.main===module||(process.versions.electron&&process.type==='browser'&&require('electron').app.getAppPath()===path.resolve(__dirname,'..'))){
  // 打包后 __dirname 在 app.asar 内: 先把真实可写数据根算好并写进环境,
  // 后面 main/store/log 全部按它落盘(否则 mkdir '...app.asar\\logs' → ENOTDIR)。
  if(process.versions.electron&&process.type==='browser'){
    try{
      const {app}=require('electron');
      process.env.LR_ROOT=process.env.LR_ROOT||dataRoot(app);
      fs.mkdirSync(process.env.LR_ROOT,{recursive:true});
    }catch(error){/* 让 main 启动后给出可见错误, 这里不阻断 */ }
  }
  if(process.env.LR_STDIO_CHILD==='1')require('./main.js');
  else{
    const {app,dialog}=require('electron');
    app.whenReady().then(()=>{try{const root=process.env.LR_ROOT||dataRoot(app),argv=process.argv.slice(process.defaultApp?2:1),protocolCall=argv.some(a=>/^[a-z][a-z0-9+.-]*:\/\//i.test(String(a))&&!/^file:/i.test(String(a))),independent=process.platform==='win32'&&!protocolCall&&fs.existsSync(path.join(root,'logs','lifecycle','independent-start.json'));if(independent&&!app.requestSingleInstanceLock()){app.exit(0);return;}if(independent)app.releaseSingleInstanceLock();const {child}=independent?launchScheduled(root):launchLogged(root,process.execPath,argv,spawn,app.isPackaged?null:root);if(independent)child.once('exit',code=>{if(code===0)app.exit(0);else{dialog.showErrorBox('直播自动录制启动失败','独立启动任务未能运行，请检查任务计划程序。');app.exit(1);}});else child.once('spawn',()=>app.exit(0));child.once('error',error=>{dialog.showErrorBox('直播自动录制启动失败',error.message);app.exit(1);});}catch(error){dialog.showErrorBox('直播自动录制启动失败',error.message);app.exit(1);}});
  }
}
module.exports={launchLogged,launchScheduled};