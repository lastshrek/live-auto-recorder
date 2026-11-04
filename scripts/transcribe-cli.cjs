#!/usr/bin/env node
'use strict';
/**
 * 转写命令行。
 *
 *   node scripts/transcribe-cli.cjs <文件或目录> [选项]
 *
 * 常见用法：
 *   node scripts/transcribe-cli.cjs recordings/主播名/某场.mp4
 *   node scripts/transcribe-cli.cjs recordings/主播名 --all
 *   node scripts/transcribe-cli.cjs 某场.mp4 --hotwords "商品名,主播名"
 */

const fs = require('node:fs');
const path = require('node:path');
const { transcribeFile, findPython, diagnose } = require('../src/core/transcribe');
const { autoHotwords } = require('../src/core/hotwords');
const { loadConfig, VENV } = require('./setup-transcribe.cjs');

const VIDEO_EXT = /\.(mp4|mkv|flv|mov|webm|ts|m4v|avi|wav|mp3|m4a|aac|flac)$/i;

function parseArgs(argv) {
  const out = { inputs: [], all: false, hotwords: '', threads: 0, keepAudio: false, srt: true, txt: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--keep-audio') out.keepAudio = true;
    else if (a === '--no-srt') out.srt = false;
    else if (a === '--no-txt') out.txt = false;
    else if (a === '--hotwords') out.hotwords = argv[++i] || '';
    else if (a === '--no-auto-hotwords') out.noAutoHotwords = true;
    else if (a === '--threads') out.threads = Number(argv[++i]) || 0;
    else if (a === '--max-speech') out.maxSpeech = Number(argv[++i]) || 15;
    else if (a.startsWith('--')) { console.error(`未知选项: ${a}`); process.exit(2); }
    else out.inputs.push(a);
  }
  return out;
}

function collectFiles(inputs, all) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) {
      console.error(`跳过（不存在）: ${input}`);
      continue;
    }
    const st = fs.statSync(abs);
    if (st.isFile()) {
      if (VIDEO_EXT.test(abs)) files.push(abs);
      else console.error(`跳过（不是音视频文件）: ${input}`);
      continue;
    }
    // 目录：默认只处理顶层，--all 递归
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && all) walk(p);
        else if (e.isFile() && VIDEO_EXT.test(e.name) && !/\.pending\./i.test(e.name)) files.push(p);
      }
    };
    walk(abs);
  }
  return files;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m${s % 60}s`;
}

function fmtSize(bytes) {
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes > 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputs.length) {
    console.log('用法: node scripts/transcribe-cli.cjs <文件或目录> [--all] [--hotwords "词1,词2"]');
    console.log('\n示例:');
    console.log('  node scripts/transcribe-cli.cjs recordings/主播名/某场.mp4');
    console.log('  node scripts/transcribe-cli.cjs recordings/主播名 --all');
    process.exit(1);
  }

  // 环境检查优先，错误信息要给得具体
  const cfg = loadConfig();
  if (!cfg) {
    console.error('转写环境未安装。请先运行：\n  npm run transcribe:setup');
    process.exit(1);
  }
  if (!findPython({ venvDir: VENV })) {
    const d = diagnose({ venvDir: VENV });
    console.error('转写环境不可用：' + (d.hint || '未知原因'));
    console.error('候选解释器：');
    for (const c of d.candidates) {
      console.error(`  ${c.python}  ${c.version}  sherpa-onnx=${c.sherpaOnnx ? '有' : '无'}`);
    }
    console.error('\n可运行 npm run transcribe:check 体检，或 npm run transcribe:setup 重装。');
    process.exit(1);
  }

  const files = collectFiles(args.inputs, args.all);
  if (!files.length) {
    console.error('没有找到可处理的音视频文件。');
    process.exit(1);
  }

  console.log(`待处理 ${files.length} 个文件\n`);

  // 历史记录只读一次，用于自动补热词（主播名/标题里的专名）
  let history = null;
  if (!args.hotwords && !args.noAutoHotwords) {
    try {
      const hf = path.join(process.cwd(), 'history.json');
      if (fs.existsSync(hf)) history = JSON.parse(fs.readFileSync(hf, 'utf8'));
    } catch { /* 历史读不到不影响转写，只是热词少了几个 */ }
  }

  const summary = [];
  const started = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = file.replace(/\.[^.]+$/, '');
    const st = fs.statSync(file);

    // 用户显式给了就用用户的；否则从文件名 + 历史自动推导
    const hotwords = args.hotwords
      || (args.noAutoHotwords ? '' : autoHotwords({ inputPath: file, history }));

    process.stdout.write(`[${i + 1}/${files.length}] ${path.basename(file)} (${fmtSize(st.size)}) `);

    const t0 = Date.now();
    try {
      const r = await transcribeFile(file, {
        venvDir: VENV,
        modelDir: cfg.modelDir,
        vadModel: cfg.vadModel,
        hotwords,
        threads: args.threads || undefined,
        maxSpeech: args.maxSpeech || 15,
        srtPath: args.srt ? `${base}.srt` : undefined,
        txtPath: args.txt ? `${base}.txt` : undefined,
        keepAudio: args.keepAudio,
      });
      const secs = (Date.now() - t0) / 1000;
      const outExt = [args.srt && 'srt', args.txt && 'txt'].filter(Boolean).join('/');
      console.log(`→ ${r.segments.length} 段, ${fmtTime(secs)} (${(r.duration / secs).toFixed(1)}x 实时) [${outExt}]`);
      summary.push({ file, ok: true, segments: r.segments.length, seconds: secs, rtf: r.stats.rtf });
    } catch (e) {
      console.log(`→ 失败: ${e.message}`);
      summary.push({ file, ok: false, error: e.message });
    }
  }

  const ok = summary.filter(s => s.ok);
  const bad = summary.filter(s => !s.ok);
  console.log(`\n完成：成功 ${ok.length}，失败 ${bad.length}，总耗时 ${fmtTime((Date.now() - started) / 1000)}`);
  if (bad.length) {
    console.log('\n失败明细：');
    for (const b of bad) console.log(`  ${path.basename(b.file)}: ${b.error}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n意外错误:', e.message);
  process.exit(1);
});