'use strict';
/**
 * 本地语音转写：调 Python 侧的 sherpa-onnx + Qwen3-ASR 引擎。
 *
 * 为什么用 Python 而不是纯 Node：
 * sherpa-onnx 的 Python 轮子在 Windows/macOS/Linux 全都有预编译包，一条
 * pip install 就装好；而 Node 绑定需要 node-gyp 现场编译，在没有 MSVC 或
 * Xcode 命令行工具的机器上极易失败。为了"换台电脑也能跑"，选择 Python
 * 作为唯一的原生依赖边界，Node 侧只负责进程编排与文件处理。
 *
 * 全程离线：除了首次下载模型，运行时不产生任何网络请求。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.join(__dirname, '..', 'transcribe', 'run_asr.py');
const DEFAULT_MODEL = 'qwen3-asr-0.6b-int8';

/** 候选 Python 解释器，按优先级排列。venv 优先，避免污染系统环境。 */
function pythonCandidates(venvDir) {
  const isWin = process.platform === 'win32';
  const list = [];
  if (venvDir) {
    list.push(isWin
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3'));
  }
  list.push(isWin ? 'python' : 'python3');
  list.push(isWin ? 'py' : 'python');
  return list;
}

/** 探测可用的 Python（要求能 import sherpa_onnx）。 */
function findPython({ venvDir } = {}) {
  for (const candidate of pythonCandidates(venvDir)) {
    // py 启动器要额外参数才能执行脚本，这里只用来探测，正式调用会带上 -3
    const probe = spawnSync(candidate, ['-c', 'import sherpa_onnx'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** 详细诊断，用于告诉用户缺什么而不是笼统报"环境不可用"。 */
function diagnose({ venvDir } = {}) {
  const findings = [];
  let anyPython = false;
  for (const candidate of pythonCandidates(venvDir)) {
    const v = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (v.status !== 0) continue;
    anyPython = true;
    const has = spawnSync(candidate, ['-c', 'import sherpa_onnx'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    findings.push({
      python: candidate,
      version: (v.stdout || v.stderr || '').trim(),
      sherpaOnnx: has.status === 0,
    });
  }
  return {
    ok: findings.some(f => f.sherpaOnnx),
    anyPython,
    candidates: findings,
    hint: !anyPython
      ? '未找到 Python，请先安装 Python 3.9+ 并加入 PATH'
      : (findings.some(f => f.sherpaOnnx) ? '' : '已找到 Python 但缺少 sherpa-onnx，请运行安装脚本'),
  };
}

/** ffmpeg 抽取音轨：16kHz / 单声道 / 16-bit PCM，正好是模型输入的规格。 */
function extractAudio(ffmpegPath, input, output, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-i', input,
      '-vn',                    // 丢弃视频流
      '-ac', '1',               // 单声道
      '-ar', '16000',           // 16kHz
      '-c:a', 'pcm_s16le',      // 16-bit PCM
      '-f', 'wav',
      output,
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      if (onProgress && /time=/.test(String(chunk))) onProgress(String(chunk));
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-3).join(' ');
      reject(new Error(`抽取音轨失败（ffmpeg 退出码 ${code}）：${tail}`));
    });
  });
}

/** 读取 wav 时长，用于校验 ffmpeg 输出是否正常。 */
function wavDurationSeconds(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(44);
    fs.readSync(fd, buf, 0, 44, 0);
    fs.closeSync(fd);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = buf.readUInt32LE(28);
    const size = fs.statSync(file).size - 44;
    if (!byteRate) return null;
    return size / byteRate;
  } catch {
    return null;
  }
}

/**
 * 转写一个视频/音频文件。
 * @returns {Promise<{ok:boolean,text:string,segments:Array,duration:number,stats:object}>}
 */
async function transcribeFile(input, options = {}) {
  const {
    ffmpegPath = require('ffmpeg-static'),
    venvDir,
    modelDir,
    vadModel,
    hotwords = '',
    threads = Math.max(1, Math.min(8, os.cpus().length - 1)),
    srtPath,
    txtPath,
    jsonPath,
    keepAudio = false,
    maxSpeech = 15,
    timeoutMs = 0,
    onStage,
  } = options;

  if (!fs.existsSync(input)) throw new Error(`输入文件不存在: ${input}`);
  if (!fs.existsSync(SCRIPT)) throw new Error(`转写引擎缺失: ${SCRIPT}`);

  const python = findPython({ venvDir });
  if (!python) {
    const d = diagnose({ venvDir });
    throw new Error(d.hint || '未找到可用的 Python 环境');
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-asr-'));
  const wav = path.join(workDir, 'audio.wav');
  const outJson = jsonPath || path.join(workDir, 'result.json');

  try {
    if (onStage) onStage('extract');
    await extractAudio(ffmpegPath, input, wav);
    const dur = wavDurationSeconds(wav);
    if (dur !== null && dur < 0.5) throw new Error('音频时长过短，无法转写');

    if (onStage) onStage('transcribe');
    const args = [
      SCRIPT,
      '--model-dir', modelDir,
      '--vad-model', vadModel,
      '--audio', wav,
      '--output', outJson,
      '--threads', String(threads),
      '--max-speech', String(maxSpeech),
    ];
    if (hotwords) args.push('--hotwords', hotwords);
    if (srtPath) args.push('--srt', srtPath);
    if (txtPath) args.push('--txt', txtPath);

    const result = await new Promise((resolve, reject) => {
      const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timer;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`转写超时（${Math.round(timeoutMs / 1000)} 秒）`));
        }, timeoutMs);
      }
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
      child.on('close', code => {
        if (timer) clearTimeout(timer);
        // 引擎把结果 JSON 打在 stdout 最后一行，前面可能有 sherpa 的告警。
        const line = stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
        if (!line) {
          const tail = stderr.trim().split('\n').slice(-4).join(' ');
          return reject(new Error(`转写引擎未返回结果（退出码 ${code}）${tail ? '：' + tail : ''}`));
        }
        let parsed;
        try { parsed = JSON.parse(line); }
        catch (e) { return reject(new Error(`转写结果不是合法 JSON: ${e.message}`)); }
        if (!parsed.ok) return reject(new Error(parsed.error || '转写失败'));
        resolve(parsed);
      });
    });

    if (onStage) onStage('done');
    return result;
  } finally {
    if (!keepAudio) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    } else {
      // 保留时告诉调用方音频位置，便于排查识别质量问题
      console.log(`[transcribe] 临时音频保留在 ${wav}`);
    }
  }
}

/** 把 segments 拼成连续文本，可选按段落合并（去掉逐句换行）。 */
function segmentsToText(segments, { paragraph = true } = {}) {
  if (!Array.isArray(segments) || !segments.length) return '';
  if (!paragraph) return segments.map(s => s.text).join('\n');
  return segments.map(s => s.text).join('');
}

module.exports = {
  transcribeFile,
  findPython,
  diagnose,
  extractAudio,
  wavDurationSeconds,
  segmentsToText,
  DEFAULT_MODEL,
  SCRIPT,
};