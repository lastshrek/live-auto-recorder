// 日志：控制台 + logs/日期.log (UTC日期滚动: 跨零点自动切换文件, 读取端用 currentLogFile() 保持一致)
const fs = require('node:fs');
const path = require('node:path');

// 打包后 __dirname 在 app.asar 内，不能作为日志目录(暂存归档是只读文件)。
// LR_ROOT 由 bootstrap 按运行环境算好；开发期/测试没有该变量，仍用仓库根目录。
const ROOT = process.env.LR_ROOT ? path.resolve(process.env.LR_ROOT) : path.join(__dirname, '..', '..');
const LOG_DIR = process.env.LR_LOG_DIR || path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

let stream = null;
let curDate = '';
// Windows GUI launches may outlive the terminal/pipe that started them.
// A broken console must never take down recording or cause recursive logging.
const failedConsoles = new WeakSet();
for (const output of [process.stdout, process.stderr]) {
  output?.on?.('error', () => { failedConsoles.add(output); });
}
function consoleWrite(output, text) {
  if (!output || output.destroyed || failedConsoles.has(output)) return;
  try { output.write(text, error => { if (error) failedConsoles.add(output); }); }
  catch { failedConsoles.add(output); }
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

// 当前日志文件路径(写入与界面读取共用, 杜绝"写入端固定旧文件、读取端按当次日期找新文件"的错位)
function currentLogFile() {
  return path.join(LOG_DIR, `app-${dateStr()}.log`);
}

function ensureStream() {
  const d = dateStr();
  if (d !== curDate || !stream) {
    if (stream) { try { stream.end(); } catch {} }
    curDate = d;
    stream = fs.createWriteStream(currentLogFile(), { flags: 'a' });
    stream.on('error',e=>consoleWrite(process.stderr,'[log] 日志写入失败: '+e.message+'\n'));
  }
  return stream;
}

function fmt(args) {
  return args.map((a) => (a && typeof a === 'object') ? JSON.stringify(a) : String(a)).join(' ');
}
function write(level, args) {
  const line = `[${new Date().toISOString()}][${level}] ${fmt(args)}`;
  consoleWrite(process.stdout, line + '\n');
  ensureStream().write(line + '\n');
}

module.exports = {
  debug: (...a) => write('D', a),
  info: (...a) => write('I', a),
  warn: (...a) => write('W', a),
  error: (...a) => write('E', a),
  currentLogFile,
};
