// 运行时生成托盘图标(16x16 蓝色圆点 PNG), 免随包带图标文件
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 运行时生成托盘图标 PNG, 免随包带图标文件。
// macOS 菜单栏按点(pt)布局、屏是 2x, 16px 图会发虚; 因此按平台给出
// 不同像素密度: macOS 36px(显示为 18pt 模板图), 其他平台 16px。
function makeTrayIconPng(platform = process.platform) {
  if (platform === 'darwin') return renderTemplateIcon(36);
  return renderIcon(16, 5.2, 6.8);
}

// macOS 菜单栏模板图: 只出纯黑 + alpha, 由系统按菜单栏明暗自动反色。
// 造型为「圆环 + 实心点」的录制指示符, 4x4 超采样抗锯齿, 避免红点白边那种脏边。
function renderTemplateIcon(S) {
  const scale = S / 18;                 // 18pt 设计稿换算到实际像素
  const center = S / 2;
  const outer = 7.2 * scale;            // 圆环外半径
  const ringInner = 6.15 * scale;       // 圆环内半径(环宽 1.05pt, 贴近系统细线图标)
  const dot = 2.95 * scale;             // 中心实心点
  const SAMPLES = 4;
  const raw = Buffer.alloc(S * (1 + S * 4));
  for (let y = 0; y < S; y++) {
    raw[y * (1 + S * 4)] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) / SAMPLES - center;
          const dy = y + (sy + 0.5) / SAMPLES - center;
          const d = Math.hypot(dx, dy);
          if (d <= dot || (d >= ringInner && d <= outer)) hits++;
        }
      }
      const o = y * (1 + S * 4) + 1 + x * 4;
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0;
      raw[o + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderIcon(W, r, ring) {
  const H = W;
  // 红色「录制中」圆点(经典REC样式), 加白色描边在深浅任务栏上都清晰
  const raw = Buffer.alloc(H * (1 + W * 4));
  const c = W / 2 - 0.5, cx = c, cy = c;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let R = 255, G = 68, B = 68, A = 0; // 默认红 #FF4444
      if (d <= r - 1) A = 255;
      else if (d <= r + 0.5) A = Math.round((r + 0.5 - d) * 255);
      else if (d > ring - 1 && d <= ring) { R = 255; G = 255; B = 255; A = 255; } // 白描边
      else if (d > ring && d <= ring + 0.5) { R = 255; G = 255; B = 255; A = Math.round((ring + 0.5 - d) * 255); }
      const o = y * (1 + W * 4) + 1 + x * 4;
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = A;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeTrayIconPng };
