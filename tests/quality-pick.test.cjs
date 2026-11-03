const test=require('node:test'),assert=require('node:assert/strict');
const {pickFlv,pickBestFlv,normalizeEnter}=require('../src/core/adapter/douyin');

const FULL={_origin:'o',FULL_HD1:'fh',HD1:'hd1',SD1:'sd1',SD2:'sd2'};

test('lowest always returns the smallest available tier',()=>{
 assert.equal(pickFlv(FULL,'lowest'),'sd2');
 assert.equal(pickFlv({FULL_HD1:'fh',HD1:'hd1',SD1:'sd1'},'lowest'),'sd1','SD2 缺失时退到 SD1');
 assert.equal(pickFlv({FULL_HD1:'fh',HD1:'hd1'},'lowest'),'hd1','只有高清档时用它');
 assert.equal(pickFlv({SD1:'only'},'lowest'),'only','只有一个档位时就用它');
});

test('lowest never falls back to the highest tier',()=>{
 // 这是关键: 旧实现指定档位缺失时会回落到 pickBestFlv(原画), 与省空间目的相反
 const noLow={_origin:'o',FULL_HD1:'fh',HD1:'hd1'};
 const got=pickFlv(noLow,'lowest');
 assert.notEqual(got,'o','绝不能回落到原画');
 assert.equal(got,'hd1');
});

test('an unknown tier is not mistaken for the lowest quality',()=>{
 // 未知档位 score=99 会排在最后, 但不能因此被当成"最低画质"
 assert.equal(pickFlv({FULL_HD1:'fh',SD2:'sd2',MYSTERY:'m'},'lowest'),'sd2');
 // 全部未知时只能退回原始顺序的最后一个
 assert.equal(pickFlv({A:'a',B:'b'},'lowest'),'b');
});

test('highest behaviour is unchanged',()=>{
 assert.equal(pickFlv(FULL,'highest'),'o');
 assert.equal(pickBestFlv(FULL),'o');
 assert.equal(pickFlv({HD1:'hd1',SD1:'sd1'},'highest'),'hd1');
});

test('an explicit tier falls back downward as before',()=>{
 assert.equal(pickFlv(FULL,'SD2'),'sd2');
 // 指定 HD1 但它缺失 -> 沿 PREFER_RANK 往下找到 SD1
 assert.equal(pickFlv({FULL_HD1:'fh',SD1:'sd1'},'SD1'),'sd1');
 assert.equal(pickFlv({FULL_HD1:'fh',HD1:'hd1'},'HD1'),'hd1');
 // 注意: SD2 已是 PREFER_RANK 末位, 无更低档可落, 会回落到最高档 —— 这是
 // 既有行为(未在本次改动范围内)。要"最省空间"请用 lowest, 它不会这样回落。
 assert.equal(pickFlv({FULL_HD1:'fh',HD1:'hd1'},'SD2'),'fh');
});

test('an empty stream list yields an empty url for every preference',()=>{
 for(const prefer of ['lowest','highest','SD2',undefined])assert.equal(pickFlv({},prefer),'');
 assert.equal(pickFlv(null,'lowest'),'');
});

test('normalizeEnter keeps best as the highest tier while lowest is available on demand',()=>{
 const mk=(stream_url)=>normalizeEnter({data:{data:[{status:2,title:'t',owner:{nickname:'n'},stream_url}]}},'1');
 const info=mk({flv_pull_url:{FULL_HD1:'origin',SD2:'sd2'}});
 assert.equal(info.best,'origin','best 仍表示最高档, 供需要原画的场景使用');
 assert.equal(pickFlv(info.flv,'lowest'),'sd2');
 // 只给 hls 时两者都为空, 不会因为去掉 best 兜底而产生行为退化
 const hlsOnly=mk({hls_pull_url:'https://x/hls'});
 assert.equal(hlsOnly.best,'');
 assert.equal(pickFlv(hlsOnly.flv,'lowest'),'');
});
test('resolveStreamUrl only uses the fallback when no flv tiers exist at all',()=>{
 const {resolveStreamUrl}=require('../src/core/adapter/douyin');
 // flv 有档位: 严格按偏好选, fallback 不参与, 避免"最低画质"被换成原画
 assert.equal(resolveStreamUrl({FULL_HD1:'fh',HD1:'hd1'},'lowest','origin'),'hd1');
 assert.equal(resolveStreamUrl({FULL_HD1:'fh',HD1:'hd1'},'highest','x'),'fh');
 // flv 完全为空: 才允许用候选地址, 否则会误报"没有可用拉流地址"
 assert.equal(resolveStreamUrl({},'lowest','origin'),'origin');
 assert.equal(resolveStreamUrl(null,'lowest','origin'),'origin');
 // 都没有就是空
 assert.equal(resolveStreamUrl({},'lowest',''),'');
 assert.equal(resolveStreamUrl({},'lowest',undefined),'');
});