'use strict';
const assert=require('node:assert/strict');
function distribution(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return {count:0,p50:null,p90:null,p99:null};
  const q=p=>{const n=(sorted.length-1)*p,a=Math.floor(n),b=Math.ceil(n);return sorted[a]+(sorted[b]-sorted[a])*(n-a);};
  return {count:sorted.length,p50:q(.5),p90:q(.9),p99:q(.99)};
}
function unionDuration(intervals,lo,hi) {
  const sorted=intervals.map(([a,b])=>[Math.max(lo,a),Math.min(hi,b)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
  let total=0,end=lo;
  for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
  return total;
}
function analyze(scene) {
  assert(scene.schema==='reverie.qt.smoothness.scene.v1');
  const origin=Number(scene.originNs),start=scene.measurementStartNs+origin,end=scene.measurementEndNs+origin;
  const frames=scene.frameTiming.frames.filter(row=>row.swapNs>=0);
  const idleIntervals=frames.slice(1).filter((f,i)=>f.swapNs<start&&frames[i].swapNs>=origin)
    .map((f,i)=>{const prior=frames[frames.indexOf(f)-1];return (f.swapNs-prior.swapNs)/1e6;});
  const reportedPeriod=1000/scene.screenRefreshRateHz;
  const shortIdle=idleIntervals.filter(v=>v>=reportedPeriod*.65&&v<reportedPeriod*1.35);
  const measuredPeriod=distribution(shortIdle).p50;
  const period=measuredPeriod||reportedPeriod;
  const trace=scene.timingTrace||{}, records=trace.records||[];
  const kindIndex=(trace.kindNames||[]).indexOf('NotifyEvent'),begins=new Map(),spans=[];
  for(const r of records) {
    if(r.kind!==kindIndex||!r.isGui)continue;
    const at=Number(trace.startedNs)+r.elapsedNs;
    if(r.edge===1)begins.set(r.spanId,at);
    else if(r.edge===2&&begins.has(r.spanId))spans.push([begins.get(r.spanId),at]);
  }
  const gpu=scene.gpu?.frames||[];
  const samples=[];
  for(let i=1;i<frames.length;i++){
    const row=frames[i],previous=frames[i-1];
    if(previous.swapNs<start||row.swapNs>end)continue;
    const values=[previous.swapNs,row.beforeSyncNs,row.afterSyncNs,row.beforeRenderNs,row.afterRenderNs,row.swapNs];
    const ordered=values.every(Number.isFinite)&&!values.some((v,i)=>i&&v<values[i-1]);
    const gap=row.beforeSyncNs-previous.swapNs;
    const active=ordered?unionDuration(spans,previous.swapNs,row.beforeSyncNs):0;
    const stages=ordered?{preSyncEvent:active/1e6,preSyncUnobserved:(gap-active)/1e6,sync:(row.afterSyncNs-row.beforeSyncNs)/1e6,
      renderPreparation:(row.beforeRenderNs-row.afterSyncNs)/1e6,renderSubmission:(row.afterRenderNs-row.beforeRenderNs)/1e6,
      afterRenderToSwap:(row.swapNs-row.afterRenderNs)/1e6}:{};
    const near=gpu.filter(g=>Math.abs(g.frameBeginNs-row.beginNs)<1e6);
    const aligned=near.length===1?near[0]:null;
    const events=scene.events.filter(e=>e.atNs+origin>=previous.swapNs&&e.atNs+origin<=row.swapNs).map(e=>e.kind);
    const interval=(row.swapNs-previous.swapNs)/1e6;
    samples.push({frameId:row.frameId,intervalMs:interval,long:interval>1.5*period,stages,
      stageUnavailable:!ordered,dominant:ordered?Object.entries(stages).sort((a,b)=>b[1]-a[1])[0][0]:'unavailable',events:[...new Set(events)],
      gpuMs:scene.gpuValidated&&aligned?.valid?Number(aligned.gpuDurationNs)/1e6:null});
  }
  const long=samples.filter(s=>s.long), dominant={},triggers={},multiples={};
  for(const row of samples){
    const multiple=Math.max(1,Math.round(row.intervalMs/reportedPeriod));
    const key=Math.abs(row.intervalMs/reportedPeriod-multiple)<.2?String(multiple):'off-grid';
    multiples[key]=(multiples[key]||0)+1;
  }
  for(const row of long){
    dominant[row.dominant]=(dominant[row.dominant]||0)+1;
    for(const event of row.events.length?row.events:['no-observed-trigger'])triggers[event]=(triggers[event]||0)+1;
  }
  const cadence=[];
  for(let lag=1;lag<=60&&lag<samples.length/4;lag++){
    const mean=long.length/samples.length;
    const variance=samples.reduce((n,s)=>n+(Number(s.long)-mean)**2,0);
    if(variance)cadence.push({lagFrames:lag,correlation:samples.slice(lag).reduce((n,s,i)=>n+(Number(s.long)-mean)*(Number(samples[i].long)-mean),0)/variance});
  }
  return {frameIntervalMs:distribution(samples.map(s=>s.intervalMs)),reportedPeriodMs:reportedPeriod,
    measuredIdlePeriodMs:measuredPeriod,idleSamples:shortIdle.length,longThresholdMs:1.5*period,
    thresholdSource:measuredPeriod?'idle-swap-short-interval-median':'reported-refresh-period-fallback',
    longFrames:long.length,longFraction:samples.length?long.length/samples.length:null,
    dominant,triggerCounts:triggers,refreshMultiples:multiples,
    strongestLag:cadence.sort((a,b)=>b.correlation-a.correlation)[0]||null,
    stageMs:Object.fromEntries([...new Set(samples.flatMap(s=>Object.keys(s.stages)))].map(k=>[k,distribution(samples.map(s=>s.stages[k]))])),
    gpuMs:distribution(samples.map(s=>s.gpuMs).filter(Number.isFinite)),samples,
    traceComplete:trace.compiled===true&&!trace.essentialFailure&&!trace.incompleteSpans,
    incompleteFrames:scene.frameTiming.dropped,unavailablePhaseFrames:samples.filter(s=>s.stageUnavailable).length,
    limitations:['Wall-clock callback spans include observer cost.',
      'Pre-sync unobserved time includes idle waits; event spans are not CPU utilization.',
      'GPU elapsed time may contain waits. GPU figures are not exclusive of CPU categories.',
      'Refresh multiples use QScreen rate; swap callbacks do not establish physical scanout.']};
}
module.exports={distribution,unionDuration,analyze};
