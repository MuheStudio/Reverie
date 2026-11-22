'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {plan,roles}=require('./smoothness-build.cjs');
const {distribution,unionDuration,analyze}=require('./smoothness-analysis.cjs');
const root=path.resolve(__dirname,'..');
test('diagnostic build plans use distinct fresh W20 directories without publishing a pointer',()=>{
  const plans=Object.keys(roles).map(role=>plan(role,'/synthetic-sdk'));
  assert.equal(new Set(plans.map(p=>p.cmakeDirectory)).size,3);
  assert.equal(new Set(plans.map(p=>p.candidateDirectory)).size,3);
  for(const p of plans){assert.equal(path.dirname(p.cmakeDirectory),path.join(root,'.tools/qt-builds'));
    assert.equal(path.basename(p.cmakeDirectory),p.candidate);assert.equal(path.basename(p.candidateDirectory),p.candidate);}
  assert.equal(plans[1].corePath,'');assert.equal(plans[1].timing,true);assert.equal(plans[2].profiler,true);
  assert.throws(()=>plan('ordinary','/sdk'));assert.throws(()=>plan('timing','relative-sdk'));
});
test('distributions keep empty observations unknown and use interpolated quantiles',()=>{
  assert.equal(distribution([]).p90,null);const d=distribution([0,10,20,30]);assert.equal(d.count,4);assert.equal(d.p50,15);assert.equal(d.p90,27);assert(Math.abs(d.p99-29.7)<1e-12);
});
test('nested event spans are clipped and counted once',()=>{
  assert.equal(unionDuration([[0,100],[10,20],[90,120],[150,180]],5,160),125);
});
function scene(){return {schema:'reverie.qt.smoothness.scene.v1',originNs:'1000000000',measurementStartNs:40000000,
  measurementEndNs:140000000,screenRefreshRateHz:60,events:[{kind:'messages-changed',atNs:90000000}],
  frameTiming:{dropped:0,frames:[20,40,60,100,120,140].map((n,i)=>({frameId:i+1,beginNs:1e9+(n-12)*1e6,
    beforeSyncNs:1e9+(n-10)*1e6,afterSyncNs:1e9+(n-9)*1e6,beforeRenderNs:1e9+(n-8)*1e6,
    afterRenderNs:1e9+(n-2)*1e6,swapNs:1e9+n*1e6}))},
  timingTrace:{compiled:true,essentialFailure:false,incompleteSpans:0,startedNs:'1000000000',kindNames:['NotifyEvent'],
    records:[{kind:0,isGui:true,elapsedNs:60000000,edge:1,spanId:1},{kind:0,isGui:true,elapsedNs:80000000,edge:2,spanId:1}]},
  gpuValidated:false,gpu:{frames:[]}};}
test('long frames are decomposed without inventing CPU utilization or GPU observations',()=>{
  const result=analyze(scene());assert.equal(result.frameIntervalMs.count,4);assert.equal(result.longFrames,1);
  assert.equal(result.triggerCounts['messages-changed'],1);assert.equal(result.gpuMs.count,0);
  const long=result.samples.find(r=>r.long);assert.equal(long.dominant,'preSyncEvent');
  assert.equal(Object.values(long.stages).reduce((a,b)=>a+b,0),40);assert(result.traceComplete);
});
test('GPU alignment requires a unique calibrated source frame and the original duration field',()=>{
  const input=scene();input.gpuValidated=true;input.gpu.frames=[{frameBeginNs:input.frameTiming.frames[3].beginNs,valid:true,gpuDurationNs:7e6}];
  assert.equal(analyze(input).gpuMs.p90,7);input.gpu.frames.push({...input.gpu.frames[0]});assert.equal(analyze(input).gpuMs.count,0);
  input.gpu.frames.pop();input.gpuValidated=false;assert.equal(analyze(input).gpuMs.count,0);
});
test('trace loss and unknown phase ordering remain explicit',()=>{
  const input=scene();input.timingTrace.essentialFailure=true;assert.equal(analyze(input).traceComplete,false);
  input.frameTiming.frames[3].afterSyncNs=-1;assert.equal(analyze(input).frameIntervalMs.count,4);assert.equal(analyze(input).unavailablePhaseFrames,1);
});
test('new entry dispatch is absent from ordinary preprocessed check bodies',()=>{
  const {execFileSync}=require('node:child_process');
  for(const file of ['PerfBootstrap.cpp','PerfScenarioCheck.cpp']){
    const before=execFileSync('git',['show','af34b20:native-ui/tests/'+file],{cwd:root,encoding:'utf8'});
    const after=fs.readFileSync(path.join(__dirname,'tests',file),'utf8');
    const stripped=after.replace(/#if defined\(REVERIE_TIMING_DIAGNOSTICS\) \|\| defined\(REVERIE_QML_PROFILER\)\n[\s\S]*?#endif\n/g,'');
    assert.equal(stripped,before,file+' ordinary code changed');
  }
});

test('a corrected build binding cannot change frozen scenarios or legitimize a successful rerun',()=>{
  const {validateRetryBindings}=require('./check-smoothness.cjs');
  const parameters={sourceHead:'a'.repeat(40),scenarios:{S1:{cycles:20}},runs:[{key:'01-control'}]};
  const retry={schema:'reverie.qt.smoothness.retry-bindings.v1',originalParameterSha256:'b'.repeat(64),
    failedRunKey:'01-control',failedSummaryPath:'bound-by-reader',failedSummarySha256:'c'.repeat(64),
    sourceHead:'d'.repeat(40),builds:{ordinary:{},timing:{},corefree:{},profiler:{}},
    calibrationOutput:'01-control-retry-1',nativeReproduction:{}};
  const failure={schema:'reverie.qt.smoothness.run.v1',key:'01-control',passed:false};
  const result=validateRetryBindings(parameters,'b'.repeat(64),retry,failure);
  assert.strictEqual(result.scenarios,parameters.scenarios);assert.strictEqual(result.runs,parameters.runs);
  assert.throws(()=>validateRetryBindings(parameters,'b'.repeat(64),{...retry,scenarios:{}},failure));
  assert.throws(()=>validateRetryBindings(parameters,'e'.repeat(64),retry,failure));
  assert.throws(()=>validateRetryBindings(parameters,'b'.repeat(64),retry,{...failure,passed:true}));
});

test('supplement build is fresh while the three phase-one roles remain stable',()=>{
  const {supplementPlan}=require('./smoothness-build.cjs');const p=supplementPlan('/synthetic-sdk');
  assert.equal(p.candidate,'smoothness-20261115-timing-supplement');assert.equal(p.timing,true);assert.equal(p.profiler,false);assert.equal(p.core,true);
  assert.equal(path.basename(p.cmakeDirectory),p.candidate);assert.equal(path.basename(p.candidateDirectory),p.candidate);
  assert(!Object.values(roles).some(r=>r.candidate===p.candidate));assert.throws(()=>supplementPlan('relative'));
});
test('per-run GPU off overrides valid calibration and preserves the old default',()=>{
  const {gpuTimingEnabled}=require('./smoothness-supplement.cjs');
  assert.equal(gpuTimingEnabled({gpuTiming:false},{measurementValid:true}),false);
  assert.equal(gpuTimingEnabled({},{measurementValid:true}),true);
  assert.equal(gpuTimingEnabled({gpuTiming:true},{measurementValid:false}),false);
  assert.throws(()=>gpuTimingEnabled({gpuTiming:'false'},{measurementValid:true}));
});
test('the no-GPU proof rejects hidden query records and secondary collector activity',()=>{
  const {validateGpuOff}=require('./smoothness-supplement.cjs');
  const value={gpu:{collected:false},gpuValidated:false,diagnostics:{gpuTimer:{queriesIssued:0,status:'disabled',samples:[]}}};
  assert.equal(validateGpuOff(value).glCallRecords,0);
  assert.throws(()=>validateGpuOff({...value,gpu:{collected:false,glCalls:[{function:'glEndQuery'}]}}));
  assert.throws(()=>validateGpuOff({...value,gpuValidated:true}));
  assert.throws(()=>validateGpuOff({...value,diagnostics:{gpuTimer:{queriesIssued:1,status:'disabled',samples:[]}}}));
});
test('drawer-background readback must be zero at both boundaries and preserve pixel ratio',()=>{
  const {validateVariant}=require('./smoothness-supplement.cjs');
  const before={surfaceCount:3,pixelRatio:1,effectsActive:true,reducedTransparency:false};
  const scene={variantReadback:{variant:'drawer-background-off',before,applied:{...before,surfaceCount:0},finished:{surfaceCount:0}}};
  assert.equal(validateVariant(scene,{variant:'drawer-background-off'}).applied.surfaceCount,0);
  for(const applied of [{...before},{...before,surfaceCount:0,pixelRatio:.5},{...before,surfaceCount:0,effectsActive:false}])
    assert.throws(()=>validateVariant({variantReadback:{...scene.variantReadback,applied}},{variant:'drawer-background-off'}));
  assert.throws(()=>validateVariant({variantReadback:{...scene.variantReadback,finished:{surfaceCount:3}}},{variant:'drawer-background-off'}));
});
test('native supplement uses a real QML array and rejects missing, nonarray and readonly targets',()=>{
  const {execFileSync}=require('node:child_process');
  const p=require('./smoothness-build.cjs').phase2Plan('/unused-for-plan');
  const result=JSON.parse(execFileSync(path.join(p.cmakeDirectory,'SmoothnessReadingRepro'),['--variant-unit'],
    {encoding:'utf8',env:{...process.env,QT_QPA_PLATFORM:'offscreen'}}));
  assert.deepEqual(result,{passed:true,cases:4});
});
test('supplement parameters keep the five-run order, original scenarios and fixed reference rules',()=>{
  const api=require('./smoothness-supplement.cjs');const original={scenarios:{S1:{rows:9},S2:{rows:100}},longFrame:{multiplier:1.5}};
  const value={schema:api.SCHEMA,package:'smoothness-20261115',runs:api.RUNS,scenarios:original.scenarios,longFrame:original.longFrame,
    criteria:api.CRITERIA,initialWindowMs:250,actionIntervalPolicy:'both-swaps-inside-one-action; swap-count-half-open'};
  assert.equal(api.validateParameters(value,original),value);
  assert.throws(()=>api.validateParameters({...value,runs:[...api.RUNS].reverse()},original));
  assert.throws(()=>api.validateParameters({...value,runs:api.RUNS.map((r,i)=>i? r:{...r,gpuTiming:true})},original));
  assert.throws(()=>api.validateParameters({...value,scenarios:{...original.scenarios,S1:{rows:300}}},original));
  assert.throws(()=>api.validateParameters({...value,criteria:{...api.CRITERIA,driftPercentagePoints:4}},original));
});
function supplementScene(){
  const ns=x=>x*1e6;
  const frame=(id,begin,render,swap)=>({frameId:id,beginNs:ns(begin),beforeSyncNs:ns(begin+1),afterSyncNs:ns(begin+2),
    beforeRenderNs:ns(render-.5),afterRenderNs:ns(render),swapNs:ns(swap)});
  const span=(id,start,end,type,window=false,parent=0)=>[
    {kind:0,isGui:true,spanId:id,parentSpanId:parent,a:type,b:Number(window),edge:1,elapsedNs:ns(start)},
    {kind:0,isGui:true,spanId:id,parentSpanId:parent,a:type,b:Number(window),edge:2,elapsedNs:ns(end)}];
  return {schema:'reverie.qt.smoothness.scene.v1',scenario:'S1',variant:'baseline',originNs:'0',measurementStartNs:ns(100),measurementEndNs:ns(131),
    screenRefreshRateHz:60,frameTiming:{dropped:0,frames:[frame(1,90,95,100),frame(2,125,128,130)]},
    events:[{kind:'drawer-open',feature:'memory',cycle:1,atNs:ns(100)},{kind:'drawer-open-complete',feature:'memory',cycle:1,atNs:ns(131)}],
    timingTrace:{compiled:true,startedNs:'0',kindNames:['NotifyEvent','DispatcherAboutToBlock','DispatcherAwake'],eventTypeNames:{77:'UpdateRequest',1:'Timer',5:'MouseMove'},
      essentialFailure:false,incompleteSpans:1,records:[...span(1,80,102,77,true),...span(2,110,124,1),...span(3,115,116,5,false,2),...span(4,124,130.25,77,true),
        {kind:1,isGui:true,edge:0,elapsedNs:ns(102)},{kind:2,isGui:true,edge:0,elapsedNs:ns(112)},
        {kind:0,isGui:true,spanId:5,parentSpanId:0,a:1,b:0,edge:1,elapsedNs:ns(131)}].sort((a,b)=>a.elapsedNs-b.elapsedNs)}};
}
test('the new partition separates post-swap blocking from idle and nested event work exactly once',()=>{
  const {analyzeSupplement}=require('./smoothness-supplement.cjs');const r=analyzeSupplement(supplementScene());
  assert.equal(r.overall.frameIntervalMs.p99,30);assert.equal(r.segments.coverage.valid,1);
  assert.deepEqual(r.segments.samples[0].stages,{postSwapTail:2,eventLoopBlocked:10,'event:Timer':11,'event:MouseMove':1,updateBeforeFrame:1,frameToRenderEnd:3,renderEndToSwap:2});
  assert.equal(r.postSwapTail.p99,2);assert.equal(r.postSwapTail.usableForConclusion,false);
  assert.equal(r.actionPeriod.longFraction,1);assert.equal(r.actionPeriod.swaps,2);
});
test('action and first-250ms windows do not count intervals crossing the start or swaps at the end',()=>{
  const {windowStats,actions}=require('./smoothness-supplement.cjs');
  const frames=[-10,0,10,30,250,260].map((ms,i)=>({frameId:i+1,swapNs:ms*1e6}));
  const r=windowStats(frames,0,250e6,25);assert.equal(r.swaps,3);assert.equal(r.swapsPerSecond,12);
  assert.deepEqual(r.sequence.map(x=>x.intervalMs),[10,20]);assert.equal(r.longFrames,0);
  assert.throws(()=>actions({...supplementScene(),events:[supplementScene().events[0]]}));
  const p=actions({scenario:'S2',originNs:'0',events:[{kind:'navigation',feature:'memory',subentry:'worldbook',atNs:10},
    {kind:'page-ready',index:0,feature:'memory',subentry:'worldbook',atNs:20},{kind:'navigation',feature:'chat',subentry:'companion',atNs:21}]});
  assert.equal(p.length,1);assert.equal(p[0].end,20);
});
test('missing update-event mapping never becomes a fabricated zero post-swap tail',()=>{
  const api=require('./smoothness-supplement.cjs');const s=supplementScene();s.timingTrace.records=s.timingTrace.records.filter(r=>r.spanId!==1);
  const r=api.analyzeSupplement(s);assert.equal(r.segments.coverage.unmappedUpdates,1);
  assert.equal(r.postSwapTail.p99,null);assert.equal(r.postSwapTail.usableForConclusion,false);
});
test('reference classification respects drift, the inclusive half threshold and invalid tail evidence',()=>{
  const {classify}=require('./smoothness-supplement.cjs');const row=(v,ok=true)=>({actionPeriod:{longFraction:v},postSwapTail:{usableForConclusion:ok}});
  const r=classify(row(.4),row(.42),{half:row(.205),larger:row(.3),invalid:row(.1,false)});
  assert.equal(r.drift,false);assert.equal(r.controls.half.classification,'这一层占大头');assert.equal(r.controls.larger.classification,'未达到减半参考');
  assert.equal(r.controls.invalid.conclusionAllowed,false);
  assert.equal(classify(row(.4),row(.431),{half:row(.1)}).controls.half.classification,'漂移：只描述');
});
test('phase-one parameter and retry bindings still read without creating a run',()=>{
  const {binding}=require('./check-smoothness.cjs');const prep=path.join(root,'.tools/local/smoothness-20261115/preparation');
  const r=binding(path.join(prep,'parameters.json'),'02-start-S1',path.join(root,'.tools/local/smoothness-20261115/diagnostics/compatibility-probe-not-run'),path.join(prep,'bootstrap-retry-bindings.json'));
  assert.equal(r.isSupplement,false);assert.equal(r.parameters.calibrationOutput,'01-control-retry-1');
  assert.equal(path.basename(r.buildDirectory),'smoothness-20261115-timing-bootstrap-retry');
});

test('environment build keeps prior role paths and uses a separate fresh directory',()=>{
  const b=require('./smoothness-build.cjs'),p=b.environmentPlan('/synthetic-sdk');
  assert.equal(p.candidate,'smoothness-20261115-timing-environment');assert(p.timing&&p.core&&!p.profiler);
  assert.notEqual(p.candidate,b.supplementPlan('/synthetic-sdk').candidate);assert.equal(Object.keys(b.roles).length,3);
  assert.throws(()=>b.environmentPlan('relative'));
});
test('environment native units cover real layer properties, smoothing and the passive two-swap gate',()=>{
  const {execFileSync}=require('node:child_process');const p=require('./smoothness-build.cjs').phase2Plan('/unused-for-plan');
  const result=JSON.parse(execFileSync(path.join(p.cmakeDirectory,'SmoothnessReadingRepro'),['--environment-unit'],
    {encoding:'utf8',env:{...process.env,QT_QPA_PLATFORM:'offscreen'}}));assert.deepEqual(result,{passed:true,cases:10});
});
function environmentProof(variant='environment-half') {
  const before={objectName:'moonroomEnvironmentShader',visible:true,x:0,y:0,width:1380,height:900,layerEnabled:true,textureWidth:2760,textureHeight:1800,smooth:false,fragmentShader:'qrc:/shaders/room.frag.qsb'};
  const after={...before,visible:variant!=='environment-hidden',textureWidth:variant==='environment-half'?1380:2760,
    textureHeight:variant==='environment-half'?900:1800,smooth:variant==='environment-half'};
  return {variant,before,applied:after,finished:{...after},writes:variant==='environment-half'?['layer.textureSize','layer.smooth']:variant==='environment-hidden'?['visible']:[]};
}
test('environment readback checks both boundaries, exact half, smooth and unchanged geometry',()=>{
  const a=require('./smoothness-environment.cjs');
  for(const variant of ['baseline','environment-hidden','environment-half'])assert(a.validateVariant({environmentReadback:environmentProof(variant)},{variant}));
  for(const changed of [{smooth:false},{textureWidth:2760},{width:690},{visible:false}]) {
    const p=environmentProof();p.finished={...p.finished,...changed};assert.throws(()=>a.validateVariant({environmentReadback:p},{variant:p.variant}));
  }
  const p=environmentProof('environment-hidden');p.finished.visible=true;assert.throws(()=>a.validateVariant({environmentReadback:p},{variant:p.variant}));
});
function captureFixture(){
  const crypto=require('node:crypto'),bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(2760,16);bytes.writeUInt32BE(1800,20);
  const scene={originNs:'0',measurementEndNs:100,frameTiming:{frames:[{swapNs:90}]},events:[],timingTrace:{enabled:false,recordCount:7},
    legacyEntryMode:'visual',diagnostics:{measured:false,reason:'Visual validation; timing disabled'},gpu:{collected:false},gpuValidated:false,
    collectorStop:{allStopped:true,atNs:110,snapshotsReadyNs:120,timingTraceEnabled:false,frameStoreStopped:true,eventsStopped:true,frameRecords:1,eventRecords:0,traceRecords:7},
    screenshot:{requested:'companion',performed:true,path:'/synthetic/environment.companion.png',timingStopped:true,recordsStopped:true,
      view:'companion',appearanceOrPoseOverrides:false,naturalAnimations:true,recordingStoppedNs:110,companionStableNs:121,
      firstNaturalSwapNs:122,lastNaturalSwapNs:123,naturalFramesAfterStable:2,grabBeginNs:124,grabEndNs:130,
      frameRecordsAfterCapture:1,eventRecordsAfterCapture:0,pixelWidth:2760,pixelHeight:1800,logicalWidth:1380,logicalHeight:900,devicePixelRatio:2,
      bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}};
  return {scene,bytes};
}
test('environment screenshot validation rejects pre-stop capture, one swap, late samples and changed PNG bytes',()=>{
  const a=require('./smoothness-environment.cjs'),{scene,bytes}=captureFixture(),selection={screenshot:'companion'};
  assert(a.validateScreenshot(scene,selection,'/synthetic',bytes));
  for(const change of [{grabBeginNs:109},{naturalFramesAfterStable:1},{recordsStopped:false},{frameRecordsAfterCapture:2},{eventRecordsAfterCapture:1}])
    assert.throws(()=>a.validateScreenshot({...scene,screenshot:{...scene.screenshot,...change}},selection,'/synthetic',bytes));
  const changed=Buffer.from(bytes);changed[23]^=1;assert.throws(()=>a.validateScreenshot(scene,selection,'/synthetic',changed));
  const late={...scene,frameTiming:{frames:[{swapNs:101}]}};assert.throws(()=>a.validateScreenshot(late,selection,'/synthetic',bytes));
  assert(a.validateScreenshot({...scene,screenshot:{requested:'none',performed:false}},{screenshot:'none'},'/synthetic'));
  assert.throws(()=>a.validateScreenshot(scene,{screenshot:'none'},'/synthetic',bytes));
});
test('environment uses no legacy sampler and requires observed basic loop with RHI timestamps disabled',()=>{
  const a=require('./smoothness-environment.cjs'),{scene}=captureFixture();assert.equal(a.validateNoGpu(scene).legacyCollectorAttached,false);
  assert.throws(()=>a.validateNoGpu({...scene,diagnostics:{measured:true}}));assert.throws(()=>a.validateNoGpu({...scene,gpu:{collected:true}}));
  assert.equal(a.renderLoopEvidence('qt.scenegraph.general: basic render loop\n  Timestamps: 0\n').observed,'basic');
  assert.throws(()=>a.renderLoopEvidence('qt.scenegraph.general: basic render loop\n  Timestamps: 1\n'));
  assert.throws(()=>a.renderLoopEvidence('QSG_RENDER_LOOP=basic\n  Timestamps: 0\n'));
});
test('environment parameters preserve the supplement analysis policy and authorize exactly two screenshots',()=>{
  const a=require('./smoothness-environment.cjs');const prior={scenarios:{S1:{rows:9},S2:{rows:100}},longFrame:{multiplier:1.5},criteria:require('./smoothness-supplement.cjs').CRITERIA,
    initialWindowMs:250,actionIntervalPolicy:'both-swaps-inside-one-action; swap-count-half-open',actionDetails:'bound',segmentDetails:'bound'};
  const p={...prior,schema:a.SCHEMA,package:'smoothness-20261115',runs:a.RUNS,classification:a.CLASSIFICATION,capture:a.CAPTURE};
  assert(a.validateParameters(p,prior));assert.equal(a.RUNS.filter(r=>r.screenshot==='companion').length,2);
  assert.throws(()=>a.validateParameters({...p,runs:a.RUNS.map((r,i)=>i===4?{...r,screenshot:'companion'}:r)},prior));
  assert.throws(()=>a.validateParameters({...p,capture:{...a.CAPTURE,entryMode:'perf'}},prior));
  assert.throws(()=>a.validateParameters({...p,initialWindowMs:200},prior));
});
test('environment classification follows the confirmed priority and suppresses conclusions on drift or invalid coverage',()=>{
  const a=require('./smoothness-environment.cjs'),row=(n,ok=true)=>({actionPeriod:{longFraction:n},postSwapTail:{usableForConclusion:ok}});
  assert.equal(a.classify(row(.3),row(.3),row(.1),row(.15)).classification,'小修候选');
  assert.equal(a.classify(row(.3),row(.3),row(.15),row(.2)).classification,'要换做法，放七期');
  assert.equal(a.classify(row(.3),row(.3),row(.2),row(.2)).classification,'移到七期');
  assert.equal(a.classify(row(.3),row(.34),row(.1),row(.1)).classification,null);
  assert.equal(a.classify(row(.3),row(.3),row(.1),row(.1,false)).classification,null);
});
test('environment leaves the supplement analysis source unchanged and retains its saved binding',()=>{
  const {execFileSync}=require('node:child_process');const filename='native-ui/smoothness-supplement.cjs';
  assert.equal(fs.readFileSync(path.join(root,filename),'utf8'),execFileSync('git',['show','0df6349:'+filename],{cwd:root,encoding:'utf8'}));
  const prep=path.join(root,'.tools/local/smoothness-20261115/preparation');
  const old=require('./check-smoothness.cjs').binding(path.join(prep,'parameters-supplement.json'),'supplement-01-baseline-S1',path.join(root,'.tools/local/smoothness-20261115/diagnostics/environment-binding-probe-not-run'));
  assert(old.isSupplement&&!old.isEnvironment);assert.equal(path.basename(old.buildDirectory),'smoothness-20261115-timing-supplement');
});
