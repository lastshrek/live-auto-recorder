// 抖音平台适配层：enter API 响应 → 统一房间信息
const TIER_RANK = ['_origin', 'FULL_HD1', 'FULL_HD', 'BD', 'UHD', 'HD1', 'SD1', 'SD2'];

function tierScore(key, url) {
  let s = TIER_RANK.indexOf(key);
  if (s < 0) return 99;
  if (/_or/.test(url)) s -= 1; // 原画流优先
  return s;
}

function pickBestFlv(flv) {
  const keys = Object.keys(flv || {});
  if (!keys.length) return '';
  keys.sort((a, b) => tierScore(a, flv[a]) - tierScore(b, flv[b]));
  return flv[keys[0]] || '';
}

// 画质偏好选择:
//   highest  → 原画优先(默认)
//   lowest   → 最省流量的档位, 用于省硬盘
//   其他     → 指定档位, 该档不存在时向下回落
const PREFER_RANK = ['FULL_HD1', 'HD1', 'SD1', 'SD2'];

// 按画质从高到低排序; 未知档位排在最后(不能当成高清)
function sortedByQuality(flv) {
  const keys = Object.keys(flv || {});
  return keys.sort((a, b) => tierScore(a, flv[a]) - tierScore(b, flv[b]));
}

// 取最低画质: 档位表里排最后的那个。
// 若平台只给了一个档位, 那就是它本身 —— 没有更低的可选。
function pickLowestFlv(flv) {
  const keys = sortedByQuality(flv);
  if (!keys.length) return '';
  // 未知档位(score 99)不应因为"排最后"就被当成最低画质,
  // 优先在已知档位里选最低; 全都未知时才退回原始顺序的最后一个。
  const known = keys.filter((k) => tierScore(k, flv[k]) < 99);
  const pick = known.length ? known[known.length - 1] : keys[keys.length - 1];
  return flv[pick] || '';
}

function pickFlv(flv, prefer) {
  const keys = Object.keys(flv || {});
  if (!keys.length) return '';
  if (prefer === 'lowest') return pickLowestFlv(flv);
  if (prefer && prefer !== 'highest') {
    let i = PREFER_RANK.indexOf(prefer);
    for (; i >= 0 && i < PREFER_RANK.length; i++) {
      if (keys.includes(PREFER_RANK[i])) return flv[PREFER_RANK[i]];
    }
  }
  return pickBestFlv(flv);
}

// 统一房间信息: { platform, rid, live, status, title, nickname, flv{档位:url}, hls, best }
function normalizeEnter(json, rid) {
  const d0 = json?.data?.data?.[0] || {};
  const su = d0.stream_url || {};
  const flv = { ...(su.flv_pull_url || {}) };
  return {
    platform: 'douyin',
    rid,
    live: d0.status === 2,
    status: d0.status,
    title: d0.title || '',
    nickname: d0?.owner?.nickname || '',
    secUid: d0?.owner?.sec_uid || json?.data?.user?.sec_uid || '',
    flv,
    hls: su.hls_pull_url || '',
    best: pickBestFlv(flv),
  };
}

// 选流: 优先按画质偏好从 flv 表里选; flv 为空时退回调用方提供的候选地址。
// 注意 fallback 只在 flv 完全为空时使用 —— 不能拿它给某个缺失档位兜底,
// 否则 "最低画质" 会被悄悄换成原画, 与省空间的意图相反。
function resolveStreamUrl(flv, prefer, fallback) {
  const picked = pickFlv(flv, prefer);
  if (picked) return picked;
  return typeof fallback === 'string' ? fallback : '';
}

module.exports = { normalizeEnter, pickBestFlv, pickFlv, pickLowestFlv, resolveStreamUrl };
