'use strict';
/**
 * 转写运行时配置的读取。
 *
 * setup-transcribe.cjs 安装完会把绝对路径写进 runtime/asr/config.json。
 * CLI 与主进程都要读它，所以单独抽出来，避免两处各写一份路径推导
 * （两边推导一旦不一致，就会出现"命令行能转、界面不能转"的怪问题）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./store');

const RUNTIME_DIR = path.join(ROOT, 'runtime', 'asr');
const CONFIG_FILE = path.join(RUNTIME_DIR, 'config.json');
const VENV_DIR = path.join(RUNTIME_DIR, 'venv');

/**
 * 读配置并校验关键路径确实存在。
 * 返回 null 表示环境没装好，调用方据此给出"请先运行 setup"的提示。
 */
function loadRuntimeConfig({ check = true } = {}) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (!cfg || typeof cfg !== 'object') return null;
  const out = {
    venvDir: VENV_DIR,
    python: cfg.python || '',
    modelDir: cfg.modelDir || '',
    vadModel: cfg.vadModel || '',
    engine: cfg.engine || '',
  };
  if (!check) return out;
  // 路径都存在才算可用；缺一个就让上层提示重装，而不是跑到一半失败
  if (!out.modelDir || !fs.existsSync(out.modelDir)) return null;
  if (!out.vadModel || !fs.existsSync(out.vadModel)) return null;
  if (!fs.existsSync(VENV_DIR)) return null;
  return out;
}

/** 环境是否就绪（给界面判断要不要显示"转字幕"按钮） */
function isReady() {
  return loadRuntimeConfig() !== null;
}

module.exports = { loadRuntimeConfig, isReady, RUNTIME_DIR, CONFIG_FILE, VENV_DIR };