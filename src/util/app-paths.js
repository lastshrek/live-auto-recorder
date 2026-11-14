// 打包相关路径工具。
//
// 开发期 __dirname 是仓库里的普通目录；打包后 __dirname 落在 app.asar 内。
// app.asar 是**只读归档文件**，不是目录：对它的子路径 mkdir / chdir /
// spawn(cwd) 都会得到 ENOTDIR，写配置也会失败。所以运行时数据必须落到
// 真实可写目录，需要交给 ffmpeg / python 等外部进程执行的文件必须用解包后的路径。
const path = require('node:path');
const fs = require('node:fs');

const ASAR_SEGMENT = /(^|[\\/])app\.asar([\\/]|$)/i;

function isInsideAsar(target) {
  return ASAR_SEGMENT.test(String(target || ''));
}

// .../resources/app.asar/src/transcribe/run_asr.py
//   → .../resources/app.asar.unpacked/src/transcribe/run_asr.py
function unpackedPath(target) {
  return String(target || '').replace(
    ASAR_SEGMENT,
    (match, before, after) => `${before}app.asar.unpacked${after}`,
  );
}

// 可写应用根目录(配置/日志/录像/任务存档都在它下面)。
// - 开发期：仓库根目录，与以往行为一致。
// - 打包后 Windows：exe 所在安装目录，与 README「相对路径按安装目录解析」一致。
// - 打包后 macOS/Linux：Electron 的 userData(.app 包内不可写，也不该写)。
// 可用 LR_ROOT 显式覆盖(测试、便携部署)。
function electronApp() {
  try {
    const electron = require('electron');
    return electron && typeof electron.getPath === 'function' ? electron : null;
  } catch { return null; }
}

function isWritable(dir) {
  const probe = path.join(dir, `.lr-write-test-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(probe); } catch {} }
}

function dataRoot(app) {
  if (process.env.LR_ROOT) return path.resolve(process.env.LR_ROOT);
  const sourceRoot = path.join(__dirname, '..', '..');
  if (!isInsideAsar(sourceRoot)) return sourceRoot;
  if (process.platform === 'win32') {
    const installDir = path.dirname(process.execPath);
    // 安装目录可写就保持便携布局(config/recordings 跟着 exe);
    // 装到 Program Files 这类只读位置时退回 userData, 至少保证能启动。
    if (isWritable(installDir)) return installDir;
  }
  const owner = app || electronApp();
  try { return owner.getPath('userData'); } catch { return path.dirname(process.execPath); }
}

module.exports = { isInsideAsar, unpackedPath, dataRoot };