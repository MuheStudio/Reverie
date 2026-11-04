'use strict';
// The comparator is an outer controller. Each child uses its own exact checked
// out source, the existing strict build verifier and a new isolation context.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {WORKLOAD_INPUT_PATHS}=require('./check-performance.cjs');
const root=path.resolve(__dirname,'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const median=a=>{const s=a.toSorted((x,y)=>x-y);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
function clean(){assert.equal(git('status','--porcelain'),'','Unknown working-tree changes; no stash, reset or cleanup will be performed');}
function sourceHashes(ref){return Object.fromEntries(WORKLOAD_INPUT_PATHS.map(p=>[p,hash(execFileSync('git',['show',`${ref}:${p}`],{cwd:root}))]));}
function powerState(environment,edge){
 const supply=environment[`power${edge}`]?.match(/Now drawing from '(AC Power|Battery Power)'/)?.[1];
 assert(supply,'Unknown power supply');
 const lowPower=environment[`powerSettings${edge}`]?.match(/\blowpowermode\s+(\d+)/)?.[1];
 assert(lowPower!==undefined,'Low power mode was not observed');
 return{supply,lowPower:Number(lowPower)};
}
function validatePair(a,b){
 for(const r of [a,b]){assert(r.passed&&r.performanceComparable&&!r.sourceDirty,'Failed or non-comparable run');assert(r.noResidualProcesses&&r.testDataRemoved&&!r.forcedCleanup,'Cleanup did not pass');}
 assert.deepEqual(a.workloadInputs,b.workloadInputs,'Measurement or workload code differs');
 assert.deepEqual(a.modelInput,b.modelInput,'Model input differs');
 assert.deepEqual(a.rows,b.rows,'History workloads differ');
 for(const key of ['qt','python','node','externalFiles','externalTrees','compilation'])assert.deepEqual(a.build[key],b.build[key],`Toolchain/build setting differs: ${key}`);
 for(const key of ['macOS','hardware','architecture','node'])assert.equal(a.environment[key],b.environment[key],`Host differs: ${key}`);
 const supply=powerState(a.environment,'Before');
 for(const r of [a,b])for(const edge of ['Before','After'])assert.deepEqual(powerState(r.environment,edge),supply,'Power condition changed');
 for(let i=0;i<a.workloads.length;i++){
  const x=a.workloads[i],y=b.workloads[i];assert.deepEqual(x.fixture,y.fixture,'Seeded encrypted history semantics differ');
  assert.equal(x.scene.scheduleVersion,y.scene.scheduleVersion);
  assert.deepEqual(x.scene.phases.map(p=>[p.name,p.plannedDurationMs,p.plannedInputs]),y.scene.phases.map(p=>[p.name,p.plannedDurationMs,p.plannedInputs]),'Scenario plans differ');
  for(let j=0;j<x.scene.phases.length;j++){
   const p=x.scene.phases[j],q=y.scene.phases[j];
   assert(p.complete&&q.complete&&p.plannedInputs===p.dispatchedInputs&&q.plannedInputs===q.dispatchedInputs,'Incomplete phase');
   if(p.active)for(const phase of [p,q]){
    assert(phase.cadence.measured!==false&&Number.isFinite(phase.cadence.p95Ms)&&phase.cadence.p95Ms>0,'Unknown cadence');
    assert(Number.isFinite(phase.processCpuMs)&&phase.processCpuMs>0,'Unknown process CPU measurement');
    assert(Number.isFinite(phase.inputDispatchLateness?.p95Ms),'Unknown input scheduling measurement');
   }
   for(const k of ['windowStateStart','windowStateEnd'])for(const key of ['width','height','devicePixelRatio','screenName','screenRefreshRateHz']) {
    assert(p[k]?.[key]!==undefined&&p[k]?.[key]!==null&&q[k]?.[key]!==undefined&&q[k]?.[key]!==null,`Missing window condition: ${key}`);
    assert.deepEqual(p[k][key],q[k][key],`Window condition differs: ${p.name}/${k}/${key}`);
   }
  }
 }
}
function analyze(pairs,criteria){
 const groups=[];for(const rows of pairs[0].A.workloads.map(w=>w.rows)){
  const phaseNames=pairs[0].A.workloads.find(w=>w.rows===rows).scene.phases.filter(p=>p.active).map(p=>p.name);
  for(const phase of phaseNames){const values=pairs.map(({A,B})=>{
   const select=r=>r.workloads.find(w=>w.rows===rows).scene.phases.find(p=>p.name===phase);
   const a=select(A),b=select(B);assert(a.cadence.sampleCount>=300&&b.cadence.sampleCount>=300,'Insufficient active samples');
   return{baselineP95:a.cadence.p95Ms,optimizedP95:b.cadence.p95Ms,relativeImprovement:(a.cadence.p95Ms-b.cadence.p95Ms)/a.cadence.p95Ms,
    baselineOver50Rate:a.cadence.over50Ms/a.cadence.sampleCount,optimizedOver50Rate:b.cadence.over50Ms/b.cadence.sampleCount,
    baselineCpuMs:a.processCpuMs,optimizedCpuMs:b.processCpuMs,
    cpuRelativeImprovement:(a.processCpuMs-b.processCpuMs)/a.processCpuMs,
    baselineInputP95Ms:a.inputDispatchLateness?.p95Ms??null,optimizedInputP95Ms:b.inputDispatchLateness?.p95Ms??null};});
   const key=`${rows}:${phase}`,noise=criteria.aaNoise?.[key]??0,improvement=median(values.map(v=>v.relativeImprovement));
   const positivePairs=values.filter(v=>v.relativeImprovement>0).length;
   const rateChanges=values.map(v=>v.baselineOver50Rate-v.optimizedOver50Rate),rateImprovement=median(rateChanges);
   const rateNoise=criteria.aaOver50Noise?.[key]??0;
   const cpuNoise=criteria.aaCpuNoise?.[key]??0,cpuImprovement=median(values.map(v=>v.cpuRelativeImprovement));
   const inputChanges=values.filter(v=>v.baselineInputP95Ms!==null&&v.optimizedInputP95Ms!==null).map(v=>v.optimizedInputP95Ms-v.baselineInputP95Ms);
   const inputNoise=criteria.aaInputP95NoiseMs?.[key]??0;
   groups.push({rows,phase,values,aaNoise:noise,medianRelativeImprovement:improvement,positivePairs,
    primary:criteria.primaryPhases.includes(phase),meetsImprovement:improvement>=Math.max(criteria.minimumImprovement,noise)&&positivePairs>=2,
    medianOver50RateReduction:rateImprovement,aaOver50Noise:rateNoise,
    over50Regression:rateImprovement < -Math.max(criteria.maximumOver50Increase??.02,rateNoise),
    medianCpuRelativeImprovement:cpuImprovement,aaCpuNoise:cpuNoise,
    meetsEfficiencyImprovement:Number.isFinite(cpuImprovement)&&cpuImprovement>=Math.max(criteria.minimumImprovement,cpuNoise)&&values.filter(v=>v.cpuRelativeImprovement>0).length>=2,
    cpuRegression:cpuImprovement < -Math.max(criteria.maximumRegression,cpuNoise),
    inputP95IncreaseMs:inputChanges.length?median(inputChanges):null,aaInputP95NoiseMs:inputNoise,
    inputRegression:inputChanges.length>0&&median(inputChanges)>Math.max(criteria.maximumInputP95IncreaseMs??16.7,inputNoise),
    regression:improvement < -Math.max(criteria.maximumRegression,noise)});
  }
 }
 // Presentation cadence and total process CPU are separate outcomes. Faster
 // presentation may render more frames in the same scripted interval. Keep
 // CPU cost increases visible, but never label them computational savings.
 const noRegression=groups.every(g=>!g.regression&&!g.over50Regression&&!g.inputRegression);
 return{groups,performanceGainAccepted:groups.some(g=>g.primary&&g.meetsImprovement)&&noRegression,
  computationEfficiencyAccepted:groups.some(g=>g.primary&&g.meetsEfficiencyImprovement)&&noRegression&&groups.every(g=>!g.cpuRegression),
  cpuCostIncreaseObserved:groups.some(g=>g.cpuRegression),
  qualityAccepted:false,scope:'Run/pair-level performance gate only. Functional and visual acceptance are separate mandatory evidence.'};
}
async function main(args=process.argv.slice(2)){
 const o={run:false};for(let i=0;i<args.length;i++){
  if(args[i]==='--run')o.run=true;else if(['--baseline-ref','--optimized-ref','--baseline-dir','--optimized-dir','--criteria'].includes(args[i])){const key=args[i].slice(2);assert(args[i+1]&&!o[key]);o[key]=args[++i];}else throw Error('Unknown comparator option');
 }
 for(const key of ['baseline-ref','optimized-ref','baseline-dir','optimized-dir','criteria'])assert(o[key],`Missing ${key}`);
 for(const key of ['baseline-dir','optimized-dir','criteria'])assert(path.isAbsolute(o[key]),`Absolute ${key} required`);
 clean();const branch=git('symbolic-ref','--short','HEAD'),head=git('rev-parse','HEAD');
 const refs={A:git('rev-parse','--verify',`${o['baseline-ref']}^{commit}`),B:git('rev-parse','--verify',`${o['optimized-ref']}^{commit}`)};
 assert.deepEqual(sourceHashes(refs.A),sourceHashes(refs.B),'Common measurement sources differ');
 const criteria=JSON.parse(fs.readFileSync(o.criteria));assert.equal(criteria.schema,'reverie.qt.performance-criteria.v1');
 assert.deepEqual(criteria.order,['A','B','B','A','A','B']);
 assert(Number.isFinite(criteria.minimumImprovement)&&criteria.minimumImprovement>=.10&&criteria.minimumImprovement<=1);
 assert(Number.isFinite(criteria.maximumRegression)&&criteria.maximumRegression>=0&&criteria.maximumRegression<=.10);
 assert(Array.isArray(criteria.primaryPhases)&&criteria.primaryPhases.length>0);
 const calibrations=[];
 if(o.run){
  assert(Array.isArray(criteria.calibrationReports)&&criteria.calibrationReports.length>=2,'Two registered A/A calibration reports are required');
  for(const r of criteria.calibrationReports){
   assert(path.isAbsolute(r.path)&&/^[a-f0-9]{64}$/.test(r.sha256),'Invalid calibration identity');
   assert.equal(hash(fs.readFileSync(r.path)),r.sha256,'Calibration report changed');
   const report=JSON.parse(fs.readFileSync(r.path));
   assert.equal(report.sourceHead,refs.A,'Calibration must use this exact A source');
   assert(report.passed&&report.performanceComparable,'Calibration is not comparable');
   calibrations.push(report);
   for(const w of report.workloads)for(const p of w.scene.phases.filter(p=>p.active))for(const name of ['aaNoise','aaOver50Noise','aaCpuNoise','aaInputP95NoiseMs']){
    const value=criteria[name]?.[`${w.rows}:${p.name}`];assert(Number.isFinite(value)&&value>=0,`Missing measured A/A noise: ${name}/${w.rows}/${p.name}`);
   }
  }
  for(const report of calibrations.slice(1))validatePair(calibrations[0],report);
 }
 if(!o.run){console.log(JSON.stringify({branch,head,refs,order:criteria.order,criteriaSha256:hash(fs.readFileSync(o.criteria))}));return;}
 const out=fs.mkdtempSync(path.join(root,'.tools/reports/qt-perf-ab-'));
 const result={schema:'reverie.qt.performance-comparison.v1',originalBranch:branch,originalHead:head,verifierSha256:hash(fs.readFileSync(__filename)),refs,criteria,criteriaSha256:hash(fs.readFileSync(o.criteria)),runs:[],restored:false,passed:false};
 let activeChild,aborted=false;
 const stop=()=>{aborted=true;if(activeChild?.connected)activeChild.send({type:'abort-performance'},()=>{});};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
 try{
  for(const [index,variant]of criteria.order.entries()){
   assert(!aborted,'Comparison interrupted');clean();git('switch','--detach',refs[variant]);assert.equal(git('rev-parse','HEAD'),refs[variant]);
   const logfile=path.join(out,`${index+1}-${variant}.log`),fd=fs.openSync(logfile,'wx');
   const child=spawn(process.execPath,[path.join(root,'native-ui/check-performance.cjs'),'--mode','perf','--full-suite','--build-dir',o[variant==='A'?'baseline-dir':'optimized-dir']],{cwd:root,stdio:['ignore',fd,fd,'ipc']});activeChild=child;
   const exit=await new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});activeChild=null;fs.closeSync(fd);
   const lines=fs.readFileSync(logfile,'utf8').trim().split('\n');let last;try{last=JSON.parse(lines.at(-1));}catch{}
   const entry={variant,source:refs[variant],exit,logfile:path.relative(root,logfile),reportRoot:last?.reportRoot};result.runs.push(entry);
   fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(result,null,2));
   assert.equal(exit.code,0,`Run failed: ${logfile}`);assert(last?.passed&&last.performanceComparable,`Run not comparable: ${logfile}`);
   const data=JSON.parse(fs.readFileSync(path.join(last.reportRoot,'summary.json')));
   validatePair(calibrations[0],data);
   if(index%2===1){const previous=JSON.parse(fs.readFileSync(path.join(result.runs[index-1].reportRoot,'summary.json')));validatePair(previous,data);}
   clean();console.log(JSON.stringify(entry));
  }
  const loaded=result.runs.map(r=>({...r,data:JSON.parse(fs.readFileSync(path.join(r.reportRoot,'summary.json')))}));const pairs=[];
  for(let i=0;i<6;i+=2){const pair=loaded.slice(i,i+2),A=pair.find(x=>x.variant==='A').data,B=pair.find(x=>x.variant==='B').data;validatePair(A,B);pairs.push({A,B});}
  result.analysis=analyze(pairs,criteria);result.passed=true;
 }catch(e){result.error=String(e.stack||e);process.exitCode=1;}
 finally{
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  try{clean();assert.equal(git('rev-parse',branch),head,'Development branch moved unexpectedly');git('switch',branch);assert.equal(git('rev-parse','HEAD'),head);result.restored=true;}catch(e){result.restoreError=String(e);process.exitCode=1;}
  fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({reportRoot:out,passed:result.passed,restored:result.restored,gain:result.analysis?.performanceGainAccepted,error:result.error}));
 }
 return result;
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={median,validatePair,analyze,main};
