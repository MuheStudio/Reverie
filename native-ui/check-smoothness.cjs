'use strict';
// W20-only entry. Reuses the owned isolation/cleanup and GPU validators, not the
// W4 package gates or the thirty-minute historical performance scenario.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const net = require('node:net');
const guard = require('../frontend/script/acceptance-isolation.cjs');
const records = require('./build-record.cjs');
const perf = require('./check-performance.cjs');
const w4 = require('./check-header-frame-local.cjs');
const {cleanupExitedSuccessfully} = require('./cleanup-exit.cjs');
const {processTreeSnapshot} = require('./perf-sampling.cjs');
const {modelPolicyRecord} = require('./perf-model-server.cjs');
const {analyze} = require('./smoothness-analysis.cjs');
const {roles,supplementRole,environmentRole,phase2Role} = require('./smoothness-build.cjs');
const supplement = require('./smoothness-supplement.cjs');
const environmentCheck = require('./smoothness-environment.cjs');
const phase2Check = require('./smoothness-phase2.cjs');
const ROOT = path.resolve(__dirname, '..'), PACKAGE = 'smoothness-20261115';
const BASE = path.join(ROOT, '.tools/local', PACKAGE);
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2)+'\n', {flag:'wx', mode:0o600});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function validateRetryBindings(parameters, parameterSha256, retry, failure) {
  assert.deepEqual(Object.keys(retry).sort(), ['schema','originalParameterSha256','failedRunKey','failedSummaryPath',
    'failedSummarySha256','sourceHead','builds','calibrationOutput','nativeReproduction'].sort(), 'SMOOTHNESS_RETRY_FIELDS');
  assert.equal(retry.schema,'reverie.qt.smoothness.retry-bindings.v1');
  assert.equal(retry.originalParameterSha256,parameterSha256,'SMOOTHNESS_RETRY_PARAMETERS');
  assert.equal(retry.failedRunKey,'01-control');
  assert.equal(retry.calibrationOutput,'01-control-retry-1');
  assert.equal(failure.key,retry.failedRunKey);assert.equal(failure.passed,false);
  assert.equal(failure.schema,'reverie.qt.smoothness.run.v1');
  assert(/^[0-9a-f]{40}$/.test(retry.sourceHead) && retry.sourceHead!==parameters.sourceHead);
  assert.deepEqual(Object.keys(retry.builds).sort(),['ordinary','timing','corefree','profiler'].sort());
  // Only build/source bindings change. Scenario values, order and counts still
  // come exclusively from the original immutable parameters object.
  return {...parameters, sourceHead:retry.sourceHead, builds:retry.builds,
    calibrationOutput:retry.calibrationOutput,nativeReproduction:retry.nativeReproduction};
}
function binding(parameterPath, key, output, retryPath) {
  assert.equal(path.dirname(parameterPath), path.join(BASE,'preparation'), 'SMOOTHNESS_PARAMETER_LOCATION');
  let parameters=read(parameterPath);
  const parameterSha256=records.fileHash(parameterPath);
  let retryBinding=null;
  const isSupplement=parameters.schema===supplement.SCHEMA,isEnvironment=parameters.schema===environmentCheck.SCHEMA,
    isPhase2=parameters.schema===phase2Check.SCHEMA;
  assert((parameters.schema === 'reverie.qt.smoothness.parameters.v1'||isSupplement||isEnvironment||isPhase2) && parameters.package === PACKAGE);
  if(isPhase2) {
    assert.equal(path.basename(parameterPath),'parameters-phase2.json');assert(!retryPath,'PHASE2_NO_OLD_REBINDING');
    const prior=parameters.environmentParameters;
    assert.equal(prior?.path,path.join(BASE,'preparation','parameters-environment.json'));
    assert.equal(records.fileHash(prior.path),prior.sha256,'PHASE2_PRIOR_PARAMETERS_CHANGED');
    phase2Check.validateParameters(parameters,read(prior.path));
    const frozen=read(path.join(BASE,'preparation','parameters-phase2-binding.json'));
    assert.equal(frozen.sha256,parameterSha256);assert.equal(frozen.sourceHead,parameters.sourceHead);
    assert.equal(parameters.analysisSourceSha256,records.fileHash(path.join(__dirname,'smoothness-supplement.cjs')));
    assert.equal(parameters.referenceImage.path,path.join(BASE,'diagnostics/environment-01-baseline-S1/environment.companion.png'));
    assert.equal(parameters.referenceImage.sha256,'5369a694688744716bfdb7400ec09484496e44aa72e67b69a1d7a2c4b45589c7');
    assert.equal(records.fileHash(parameters.referenceImage.path),parameters.referenceImage.sha256);
  }
  if(isEnvironment) {
    assert.equal(path.basename(parameterPath),'parameters-environment.json');assert(!retryPath,'ENVIRONMENT_NO_OLD_REBINDING');
    const prior=parameters.supplementParameters;
    assert.equal(prior?.path,path.join(BASE,'preparation','parameters-supplement.json'));
    assert.equal(records.fileHash(prior.path),prior.sha256,'ENVIRONMENT_PRIOR_PARAMETERS_CHANGED');
    environmentCheck.validateParameters(parameters,read(prior.path));
    const frozen=read(path.join(BASE,'preparation','parameters-environment-binding.json'));
    assert.equal(frozen.sha256,parameterSha256,'ENVIRONMENT_PARAMETERS_CHANGED');assert.equal(frozen.sourceHead,parameters.sourceHead);
    assert.equal(parameters.analysisSourceSha256,records.fileHash(path.join(__dirname,'smoothness-supplement.cjs')),'ENVIRONMENT_ANALYSIS_CHANGED');
  }
  if(isSupplement) {
    assert.equal(path.basename(parameterPath),'parameters-supplement.json');
    assert(!retryPath,'SMOOTHNESS_SUPPLEMENT_NO_PHASE_ONE_REBINDING');
    const source=parameters.phaseOneParameters;
    assert.equal(source?.path,path.join(BASE,'preparation','parameters.json'));
    assert.equal(records.fileHash(source.path),source.sha256,'SMOOTHNESS_PHASE_ONE_PARAMETERS_CHANGED');
    supplement.validateParameters(parameters,read(source.path));
    const bindingPath=path.join(BASE,'preparation','parameters-supplement-binding.json');
    const frozen=read(bindingPath);
    assert.equal(frozen.sha256,parameterSha256,'SMOOTHNESS_SUPPLEMENT_PARAMETERS_CHANGED');
    assert.equal(frozen.sourceHead,parameters.sourceHead);
  }
  if(retryPath) {
    assert.equal(path.dirname(retryPath),path.join(BASE,'preparation'),'SMOOTHNESS_RETRY_LOCATION');
    const retry=read(retryPath);
    assert.equal(retry.failedSummaryPath,path.join(BASE,'diagnostics','01-control','summary.json'));
    assert.equal(records.fileHash(retry.failedSummaryPath),retry.failedSummarySha256,'SMOOTHNESS_FAILED_RUN_BYTES');
    const failure=read(retry.failedSummaryPath);
    assert.equal(records.fileHash(failure.scene.path),failure.scene.sha256,'SMOOTHNESS_FAILED_SCENE_BYTES');
    assert.equal(read(failure.scene.path).bootstrap?.error,'SMOOTHNESS_BOOTSTRAP_TIMEOUT');
    parameters=validateRetryBindings(parameters,parameterSha256,retry,failure);
    retryBinding={path:retryPath,sha256:records.fileHash(retryPath)};
  }

  const selected=parameters.runs.filter(row=>row.key===key);
  assert.equal(selected.length,1,'SMOOTHNESS_RUN_KEY');
  assert.equal(path.dirname(output),path.join(BASE,'diagnostics'),'SMOOTHNESS_OUTPUT_LOCATION');
  assert(!fs.existsSync(output),'SMOOTHNESS_OUTPUT_EXISTS');
  const run=selected[0];
  assert(isPhase2?run.build==='phase2':isEnvironment?run.build==='environment':isSupplement?run.build==='supplement':Object.hasOwn(roles,run.build));
  assert(['control','S1','S2','S3','S4'].includes(run.scenario));
  assert((isPhase2?['baseline']:isEnvironment?['baseline','environment-hidden','environment-half']:isSupplement?['baseline','reduced-transparency','drawer-background-off']:['baseline','reduced-transparency','corefree','threaded','profiler','gpu-positive-control']).includes(run.variant));
  return {parameters,selected:run,parameterSha256,retryBinding,isSupplement,isEnvironment,isPhase2,
    buildDirectory:path.join(ROOT,'.tools/qt-candidates',(isPhase2?phase2Role:isEnvironment?environmentRole:isSupplement?supplementRole:roles[run.build]).candidate)};
}
function calibration(anchor, buildHash) {
  if (!anchor) return {measurementValid:false,reason:'no calibration requested for this build'};
  const summary=read(anchor);
  assert(summary.schema==='reverie.qt.smoothness.run.v1' && summary.scenario==='control' && summary.passed
    && summary.buildManifestSha256===buildHash,'SMOOTHNESS_CALIBRATION_BUILD');
  assert.equal(records.fileHash(summary.scene.path),summary.scene.sha256,'SMOOTHNESS_CONTROL_BYTES');
  try {
    const result=w4.validatePositiveControl(read(summary.scene.path).rawControl,{variant:'gpu-positive-control'});
    return {measurementValid:true,method:result.method,source:anchor,sourceSha256:records.fileHash(anchor)};
  } catch(error) {return {measurementValid:false,reason:String(error),source:anchor,sourceSha256:records.fileHash(anchor)};}
}
async function unusedPort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function main(args=process.argv.slice(2)) {
  assert(args.length===3||args.length===4,'usage: check-smoothness.cjs PARAMETER_FILE RUN_KEY NEW_OUTPUT [RETRY_BINDINGS]');
  const [parameterPath,key,output,retryPath]=args;
  const {parameters,selected,parameterSha256,buildDirectory,retryBinding,isSupplement,isEnvironment,isPhase2}=binding(parameterPath,key,output,retryPath);
  assert.equal(process.platform,'darwin');
  const build=records.verifyBuild(ROOT,buildDirectory);
  assert.equal(build.record.diagnostics.ordinaryLauncherAllowed,false);
  assert.equal(build.buildManifestSha256,parameters.builds[selected.build].sha256,'SMOOTHNESS_FROZEN_BUILD');
  assert.equal(build.record.source.head,parameters.sourceHead,'SMOOTHNESS_SOURCE_HEAD');
  const control=selected.gpuTiming!==false&&selected.scenario!=='control'&&selected.build==='timing'
    ?calibration(path.join(BASE,'diagnostics',parameters.calibrationOutput,'summary.json'),build.buildManifestSha256)
    :calibration(null,build.buildManifestSha256);
  fs.mkdirSync(output,{mode:0o700});
  const start=new Date().toISOString();
  const result={schema:'reverie.qt.smoothness.run.v1',package:PACKAGE,key,scenario:selected.scenario,variant:selected.variant,
    diagnostic:true,acceptanceEligible:false,passed:false,startedAt:start,buildDirectory,
    buildManifestSha256:build.buildManifestSha256,parameterSha256,retryBinding,control,
    ...(isSupplement?{supplement:true,gpuTimingRequested:selected.gpuTiming}:{}),
    ...((isEnvironment||isPhase2)?{environmentCheck:true,gpuTimingRequested:false,entryMode:'visual'}:{}),
    ...(isPhase2?{phase2:true}:{}),
    processExits:[],cleanupErrors:[],ownedInstances:[],modelCalls:[],completedCalls:[]};
  const environment=perf.safeEnvironment({PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHON_DOTENV_DISABLED:'1',
    HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
  const model=path.join(ROOT,'.tools/live2d/yumi-local-validation/原模型测试 副本');
  const modelBefore=records.digest(records.directoryInventory(model));
  const active=[];
  let run,data,contextPath,seedAttempted=false,tracking,app,profiler;
  function track(child,identity,cycle,log=null) {
    const owned={runRoot:run.runRoot,userData:data,child,identity,cycle,owned:new Map(),spawnConfirmed:false,log};
    owned.closeCompletion=new Promise(resolve=>child.once('close',()=>{if(owned.log!==null){fs.closeSync(owned.log);owned.log=null;}resolve();}));
    child.once('spawn',()=>{owned.spawnConfirmed=true;});child.on('error',error=>{owned.error=error;});
    active.push(owned);return owned;
  }
  async function register(owned) {
    if(!owned.spawnConfirmed&&!owned.error)await new Promise((resolve,reject)=>{owned.child.once('spawn',resolve);owned.child.once('error',reject);});
    if(owned.error)throw owned.error;
    if(owned.child.exitCode!==null||owned.child.signalCode!==null) {
      assert.equal(owned.cycle,'cleanup');assert.equal(owned.child.exitCode,0);assert.equal(owned.child.signalCode,null);return;
    }
    let absent=false;
    try {guard.registerRoot(owned,(root,pids)=>{const rows=guard.inspectProcesses(root,pids);absent=rows.length===0;return rows;});}
    catch(error) {if(!await cleanupExitedSuccessfully(owned.child,{cycle:owned.cycle,processAbsent:absent,
      spawnConfirmed:owned.spawnConfirmed,spawnError:owned.error,registrationError:error}))throw error;}
    if(owned.rootIdentity)result.ownedInstances.push({cycle:owned.cycle,...owned.rootIdentity});
  }
  async function launch(cycle,flags,extra={}) {
    guard.assertIsolation(run.runRoot,data);
    const log=fs.openSync(path.join(output,cycle+'.log'),'wx',0o600);
    const child=spawn(build.binary,['--project-root',ROOT,'--data-dir',data,'--python',path.join(ROOT,'.venv/bin/python'),
      '--context',contextPath,...flags],{cwd:ROOT,env:{...environment,...extra},stdio:['ignore',log,log]});
    const owned=track(child,{executable:build.binary,appRoot:build.app,appId:'com.muhe.reverie.qt.local'},cycle,log);
    await register(owned);return owned;
  }
  async function wait(owned,ms) {
    await perf.childCompletion(owned.child,ms,owned.cycle);await owned.closeCompletion;
    const remaining=owned.rootIdentity?guard.remainingProcesses(owned):[];
    result.processExits.push({cycle:owned.cycle,exitCode:owned.child.exitCode,signal:owned.child.signalCode,remaining:remaining.length});
    assert.equal(owned.child.exitCode,0,owned.cycle+' exited abnormally');assert.equal(owned.child.signalCode,null);
    assert.equal(remaining.length,0,owned.cycle+' children remain');
  }
  async function waitFile(name,ms) {
    const deadline=Date.now()+ms;
    while(!fs.existsSync(path.join(output,name))) {
      assert(Date.now()<deadline,'SMOOTHNESS_WAIT_'+name);
      assert(app.child.exitCode===null&&app.child.signalCode===null,'SMOOTHNESS_APP_EXITED_BEFORE_'+name);await pause(50);
    }
  }
  const envInfo=()=>Object.fromEntries([['power',['-g','batt']],['thermal',['-g','therm']]].map(([name,argv])=>{
    const r=spawnSync('/usr/bin/pmset',argv,{encoding:'utf8'});return [name,{exitCode:r.status,stdout:r.stdout,stderr:r.stderr}];}));
  result.environmentBefore=envInfo();
  try {
    run=guard.createIsolationContext(fs.realpathSync(os.tmpdir()));data=guard.createIsolatedDirectory(run.runRoot,'smoothness-fixture');
    guard.prepareNativeController(run.runRoot);contextPath=path.join(run.runRoot,'smoothness.context.json');
    const rows=parameters.scenarios[selected.scenario].rows, isProfiler=selected.build==='profiler';
    const selectedContext={schema:'reverie.qt.smoothness.context.v1',package:PACKAGE,...parameters.scenarios[selected.scenario],
      scenario:selected.scenario,variant:selected.variant,buildDirectory,buildManifestSha256:build.buildManifestSha256,
      outputDirectory:output,coreFree:selected.build==='corefree',profiler:isProfiler,
      gpuEnabled:supplement.gpuTimingEnabled(selected,control),parameterSha256,
      ...(isSupplement?{supplement:true}:{}),
      ...((isEnvironment||isPhase2)?{environmentCheck:true,screenshot:selected.screenshot}:{}),
      ...(isPhase2?{phase2:true}:{}),};
    write(contextPath,{schema:'reverie.qt.isolation.v1',root:guard.snapshotDirectory(run.runRoot),data:guard.snapshotDirectory(data),smoothness:selectedContext});
    const child=spawn(process.execPath,[path.join(__dirname,'perf-model-server.cjs'),'--protocol','companion-transactions-v1'],
      {cwd:ROOT,env:environment,stdio:['ignore','ignore','ignore','ipc']});
    const server=track(child,{executable:process.execPath},'smoothness-model-server');
    const readiness=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('SMOOTHNESS_MODEL_START_TIMEOUT')),10000);
      child.on('message',message=>{
        if(message?.type==='ready'){clearTimeout(timeout);resolve(message);}
        else if(message?.type==='call')result.modelCalls.push(message);
        else if(message?.type==='complete')result.completedCalls.push(message);
      });child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',()=>{clearTimeout(timeout);reject(Error('SMOOTHNESS_MODEL_START_EXIT'));});
    });readiness.catch(()=>{});await register(server);
    const address=await readiness;
    assert(address.address==='127.0.0.1'&&address.pid===child.pid&&Number.isInteger(address.port)&&address.port>=1024
      &&address.protocol==='companion-transactions-v1'&&address.mockPolicySha256===modelPolicyRecord(address.protocol).sha256);
    const endpoint=`http://127.0.0.1:${address.port}/v1`;
    fs.mkdirSync(path.join(data,'data'),{mode:0o700});write(path.join(data,'data/config.json'),perf.fixtureConfig(endpoint));
    const fixture=path.join(output,'fixture.json');seedAttempted=true;
    await wait(await launch('seed',['--perf-seed','--perf-rows',String(rows),'--perf-fixture-report',fixture]),90000);
    const seed=read(fixture);assert(seed.rows===rows&&seed.encrypted&&seed.committed&&seed.messageIds.length===rows,'SMOOTHNESS_SEED');
    const scenePath=path.join(output,'scene.json'),port=isProfiler?await unusedPort():null;
    const extra={REVERIE_SMOOTHNESS_DIAGNOSTIC:'1',QSG_INFO:'1',...((isEnvironment||isPhase2)?{}:{QSG_RHI_PROFILE:'1'}),...(selected.environment||{})};
    app=await launch('smoothness-app',['--perf-report',scenePath,'--perf-rows',String(rows),'--perf-mode',(isEnvironment||isPhase2)?'visual':isProfiler?'diagnostic':'perf',
      '--perf-protocol','companion-transactions-v1','--test-model',model,'--test-endpoint',endpoint,
      ...(port?['--profiler-port',String(port)]:[])],extra);
    tracking=setInterval(()=>{try {for(const owned of active)if(owned.rootIdentity&&owned.child.exitCode===null)
      guard.collectProcesses(owned,processTreeSnapshot());}catch(error){result.cleanupErrors.push(String(error));}},1000);
    if(isProfiler) {
      await waitFile('scene-ready.json',100000);
      const executable=path.join(ROOT,'.tools/qt-sdk/bin/qmlprofiler'),trace=path.join(output,'scene.qmltrace');
      const stderr=path.join(output,'qml-profiler.stderr.log'),out=fs.openSync(path.join(output,'qml-profiler.stdout.log'),'wx',0o600),err=fs.openSync(stderr,'wx',0o600);
      const child=spawn(executable,['--interactive','--attach','127.0.0.1','--port',String(port),'--include',
        'binding,handlingsignal,creating,scenegraph','--output',trace,'--record','off'],{cwd:ROOT,env:environment,stdio:['pipe','pipe','pipe']});
      profiler=track(child,{executable,profilerAttachmentMode:'attach-only'},'smoothness-qml-profiler');
      child.stdin.on('error',error=>{profiler.stdinError=error;});child.stdout.on('data',chunk=>fs.writeSync(out,chunk));
      child.once('close',()=>{fs.closeSync(out);fs.closeSync(err);});
      profiler.profilerLogPath=stderr;profiler.profilerTracePath=trace;profiler.profilerAckChannel='stderr';profiler.profilerAckStream=child.stderr;
      profiler.profilerOutput=perf.profilerAckReader(child.stderr,chunk=>fs.writeSync(err,chunk),'stderr');
      await register(profiler);result.profilerStart=await perf.startProfilerRecording(profiler);
      write(path.join(output,'profiler-ready.json'),{ready:true});await waitFile('scene-complete.json',parameters.scenarios[selected.scenario].nativeTimeoutMs);
      result.profilerFlush=await perf.flushProfilerRecording(profiler);write(path.join(output,'profiler-flushed.json'),{flushed:true});
    }
    await wait(app,selected.scenario==='control'?420000:parameters.scenarios[selected.scenario].nativeTimeoutMs+100000);
    const scene=read(scenePath);result.scene={path:scenePath,sha256:records.fileHash(scenePath),bytes:fs.statSync(scenePath).size};
    assert.equal(scene.passed,true,scene.error||'SMOOTHNESS_SCENE_FAILED');
    if(selected.scenario==='control') {
      try {result.calibration=w4.validatePositiveControl(scene.rawControl,{variant:'gpu-positive-control'});result.gpuValid=true;}
      catch(error){result.gpuValid=false;result.calibrationError=String(error);}
    } else {
      if(control.measurementValid){try{w4.validateOrdinaryMethod({headerFrameTiming:scene.gpu},control.method);}
        catch(error){scene.gpuValidated=false;result.gpuInvalidReason=String(error);}}
      if(isEnvironment||isPhase2) {
        result.gpuDisabledProof=environmentCheck.validateNoGpu(scene);
        if(isPhase2)result.idleReadback=phase2Check.idleProof(scene);
        else result.variantReadback=environmentCheck.validateVariant(scene,selected);
        result.renderLoop=environmentCheck.renderLoopEvidence(fs.readFileSync(path.join(output,'smoothness-app.log'),'utf8'));
        let png;
        const imagePath=path.join(output,'environment.companion.png');
        if(selected.screenshot==='companion') {
          const info=fs.lstatSync(imagePath);assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===process.getuid()&&info.size<=32*1024*1024,'ENVIRONMENT_IMAGE_FILE');
          png=fs.readFileSync(imagePath);
        } else assert(!fs.existsSync(imagePath),'ENVIRONMENT_UNREQUESTED_SCREENSHOT');
        result.screenshot=environmentCheck.validateScreenshot(scene,selected,output,png);
        const analysis=supplement.analyzeSupplement(scene);
        if(isPhase2)analysis.resolutionFrames=phase2Check.resolutionFrames(scene);
        write(path.join(output,'analysis.json'),analysis);
        if(isPhase2) {
          let image;
          if(png) {
            const compared=spawnSync(path.join(ROOT,'.venv/bin/python'),['-I','-B',path.join(__dirname,'smoothness-image-diff.py'),
              parameters.referenceImage.path,imagePath],{cwd:ROOT,env:environment,encoding:'utf8',maxBuffer:1024*1024});
            assert.equal(compared.status,0,'PHASE2_IMAGE_ANALYSIS_FAILED: '+compared.stderr);
            image=JSON.parse(compared.stdout);write(path.join(output,'image-difference.json'),image);
          }
          result.phase2Verdict=phase2Check.verdict(selected.scenario,analysis,image);
          write(path.join(output,'phase2-verdict.json'),result.phase2Verdict);
          assert(result.phase2Verdict.passed,'PHASE2_FIXED_GATE_FAILED');
        }
      } else if(isSupplement) {
        result.gpuDisabledProof=supplement.validateGpuOff(scene);
        result.variantReadback=supplement.validateVariant(scene,selected);
        assert.equal(scene.diagnostics?.renderLoop?.observed,'basic','SMOOTHNESS_SUPPLEMENT_RENDER_LOOP');
        write(path.join(output,'analysis.json'),supplement.analyzeSupplement(scene));
      } else if(!isProfiler)write(path.join(output,'analysis.json'),analyze(scene));
    }
    if(profiler) {
      await perf.requestOwnedNormalExit(profiler);await wait(profiler,30000);
      const parsed=spawnSync(path.join(ROOT,'.venv/bin/python'),['-I','-B',path.join(__dirname,'perf-trace.py'),'--trace',profiler.profilerTracePath],
        {cwd:ROOT,env:environment,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      assert.equal(parsed.status,0,'SMOOTHNESS_PROFILER_PARSE');write(path.join(output,'profiler-analysis.json'),JSON.parse(parsed.stdout));
    }
    await perf.requestOwnedNormalExit(server);await wait(server,15000);
    await wait(await launch('cleanup',['--remove-test-key']),30000);result.keyCleanupCompleted=true;
    result.applicationUnchanged=JSON.stringify(records.digest(records.directoryInventory(build.app)))===JSON.stringify(build.record.application.inventory);
    result.modelUnchanged=JSON.stringify(records.digest(records.directoryInventory(model)))===JSON.stringify(modelBefore);
    assert(result.applicationUnchanged&&result.modelUnchanged,'SMOOTHNESS_INPUT_CHANGED');result.passed=true;
  } catch(error) {result.error=String(error.stack||error);}
  finally {
    clearInterval(tracking);
    for(const owned of perf.cleanupOrder(active)) {
      try {const cleanup=await w4.settleOwned(owned);result.forcedCleanup ||= cleanup.forcedCleanup;result.cleanupErrors.push(...cleanup.errors);}
      catch(error){result.cleanupErrors.push(String(error));}
    }
    if(seedAttempted&&!active.some(r=>r.cycle==='cleanup')) {
      try{await wait(await launch('cleanup',['--remove-test-key']),30000);result.keyCleanupCompleted=true;}
      catch(error){result.keyCleanupError=String(error);}
    }
    result.noResidualProcesses=active.every(r=>r.rootIdentity?guard.remainingProcesses(r).length===0:r.child.exitCode!==null||r.child.signalCode!==null);
    if(run&&result.noResidualProcesses&&(!seedAttempted||result.keyCleanupCompleted)) {
      try{guard.removeIsolationContext(run.runRoot);result.testDataRemoved=!fs.existsSync(run.runRoot);}
      catch(error){result.cleanupErrors.push(String(error));}
    }
    if(run&&!result.testDataRemoved)result.retainedIsolationRoot=run.runRoot;
    if(result.cleanupErrors.length||result.forcedCleanup||!result.noResidualProcesses||!result.testDataRemoved)result.passed=false;
    result.environmentAfter=envInfo();result.endedAt=new Date().toISOString();
    write(path.join(output,'summary.json'),result);
    console.log(JSON.stringify({key,output,passed:result.passed,error:result.error,gpuValid:result.gpuValid}));
    if(!result.passed)process.exitCode=1;
  }
  return result;
}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={binding,calibration,validateRetryBindings,main};
