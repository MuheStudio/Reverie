'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const api=require('./smoothness-phase2.cjs'),builds=require('./smoothness-build.cjs');
const root=path.resolve(__dirname,'..');
test('phase two adds a fresh build without rebinding prior diagnostic roles',()=>{
 const p=builds.phase2Plan('/synthetic-sdk');
 assert.equal(p.candidate,'smoothness-20261115-timing-phase2');assert(p.timing&&p.core&&!p.profiler);
 for(const role of [builds.environmentRole,builds.supplementRole,...Object.values(builds.roles)])assert.notEqual(p.candidate,role.candidate);
 assert.throws(()=>builds.phase2Plan('relative'));
});
test('phase two fixes three runs, one screenshot and the reviewed numerical gates',()=>{
 const prior=JSON.parse(fs.readFileSync(path.join(root,'.tools/local/smoothness-20261115/preparation/parameters-environment.json')));
 const p={...prior,schema:api.SCHEMA,runs:api.RUNS,gates:api.GATES};assert(api.validateParameters(p,prior));
 for(const change of [{runs:[...p.runs].reverse()},{gates:{...p.gates,s1LongFractionMaximum:.16}},
  {scenarios:{...p.scenarios,S1:{...p.scenarios.S1,rows:10}}},{capture:{...p.capture,naturalSwaps:1}}])
  assert.throws(()=>api.validateParameters({...p,...change},prior));
 assert.equal(p.runs.filter(r=>r.screenshot==='companion').length,1);
 assert(p.runs.every(r=>r.gpuTiming===false));
});
function idleScene() {
 const observed={objectName:'moonroomEnvironmentShader',x:0,y:0,width:1380,height:900,visible:true,
  layerEnabled:true,smooth:true,textureWidth:2760,textureHeight:1800,fragmentShader:'qrc:/shaders/room.frag.qsb'};
 return {collectorStop:{snapshotsReadyNs:100},environmentReadback:{before:{...observed},writes:[]},
  phase2Idle:{idleStartNs:110,readAtNs:1000000110,quietMs:1000,observed},
  screenshot:{performed:true,companionStableNs:1000000120}};
}
test('phase two requires a full second after collectors stop before full-resolution readback and capture',()=>{
 assert(api.idleProof(idleScene()));
 for(const edit of [s=>s.phase2Idle.idleStartNs=99,s=>s.phase2Idle.readAtNs--,
  s=>s.phase2Idle.observed.textureWidth=1380,s=>s.phase2Idle.observed.smooth=false,
  s=>s.phase2Idle.observed.width=690,s=>s.environmentReadback.writes=['layer.textureSize'],
  s=>s.screenshot.companionStableNs=s.phase2Idle.readAtNs-1]){
  const s=idleScene();edit(s);assert.throws(()=>api.idleProof(s));
 }
});
function frameScene() {
 return {scenario:'S1',originNs:'0',events:[{kind:'drawer-open',feature:'memory',cycle:1,atNs:10},
  {kind:'drawer-open-complete',feature:'memory',cycle:1,atNs:40}],frameTiming:{frames:[
   {swapNs:9,textureWidth:2760,textureHeight:1800,textureReadOnGui:true},
   {swapNs:10,textureWidth:1380,textureHeight:900,textureReadOnGui:true},
   {swapNs:20,textureWidth:2760,textureHeight:1800,textureReadOnGui:true},
   {swapNs:30,textureWidth:100,textureHeight:100,textureReadOnGui:true},
   {swapNs:40,textureWidth:2760,textureHeight:1800,textureReadOnGui:true}]}};
}
test('per-action resolution counts use the original half-open swap boundaries and retain other sizes',()=>{
 const [r]=api.resolutionFrames(frameScene());assert.equal(r.frames,3);assert.equal(r.half,1);assert.equal(r.full,1);assert.equal(r.other,1);
});
test('missing or non-GUI texture samples cannot be counted as full-resolution frames',()=>{
 for(const edit of [f=>delete f.textureWidth,f=>f.textureReadOnGui=false]){
  const s=frameScene();edit(s.frameTiming.frames[1]);assert.throws(()=>api.resolutionFrames(s));
 }
});
test('the two S1 gates are inclusive and S2 has no invented performance threshold',()=>{
 const a=v=>({actionPeriod:{longFraction:v}});
 assert(api.verdict('S1',a(.1526)).passed);assert(!api.verdict('S1',a(.1526001)).passed);
 assert(!api.verdict('S1',a(null)).passed);assert(api.verdict('S2',a(.8)).passed);
});
test('both reviewed static regions must pass independently without rounding',()=>{
 const image={imageSize:[2760,1800],regions:api.GATES.regions.map(r=>({name:r.name,box:r.box,mean:r.maximumMean}))};
 assert(api.verdict('S1',{actionPeriod:{longFraction:.1}},image).passed);
 for(let i=0;i<2;++i){const x=structuredClone(image);x.regions[i].mean+=.00001;
  assert(!api.verdict('S1',{actionPeriod:{longFraction:.1}},x).passed);}
});
test('the fixed image algorithm reads the retained reference without edits or resampling',()=>{
 const reference=path.join(root,'.tools/local/smoothness-20261115/diagnostics/environment-01-baseline-S1/environment.companion.png');
 const result=JSON.parse(execFileSync(path.join(root,'.venv/bin/python'),['-I','-B',path.join(__dirname,'smoothness-image-diff.py'),reference,reference],{encoding:'utf8'}));
 assert.deepEqual(result.imageSize,[2760,1800]);assert.deepEqual(result.regions.map(r=>r.mean),[0,0]);
});
