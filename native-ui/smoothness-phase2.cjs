'use strict';
const assert=require('node:assert/strict');
const supplement=require('./smoothness-supplement.cjs');
const environment=require('./smoothness-environment.cjs');
const SCHEMA='reverie.qt.smoothness.phase2-parameters.v1';
const RUNS=Object.freeze([
 {key:'phase2-01-S1',scenario:'S1',variant:'baseline',build:'phase2',gpuTiming:false,screenshot:'companion'},
 {key:'phase2-02-S2',scenario:'S2',variant:'baseline',build:'phase2',gpuTiming:false,screenshot:'none'},
 {key:'phase2-03-S1',scenario:'S1',variant:'baseline',build:'phase2',gpuTiming:false,screenshot:'none'},
]);
const GATES=Object.freeze({s1LongFractionMaximum:.1526,idleMs:1000,textureWidth:2760,textureHeight:1800,
 imageSize:[2760,1800],regions:[{name:'books',box:[60,1100,400,1200],maximumMean:.86},
 {name:'floor-ring-left',box:[600,1300,900,1470],maximumMean:.58}],
 imageAlgorithm:'Pillow RGB -> crop -> ImageChops.difference -> L -> ImageStat.Stat.mean[0]'});
function validateParameters(p,prior) {
 assert.equal(p.schema,SCHEMA);assert.equal(p.package,'smoothness-20261115');
 assert.deepEqual(p.runs,RUNS);assert.deepEqual(p.gates,GATES);
 for(const k of ['scenarios','longFrame','criteria','initialWindowMs','actionIntervalPolicy','actionDetails','segmentDetails'])
  assert.deepEqual(p[k],prior[k],'PHASE2_ANALYSIS_POLICY_CHANGED:'+k);
 assert.deepEqual(p.capture,environment.CAPTURE);
 return p;
}
function idleProof(scene) {
 const p=scene.phase2Idle,r=p?.observed;
 assert(p&&p.idleStartNs>=scene.collectorStop.snapshotsReadyNs&&p.readAtNs-p.idleStartNs>=1e9&&p.quietMs>=1000,'PHASE2_IDLE_WINDOW');
 assert(r?.objectName==='moonroomEnvironmentShader'&&r.visible===true&&r.layerEnabled===true&&r.smooth===true&&
  r.textureWidth===GATES.textureWidth&&r.textureHeight===GATES.textureHeight,'PHASE2_IDLE_NOT_FULL_RESOLUTION');
 assert.deepEqual(scene.environmentReadback?.writes,[],'PHASE2_DIAGNOSTIC_PRODUCT_OVERRIDE');
 for(const k of ['objectName','x','y','width','height','layerEnabled','fragmentShader'])
  assert.deepEqual(r[k],scene.environmentReadback.before[k],'PHASE2_GEOMETRY_CHANGED:'+k);
 if(scene.screenshot.performed)assert(scene.screenshot.companionStableNs>=p.readAtNs,'PHASE2_SCREENSHOT_BEFORE_IDLE_READ');
 return p;
}
function resolutionFrames(scene) {
 const frames=scene.frameTiming.frames.filter(f=>f.swapNs>=0);
 assert(frames.length>0&&frames.every(f=>f.textureReadOnGui===true&&Number.isInteger(f.textureWidth)&&Number.isInteger(f.textureHeight)),
  'PHASE2_TEXTURE_SAMPLE_MISSING');
 return supplement.actions(scene).map(action=>{
  const rows=frames.filter(f=>f.swapNs>=action.start&&f.swapNs<action.end);
  const half=rows.filter(f=>f.textureWidth===1380&&f.textureHeight===900).length;
  const full=rows.filter(f=>f.textureWidth===2760&&f.textureHeight===1800).length;
  return {...action,frames:rows.length,half,full,other:rows.length-half-full};
 });
}
function verdict(scenario,analysis,image) {
 const checks=[];
 if(scenario==='S1')checks.push({name:'action-long-fraction',observed:analysis.actionPeriod.longFraction,
  maximum:GATES.s1LongFractionMaximum,passed:Number.isFinite(analysis.actionPeriod.longFraction)&&analysis.actionPeriod.longFraction<=GATES.s1LongFractionMaximum});
 if(image) {
  assert.deepEqual(image.imageSize,GATES.imageSize);
  assert.equal(image.regions.length,2);
  for(let i=0;i<2;++i) {
   const r=image.regions[i],fixed=GATES.regions[i];assert.equal(r.name,fixed.name);assert.deepEqual(r.box,fixed.box);
   checks.push({name:fixed.name,observed:r.mean,maximum:fixed.maximumMean,passed:Number.isFinite(r.mean)&&r.mean<=fixed.maximumMean});
  }
 }
 return {passed:checks.every(c=>c.passed),checks};
}
module.exports={SCHEMA,RUNS,GATES,validateParameters,idleProof,resolutionFrames,verdict};
