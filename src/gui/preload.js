const { contextBridge, ipcRenderer } = require('electron');

// 界面文案需要随平台变化(macOS 称菜单栏而非托盘), 只暴露只读的平台标识
contextBridge.exposeInMainWorld('platformInfo', {
  platform: process.platform,
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  // 修饰键名称: macOS 用 ⌘, 其他用 Ctrl
  modKey: process.platform === 'darwin' ? '⌘' : 'Ctrl',
});

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  companyAction: (action,data) => ipcRenderer.invoke('company:action',action,data),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  addStreamer: (input, name, mode) => ipcRenderer.invoke('streamer:add', input, name, mode),
  removeStreamer: (rid) => ipcRenderer.invoke('streamer:remove', rid),
  stopRecording: (rid) => ipcRenderer.invoke('record:stop', rid),
  setMonitorPaused: (id, paused) => ipcRenderer.invoke('monitor:set-paused', id, paused),
  postCancel: (id) => ipcRenderer.invoke('post:cancel', id),
  pauseRecording: (rid) => ipcRenderer.invoke('record:pause', rid),
  resumeRecording: (rid) => ipcRenderer.invoke('record:resume', rid),
  watch: (rid) => ipcRenderer.invoke('room:watch', rid),
  openRecordings: () => ipcRenderer.invoke('recordings:open'),
  listRecordings: (relative) => ipcRenderer.invoke('recordings:list',relative),
  openRecordingsSystem: (relative) => ipcRenderer.invoke('recordings:system-open',relative),
  copyRecordingsPath: (relative) => ipcRenderer.invoke('recordings:copy',relative),
  playRecording: (relative) => ipcRenderer.invoke('recordings:play',relative),
  saveSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  batchAdd: (text) => ipcRenderer.invoke('streamer:batch', text),
  exportList: () => ipcRenderer.invoke('streamer:export'),
  logsTail: () => ipcRenderer.invoke('logs:tail'),
  openLogin: () => ipcRenderer.invoke('account:login'),
  streamerConfig: (rid, patch) => ipcRenderer.invoke('streamer:config', rid, patch),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  retryPost: (id) => ipcRenderer.invoke('post:retry',id),
  postPause: (id) => ipcRenderer.invoke('post:pause',id),
  postResume: (id) => ipcRenderer.invoke('post:resume',id),
  postMove: (id,dir) => ipcRenderer.invoke('post:move',id,dir),
  postNow: (id) => ipcRenderer.invoke('post:now',id),
  postRemove: (id) => ipcRenderer.invoke('post:remove',id),
});
