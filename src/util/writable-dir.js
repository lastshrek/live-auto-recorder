// 录像目录可写性校验。
//
// 为什么需要: 用户改「保存路径」时, fs.mkdirSync 成功并不代表能写文件。
// 只读盘、权限不足、网盘掉线、磁盘已满、路径被安全软件锁定, 这些情况
// mkdir 都可能通过, 却会在真正开录时才失败 —— 那时直播已经开始了,
// 用户会白白错过一场。所以改设置时就落一个探针文件验证。
const fs = require('node:fs');
const path = require('node:path');

// 常见错误的可读解释。用户看到的应该是"该往哪查", 而不是 errno 原文。
function explain(err, dir) {
  const code = err && err.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `没有写入权限：${dir}\n`
        + 'Windows 上常见于把目录设在 C:\\Program Files 或系统盘根目录；'
        + '请换到 D:\\ 这类普通目录，或以管理员身份运行。';
    case 'ENOENT':
      return `路径不存在且无法创建：${dir}\n请确认上级目录存在，或盘符/网络位置已连接。`;
    case 'ENOSPC':
      return `磁盘空间不足：${dir}\n请清理空间或换一个磁盘。`;
    case 'EROFS':
      return `该位置是只读的：${dir}\n请换到可写的磁盘。`;
    case 'EBUSY':
      return `目录被占用：${dir}\n可能有其他程序正在写入，请稍后重试。`;
    case 'ENOTDIR':
      return `路径中有一段不是目录：${dir}\n请检查路径拼写。`;
    case 'ENAMETOOLONG':
      return `路径过长：${dir}\n请换一个更短的路径。`;
    case 'LR_NOT_DIR':
      return `该路径已存在但不是目录：${dir}\n请换一个目录。`;
    default:
      return `无法使用该目录：${dir}\n${(err && err.message) || err}`;
  }
}

// 确保 dir 存在且可写。可写则以探针文件实测, 成功返回 true, 失败抛带说明的 Error。
// 注意: dir 必须是已经解析好的绝对路径。相对路径(如默认的 "recordings")
// 由调用方先用 _resolveOutDir 拼成绝对路径, 这里不再做相对路径推断,
// 否则同一份配置在 CLI 与 GUI 下可能指向不同位置。
function assertWritableDir(dir) {
  const target = String(dir || '').trim();
  if (!target) throw new Error('录像目录不能为空');
  if (!path.isAbsolute(target)) {
    throw new Error(`录像目录必须是绝对路径，收到的是：${target}\n`
      + '（相对路径由程序按安装目录解析，无需手填）');
  }

  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
      const e = new Error('not a directory');
      e.code = 'LR_NOT_DIR';
      throw e;
    }
  } catch (e) {
    if (e.code === 'LR_NOT_DIR') throw new Error(explain(e, target));
    if (e.code !== 'ENOENT') throw new Error(explain(e, target));
    // 不存在就建, 建不动则报错
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (e2) {
      throw new Error(explain(e2, target));
    }
  }

  // 真正写一次。名字带 pid 与随机串, 避免并发调用互相踩, 也便于残留识别。
  const probe = path.join(target, `.lr-write-test-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
  } catch (e) {
    throw new Error(explain(e, target));
  } finally {
    try { fs.unlinkSync(probe); } catch {}
  }
  return true;
}

module.exports = { assertWritableDir, explain };