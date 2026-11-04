'use strict';
/**
 * 从录像文件名/历史记录推导转写热词。
 *
 * 为什么需要这个：
 * 实测发现，同一名人物在一段 60 秒音频里被识别成三种不同写法
 * 加上热词后立刻统一。可见热词对专名一致性
 * 的作用远大于换更大的模型 —— 1.7B 实测并没有更好，还慢一倍。
 *
 * 本项目录出来的文件名本身就带主播名与直播标题（见 video-names.js），
 * 这两处恰好是热词最该覆盖的内容：主播自称、品牌名、商品名、常驻话题。
 * 与其让用户手填，不如自动抽出来。
 */

const path = require('node:path');

/** 命名规则里的固定词，不是专名，不该进热词。 */
const NOISE = new Set([
  '纯享版', '凌晨', '未命名主题', '直播', '录像', '回放',
  'mp4', 'flv', 'mkv', 'mov', 'webm',
]);

/** 状态/序号等非语义片段。 */
const NOISE_PATTERN = /^\d+$|^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}-\d{2}$|^_+$/;

/**
 * 通用词黑名单。
 * 这些词出现在文件名里通常只是占位（test / tmp / 副本），
 * 喂给模型当热词反而会把这些词硬塞进结果，属于负收益。
 */
const GENERIC = new Set([
  'test', 'tmp', 'temp', 'demo', 'sample', 'output', 'input', 'final',
  'copy', 'new', 'old', 'video', 'audio', 'untitled', 'download',
  '测试', '临时', '副本', '未命名', '新建', '导出', '视频', '音频',
  '题目', '标题', '名称', '文件名', '无标题', '占位',
]);

/** 是否值得作为热词。 */
function worthKeeping(word, { minLen = 2, maxLen = 16 } = {}) {
  if (typeof word !== 'string') return false;
  const w = word.trim();
  if (w.length < minLen || w.length > maxLen) return false;
  if (NOISE.has(w) || NOISE_PATTERN.test(w)) return false;
  if (GENERIC.has(w.toLowerCase())) return false;

  // 实测教训：带标点或 # 话题符号的词会让模型把这些字符一起吐进正文。
  // 曾用一个带 "#" 话题标签的热词列表跑 60 秒音频，模型直接把整串热词
  // 当正文输出，真正的解说内容反而丢失。热词必须是干净的名词。
  //
  // 但括号要放过：主播名带别名是常态（"某某说手机（别名）"），
  // 早先把括号算作标点，导致整个主播名被拒、只剩括号内的别名。
  // 同理不列 - 和 _，否则 "Mate70Pro" 这类合法型号会被误杀。
  if (/[，,。.！!？?、；;：:""''“”‘’【】\[\]#＃@＠\/\\|｜·…~～]/.test(w)) return false;

  // 句读类标点说明这是一句话而不是专名。括号不在此列（见上），
  // 但含逗号/句号/问叹号的词一定不是热词该有的形态。
  // 长度上限 16 是为了容纳 "某某说手机（别名）" 这类长主播名，
  // 因此必须用「是否成句」而不是「字数」来拦住整句标题。
  if (/[，,。.！!？?；;…]/.test(w)) return false;

  // 纯 ASCII 且无数字的单词多半是占位名；带数字的（如商品型号）则保留
  if (/^[a-z]+$/i.test(w) && !/\d/.test(w)) return false;

  return true;
}

/**
 * 从单个文件名抽取候选词。
 * 命名格式：日期_主播名_起录时间_直播标题_纯享版.mp4
 *
 * 只取「主播名」这一段，不取标题。
 * 原因：实测标题里的内容（"1分钟集锦""多久下架，就看造化啦"）不是专名，
 * 喂给模型只会挤占 prompt，甚至让模型把热词串当正文吐出来。真正影响
 * 识别质量的是人名/品牌名，而它们稳定出现在主播名那一段。
 */
function wordsFromFilename(filename, { minLen = 2, maxLen = 16 } = {}) {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');
  const parts = base.split(/[_＿]/);
  const out = [];
  const opts = { minLen, maxLen };

  // 命名规则固定为 日期_主播名_时间_标题_纯享版，主播名在第 2 段。
  // 但用户可能把文件重命名成别的形式，所以退一步：只要某段像主播名就用。
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;

    // 第一段通常是日期，第 3 段是起录时间（HH-MM-SS），都不是专名
    if (i === 0 && /^\d{4}-\d{2}-\d{2}/.test(seg)) continue;
    if (/^\d{2}-\d{2}-\d{2}$/.test(seg)) continue;

    // 主播名常带括号内的别名，如 "某某说手机（别名）"，
    // 全称与括号内部分都保留，两者都可能被口播提到
    if (worthKeeping(seg, opts)) out.push(seg);
    const bracket = seg.match(/[（(]([^（）()]{2,8})[）)]/);
    if (bracket && worthKeeping(bracket[1], opts)) out.push(bracket[1]);
  }
  return out;
}

/**
 * 从历史记录补齐热词。
 *
 * 只取 nickname，不取 title。
 * 原因是实测过：标题里的内容（"1分钟集锦""多久下架，就看造化啦"）往往是
 * 话题句而非专名，塞进热词会挤占 prompt 并诱发模型复述热词。
 * 主播名才是稳定出现、且真正会被口播的专名。
 */
function wordsFromHistory(history, { roomId, nickname, minLen = 2, maxLen = 16 } = {}) {
  const out = [];
  if (!Array.isArray(history)) return out;
  const opts = { minLen, maxLen };
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    // 指定了房间时只取该房间的历史，避免把别的主播名混进热词
    if (roomId && entry.roomId && String(entry.roomId) !== String(roomId)) continue;
    if (nickname && entry.nickname && entry.nickname !== nickname) continue;

    const name = entry.nickname;
    if (typeof name !== 'string') continue;
    const s = name.trim();
    if (worthKeeping(s, opts)) out.push(s);
    // "某某说手机（别名）" 这类带别名的，括号内也算一个热词
    const bracket = s.match(/[（(]([^（）()]{2,8})[）)]/);
    if (bracket && worthKeeping(bracket[1], opts)) out.push(bracket[1]);
  }
  return out;
}

/**
 * 汇总并去重。保持出现顺序，长度降序（更长的词先匹配，避免被短词切开）。
 *
 * limit 默认 4 是实测出来的，不是拍脑袋：
 * 同一段 60 秒音频，热词 2 个时三种人名写法被统一，
 * 且额外修正出一处漏识别的词；热词 5 个时第一段直接输出成
 * 热词串本身（"某某主播 26赛季结束..."），真实内容丢失；热词 10 个时
 * 出现 "system" 这样的垃圾输出。
 * 结论：这个模型对热词很敏感，宁少勿多。专名一致性靠少量精准词解决，
 * 不是靠堆列表。
 */
function buildHotwords(sources, { limit = 4 } = {}) {
  const seen = new Map(); // 词 -> 出现次数
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const w of list) {
      if (typeof w !== 'string') continue;
      const t = w.trim();
      if (!t) continue;
      seen.set(t, (seen.get(t) || 0) + 1);
    }
  }
  const words = [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w)
    .slice(0, limit);
  return words.join(',');
}

/** 规则与历史一并算，给 CLI 用。 */
function autoHotwords({ inputPath, history, roomId, nickname, limit = 4 } = {}) {
  const sources = [];
  if (inputPath) sources.push(wordsFromFilename(inputPath));
  if (history) sources.push(wordsFromHistory(history, { roomId, nickname }));
  return buildHotwords(sources, { limit });
}

module.exports = {
  wordsFromFilename,
  wordsFromHistory,
  buildHotwords,
  autoHotwords,
  worthKeeping,
  NOISE,
  GENERIC,
};