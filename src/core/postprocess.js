// 后处理队列: 录制结束后统一收尾(超大录像拆分), 不再生成弹幕烧录版。
// 本模块只做队列编排与文件读写, 所有 ffmpeg 执行都经由 Recorder 内部的白名单封装
const fs = require('node:fs');
const log = require('../util/log');
const {splitRecorder}=require('./upload-split');

// 退出时取消尚未完成的阶段；正常暂停通过挂起进程保留进度。
class PauseSignal extends Error {
  constructor() { super('用户暂停'); this.name = 'PauseSignal'; }
}

class PostProcessor {
  constructor(settings) {
    this.s = settings; // {keepRaw, postConcurrency}
    this.queue = [];
    this.running = new Set(); // 并发车道上的任务
    this._seq = 0;
    this.current = null; // 兼容引用(最近启动的任务)
    this.onUpdate = () => {};
    this.history = [];
    this.items = []; // 可视化任务项(含已完成, 上限30)
    this.watchdog=setInterval(()=>this._drain(),5000);this.watchdog.unref?.();
  }

  // 并发车道数(设置实时生效): 1=与旧版串行行为一致
  concurrencyTarget() {
    return Math.max(1, Math.min(4, Number(this.s && this.s.postConcurrency) || 1));
  }

  get activeCount(){return [...this.running].filter(job=>!job.paused).length;}
  get busy() { return this.activeCount > 0; }

  get status() {
    const active = this.items.filter(v => ['processing', 'queued'].includes(v.status));
    const pausedCount = this.items.filter(v => v.status === 'paused').length;
    return {
      busy: this.busy || active.length > 0,
      current: active.length ? { name: active[0].name, stage: active[0].stage } : null,
      pending: this.queue.length,
      concurrency: this.concurrencyTarget(),
      running: this.activeCount,
      pausedCount,
      quiet: this.quietInfo ? this.quietInfo() : {active:false},
      items: this.items.map((v) => ({ ...v })),
    };
  }

  get hasRunnable() { return this.queue.some(job=>!job.paused&&(!this.canStart||this.canStart(job))); }

  begin(recorder, nickname) {
    const view = { name: nickname || '', partsTotal: recorder.part || 1,
      partsDone: 0, partIdx: 0, partPct: 0, status: 'processing',
      stage: '正在收尾', error: '', at: Date.now() };
    this.items.push(view);
    const completed = this.items.filter(v => ['done','recovered','skipped'].includes(v.status));
    for (const old of completed.slice(0, Math.max(0, this.items.length - 30))) this.items.splice(this.items.indexOf(old), 1);
    this.bindProgress(recorder, view);
    this.onUpdate();
    return view;
  }

  bindProgress(recorder, view) {
    recorder.onStage = stage => { recorder.processingStage=stage;if(view.status!=='paused'){view.stage = stage; view.progress = null;this.onUpdate();} };
    recorder.onProgress = progress => { if(view.status!=='paused'){view.progress = progress; this.onUpdate();} };
    recorder.onResourceWait=()=>{if(view.status!=='paused'){view.stage='等待处理资源';this.onUpdate();}};
    recorder.onResourceReady=()=>{if(view.status!=='paused'){view.stage=recorder.processingStage||'正在处理';this.onUpdate();}};
  }

  finish(view, status, error = '') {
    if (!view) return;
    view.status = status; view.error = error; view.stage = ''; view.progress = null;
    this.onUpdate();
  }

  enqueue(job) {
    const duplicate=[...this.queue,...this.running].find(j=>j.id&&j.id===job.id);
    if(duplicate)return duplicate;
    // job: {recorder, nickname}
    if (!job.postId) job.postId = 'q' + (++this._seq) + '-' + Date.now().toString(36);
    // 可视化任务项: 队列/进度/完成状态
    job.view = job.view || this.begin(job.recorder, job.nickname);
    job.view.postId = job.postId;
    Object.assign(job.view, {
      name: job.view.name || job.nickname || '',
      partsTotal: job.recorder.part || 1,
      partsDone: 0,
      partIdx: 0,
      partPct: 0,
      status: job.paused ? 'paused' : 'queued', // queued | processing | paused | done | failed
      progress: null,
      stage: job.paused ? '已暂停' : '等待收尾处理',
      error: '',
      at: Date.now(),
    });
    this.queue.push(job);
    this.onUpdate();
    this._drain();
    return job;
  }

  // 单任务暂停：挂起媒体进程，保留当前输出，释放执行名额。
  pauseTask(id) {
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    const job = this._find(id);
    if (!job) return { ok: false, error: '未找到该任务' };
    if (job.paused&&!job.resuming) return { ok: true };
    if(job.resuming)job.resumeCanceled=true;
    try{job.recorder.pauseProcessing?.();}catch(e){return {ok:false,error:e.message};}
    job.paused = true;
    job.pausedStage=job.view?.stage;
    if (job.view) { job.view.status = 'paused'; job.view.stage = '已暂停'; }
    this.onState?.(job,'paused');
    this.onUpdate();
    this._drain();
    return { ok: true };
  }

  // 单任务恢复：获得资源后恢复同一媒体进程。
  async resumeTask(id) {
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    const job = this._find(id);
    if (!job) return { ok: false, error: '未找到该任务' };
    if (!job.paused) return { ok: true };
    if(job.resuming)return {ok:false,error:'任务正在等待恢复资源'};
    job.resuming=true;job.resumeCanceled=false;let resumed;
    try{resumed=await job.recorder.resumeProcessing?.();}catch(e){return {ok:false,error:e.message};}finally{job.resuming=false;}
    if(job.resumeCanceled||resumed===false)return {ok:true,paused:true};
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    job.paused = false;
    if (job.view) { job.view.status = this.running.has(job)?'processing':'queued'; job.view.stage = this.running.has(job)?job.pausedStage||'正在处理':'排队等待'; }
    this.onState?.(job,this.running.has(job)?'processing':'queued');
    this.onUpdate();
    this._drain();
    return { ok: true };
  }

  // 调整排队顺序(仅队列中的任务可移动)
  moveTask(id, dir) {
    const i = this.queue.findIndex(j => j.postId === id);
    if (i < 0) return { ok: false, error: '仅排队中的任务可调整顺序' };
    const t = i + (dir === 'up' ? -1 : 1);
    if (t < 0 || t >= this.queue.length) return { ok: false, error: '已到队首/队尾' };
    [this.queue[i], this.queue[t]] = [this.queue[t], this.queue[i]];
    this.onUpdate();
    return { ok: true };
  }

  _find(id) {
    return this.queue.find(j => j.postId === id||j.id===id) || [...this.running].find(j => j.postId === id||j.id===id);
  }

  // 并发车道池: 每车道串行处理一个任务; 车道数=设置 postConcurrency(1=旧版串行行为)
  _drain() {
    if(this.deferOnExit)return;
    const max = this.concurrencyTarget();
    while (this.activeCount < max) {
      const index = this.queue.findIndex(job => !job.paused && (!this.canStart || this.canStart(job)));
      if (index < 0) {
        if (this.running.size === 0) {
          for (const pending of this.queue) if (pending.view?.status !== 'quiet' && !pending.paused) this.onDeferred?.(pending);
        }
        break;
      }
      const [job] = this.queue.splice(index, 1);
      this.running.add(job);
      this.onStart?.(job);
      this.current = job;
      if (job.view) { job.view.status = 'processing'; job.view.stage = '准备收尾'; }
      this.onUpdate();
      this._runLane(job);
    }
    this.onUpdate();
  }

  async _runLane(job, lane) {
    try {
      const result = await this._process(job, lane);
      if(job.canceled||job.exitDeferred)throw new Error('任务已停止');
      const warnings=job.recorder.issues||[],notices=job.recorder.notices||[];
      this.finish(job.view, warnings.length ? 'warning' : notices.length?'recovered':result && result.skipped ? 'skipped' : 'done', warnings.join('; ')||notices.join('; '));
      if(this.onResult)this.onResult(job,null,result);
    } catch (e) {
      if(job.canceled||job.exitDeferred){} else if (e instanceof PauseSignal) {
        // 回队首: 恢复时优先续处理
        this.finish(job.view, 'paused', '已暂停');
        this.queue.unshift(job);
      } else {
        this.finish(job.view, 'failed', String(e.message).slice(0, 180));
        log.error('[post] 任务失败:', e.message);
        try{if(this.onResult)this.onResult(job,e);}catch(error){log.error('[post] 失败状态保存异常:',error.message);}
      }
    }
    job.recorder.onStage = null;
    job.recorder.onProgress = null;
    job.recorder.onResourceWait=null;job.recorder.onResourceReady=null;
    this.running.delete(job);
    if (this.current === job) this.current = null;
    this.onUpdate();
    this._drain();
  }
  prepareExit(){this.shuttingDown=true;this.deferOnExit=true;for(const job of this.running){job.exitDeferred=true;job.recorder._exitDeferred=true;job.recorder._processingPaused=false;job.recorder._abortFfmpeg?.();}this.queue.length=0;}
  prepareShutdown(){this.shuttingDown=true;for(const job of this.running)if(job.paused){job.recorder._userAbort=true;job.recorder._abortFfmpeg?.();}}
  close(){clearInterval(this.watchdog);}

  // 录制链路已把分片转封装为 MP4; 此处只做超大录像的上传分段拆分。
  async _process(job, lane) {
    const { recorder } = job;
    const settings = job.settings || this.s;
    if (job.paused) throw new PauseSignal();
    await recorder.recoverPublications?.();
    if (job.paused) throw new PauseSignal();
    // 单文件强保证: FLV层拼接若失败, 此处在MP4层再拼一次(多段→单文件后再拆分)
    if (!job.mergeComplete && settings.autoPartMerge && recorder.part > 1 && !(recorder.issues && recorder.issues.length)) {
      try { await recorder.consolidateMp4s(); } catch (e) { log.warn('[post] MP4兜底合并异常(按原分片处理)', e && e.message); }
    }
    if(typeof recorder.mp4Path==='function')await splitRecorder(recorder);
    return { skipped: false };
  }
}

module.exports = { PostProcessor, PauseSignal };