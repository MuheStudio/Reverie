'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {median,validatePair,analyze}=require('./compare-performance.cjs');
function fixture(p95=40){const edge={width:1380,height:900,devicePixelRatio:2,screenName:'test',screenRefreshRateHz:60};return{passed:true,performanceComparable:true,sourceDirty:false,noResidualProcesses:true,testDataRemoved:true,forcedCleanup:false,workloadInputs:{scenario:'same'},modelInput:{sha256:'same'},rows:[9],build:{qt:{version:'fixed'},python:{version:'fixed'},node:'fixed',externalFiles:[],externalTrees:[],compilation:{flags:'same'}},environment:{macOS:'fixed',hardware:'test',architecture:'arm64',node:'fixed',powerBefore:"Now drawing from 'AC Power'",powerAfter:"Now drawing from 'AC Power'",powerSettingsBefore:'lowpowermode 0',powerSettingsAfter:'lowpowermode 0'},workloads:[{rows:9,fixture:{rows:9,historySha256:'same'},scene:{scheduleVersion:'fixed',phases:[{name:'target',active:true,plannedDurationMs:30000,plannedInputs:30,dispatchedInputs:30,complete:true,windowStateStart:edge,windowStateEnd:edge,cadence:{sampleCount:500,p95Ms:p95,over50Ms:3},processCpuMs:100,inputDispatchLateness:{p95Ms:5}}]}}]};}
test('pair gate refuses workload, display, toolchain and failed run mismatches',()=>{
 const a=fixture();validatePair(a,fixture());
 for(const change of [b=>b.passed=false,b=>b.performanceComparable=false,b=>b.workloadInputs.scenario='other',b=>b.build.compilation.flags='different',b=>b.workloads[0].scene.phases[0].windowStateEnd={...b.workloads[0].scene.phases[0].windowStateEnd,screenRefreshRateHz:120},b=>delete b.workloads[0].scene.phases[0].windowStateEnd.devicePixelRatio,b=>b.workloads[0].fixture.historySha256='other',b=>b.forcedCleanup=true,b=>b.environment.powerAfter="Now drawing from 'Battery Power'",b=>b.environment.powerSettingsAfter='lowpowermode 1']){const b=fixture();change(b);assert.throws(()=>validatePair(a,b));}
});
test('improvement uses independent pairs and is not a visual acceptance claim',()=>{
 const criteria={minimumImprovement:.1,maximumRegression:.05,primaryPhases:['target'],aaNoise:{'9:target':.02}};
 const pairs=[{A:fixture(40),B:fixture(32)},{A:fixture(42),B:fixture(34)},{A:fixture(40),B:fixture(33)}];
 const r=analyze(pairs,criteria);assert.equal(r.performanceGainAccepted,true);assert.equal(r.qualityAccepted,false);assert.equal(r.groups[0].positivePairs,3);
 assert.equal(analyze(pairs,{...criteria,aaNoise:{'9:target':.3}}).performanceGainAccepted,false);
 assert.equal(analyze([{A:fixture(),B:fixture(50)},{A:fixture(),B:fixture(50)},{A:fixture(),B:fixture(30)}],criteria).performanceGainAccepted,false);
});
test('zero or insufficient active samples cannot be accepted',()=>{
 const a=fixture(),b=fixture(20);b.workloads[0].scene.phases[0].cadence.sampleCount=0;
 assert.throws(()=>analyze([{A:a,B:b}],{minimumImprovement:.1,maximumRegression:.05,primaryPhases:['target']}));
 assert.equal(median([3,1,2]),2);assert.equal(median([4,1,2,3]),2.5);
});
test('CPU efficiency stays separate from cadence and regressions veto both',()=>{
 const criteria={minimumImprovement:.1,maximumRegression:.05,primaryPhases:['target'],maximumOver50Increase:.02,maximumInputP95IncreaseMs:16.7};
 const pairs=Array.from({length:3},()=>{const A=fixture(),B=fixture();B.workloads[0].scene.phases[0].processCpuMs=75;return{A,B};});
 let r=analyze(pairs,criteria);assert.equal(r.performanceGainAccepted,false);assert.equal(r.computationEfficiencyAccepted,true);
 for(const {B}of pairs)B.workloads[0].scene.phases[0].cadence.over50Ms=40;
 r=analyze(pairs,criteria);assert.equal(r.computationEfficiencyAccepted,false);assert(r.groups[0].over50Regression);
 for(const {A,B}of pairs){B.workloads[0].scene.phases[0].cadence.over50Ms=3;A.workloads[0].scene.phases[0].inputDispatchLateness={p95Ms:5};B.workloads[0].scene.phases[0].inputDispatchLateness={p95Ms:50};}
 r=analyze(pairs,criteria);assert.equal(r.computationEfficiencyAccepted,false);assert(r.groups[0].inputRegression);
 assert.equal(analyze(pairs,{...criteria,aaInputP95NoiseMs:{'9:target':50}}).computationEfficiencyAccepted,true);
});
test('more CPU with faster presentation is reported as a cost, never CPU efficiency',()=>{
 const pairs=Array.from({length:3},()=>{const A=fixture(40),B=fixture(25);B.workloads[0].scene.phases[0].processCpuMs=160;return{A,B};});
 const r=analyze(pairs,{minimumImprovement:.1,maximumRegression:.05,primaryPhases:['target']});
 assert.equal(r.performanceGainAccepted,true);assert.equal(r.computationEfficiencyAccepted,false);assert.equal(r.cpuCostIncreaseObserved,true);
});
