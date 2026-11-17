'use strict';
/**
 * 天津津门虎队专用热词表。
 *
 * 为什么单独一份：球队专名（尤其外援音译名）是转写最容易出错的部分——
 * 「基莱斯」「谢蒂内」「哈达斯」通用中文词表里没有，模型极易听成普通词。
 *  尤其是体育解说，一场里反复出现，错了会贯穿整场字幕。
 *
 * 关键约束：这个模型对热词数量非常敏感（见 hotwords.js 的实测记录），
 * 塞满 28 人会把整段字幕冲成热词串。所以词表按「识别收益」排序，
 * 由设置的 teamHotwordsLimit 截取前 N 个，默认只给最值钱的几个。
 *
 * 数据来源：天津津门虎 FC 官方 2026 赛季大名单（28 人，2026-03-03 公布）。
 * 赛季变动后更新本表即可，用户也可在配置目录放 hotwords-team.txt 覆盖。
 */

// 按「错一字就很明显、且口播高频」排序。
// 外援音译名放最前：通用词表没有，最容易被听成同音普通词。
const TEAM_HOTWORDS = [
  // 外援（音译，最易错）
  '基莱斯', '谢蒂内', '哈达斯', '科尔多瓦', '格劳', '萨尔瓦多',
  // 教练 / 球队 / 主场（解说高频专名）
  '于根伟', '津门虎', '泰达足球场', '天津泰达',
  // 国内主力（出场多、常口播）
  '王秋明', '谢维军', '巴顿', '吴兴涵', '杨帆', '黄嘉辉',
  '季胜攀', '郭皓', '闫炳良', '王政豪', '孙铭谦', '刘俊贤',
  // 球迷黑话 / 口号（有固定说法，模型容易写成大白话）
  '于六定律', '好水', '津门虎球迷',
];

/**
 * 读取用户自定义球队词表（覆盖内置表）。
 * 路径：<数据目录>/hotwords-team.txt，一行一个词，# 开头为注释。
 * 读不到就返回 null，调用方回退到内置表。
 */
function loadUserTeamHotwords(ROOT, fs = require('node:fs'), path = require('node:path')) {
  try {
    const file = path.join(ROOT, 'hotwords-team.txt');
    if (!fs.existsSync(file)) return null;
    const words = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(line => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
    return words.length ? words : null;
  } catch {
    return null;
  }
}

/**
 * 取球队热词。
 * @param {object} opts
 * @param {string} opts.root 数据目录（读用户词表）
 * @param {number} opts.limit 最多取几个，0=不取
 * @returns {string[]}
 */
function teamHotwords({ root, limit = 6 } = {}) {
  if (!limit || limit <= 0) return [];
  const custom = root ? loadUserTeamHotwords(root) : null;
  const source = custom || TEAM_HOTWORDS;
  // 去重后按给定顺序截取；用户词表按自己的行序优先
  const seen = new Set();
  const out = [];
  for (const w of source) {
    if (typeof w !== 'string') continue;
    const t = w.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { TEAM_HOTWORDS, teamHotwords, loadUserTeamHotwords };
