// 配置与持久化
const fs = require('node:fs');
const path = require('node:path');
const {writeJson}=require('../util/atomic-json');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT = {
  watchlist: [], // [{ rid, secUid?, name?, maxSec?, titleFilter?, hours? }]
  companies: [],
  ungroupedCollapsed: false,
  settings: {
    pollIntervalSec: 3,
    outputDir: 'recordings',
    minFreeGB: 5,
    maxConcurrentRecordings: 6,
    keepRaw: true,     // 兼容旧配置字段; 当前版本只产出单一录像文件, 该值不再影响产物
    segment: '0',      // 默认整场保存, 0=不分段
    quality: 'highest', // 画质偏好: highest=最高(原画), lowest=最低(省空间), 或指定 FULL_HD1/HD1/SD1/SD2
    minSizeMB: 0,      // 默认保留并处理短场内容
    autoPartMerge: true, // 相邻分片自动合并(断流重连/轮换的分片无缝并回一个文件, 对齐 biliLive-tools)
    preventSleep: false, // 录制期间阻止系统休眠
    postConcurrency: 2, // 媒体处理共享上限；录制时至多2路，拉流停滞时降至1路
    segmentMin: 30,    // 旧字段, 仅向后兼容(读取时迁移到 segment)
    keepDays: 0,       // 录像保留天数(0=永久)
    webhookUrl: '',    // 事件通知(开播/录完/磁盘), POST JSON
    autoStart: false,  // 开机自启
    postQuietEnabled: false,
    postQuietStart: '23:00',
    postQuietEnd: '08:00',
    autoTranscribe: false, // 录完自动转字幕(默认关：转写吃 CPU，不能悄悄替用户开)
  },
};

function load() {
  let c = null;
  let recovered=false;
  const parsed = readConfigWithRetry();
  if (parsed.ok) {
    c = parsed.value;
  } else {
    // 重试仍失败才判定为损坏。留证后回退 .bak → 默认。
    // 合法 JSON 语法错误与结构非法都算损坏; 瞬时 I/O 错误绝不重命名、绝不用默认值覆盖。
    if (parsed.transient) {
      const fallback = tryReadJson(CONFIG_PATH + '.bak');
      if (fallback) { c = fallback; recovered = true; }
      else {
        // 读不到又无备份: 只返回内存默认值, 不写盘 —— 保留磁盘上的原文件等待下次成功读取
        // 纯配置层不引入日志依赖(便于隔离测试): 用 stderr 留一条可追溯线索
        console.error('[config] 配置暂时无法读取，本次使用默认值且不改写文件:', parsed.error && parsed.error.message);
        return mergeConfig(structuredClone(DEFAULT), false, {noSave:true});
      }
    } else {
      if(parsed.error?.code!=='ENOENT')try { fs.renameSync(CONFIG_PATH, CONFIG_PATH + '.corrupt-' + Date.now()); } catch {}
      const fallback = tryReadJson(CONFIG_PATH + '.bak');
      if (fallback) { c = fallback; recovered = true; }
      else { save(structuredClone(DEFAULT)); return structuredClone(DEFAULT); }
    }
  }
  return mergeConfig(c,recovered);
}

// 读取并解析配置。原子写(临时文件+rename)保证读到的一定是完整旧版或新版,
// 但外部工具可能直接截断重写同一文件 —— 此时短暂重试即可读到完整内容。
function readConfigWithRetry(){
  let lastError=null;
  for(let attempt=0;attempt<4;attempt++){
    if(attempt)syncSleep(25);
    let raw;
    try{ raw=fs.readFileSync(CONFIG_PATH,'utf8'); }
    catch(e){ lastError=e; if(e.code==='ENOENT')break; continue; } // 文件被替换的瞬间会短暂 ENOENT
    try{
      const value=JSON.parse(raw);
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置结构无效');
      return {ok:true,value};
    }catch(e){ lastError=e; }
  }
  // 语法/结构错误视为损坏; 其余(EMFILE/EACCES/EIO 等)是瞬时故障
  const corrupt=!!lastError&&(/JSON|结构无效|Unexpected|position \d+/.test(String(lastError.message)));
  return {ok:false,transient:!corrupt,error:lastError};
}
function tryReadJson(file){
  try{const value=JSON.parse(fs.readFileSync(file,'utf8'));return (value&&typeof value==='object'&&!Array.isArray(value))?value:null;}catch{return null;}
}
// 同步睡眠: 仅用于启动/热重载路径的短暂重试
function syncSleep(ms){
  try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{const end=Date.now()+ms;while(Date.now()<end);}
}

// 合并默认值 + 归一化 + 迁移。读取路径与重试路径共用, 避免两套逻辑漂移。
// noSave: 本次结果只用于内存(磁盘上的配置暂时读不到), 任何情况下都不写回。
function mergeConfig(c,recovered,{noSave=false}={}){
  const merged = {
    ...structuredClone(DEFAULT),
    ...c,
    settings: { ...DEFAULT.settings, ...(c.settings || {}) },
  };
  if(!Array.isArray(merged.watchlist))merged.watchlist=[];
  merged.watchlist=merged.watchlist.filter(w=>w&&typeof w==='object'&&!Array.isArray(w));
  merged.companies=require('./companies').normalizeCompanies(merged.companies);
  const ranges={pollIntervalSec:[1,10],minFreeGB:[0,500],maxConcurrentRecordings:[1,20],minSizeMB:[0,100000],keepDays:[0,3650]};
  for(const [key,[min,max]] of Object.entries(ranges)){
    const n=Number(merged.settings[key]);merged.settings[key]=Number.isFinite(n)?Math.max(min,Math.min(max,n)):DEFAULT.settings[key];
  }
  for(const key of ['keepRaw','autoPartMerge','preventSleep','autoStart','postQuietEnabled'])if(typeof merged.settings[key]!=='boolean')merged.settings[key]=DEFAULT.settings[key];
  const {validClock}=require('./quiet-hours');
  for(const key of ['postQuietStart','postQuietEnd'])if(!validClock(merged.settings[key]))merged.settings[key]=DEFAULT.settings[key];
  if(merged.settings.postQuietStart===merged.settings.postQuietEnd)merged.settings.postQuietEnabled=false;
  if(typeof merged.settings.outputDir!=='string'||!merged.settings.outputDir.trim()||merged.settings.outputDir.includes('\0'))merged.settings.outputDir=DEFAULT.settings.outputDir;
  // 旧配置迁移: segmentMin(数字分钟) → segment(字符串, 双模式)
  if ((c?.settings?.segment === undefined && c?.settings?.segmentMin !== undefined) || merged.settings.segment === '') {
    merged.settings.segment = String(merged.settings.segmentMin ?? DEFAULT.settings.segment);
  }
  if(!/^(0|[1-9]\d{0,4})(\.\d+)?\s*(B|KB|MB|GB)?$/i.test(String(merged.settings.segment)))merged.settings.segment=DEFAULT.settings.segment;
  // watchlist 去重收敛(历史bug曾把同一房间重复写入数千条): 按rid(或纯secUid)归一
  const before = Array.isArray(merged.watchlist) ? merged.watchlist.length : 0;
  if (before > 1) {
    const best = new Map();
    for (const w of merged.watchlist) {
      const k = String(w.rid || '') || 'sec:' + String(w.secUid || '');
      if (!k || k === 'sec:') continue;
      const cur = best.get(k);
      if (!cur) { best.set(k, w); continue; }
      // 字段级合并: 逐字段非空优先(整体 spread 会让空串覆盖有效值)
      const item = { ...cur };
      for (const f of ['rid', 'secUid', 'name', 'nickname', 'titleFilter', 'hours', 'maxSec', 'companyId']) {
        const v = item[f];
        if (v === undefined || v === '' || v === 0) {
          const nv = w[f];
          if (nv !== undefined && nv !== '' && nv !== 0) item[f] = nv;
        }
      }
      best.set(k, item);
    }
    merged.watchlist = [...best.values()];
    // 仅当去重真正减少条数时才写回: 无条件save会改mtime→热重载循环触发(读一次写一次)
    if (merged.watchlist.length !== before && !noSave) {
      try { save(merged); } catch {}
    }
  }
  if(recovered&&!noSave){try{writeJson(CONFIG_PATH,merged,{space:2});}catch{}}
  return merged;
}

// 原子写: 先写临时文件再 rename 替换(直接 writeFileSync 崩溃/断电会留截断 JSON → 下次启动僵尸)
function save(cfg) {
  writeJson(CONFIG_PATH,cfg,{backup:true,space:2});
}

module.exports = { ROOT, CONFIG_PATH, load, save };
