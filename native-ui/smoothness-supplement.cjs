'use strict';
const assert = require('node:assert/strict');
const {distribution, unionDuration, analyze} = require('./smoothness-analysis.cjs');

const SCHEMA = 'reverie.qt.smoothness.supplement-parameters.v1';
const RUNS = Object.freeze([
  {key:'supplement-01-baseline-S1',scenario:'S1',variant:'baseline',build:'supplement',gpuTiming:false},
  {key:'supplement-02-baseline-S2',scenario:'S2',variant:'baseline',build:'supplement',gpuTiming:false},
  {key:'supplement-03-reduced-S1',scenario:'S1',variant:'reduced-transparency',build:'supplement',gpuTiming:false},
  {key:'supplement-04-background-off-S1',scenario:'S1',variant:'drawer-background-off',build:'supplement',gpuTiming:false},
  {key:'supplement-05-baseline-S1',scenario:'S1',variant:'baseline',build:'supplement',gpuTiming:false},
]);
const CRITERIA = Object.freeze({driftPercentagePoints:3, dominantLayerRatio:.5, postSwapTailP99Ms:1});
function validateParameters(parameters, original) {
  assert.equal(parameters.schema, SCHEMA);
  assert.equal(parameters.package, 'smoothness-20261115');
  assert.deepEqual(parameters.runs, RUNS, 'SMOOTHNESS_SUPPLEMENT_ORDER');
  assert.deepEqual(parameters.scenarios, {S1:original.scenarios.S1,S2:original.scenarios.S2}, 'SMOOTHNESS_SUPPLEMENT_SCENARIOS');
  assert.deepEqual(parameters.longFrame, original.longFrame, 'SMOOTHNESS_SUPPLEMENT_LONG_FRAME');
  assert.deepEqual(parameters.criteria, CRITERIA, 'SMOOTHNESS_SUPPLEMENT_CRITERIA');
  assert.equal(parameters.initialWindowMs,250);
  assert.equal(parameters.actionIntervalPolicy,'both-swaps-inside-one-action; swap-count-half-open');
  return parameters;
}
function gpuTimingEnabled(selected, control) {
  assert(selected.gpuTiming === undefined || typeof selected.gpuTiming === 'boolean', 'SMOOTHNESS_GPU_OPTION_TYPE');
  return selected.gpuTiming !== false && control.measurementValid === true;
}
function validateGpuOff(scene) {
  assert.equal(scene.gpu?.collected,false,'SMOOTHNESS_GPU_NOT_DISABLED');
  assert.equal(scene.gpuValidated,false,'SMOOTHNESS_GPU_NOT_DISABLED');
  const scan=value=>{
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)) {
      if(key==='glCalls')assert(Array.isArray(child)&&child.length===0,'SMOOTHNESS_UNEXPECTED_GL_RECORDS');
      else scan(child);
    }
  };
  scan(scene);
  assert.equal(scene.diagnostics?.gpuTimer?.queriesIssued,0,'SMOOTHNESS_PERF_GPU_QUERIES');
  assert.equal(scene.diagnostics?.gpuTimer?.status,'disabled','SMOOTHNESS_PERF_GPU_STATUS');
  assert.deepEqual(scene.diagnostics?.gpuTimer?.samples,[],'SMOOTHNESS_PERF_GPU_SAMPLES');
  return {collected:false,glCallRecords:0,perfQueriesIssued:0};
}
function validateVariant(scene, selected) {
  const proof=scene.variantReadback;
  assert(proof?.variant===selected.variant && proof.before?.surfaceCount===3, 'SMOOTHNESS_SUPPLEMENT_VARIANT_BEFORE');
  const reduced=selected.variant==='reduced-transparency',backgroundOff=selected.variant==='drawer-background-off';
  const after=proof.applied;
  assert(after && after.surfaceCount===(backgroundOff?0:3) && after.reducedTransparency===reduced &&
    after.effectsActive===!reduced && after.pixelRatio===proof.before.pixelRatio &&
    proof.before.effectsActive===true && proof.before.reducedTransparency===false,
    'SMOOTHNESS_SUPPLEMENT_VARIANT_READBACK');
  if(backgroundOff)assert(proof.finished?.surfaceCount===0,'SMOOTHNESS_SUPPLEMENT_VARIANT_NOT_RETAINED');
  return proof;
}
function upperBound(values, key) {
  let lo=0,hi=values.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(values[mid]<=key)lo=mid+1;else hi=mid;}
  return lo;
}
function indexIntervals(input) {
  const rows=[...input].sort((a,b)=>a.start-b.start||b.end-a.end);
  const starts=rows.map(r=>r.start),maximum=[];
  for(let i=0;i<rows.length;++i)maximum.push(Math.max(rows[i].end,maximum[i-1]??-Infinity));
  return {rows,overlap(lo,hi){
    const found=[];
    for(let i=upperBound(starts,hi)-1;i>=0&&maximum[i]>lo;--i)
      if(rows[i].end>lo&&rows[i].start<hi)found.push(rows[i]);
    return found;
  },containing(at){return this.overlap(at-.01,at+.01).filter(r=>r.start<=at&&r.end>=at)
    .sort((a,b)=>b.start-a.start||a.end-b.end)[0]||null;}};
}
function traceIntervals(trace) {
  const kind=Object.fromEntries((trace.kindNames||[]).map((n,i)=>[n,i]));
  const origin=Number(trace.startedNs),open=new Map(),events=[],blocks=[];
  let blocked=null;
  for(const r of trace.records||[]) {
    if(!r.isGui)continue;
    const at=origin+r.elapsedNs;
    if(r.kind===kind.NotifyEvent) {
      if(r.edge===1)open.set(r.spanId,{start:at,type:r.a,window:r.b===1,parent:r.parentSpanId,spanId:r.spanId});
      else if(r.edge===2&&open.has(r.spanId)) {
        const begin=open.get(r.spanId);open.delete(r.spanId);
        if(at>=begin.start)events.push({...begin,end:at,name:trace.eventTypeNames?.[String(begin.type)]||`event-${begin.type}`});
      }
    } else if(r.kind===kind.DispatcherAboutToBlock)blocked=at;
    else if(r.kind===kind.DispatcherAwake&&blocked!==null){if(at>=blocked)blocks.push({start:blocked,end:at});blocked=null;}
  }
  return {events:indexIntervals(events),updates:indexIntervals(events.filter(r=>r.type===77&&r.window)),
    blocks:indexIntervals(blocks),unclosed:[...open.values()],incompleteSpans:trace.incompleteSpans||0,
    essentialFailure:!!trace.essentialFailure,unclosedIdle:blocked!==null};
}
// Split the gap by endpoints so nested event-loop waits are never double
// counted as active event work. These remain wall-clock boundaries, not CPU use.
function partitionGap(lo,hi,previousUpdate,currentUpdate,trace) {
  const selected=[];
  if(previousUpdate)selected.push({start:lo,end:Math.min(hi,previousUpdate.end),label:'postSwapTail',priority:0});
  if(currentUpdate)selected.push({start:Math.max(lo,currentUpdate.start),end:hi,label:'updateBeforeFrame',priority:1});
  for(const r of trace.blocks.overlap(lo,hi))selected.push({...r,label:'eventLoopBlocked',priority:2});
  for(const r of trace.events.overlap(lo,hi)) {
    if(r.type===77&&r.window)continue;
    selected.push({...r,label:'event:'+r.name,priority:3});
  }
  const cuts=[lo,hi];
  for(const r of selected)if(r.end>r.start){cuts.push(Math.max(lo,r.start),Math.min(hi,r.end));}
  cuts.sort((a,b)=>a-b);
  const totals={};
  for(let i=1;i<cuts.length;++i) {
    const a=cuts[i-1],b=cuts[i];if(b<=a)continue;
    const active=selected.filter(r=>r.start<=a&&r.end>=b)
      .sort((x,y)=>x.priority-y.priority||y.start-x.start||x.end-y.end);
    const label=active[0]?.label||'unobserved';totals[label]=(totals[label]||0)+b-a;
  }
  return totals;
}
function actions(scene) {
  const origin=Number(scene.originNs),result=[];
  if(scene.scenario==='S1') {
    const open=new Map();
    for(const event of scene.events) {
      if(['drawer-open','drawer-close'].includes(event.kind)) {
        const id=[event.feature,event.cycle,event.kind].join(':');assert(!open.has(id));open.set(id,event);
      } else if(['drawer-open-complete','drawer-close-complete'].includes(event.kind)) {
        const kind=event.kind.replace('-complete',''),id=[event.feature,event.cycle,kind].join(':');
        const start=open.get(id);assert(start,'SMOOTHNESS_ACTION_START_MISSING');open.delete(id);
        result.push({id,start:origin+start.atNs,end:origin+event.atNs,input:'QTest mouse click'});
      }
    }
    assert.equal(open.size,0,'SMOOTHNESS_ACTION_END_MISSING');
  } else if(scene.scenario==='S2') {
    let start=null;
    for(const event of scene.events) {
      if(event.kind==='navigation' && !(event.feature==='chat'&&event.subentry==='companion'))start=event;
      else if(event.kind==='page-ready') {
        assert(start,'SMOOTHNESS_PAGE_START_MISSING');
        result.push({id:[event.index,event.feature,event.subentry].join(':'),start:origin+start.atNs,end:origin+event.atNs,
          input:'existing navigation call; return-to-companion has no completion event in phase one and is excluded from action statistics'});start=null;
      }
    }
    assert.equal(start,null,'SMOOTHNESS_PAGE_END_MISSING');
  } else throw Error('SMOOTHNESS_SUPPLEMENT_SCENARIO');
  assert(result.length>0&&result.every(r=>r.end>r.start),'SMOOTHNESS_EMPTY_ACTIONS');
  result.sort((a,b)=>a.start-b.start);
  assert(result.every((r,i)=>!i||r.start>=result[i-1].end),'SMOOTHNESS_OVERLAPPING_ACTIONS');
  return result;
}
function windowStats(frames,start,end,threshold) {
  const swaps=frames.filter(f=>f.swapNs>=start&&f.swapNs<end),intervals=[];
  for(let i=1;i<frames.length;++i){const a=frames[i-1].swapNs,b=frames[i].swapNs;
    if(a>=start&&b<end)intervals.push({frameId:frames[i].frameId,fromMs:(a-start)/1e6,toMs:(b-start)/1e6,intervalMs:(b-a)/1e6});}
  const durationMs=(end-start)/1e6;
  return {durationMs,swaps:swaps.length,swapsPerSecond:swaps.length*1000/durationMs,
    intervals:intervals.length,frameIntervalMs:distribution(intervals.map(r=>r.intervalMs)),
    longFrames:intervals.filter(r=>r.intervalMs>threshold).length,
    longFraction:intervals.length?intervals.filter(r=>r.intervalMs>threshold).length/intervals.length:null,
    sequence:intervals};
}
function analyzeSupplement(scene) {
  assert.equal(scene.schema,'reverie.qt.smoothness.scene.v1');
  const legacy=analyze(scene),threshold=legacy.longThresholdMs,trace=traceIntervals(scene.timingTrace||{});
  const frames=scene.frameTiming.frames.filter(f=>f.swapNs>=0),origin=Number(scene.originNs);
  const first=origin+scene.measurementStartNs,last=origin+scene.measurementEndNs;
  const steps=actions(scene);const actionStats=steps.map(step=>({...step,
    full:windowStats(frames,step.start,step.end,threshold),first250ms:windowStats(frames,step.start,step.start+250e6,threshold)}));
  const fullIntervals=actionStats.flatMap(s=>s.full.sequence),actionDuration=actionStats.reduce((n,s)=>n+s.full.durationMs,0),actionSwaps=actionStats.reduce((n,s)=>n+s.full.swaps,0);
  const samples=[];let unmappedUpdates=0,invalidFrameOrder=0;
  for(let i=1;i<frames.length;++i) {
    const prev=frames[i-1],cur=frames[i];if(prev.swapNs<first||cur.swapNs>last)continue;
    const intervalMs=(cur.swapNs-prev.swapNs)/1e6;
    if(!(prev.swapNs<=cur.beginNs&&cur.beginNs<=cur.afterRenderNs&&cur.afterRenderNs<=cur.swapNs)) {
      ++invalidFrameOrder;samples.push({frameId:cur.frameId,intervalMs,long:intervalMs>threshold,complete:false});continue;
    }
    const previousUpdate=trace.updates.containing(prev.swapNs),currentUpdate=trace.updates.containing(cur.beginNs);
    if(!previousUpdate||!currentUpdate)++unmappedUpdates;
    const ns=partitionGap(prev.swapNs,cur.beginNs,previousUpdate,currentUpdate,trace);
    ns.frameToRenderEnd=cur.afterRenderNs-cur.beginNs;ns.renderEndToSwap=cur.swapNs-cur.afterRenderNs;
    const stages=Object.fromEntries(Object.entries(ns).map(([k,v])=>[k,v/1e6]));
    // A genuine zero tail remains measured zero; missing update mapping remains unknown.
    if(previousUpdate)stages.postSwapTail??=0;
    const sum=Object.values(stages).reduce((a,b)=>a+b,0);
    assert(Math.abs(sum-intervalMs)<1e-5,'SMOOTHNESS_SEGMENT_PARTITION');
    samples.push({frameId:cur.frameId,intervalMs,long:intervalMs>threshold,complete:!!previousUpdate&&!!currentUpdate,
      stages,dominant:Object.entries(stages).sort((a,b)=>b[1]-a[1])[0][0]});
  }
  const stageNames=[...new Set(samples.flatMap(r=>Object.keys(r.stages||{})))].sort();
  const valid=samples.filter(r=>r.complete),long=valid.filter(r=>r.long),dominant={};
  for(const r of long)dominant[r.dominant]=(dominant[r.dominant]||0)+1;
  const perStage=rows=>Object.fromEntries(stageNames.map(k=>[k,distribution(rows.map(r=>r.stages[k]||0))]));
  const tails=valid.map(r=>r.stages.postSwapTail),tail=distribution(tails);
  const allSwaps=frames.filter(f=>f.swapNs>=first&&f.swapNs<last).length;
  return {schema:'reverie.qt.smoothness.supplement-analysis.v1',scenario:scene.scenario,variant:scene.variant,
    overall:{frameIntervalMs:legacy.frameIntervalMs,longFrames:legacy.longFrames,longFraction:legacy.longFraction,
      longThresholdMs:threshold,measuredIdlePeriodMs:legacy.measuredIdlePeriodMs,thresholdSource:legacy.thresholdSource,
      durationMs:(last-first)/1e6,swaps:allSwaps,swapsPerSecond:allSwaps*1e9/(last-first)},
    actionPeriod:{actions:steps.length,durationMs:actionDuration,swaps:actionSwaps,swapsPerSecond:actionSwaps*1000/actionDuration,
      frameIntervalMs:distribution(fullIntervals.map(r=>r.intervalMs)),longFrames:fullIntervals.filter(r=>r.intervalMs>threshold).length,
      longFraction:fullIntervals.length?fullIntervals.filter(r=>r.intervalMs>threshold).length/fullIntervals.length:null},
    actions:actionStats,segments:{coverage:{total:samples.length,valid:valid.length,unmappedUpdates,invalidFrameOrder,
      traceEssentialFailure:trace.essentialFailure,incompleteSpans:trace.incompleteSpans},allMs:perStage(valid),longMs:perStage(long),dominantLong:dominant,samples},
    postSwapTail:{...tail,limitMs:CRITERIA.postSwapTailP99Ms,usableForConclusion:valid.length===samples.length&&samples.length>0&&!trace.essentialFailure&&tail.p99<CRITERIA.postSwapTailP99Ms},
    interpretation:{fixedCriteria:CRITERIA,scope:'Disjoint callback/event-loop wall-clock partition. Idle waits inside nested event loops take priority over an enclosing event. No CPU-utilization or GPU-load claim.',
      intervalPolicy:'Both swap endpoints must lie in one action for its interval metrics; swap counts use [start,end). First250ms is exactly250ms after each recorded action start. S2 uses navigation starts, not new physical clicks.',
      unobserved:'Unmapped or unfinished trace coverage is kept unknown. The final unfinished timer is not synthesized.'}};
}
function classify(baselineFirst,baselineLast,controls) {
  const a=baselineFirst.actionPeriod.longFraction,b=baselineLast.actionPeriod.longFraction;
  assert(Number.isFinite(a)&&Number.isFinite(b),'SMOOTHNESS_BASELINE_EMPTY');
  const drift=Math.abs(a-b)*100>CRITERIA.driftPercentagePoints,average=(a+b)/2;
  const baselinesUsable=baselineFirst.postSwapTail.usableForConclusion&&baselineLast.postSwapTail.usableForConclusion;
  return {criteria:CRITERIA,baselineMeanLongFraction:average,differencePercentagePoints:Math.abs(a-b)*100,drift,
    controls:Object.fromEntries(Object.entries(controls).map(([name,r])=>{
      const observed=r.actionPeriod.longFraction,usable=baselinesUsable&&r.postSwapTail.usableForConclusion&&Number.isFinite(observed);
      return [name,{longFraction:observed,ratioToBaseline:average>0?observed/average:null,
        classification:drift?'漂移：只描述':!usable?'尾段或覆盖不满足：不用于结论':observed<=average*CRITERIA.dominantLayerRatio?'这一层占大头':'未达到减半参考',
        conclusionAllowed:!drift&&usable}];}))};
}
module.exports={SCHEMA,RUNS,CRITERIA,validateParameters,gpuTimingEnabled,validateGpuOff,validateVariant,indexIntervals,traceIntervals,partitionGap,actions,windowStats,analyzeSupplement,classify};
