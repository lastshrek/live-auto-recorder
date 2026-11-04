'use strict';
/**
 * 磁盘剩余空间查询。
 *
 * 为什么不只用 fs.statfsSync：
 * 它是 Node 18.15+ 才加的，且在各平台底层依赖不同（Linux: statfs，
 * Windows: GetDiskFreeSpaceEx）。历史版本里 Windows 上的行为有过变化。
 *
 * 关键风险不在"查不到"，而在"查不到时返回 0" —— 上层判断是
 * `freeBytes < minFreeGB`，0 会被当成"磁盘已满"，直接拒绝开始录制，
 * 而且报错文案是"等待磁盘空间"，用户完全无法自查。宁可返回 null 让
 * 上层跳过检查，也不要谎报 0。
 *
 * 策略：
 *   1. 先试 fs.statfsSync（跨平台，Node 22 全支持）
 *   2. 失败则 Windows 用 PowerShell 的 GetDiskFreeSpaceEx 兜底
 *   3. 全部失败返回 null，由调用方决定"跳过检查"而非"判定为满"
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/**
 * @returns {number|null} 可用字节数；无法确定时返回 null（不要返回 0）
 */
function freeBytes(dir) {
  // 主路径：statfsSync
  try {
    const st = fs.statfsSync(dir);
    const bytes = Number(st.bsize) * Number(st.bavail);
    // 极少数情况下底层实现可能返回 0，这不可信（系统盘不会是 0 字节空闲）
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
  } catch { /* 落到兜底 */ }

  // Windows 兜底：PowerShell 取同一分区的可用空间
  if (process.platform === 'win32') {
    try {
      const drive = require('node:path').parse(require('node:path').resolve(dir)).root.replace(/\\$/, '');
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-PSDrive -PSProvider FileSystem -Name '${drive.replace(/:$/, '')}').Free`,
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const n = Number(String(out).trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* 继续返回 null */ }
  }

  return null;
}

module.exports = { freeBytes };