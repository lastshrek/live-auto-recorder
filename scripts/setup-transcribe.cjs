#!/usr/bin/env node
'use strict';
/**
 * 转写环境一键准备（Windows / macOS / Linux 通用）。
 *
 * 为什么用 Node 写而不是 .sh + .bat 两份：
 * 两份脚本必然随时间漂移，改一边忘一边是常态。这里用 Node 统一编排，
 * 只把真正和平台相关的部分（解释器路径、可执行后缀）抽出来判断。
 *
 * 做的事情：
 *   1. 检查 python3（3.9+）
 *   2. 在 runtime/asr/ 下建独立 venv，不污染系统 Python
 *   3. pip install sherpa-onnx
 *   4. 下载 Qwen3-ASR 模型 + Silero VAD（约 850MB，只需一次）
 *   5. 写 config 供转写模块读取
 *
 * 用法:
 *   node scripts/setup-transcribe.cjs            # 完整安装
 *   node scripts/setup-transcribe.cjs --check    # 只体检
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime', 'asr');
const VENV = path.join(RUNTIME, 'venv');
const MODELS = path.join(RUNTIME, 'models');
const CONFIG = path.join(RUNTIME, 'config.json');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2';
const VAD_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const MODEL_DIR_NAME = 'sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';

const isWin = process.platform === 'win32';

function log(msg) { console.log(msg); }
function fail(msg) {
  console.error(`\n[失败] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  return r.status === 0;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function findPython() {
  const candidates = isWin ? ['python', 'py'] : ['python3', 'python'];
  for (const c of candidates) {
    const v = capture(c, ['--version']);
    if (!v.ok) continue;
    const m = v.out.match(/Python (\d+)\.(\d+)/);
    if (!m) continue;
    const major = Number(m[1]), minor = Number(m[2]);
    if (major < 3 || (major === 3 && minor < 9)) {
      log(`  跳过 ${c}（版本 ${major}.${minor} 过低，需要 3.9+）`);
      continue;
    }
    return c;
  }
  return null;
}

function venvPython() {
  return isWin ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python3');
}

function checkExisting() {
  const py = venvPython();
  if (!fs.existsSync(py)) return { venv: false, sherpa: false, model: false, vad: false };
  const sherpa = capture(py, ['-c', 'import sherpa_onnx']).ok;
  const model = fs.existsSync(path.join(MODELS, MODEL_DIR_NAME, 'decoder.int8.onnx'));
  const vad = fs.existsSync(path.join(MODELS, 'silero_vad.onnx'));
  return { venv: true, sherpa, model, vad, python: py };
}

function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`  ${label} 已存在，跳过下载`);
    return true;
  }
  log(`  下载 ${label} ...`);
  // 用系统 curl：三个平台都自带（Windows 10+ 亦有 curl.exe），
  // 避免为了下载再引入 node-fetch 之类的依赖。
  // --progress-bar 而非默认的进度表：默认输出每秒几十行，在 CI 与日志里不可读
  const args = ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--progress-bar', '-o', dest, url];
  const ok = run('curl', args);
  if (!ok) {
    // 老 Windows 可能没有 curl，退回 PowerShell
    if (isWin) {
      log('  curl 不可用，改用 PowerShell 下载 ...');
      const ps = `Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing`;
      return run('powershell', ['-NoProfile', '-Command', ps]);
    }
    return false;
  }
  return true;
}

function extractTarBz2(archive, destDir) {
  const ok = run('tar', ['xjf', archive, '-C', destDir]);
  if (!ok && isWin) {
    log('  tar 失败，尝试用 python 的 tarfile 解压 ...');
    const py = findPython();
    if (!py) return false;
    return run(py, ['-c', `import tarfile;tarfile.open(r'${archive}').extractall(r'${destDir}')`]);
  }
  return ok;
}

function writeConfig(py) {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const cfg = {
    // 记录绝对路径，转写模块直接读，避免每次猜目录结构
    python: py,
    modelDir: path.join(MODELS, MODEL_DIR_NAME),
    vadModel: path.join(MODELS, 'silero_vad.onnx'),
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    engine: 'sherpa-onnx + Qwen3-ASR 0.6B int8',
  };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch { return null; }
}

function doctor() {
  log('=== 转写环境体检 ===');
  const py = findPython();
  log(`Python: ${py || '未知'}`);
  const st = checkExisting();
  log(`虚拟环境: ${st.venv ? '已建' : '未建'}`);
  log(`sherpa-onnx: ${st.sherpa ? '已装' : '未装'}`);
  log(`ASR 模型: ${st.model ? '已下载' : '未下载'}`);
  log(`VAD 模型: ${st.vad ? '已下载' : '未下载'}`);
  if (st.sherpa) {
    const v = capture(venvPython(), ['-c', 'import sherpa_onnx;print(sherpa_onnx.__version__)']);
    if (v.ok) log(`版本: ${v.out.trim()}`);
  }
  log(`磁盘可用: ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB 内存 / ${os.cpus().length} 核`);
  return st;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  log('=== 本地语音转写环境准备（Qwen3-ASR，完全离线）===');
  log(`平台: ${process.platform} ${process.arch}`);

  const existing = checkExisting();
  const ready = existing.sherpa && existing.model && existing.vad;

  if (checkOnly) {
    doctor();
    log(ready ? '\n环境就绪，可以直接转写。' : '\n环境未就绪，运行 npm run transcribe:setup 安装。');
    process.exit(ready ? 0 : 1);
  }

  if (ready) {
    log('\n环境已就绪，无需重复安装。');
    writeConfig(venvPython());
    log(`配置: ${CONFIG}`);
    return;
  }

  // 1. Python
  const sysPy = findPython();
  if (!sysPy) {
    fail('未找到 Python 3.9+。请先安装：\n'
      + '  macOS:   brew install python@3.12\n'
      + '  Windows: https://www.python.org/downloads/ （安装时勾选 Add to PATH）');
  }
  log(`\n[1/4] 使用 Python: ${sysPy}`);

  // 2. venv
  fs.mkdirSync(RUNTIME, { recursive: true });
  if (!fs.existsSync(venvPython())) {
    log('[2/4] 创建独立虚拟环境（不污染系统 Python）...');
    if (!run(sysPy, ['-m', 'venv', VENV])) {
      fail('创建虚拟环境失败。Windows 上若提示找不到 venv，请重装 Python 并勾选 pip/venv 组件。');
    }
  } else {
    log('[2/4] 虚拟环境已存在，复用');
  }

  // 3. 依赖
  if (!existing.sherpa) {
    log('[3/4] 安装 sherpa-onnx（含全部平台的预编译轮子，无需编译）...');
    // 国内网络下 PyPI 可能很慢，允许通过环境变量换源
    const index = process.env.LR_PIP_INDEX;
    const args = ['-m', 'pip', 'install', '--upgrade', 'pip', '-q'];
    if (index) args.push('-i', index);
    run(venvPython(), args);
    const installArgs = ['-m', 'pip', 'install', '-q', 'sherpa-onnx', 'numpy'];
    if (index) installArgs.push('-i', index);
    if (!run(venvPython(), installArgs)) {
      fail('安装 sherpa-onnx 失败。国内网络可设置镜像后重试：\n'
        + '  macOS/Linux: LR_PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple node scripts/setup-transcribe.cjs\n'
        + '  Windows:     set LR_PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple && node scripts/setup-transcribe.cjs');
    }
  } else {
    log('[3/4] sherpa-onnx 已安装，跳过');
  }

  // 4. 模型
  log('[4/4] 下载模型（约 850MB，仅首次）...');
  fs.mkdirSync(MODELS, { recursive: true });

  if (!existing.vad) {
    if (!download(VAD_URL, path.join(MODELS, 'silero_vad.onnx'), 'VAD 模型')) {
      fail('下载 VAD 模型失败，请检查网络。');
    }
  } else {
    log('  VAD 模型已存在');
  }

  if (!existing.model) {
    const archive = path.join(MODELS, 'model.tar.bz2');
    if (!download(MODEL_URL, archive, 'Qwen3-ASR 模型')) {
      fail('下载模型失败。GitHub 在国内可能无法直连，建议挂代理后重试，或手动下载后放到 '
        + `${MODELS} 目录：\n  ${MODEL_URL}`);
    }
    log('  解压 ...');
    if (!extractTarBz2(archive, MODELS)) fail('解压模型失败。');
    // 解压成功后删掉压缩包，省 838MB
    try { fs.rmSync(archive); } catch { /* 删不掉不影响使用 */ }
  } else {
    log('  ASR 模型已存在');
  }

  const cfg = writeConfig(venvPython());
  log('\n=== 完成 ===');
  log(`模型: ${cfg.modelDir}`);
  log(`配置: ${CONFIG}`);
  log('\n试一下：');
  log('  node scripts/transcribe-cli.cjs "某个录像.mp4"');
}

if (require.main === module) main();

module.exports = { loadConfig, VENV, MODELS, RUNTIME };