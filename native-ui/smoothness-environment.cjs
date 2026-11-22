'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const supplement=require('./smoothness-supplement.cjs');
const SCHEMA='reverie.qt.smoothness.environment-parameters.v1';
const RUNS=Object.freeze([
 {key:'environment-01-baseline-S1',scenario:'S1',variant:'baseline',build:'environment',gpuTiming:false,screenshot:'companion'},
 {key:'environment-02-hidden-S1',scenario:'S1',variant:'environment-hidden',build:'environment',gpuTiming:false,screenshot:'none'},
 {key:'environment-03-half-S1',scenario:'S1',variant:'environment-half',build:'environment',gpuTiming:false,screenshot:'companion'},
 {key:'environment-04-half-S2',scenario:'S2',variant:'environment-half',build:'environment',gpuTiming:false,screenshot:'none'},
 {key:'environment-05-baseline-S1',scenario:'S1',variant:'baseline',build:'environment',gpuTiming:false,screenshot:'none'},
]);
const CLASSIFICATION=Object.freeze({half:'小修候选',hiddenOnly:'要换做法，放七期',neither:'移到七期',drift:'只描述，不分类'});
const CAPTURE=Object.freeze({naturalSwaps:2,timeoutMs:4000,view:'companion',format:'PNG',scope:'whole-window-after-recording-stop',entryMode:'visual',qsgRhiProfile:'unset'});
function validateParameters(p,prior) {
 assert.equal(p.schema,SCHEMA);assert.equal(p.package,'smoothness-20261115');assert.deepEqual(p.runs,RUNS,'ENVIRONMENT_RUN_ORDER');
 for(const key of ['scenarios','longFrame','criteria','initialWindowMs','actionIntervalPolicy','actionDetails','segmentDetails'])
  assert.deepEqual(p[key],prior[key],'ENVIRONMENT_ANALYSIS_POLICY_CHANGED:'+key);
 assert.deepEqual(p.classification,CLASSIFICATION);assert.deepEqual(p.capture,CAPTURE);
 return p;
}
function validateVariant(scene,selected) {
 const proof=scene.environmentReadback;
 assert(proof?.variant===selected.variant,'ENVIRONMENT_VARIANT_IDENTITY');
 const before=proof.before;assert(before?.objectName==='moonroomEnvironmentShader'&&before.visible===true&&before.layerEnabled===true);
 assert(Number.isSafeInteger(before.textureWidth)&&before.textureWidth>0&&Number.isSafeInteger(before.textureHeight)&&before.textureHeight>0);
 const half=selected.variant==='environment-half',hidden=selected.variant==='environment-hidden';
 assert(['baseline','environment-half','environment-hidden'].includes(selected.variant));
 if(half)assert(before.textureWidth%2===0&&before.textureHeight%2===0);
 for(const after of [proof.applied,proof.finished]) {
  assert(after&&after.visible===!hidden&&after.textureWidth===before.textureWidth/(half?2:1)&&
   after.textureHeight===before.textureHeight/(half?2:1)&&after.smooth===(half?true:before.smooth),'ENVIRONMENT_VARIANT_READBACK');
  for(const key of ['objectName','x','y','width','height','layerEnabled','fragmentShader'])assert.deepEqual(after[key],before[key],'ENVIRONMENT_UNREQUESTED_CHANGE:'+key);
 }
 assert.deepEqual(proof.writes,half?['layer.textureSize','layer.smooth']:hidden?['visible']:[]);
 return proof;
}
function validateStopped(scene) {
 const stop=scene.collectorStop;
 assert(stop?.allStopped===true&&stop.timingTraceEnabled===false&&stop.frameStoreStopped===true&&stop.eventsStopped===true,
  'ENVIRONMENT_RECORDERS_NOT_STOPPED');
 assert(scene.measurementEndNs>=0&&stop.atNs>=scene.measurementEndNs&&stop.snapshotsReadyNs>=stop.atNs);
 assert.equal(stop.frameRecords,scene.frameTiming.frames.length);assert.equal(stop.eventRecords,scene.events.length);
 assert.equal(stop.traceRecords,scene.timingTrace.recordCount);assert.equal(scene.timingTrace.enabled,false);
 assert(scene.frameTiming.frames.every(f=>f.swapNs<0||f.swapNs<=Number(scene.originNs)+scene.measurementEndNs),'ENVIRONMENT_POST_MEASUREMENT_FRAME');
 return stop;
}
function validateNoGpu(scene) {
 assert.equal(scene.legacyEntryMode,'visual');
 assert.equal(scene.diagnostics?.measured,false,'ENVIRONMENT_LEGACY_RECORDER_PRESENT');
 assert(!Object.hasOwn(scene.diagnostics,'cpuStages')&&!Object.hasOwn(scene.diagnostics,'gpuTimer'));
 assert.equal(scene.gpu?.collected,false);assert.equal(scene.gpuValidated,false);
 function scan(v){if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){if(k==='glCalls')assert(Array.isArray(x)&&x.length===0,'ENVIRONMENT_GL_TIMING_RECORDS');else scan(x);}}
 scan(scene);validateStopped(scene);
 return {collected:false,glCallRecords:0,legacyCollectorAttached:false,entryMode:'visual'};
}
function renderLoopEvidence(log) {
 const lines=log.split('\n');const loops=lines.filter(l=>l.startsWith('qt.scenegraph.general: ')&&l.includes('render loop'));
 assert(loops.some(l=>l.includes('basic render loop'))&&!loops.some(l=>l.includes('threaded render loop')),'ENVIRONMENT_RENDER_LOOP');
 const timestamps=lines.filter(l=>/^\s*Timestamps:\s*[01]\s*$/.test(l));
 assert(timestamps.length>0&&timestamps.every(l=>/Timestamps:\s*0\s*$/.test(l)),'ENVIRONMENT_RHI_TIMING_ENABLED');
 return {observed:'basic',evidence:loops,rhiTimestampsRequested:false,timestampEvidence:timestamps};
}
function validateScreenshot(scene,selected,output,bytes) {
 const shot=scene.screenshot;assert(shot?.requested===selected.screenshot);
 if(selected.screenshot==='none') {assert.equal(shot.performed,false);assert(!Object.hasOwn(shot,'path')&&bytes===undefined);return shot;}
 const stop=validateStopped(scene);
 assert.equal(shot.performed,true);assert.equal(shot.path,path.join(output,'environment.companion.png'));
 assert(shot.timingStopped===true&&shot.recordsStopped===true&&shot.view==='companion'&&shot.appearanceOrPoseOverrides===false&&shot.naturalAnimations===true);
 const times=[scene.measurementEndNs,shot.recordingStoppedNs,stop.snapshotsReadyNs,shot.companionStableNs,shot.firstNaturalSwapNs,shot.lastNaturalSwapNs,shot.grabBeginNs,shot.grabEndNs];
 assert(times.every(Number.isSafeInteger)&&times.every((v,i)=>!i||v>=times[i-1]),'ENVIRONMENT_CAPTURE_ORDER');
 assert.equal(shot.recordingStoppedNs,stop.atNs);assert(shot.naturalFramesAfterStable>=2&&shot.firstNaturalSwapNs<shot.lastNaturalSwapNs);
 assert.equal(shot.frameRecordsAfterCapture,stop.frameRecords);assert.equal(shot.eventRecordsAfterCapture,stop.eventRecords);
 assert(Buffer.isBuffer(bytes)&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.toString('ascii',12,16)==='IHDR','ENVIRONMENT_SCREENSHOT_PNG');
 assert.equal(bytes.readUInt32BE(16),shot.pixelWidth);assert.equal(bytes.readUInt32BE(20),shot.pixelHeight);
 assert(shot.logicalWidth===1380&&shot.logicalHeight===900&&shot.devicePixelRatio>0&&shot.pixelWidth===Math.round(shot.logicalWidth*shot.devicePixelRatio)&&shot.pixelHeight===Math.round(shot.logicalHeight*shot.devicePixelRatio));
 assert.equal(bytes.length,shot.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),shot.sha256);
 return shot;
}
function classify(first,last,hidden,half) {
 const reference=supplement.classify(first,last,{hidden,half});
 if(reference.drift)return {reference,classification:null,status:CLASSIFICATION.drift,reason:'baseline-drift'};
 if(!reference.controls.hidden.conclusionAllowed||!reference.controls.half.conclusionAllowed)
  return {reference,classification:null,status:'只描述，不分类',reason:'tail-or-coverage-invalid'};
 const reduced=name=>reference.controls[name].ratioToBaseline!==null&&reference.controls[name].ratioToBaseline<=reference.criteria.dominantLayerRatio;
 const decision=reduced('half')?CLASSIFICATION.half:reduced('hidden')?CLASSIFICATION.hiddenOnly:CLASSIFICATION.neither;
 return {reference,classification:decision,status:'classified',reason:reduced('half')?'half-at-most-half':reduced('hidden')?'hidden-only-at-most-half':'neither-at-most-half'};
}
module.exports={SCHEMA,RUNS,CLASSIFICATION,CAPTURE,validateParameters,validateVariant,validateStopped,validateNoGpu,renderLoopEvidence,validateScreenshot,classify};
