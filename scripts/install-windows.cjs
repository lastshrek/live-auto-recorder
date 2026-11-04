/**
 * Windows 一键安装脚本。
 *
 * 给智能体或用户一条命令就能跑完：
 *   node scripts/install-windows.cjs
 *
 * 为什么要有这个脚本而不是让智能体照着文档敲命令：
 * 文档需要理解、需要判断、可能漏步；脚本是确定的。AI 读文档后可能
 * 自行"优化"命令（改镜像、跳步骤、换参数），脚本按固定流程走，出错
 * 点也明确。
 *
 * 设计原则：
 * - 幂等：重复执行不会重复下载、不会破坏已装好的部分
 * - 每步验证：不只看命令退出码，还检查产物是否真的存在
 * - 失败即停并给出可操作提示，不静默跳过
 * - 国内网络自动走镜像，不需要用户判断
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

// 国内网络下 GitHub Release 直连基本不通，预先设好镜像
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const NPM_REGISTRY = 'https://registry.npmmirror.com';

let step = 0;
const TOTAL = 5;

function log(msg) { console.log(msg); }
function head(msg) { step++; console.log(`\n[${step}/${TOTAL}] ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function die(msg, hint) {
  console.error(`\n[失败] ${msg}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    windowsHide: true,
    cwd: ROOT,
    ...opts,
  });
  return r.status === 0;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

// ---------- 1. 环境检查 ----------

function checkNode() {
  head('检查 Node.js 版本');
  const v = capture(process.execPath, ['-v']);
  const m = (v.out.match(/v(\d+)\.(\d+)/) || []);
  const major = Number(m[1] || 0);
  const minor = Number(m[2] || 0);
  if (!major) die('无法获取 Node.js 版本', '请确认已安装 Node.js 并重开终端');
  ok(`Node.js ${v.out}`);
  // electron@45 的 engines 要求 >= 22.12.0，低于此版本 npm install 必定失败
  if (major < 22 || (major === 22 && minor < 12)) {
    die(
      `Node.js 版本过低（需要 22.12 或更高，当前 ${major}.${minor}）`,
      '升级方式：\n  winget install OpenJS.NodeJS.LTS\n或从 https://nodejs.org/ 下载 LTS 版本\n安装后请重开终端再运行本脚本',
    );
  }
  ok('版本满足要求（electron@45 要求 >= 22.12）');
}

// ---------- 2. 依赖 ----------

function installDeps() {
  head('安装项目依赖（约 300MB）');

  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist',
    isWin ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
  const ffmpegExe = path.join(ROOT, 'node_modules', 'ffmpeg-static',
    isWin ? 'ffmpeg.exe' : 'ffmpeg');

  if (fs.existsSync(electronExe) && fs.existsSync(ffmpegExe)) {
    ok('依赖已存在，跳过安装');
    return;
  }

  // 设镜像：这两个包都从 GitHub Release 下载，国内直连会超时
  const env = {
    ...process.env,
    ELECTRON_MIRROR,
    npm_config_registry: NPM_REGISTRY,
  };
  log('  使用国内镜像加速下载…');
  if (!run('npm', ['install', '--no-audit', '--no-fund'], { env })) {
    die(
      '依赖安装失败',
      '常见原因与处理：\n'
      + '  1) 网络问题 → 挂代理后重试：npm install --proxy http://127.0.0.1:端口\n'
      + '  2) 权限问题 → 不要把项目放在 C:\\Program Files\n'
      + '  3) 残留文件 → 删除 node_modules 后重试',
    );
  }
  ok('npm install 完成');
}

function verifyDeps() {
  head('验证关键文件');
  const checks = isWin
    ? [
      [path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), 'Electron 运行时', true],
      [path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'), 'ffmpeg 录制内核', true],
      [path.join(ROOT, 'node_modules', 'ntsuspend'), 'ntsuspend（可选）', false],
    ]
    : [
      [path.join(ROOT, 'node_modules', 'electron', 'dist'), 'Electron 运行时', true],
      [path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'), 'ffmpeg 录制内核', true],
    ];

  let fatal = false;
  for (const [p, label, required] of checks) {
    const exists = fs.existsSync(p);
    if (exists) ok(label);
    else if (required) { console.error(`  ✗ ${label} 缺失`); fatal = true; }
    // ntsuspend 是可选依赖，缺失只影响「暂停后处理任务」，不影响录制
    else warn(`${label} 未安装（不影响录制，仅「暂停后处理任务」不可用）`);
  }

  if (fatal) {
    die(
      '关键文件缺失，程序无法运行',
      'ffmpeg 缺失时可手动补：\n'
      + '  下载 https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz\n'
      + '  解压得到 ffmpeg.exe，放到 node_modules\\ffmpeg-static\\ 下',
    );
  }
}

// ---------- 3. 配置 ----------

function prepareConfig() {
  head('准备配置文件');
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    ok('config.json 已存在，保留现有配置');
    return;
  }
  // 首次运行由程序自己生成默认配置，这里只确认目录可写
  const outDir = path.join(ROOT, 'recordings');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const probe = path.join(outDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok('录像目录可写');
  } catch (e) {
    die(
      `录像目录不可写：${outDir}`,
      '通常是因为项目放在 C:\\Program Files 等需要管理员权限的位置。\n'
      + '请把项目移动到 D:\\live-auto-recorder 这类普通目录后重试。',
    );
  }
  ok('将使用默认配置（首次启动自动生成）');
}

// ---------- 4. 自检 ----------

function selfTest() {
  head('运行自检');
  const r = capture('npm', ['run', 'transcribe:check']);
  if (r.ok) {
    ok('字幕环境就绪');
  } else {
    // 字幕是可选功能，没装不影响主程序
    warn('字幕环境未安装（可选功能，不影响录制）');
    warn('需要时运行：npm run transcribe:setup');
  }

  // 确认主进程能被解析（不启动 GUI，避免阻塞）
  const main = path.join(ROOT, 'src', 'bootstrap.cjs');
  if (!fs.existsSync(main)) die('主进程入口缺失，项目文件可能不完整');
  const check = capture(process.execPath, ['--check', main]);
  if (!check.ok) die(`主进程代码有语法错误：${check.out.split('\n')[0]}`);
  ok('主进程代码完整');
}

// ---------- 5. 收尾 ----------

function finish() {
  console.log('');
  const isAscii = s => /^[\x20-\x7E]*$/.test(s);
  const name = path.basename(ROOT);
  if (!isAscii(name)) {
    warn(`项目目录名含中文或特殊字符（${name}），个别系统上可能有兼容问题，建议改为英文路径`);
  }
  if (isWin) {
    warn('首次启动若弹出 Windows 防火墙提示，请选择「允许」（需要访问抖音接口）');
  } else {
    warn('首次启动若提示「无法验证开发者」，右键应用 → 打开 → 打开');
  }
  log('\n启动方式：');
  log(isWin ? '  npm start   或双击 启动直播录制.bat' : '  npm start   或双击 启动直播录制.command');
  log('\n添加主播：粘贴直播间链接或房间号，例如 https://live.douyin.com/123456789012');
}

function main() {
  log(`=== 直播自动录制 · ${isWin ? 'Windows' : '桌面端'}一键安装 ===`);
  log(`平台: ${process.platform} ${process.arch}  目录: ${ROOT}`);

  checkNode();
  installDeps();
  verifyDeps();
  prepareConfig();
  selfTest();
  finish();
}

if (require.main === module) main();
module.exports = { main };