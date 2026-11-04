'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {verifyInputHit}=require('./worldbook-injection-verdicts.cjs');
const {INJECTION_HIT_NATIVE_EVIDENCE_CONTRACT:C,verifyNativeWorldbookInjectionHitEvidence,
  writeNativeWorldbookInjectionHitEvidence}=require('./worldbook-injection-hit-native-evidence-consume.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));
const context={kind:'native-injection-hit'},primary={...context,caseId:'hit-button'};
function hitRecord(spec) {
  const scope='default:2:'+'7'.repeat(64),target={found:true,objectName:spec.control,className:'QQuickItem',token:'c1'},
    window={found:true,objectName:'',className:'QQuickWindow',token:'c2'},point={x:30,y:15};
  const hit={hitResult:'descendant',acceptorFound:true,acceptorName:'',acceptorClass:'QQuickMouseArea',
    containing:[{found:true,objectName:'',className:'QQuickMouseArea'}],containingCount:1,
    passiveObservers:[],passiveObserverCount:0,containingLimit:6};
  const metadata=elapsedMs=>({nowMs:100+elapsedMs,elapsedMs,frame:3,scope,generation:1,step:spec.step,control:spec.control,
    selectedEntryId:spec.selectedEntryIdBefore,stepAtMs:0,inputAtMs:100,window:copy(window),target:copy(target)});
  const inputHit={schema:C.inputHitSchema,kind:spec.kind,scope,generation:1,step:spec.step,control:spec.control,
    selectedEntryId:spec.selectedEntryIdBefore,stepAtMs:0,inputAtMs:100,windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,
    window:copy(window),target:copy(target),readinessPoint:copy(point),
    probe:{point:copy(point),accepted:true,hit:copy(hit),metadata:metadata(50)},
    dispatch:{point:copy(point),button:1,modifiers:0,delayMs:0,mouseDispatchCount:1,before:metadata(51),after:metadata(54),
      events:['press','release'].map((type,index)=>({type,x:30,y:15,button:1,buttons:index===0?1:0,modifiers:0,
        timestampMs:1000+index,metadata:metadata(52+index)}))}};
  const sourceInput={step:spec.step,control:spec.control,scope,generation:1,stepAtMs:0,inputAtMs:100,elapsedMs:60,frame:4,
    selectedEntryId:spec.selectedEntryId,selectedEntryIdBefore:spec.selectedEntryIdBefore,hit:copy(hit),windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,
    signals:{kind:spec.kind,mouseDispatchCount:1},inputHit,
    layout:{ready:true,polls:2,resets:1,minimumStableMs:40,last:{found:true,visible:true,fullyVisible:true,ready:true,
      layoutStable:true,enabled:true,surfaceClosed:true,scope,elapsedMs:40,stableSinceMs:0,frameSerial:2,stableFrameSerial:1,
      sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:spec.windowWidth,clipHeight:spec.windowHeight,
      inputPointInsideClip:true,visibleWidth:spec.windowWidth,visibleHeight:spec.windowHeight,bound:true,geometryValid:true,
      integerPointInsideClip:true,pointX:30,pointY:15,clipCount:1,scrollCount:1,reason:'ready',
      scrolls:[{contentY:0,contentHeight:1600,sceneX:0,sceneY:0,sceneWidth:spec.windowWidth,sceneHeight:spec.windowHeight}]}}};
  const input=copy(sourceInput);
  if(spec.fault==='dispatch-coordinate-mismatch')input.inputHit.dispatch.point.x+=1;
  if(spec.fault==='legacy-input-without-envelope')delete input.inputHit;
  return {schema:C.recordSchema,caseId:spec.caseId,sourceInput,input};
}
function boundary(input) {
  return {kind:input.signals.kind,step:input.step,control:input.control,scope:input.scope,generation:input.generation,
    selectedEntryId:input.selectedEntryIdBefore,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,windowWidth:input.windowWidth,
    windowHeight:input.windowHeight,layoutLast:input.layout.last,hit:input.hit,mouseDispatchCount:input.signals.mouseDispatchCount,
    afterAtMs:input.inputAtMs+input.elapsedMs,afterFrame:input.frame};
}
const hitFixture=()=>hitRecord(C.cases[0]).sourceInput;
const verifyHit=input=>verifyInputHit(input.inputHit,boundary(input),primary);
function rejectHit(rows) {
  for(const row of rows)assertRejectedMutation({makeFixture:hitFixture,verify:verifyHit,expectedContext:primary,...row});
}
function hitFilesFixture(existingRoot) {
  const root=existingRoot||fs.mkdtempSync(path.join(os.tmpdir(),'injection-hit-native-')),
    directory=path.join(root,'hit'),contractPath=path.join(root,'hit-contract.json');
  fs.mkdirSync(directory);fs.copyFileSync(path.join(__dirname,'tests/worldbook-injection-hit-native-evidence-contract.json'),contractPath);
  const manifest={schema:C.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of C.cases) {
    const bytes=Buffer.from(JSON.stringify(hitRecord(spec)));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'hit-proof.json')};
}
const verify=value=>verifyNativeWorldbookInjectionHitEvidence(value.directory,value.contractPath);
const dispose=value=>fs.rmSync(value.root,{recursive:true,force:true});
function rejectFiles(rows,verifier=verify) {
  for(const row of rows)assertRejectedMutation({makeFixture:hitFilesFixture,verify:verifier,dispose,kind:'files',expectedContext:context,...row});
}
function manifestMutation(value,mutate) {
  const file=path.join(value.directory,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  mutate(manifest);fs.writeFileSync(file,JSON.stringify(manifest));
}
function recordMutation(value,mutate,index=0) {
  const spec=C.cases[index],file=path.join(value.directory,spec.filename),record=JSON.parse(fs.readFileSync(file,'utf8'));
  mutate(record);const bytes=Buffer.from(JSON.stringify(record));fs.writeFileSync(file,bytes);
  manifestMutation(value,manifest=>Object.assign(manifest.cases[index],{bytes:bytes.length,sha256:hash(bytes)}));
}
const rawSnapshot=value=>Object.fromEntries(fs.readdirSync(value.directory).sort().map(name=>[name,fs.readFileSync(path.join(value.directory,name)).toString('hex')]));
test('input hit shared verifier consumes all five dispatch kinds and real nine field hit observations',()=>{
  for(const spec of C.cases.filter(spec=>spec.expectedPassed)) {
    const input=hitRecord(spec).sourceInput;
    assert.equal(verifyInputHit(input.inputHit,boundary(input)).passed,true);
    assert.equal(Object.keys(input.hit).length,9);assert.equal(Object.hasOwn(input.hit,'accepted'),false);
    assert.equal(Object.hasOwn(input.hit,'x'),false);assert.equal(Object.hasOwn(input.hit,'y'),false);
    if(spec.caseId==='hit-entry-selector') {
      assert.equal(input.selectedEntryIdBefore,'priority-a');assert.equal(input.selectedEntryId,'priority-b');
      assert.equal(input.inputHit.selectedEntryId,'priority-a');
      assert(input.inputHit.dispatch.events.every(event=>event.metadata.selectedEntryId==='priority-a'));
    }
  }
});
test('input hit evidence rejects absent legacy fields and strict false or coerced success',()=>rejectHit([
  {id:'hit.missing-envelope',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{delete v.inputHit;}},
  {id:'hit.null-envelope',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{v.inputHit=null;}},
  {id:'hit.old-schema',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{v.inputHit.schema='reverie.qt.worldbook-injection-input-hit.v0';}},
  {id:'hit.old-synthetic-result',expectedReason:'INJECTION_INPUT_HIT_SHAPE',mutate:v=>{v.hit={accepted:true,x:30,y:15};}},
  {id:'hit.missing-accepted',expectedReason:'INJECTION_INPUT_HIT_PROBE',mutate:v=>{delete v.inputHit.probe.accepted;}},
  {id:'hit.false-accepted',expectedReason:'INJECTION_INPUT_HIT_ACCEPTED',mutate:v=>{v.inputHit.probe.accepted=false;}},
  {id:'hit.string-accepted',expectedReason:'INJECTION_INPUT_HIT_ACCEPTED',mutate:v=>{v.inputHit.probe.accepted='true';}},
  {id:'hit.number-accepted',expectedReason:'INJECTION_INPUT_HIT_ACCEPTED',mutate:v=>{v.inputHit.probe.accepted=1;}},
  {id:'hit.missing-result',expectedReason:'INJECTION_INPUT_HIT_SHAPE',mutate:v=>{delete v.hit.hitResult;}},
  {id:'hit.other-result',expectedReason:'INJECTION_INPUT_HIT_RESULT',mutate:v=>{v.hit.hitResult='other';}},
  {id:'hit.acceptor-not-found',expectedReason:'INJECTION_INPUT_HIT_RESULT',mutate:v=>{v.hit.acceptorFound=false;}},
  {id:'hit.acceptor-coercion',expectedReason:'INJECTION_INPUT_HIT_RESULT',mutate:v=>{v.hit.acceptorFound=1;}},
  {id:'hit.result-type-coercion',expectedReason:'INJECTION_INPUT_HIT_RESULT',mutate:v=>{v.hit.hitResult=1;}},
  {id:'hit.probe-result-swapped',expectedReason:'INJECTION_INPUT_HIT_RESULT_BINDING',mutate:v=>{v.inputHit.probe.hit.acceptorName='other';v.inputHit.probe.hit.containing[0].objectName='other';}},
]));
test('input hit independent coordinates reject missing wrong fractional and coerced points',()=>rejectHit([
  {id:'hit.readiness-x-missing',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{delete v.inputHit.readinessPoint.x;}},
  {id:'hit.readiness-layout-different',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{v.layout.last.pointX++;}},
  {id:'hit.probe-x-wrong',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{v.inputHit.probe.point.x++;}},
  {id:'hit.dispatch-x-wrong',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{v.inputHit.dispatch.point.x++;}},
  {id:'hit.dispatch-x-string',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{v.inputHit.dispatch.point.x='30';}},
  {id:'hit.dispatch-x-fractional',expectedReason:'INJECTION_INPUT_HIT_COORDINATES',mutate:v=>{v.inputHit.dispatch.point.x=30.5;}},
  {id:'hit.press-x-wrong',expectedReason:'INJECTION_INPUT_HIT_EVENT_COORDINATES',mutate:v=>{v.inputHit.dispatch.events[0].x++;}},
  {id:'hit.release-y-wrong',expectedReason:'INJECTION_INPUT_HIT_EVENT_COORDINATES',mutate:v=>{v.inputHit.dispatch.events[1].y++;}},
  {id:'hit.event-coordinate-coercion',expectedReason:'INJECTION_INPUT_HIT_EVENT_COORDINATES',mutate:v=>{v.inputHit.dispatch.events[0].x='30';}},
]));
test('input hit binds scope generation step target selected entry window and original clocks',()=>rejectHit([
  {id:'hit.scope-wrong',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.scope='other';}},
  {id:'hit.scope-missing',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{delete v.inputHit.scope;}},
  {id:'hit.generation-string',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.generation='1';}},
  {id:'hit.step-wrong',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.step++;}},
  {id:'hit.kind-wrong',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.kind='text';}},
  {id:'hit.entry-wrong',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.selectedEntryId='other';}},
  {id:'hit.target-name-wrong',expectedReason:'INJECTION_INPUT_HIT_TARGET',mutate:v=>{v.inputHit.target.objectName='other';}},
  {id:'hit.target-missing',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{delete v.inputHit.target;}},
  {id:'hit.target-token-missing',expectedReason:'INJECTION_INPUT_HIT_TARGET',mutate:v=>{delete v.inputHit.target.token;}},
  {id:'hit.window-missing',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',mutate:v=>{delete v.inputHit.window;}},
  {id:'hit.window-not-found',expectedReason:'INJECTION_INPUT_HIT_WINDOW',mutate:v=>{v.inputHit.window.found=false;}},
  {id:'hit.window-width-wrong',expectedReason:'INJECTION_INPUT_HIT_WINDOW',mutate:v=>{v.inputHit.windowWidth++;}},
  {id:'hit.window-width-string',expectedReason:'INJECTION_INPUT_HIT_WINDOW',mutate:v=>{v.inputHit.windowWidth='1380';}},
  {id:'hit.metadata-scope-wrong',expectedReason:'INJECTION_INPUT_HIT_METADATA_BOUND',mutate:v=>{v.inputHit.probe.metadata.scope='other';}},
  {id:'hit.metadata-window-swapped',expectedReason:'INJECTION_INPUT_HIT_METADATA_WINDOW',mutate:v=>{v.inputHit.dispatch.before.window.token='ff';}},
  {id:'hit.metadata-target-swapped',expectedReason:'INJECTION_INPUT_HIT_METADATA_TARGET',mutate:v=>{v.inputHit.dispatch.events[0].metadata.target.token='ff';}},
  {id:'hit.input-clock-restarted',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{v.inputHit.inputAtMs++;}},
  {id:'hit.entry-before-missing-no-fallback',expectedReason:'INJECTION_INPUT_HIT_BOUND',mutate:v=>{delete v.selectedEntryIdBefore;}},
  {id:'hit.clock-missing',expectedReason:'INJECTION_INPUT_HIT_METADATA',mutate:v=>{delete v.inputHit.probe.metadata.nowMs;}},
  {id:'hit.clock-coercion',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{v.inputHit.probe.metadata.nowMs='150';}},
  {id:'hit.clock-reversal',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{const m=v.inputHit.dispatch.before;m.nowMs=149;m.elapsedMs=49;}},
  {id:'hit.clock-before-readiness',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{const m=v.inputHit.probe.metadata;m.nowMs=139;m.elapsedMs=39;}},
  {id:'hit.clock-at-four-seconds',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{const m=v.inputHit.probe.metadata;m.nowMs=4100;m.elapsedMs=4000;v.elapsedMs=4100;}},
  {id:'hit.clock-after-input',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{const m=v.inputHit.dispatch.after;m.nowMs=161;m.elapsedMs=61;}},
  {id:'hit.frame-future',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{v.inputHit.dispatch.after.frame=5;}},
  {id:'hit.enclosing-frame-coercion',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{v.frame='4';}},
  {id:'hit.frame-reversal',expectedReason:'INJECTION_INPUT_HIT_CLOCK',mutate:v=>{v.inputHit.dispatch.before.frame=2;}},
]));
test('input hit dispatch requires exactly one left click and one ordered press release pair',()=>rejectHit([
  {id:'hit.dispatch-count-zero',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.mouseDispatchCount=0;}},
  {id:'hit.dispatch-count-missing',expectedReason:'INJECTION_INPUT_HIT_DISPATCH',mutate:v=>{delete v.inputHit.dispatch.mouseDispatchCount;}},
  {id:'hit.dispatch-count-two',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.mouseDispatchCount=2;}},
  {id:'hit.dispatch-count-string',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.mouseDispatchCount='1';}},
  {id:'hit.signal-count-two',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.signals.mouseDispatchCount=2;}},
  {id:'hit.dispatch-right-button',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.button=2;}},
  {id:'hit.dispatch-modified',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.modifiers=1;}},
  {id:'hit.dispatch-delay',expectedReason:'INJECTION_INPUT_HIT_DISPATCH_COUNT',mutate:v=>{v.inputHit.dispatch.delayMs=1;}},
  {id:'hit.event-missing-release',expectedReason:'INJECTION_INPUT_HIT_EVENTS',mutate:v=>{v.inputHit.dispatch.events.pop();}},
  {id:'hit.event-duplicate-click',expectedReason:'INJECTION_INPUT_HIT_EVENTS',mutate:v=>{v.inputHit.dispatch.events.push(...copy(v.inputHit.dispatch.events));}},
  {id:'hit.event-order-reversed',expectedReason:'INJECTION_INPUT_HIT_EVENT',mutate:v=>{v.inputHit.dispatch.events.reverse();}},
  {id:'hit.event-still-pressed',expectedReason:'INJECTION_INPUT_HIT_EVENT',mutate:v=>{v.inputHit.dispatch.events[1].buttons=1;}},
  {id:'hit.event-time-reversed',expectedReason:'INJECTION_INPUT_HIT_EVENT',mutate:v=>{v.inputHit.dispatch.events[1].timestampMs=999;}},
]));
test('input hit keeps the original strict four second deadline and inclusive enclosing frame time',()=>{
  const input=hitFixture(),proof=input.inputHit;
  input.elapsedMs=3999;
  const rows=[proof.probe.metadata,proof.dispatch.before,...proof.dispatch.events.map(event=>event.metadata),proof.dispatch.after];
  for(const [index,row] of rows.entries()) {row.elapsedMs=3995+index;row.nowMs=input.inputAtMs+row.elapsedMs;}
  assert.equal(verifyHit(input).passed,true);
  assert.equal(rows.at(-1).nowMs,input.inputAtMs+input.elapsedMs);
});
function setObservations(input,count,passive) {
  const hit=input.hit,observer={found:true,objectName:'passive-observer',className:'QQuickItem'},
    acceptor={found:true,objectName:hit.acceptorName,className:hit.acceptorClass};
  hit.containingCount=count;hit.passiveObserverCount=passive;
  hit.containing=Array.from({length:Math.min(count,6)},(_,index)=>count<=6&&index===count-1?copy(acceptor):copy(observer));
  hit.passiveObservers=Array.from({length:Math.min(passive,6)},()=>copy(observer));input.inputHit.probe.hit=copy(hit);
}
test('input hit observations preserve passive observers and six item truncation boundaries',()=>{
  for(const [count,passive] of [[1,0],[2,1],[6,5],[7,6],[8,7]]) {
    const input=hitFixture();setObservations(input,count,passive);assert.equal(verifyHit(input).passed,true);
  }
  rejectHit([
    {id:'hit.observer-count-string',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{v.hit.passiveObserverCount='0';}},
    {id:'hit.observer-acceptor-only',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{v.hit.passiveObserverCount=1;}},
    {id:'hit.observer-list-missing',expectedReason:'INJECTION_INPUT_HIT_SHAPE',mutate:v=>{delete v.hit.passiveObservers;}},
    {id:'hit.observer-list-too-short',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{setObservations(v,8,7);v.hit.passiveObservers.pop();}},
    {id:'hit.observer-list-too-long',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{setObservations(v,8,7);v.hit.passiveObservers.push(copy(v.hit.passiveObservers[0]));}},
    {id:'hit.containing-count-zero',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{v.hit.containingCount=0;}},
    {id:'hit.containing-truncation-short',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{setObservations(v,7,0);v.hit.containing.pop();}},
    {id:'hit.containing-limit-changed',expectedReason:'INJECTION_INPUT_HIT_OBSERVATIONS',mutate:v=>{v.hit.containingLimit=7;}},
    {id:'hit.acceptor-list-mismatch',expectedReason:'INJECTION_INPUT_HIT_ACCEPTOR',mutate:v=>{v.hit.containing[0].objectName='other';}},
    {id:'hit.target-result-impostor',expectedReason:'INJECTION_INPUT_HIT_TARGET',mutate:v=>{v.hit.hitResult='target';}},
  ]);
});
test('native hit consumer preserves source bytes and validates five kinds plus two isolated faults',()=>{
  const value=hitFilesFixture();
  try {
    const before=rawSnapshot(value),proof=verify(value);
    assert.equal(proof.passed,true);assert.equal(proof.contentCollected,false);assert.deepEqual(proof.caseIds,C.cases.map(spec=>spec.caseId));
    assert.deepEqual(proof.cases.filter(row=>row.proof.expectedPassed===false).map(row=>row.proof.rejectedReason),['INJECTION_INPUT_HIT_COORDINATES','INJECTION_INPUT_HIT_EVIDENCE']);
    assert.deepEqual(writeNativeWorldbookInjectionHitEvidence(value.directory,value.contractPath,value.outputPath),proof);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.outputPath,'utf8')),proof);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('native hit consumer accepts and preserves exactly the 128 KiB record boundary',()=>{
  const value=hitFilesFixture();
  try {
    const file=path.join(value.directory,C.cases[0].filename),original=fs.readFileSync(file),
      bytes=Buffer.concat([original,Buffer.alloc(C.maximumRecordBytes-original.length,0x20)]);
    fs.writeFileSync(file,bytes);manifestMutation(value,m=>Object.assign(m.cases[0],{bytes:bytes.length,sha256:hash(bytes)}));
    const before=rawSnapshot(value);assert.equal(verify(value).passed,true);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('native hit rejects source failure candidate repair and mutations outside the declared fault',()=>rejectFiles([
  {id:'hit-native.missing-source',expectedReason:'INJECTION_HIT_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{delete r.sourceInput;})},
  {id:'hit-native.source-old-shape',expectedReason:'INJECTION_INPUT_HIT_SHAPE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.sourceInput.hit={accepted:true,x:30,y:15};})},
  {id:'hit-native.source-no-envelope',expectedReason:'INJECTION_HIT_NATIVE_INPUT_FIELDS',expectedContext:{...context,caseId:C.cases[6].caseId},mutate:v=>recordMutation(v,r=>{delete r.sourceInput.inputHit;},6)},
  {id:'hit-native.positive-candidate-mutation',expectedReason:'INJECTION_HIT_NATIVE_CANDIDATE_MUTATION',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.input.inputHit.probe.accepted=false;})},
  {id:'hit-native.coordinate-negative-repaired',expectedReason:'INJECTION_HIT_NATIVE_CANDIDATE_MUTATION',expectedContext:{...context,caseId:C.cases[5].caseId},mutate:v=>recordMutation(v,r=>{r.input=copy(r.sourceInput);},5)},
  {id:'hit-native.coordinate-negative-second-fault',expectedReason:'INJECTION_HIT_NATIVE_CANDIDATE_MUTATION',expectedContext:{...context,caseId:C.cases[5].caseId},mutate:v=>recordMutation(v,r=>{r.input.inputHit.dispatch.events[0].x++;},5)},
  {id:'hit-native.legacy-negative-repaired',expectedReason:'INJECTION_HIT_NATIVE_CANDIDATE_MUTATION',expectedContext:{...context,caseId:C.cases[6].caseId},mutate:v=>recordMutation(v,r=>{r.input=copy(r.sourceInput);},6)},
  {id:'hit-native.entry-selector-final-entry-wrong',expectedReason:'INJECTION_HIT_NATIVE_INPUT_BINDING',expectedContext:{...context,caseId:'hit-entry-selector'},mutate:v=>recordMutation(v,r=>{r.sourceInput.selectedEntryId='priority-a';},7)},
  {id:'hit-native.entry-selector-before-entry-wrong',expectedReason:'INJECTION_HIT_NATIVE_INPUT_BINDING',expectedContext:{...context,caseId:'hit-entry-selector'},mutate:v=>recordMutation(v,r=>{r.sourceInput.selectedEntryIdBefore='priority-b';},7)},
  {id:'hit-native.entry-selector-before-entry-missing',expectedReason:'INJECTION_HIT_NATIVE_INPUT_FIELDS',expectedContext:{...context,caseId:'hit-entry-selector'},mutate:v=>recordMutation(v,r=>{delete r.sourceInput.selectedEntryIdBefore;},7)},
  {id:'hit-native.entry-selector-envelope-uses-final',expectedReason:'INJECTION_INPUT_HIT_BOUND',expectedContext:{...context,caseId:'hit-entry-selector'},mutate:v=>recordMutation(v,r=>{r.sourceInput.inputHit.selectedEntryId='priority-b';},7)},
  {id:'hit-native.entry-selector-event-uses-final',expectedReason:'INJECTION_INPUT_HIT_METADATA_BOUND',expectedContext:{...context,caseId:'hit-entry-selector'},mutate:v=>recordMutation(v,r=>{r.sourceInput.inputHit.dispatch.events[0].metadata.selectedEntryId='priority-b';},7)},
]));
test('native hit reader rejects missing tampered swapped oversized symbolic and old evidence',()=>rejectFiles([
  {id:'hit-native.contract-missing',expectedReason:'INJECTION_HIT_NATIVE_FILE_MISSING',expectedContext:{...context,file:'contract'},mutate:v=>fs.unlinkSync(v.contractPath)},
  {id:'hit-native.file-missing',expectedReason:'INJECTION_HIT_NATIVE_FILE_SET',mutate:v=>fs.unlinkSync(path.join(v.directory,C.cases[0].filename))},
  {id:'hit-native.record-tampered',expectedReason:'INJECTION_HIT_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('"generation":1','"generation":2'));}},
  {id:'hit-native.record-swapped',expectedReason:'INJECTION_HIT_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename),bytes=fs.readFileSync(path.join(v.directory,C.cases[1].filename));fs.writeFileSync(file,bytes);manifestMutation(v,m=>Object.assign(m.cases[0],{bytes:bytes.length,sha256:hash(bytes)}));}},
  {id:'hit-native.record-oversized',expectedReason:'INJECTION_HIT_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),Buffer.alloc(C.maximumRecordBytes+1))},
  {id:'hit-native.record-symbolic',expectedReason:'INJECTION_HIT_NATIVE_FILE_KIND',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename),target=path.join(v.root,'held.json');fs.renameSync(file,target);fs.symlinkSync(target,file);}},
  {id:'hit-native.record-invalid-json',expectedReason:'INJECTION_HIT_NATIVE_FILE_JSON',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'{')},
  {id:'hit-native.old-contract',expectedReason:'INJECTION_HIT_NATIVE_CONTRACT',mutate:v=>{const c=JSON.parse(fs.readFileSync(v.contractPath));c.schema='reverie.qt.worldbook-injection-hit-native-contract.v0';fs.writeFileSync(v.contractPath,JSON.stringify(c));}},
  {id:'hit-native.old-manifest',expectedReason:'INJECTION_HIT_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.schema='reverie.qt.worldbook-injection-hit-native-manifest.v0';})},
  {id:'hit-native.manifest-byte-coercion',expectedReason:'INJECTION_HIT_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes=String(m.cases[0].bytes);})},
  {id:'hit-native.old-record',expectedReason:'INJECTION_HIT_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.schema='reverie.qt.worldbook-injection-hit-native-evidence.v0';})},
  {id:'hit-native.old-input-envelope',expectedReason:'INJECTION_INPUT_HIT_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.sourceInput.inputHit.schema='reverie.qt.worldbook-injection-input-hit.v0';})},
]));

// Fresh synthetic fixtures for the five unchanged evidence contracts. These
// helper bodies are retained from the prior navigation consumer tests; no raw
// Qt file or old proof is edited to manufacture a passing sixth-group result.
const {INJECTION_NAVIGATION_NATIVE_EVIDENCE_CONTRACT:N,verifyNativeWorldbookInjectionNavigationEvidence}=require('./worldbook-injection-navigation-native-evidence-consume.cjs');
const {INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT:D,verifyNativeWorldbookInjectionDepthEvidence}=require('./worldbook-injection-depth-native-evidence-consume.cjs');
const {verifyWorldbookInjectionNavigationNativeEvidencePair}=require('./worldbook-injection-navigation-native-evidence-pair-consume.cjs');
const {verifyWorldbookInjectionHitNativeEvidencePair,writeWorldbookInjectionHitNativeEvidencePair}=require('./worldbook-injection-hit-native-evidence-pair-consume.cjs');
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100};
function depthRecord(spec) {
  const scope='default:2:'+'7'.repeat(64),target={found:true,objectName:'worldbookInsertionDepth',className:'QQuickSpinBox',token:'a1'},
    editableTextInput={found:true,objectName:'',className:'QQuickTextInput',token:'a2'},
    editor={found:true,objectName:'',className:'ArchiveEditor',token:'a3'};
  const wholeVisibility={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,
    clipX:0,clipY:0,clipWidth:spec.windowWidth,clipHeight:spec.windowHeight};
  const phases=['before-click','after-click','before-select-all','after-select-all','before-digit','after-digit','before-commit','after-commit'];
  const depthInput={schema:'reverie.qt.worldbook-injection-depth-input.v1',step:spec.step,stepAtMs:0,inputAtMs:0,
    expectedValue:spec.expectedValue,beforeValue:spec.beforeValue,selectedEntryId:spec.selectedEntryId,scope,generation:1,
    controlObjectName:'worldbookInsertionDepth',standardKey:'SelectAll',sequenceMatchesStandardKey:true,standardBindingIndex:0,
    dispatchedSequencePortableText:'Ctrl+A',standardSequencePortableText:'Ctrl+A',dispatchedSequenceCodes:[0x04000041],
    standardSequenceCodes:[0x04000041],keyActions:['SelectAll',`Digit${spec.expectedValue}`,'Return'],
    mouseDispatchCount:1,keyDispatchCount:3,valueModifiedSignals:1,completed:true,
    snapshots:phases.map((phase,index)=>({phase,capturePoint:'before-boundary-assertion',nowMs:60+index*10,elapsedMs:60+index*10,
      stepAtMs:0,inputAtMs:0,scope,generation:1,step:spec.step,frame:3,selectedEntryId:spec.selectedEntryId,
      target:copy(target),editableTextInput:copy(editableTextInput),editor:copy(editor),
      focus:index===0?{found:false,objectName:'',className:'',token:''}:copy(editableTextInput),controlObjectName:'worldbookInsertionDepth',
      targetMatchesBound:true,editableMatchesBound:true,focusInTarget:index>0,focusInEditable:index>0,propertiesValid:true,
      selectionBoundsValid:true,fullSelection:index===3||index===4,textLength:1,cursorPosition:1,
      selectionStart:index===3||index===4?0:1,selectionEnd:1,selectedTextLength:index===3||index===4?1:0,textNumeric:true,
      editableValue:index<5?spec.beforeValue:spec.expectedValue,controlValue:index===7?spec.expectedValue:spec.beforeValue,
      editorValue:index===7?spec.expectedValue:spec.beforeValue,valueModifiedSignals:index===7?1:0,
      mouseDispatchCount:index===0?0:1,keyDispatchCount:[0,0,0,1,1,2,2,3][index]}))};
  const boundary={schema:D.boundarySchema,source:'native',caseId:spec.caseId,control:'worldbookInsertionDepth',
    windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,beforeValue:spec.beforeValue,expectedValue:spec.expectedValue,
    selectedEntryId:spec.selectedEntryId,scope,generation:1,step:spec.step,stepAtMs:0,inputAtMs:0,preparedAtMs:50,afterAtMs:140,
    prepareFrame:2,afterFrame:3,wholeVisibility:copy(wholeVisibility),
    layout:{ready:true,polls:2,resets:1,minimumStableMs:40,last:{...copy(wholeVisibility),ready:true,layoutStable:true,enabled:true,
      surfaceClosed:true,scope,elapsedMs:40,stableSinceMs:0,frameSerial:2,stableFrameSerial:1,inputPointInsideClip:true,
      visibleWidth:spec.windowWidth,visibleHeight:spec.windowHeight,bound:true,geometryValid:true,integerPointInsideClip:true,pointX:30,pointY:15,
      clipCount:1,scrollCount:1,reason:'ready',scrolls:[{contentY:0,contentHeight:1600,sceneX:0,sceneY:0,sceneWidth:spec.windowWidth,sceneHeight:spec.windowHeight}]}},
    qualifications:['before-click','before-select-all','before-digit','before-commit'].map((phase,index)=>({phase,nowMs:65+index*20,
      elapsedMs:65+index*20,frame:3,scope,generation:1,target:copy(target),wholeVisibility:copy(wholeVisibility),layoutMatches:true,
      focusInTarget:index>0,hit:index?{}:{hitResult:'descendant',acceptorFound:true,acceptorName:'',acceptorClass:'QQuickTextInput',
        containing:[{found:true,objectName:'',className:'QQuickTextInput'}],containingCount:1,passiveObservers:[],passiveObserverCount:0,containingLimit:6}}))};
  return {schema:D.recordSchema,caseId:spec.caseId,depthInput,boundary};
}
function navigationProofFor(input) {
  const flags=kind=>({textInput:kind==='input',textEdit:kind==='edit',comboBox:kind==='combo',spinBox:kind==='spin'});
  const empty={found:false,objectName:'',className:'',token:''};
  const identity=(objectName,className,token)=>({found:true,objectName,className,token});
  const descriptor=(objectName,className,token,contentItem=empty,focusPolicy=11,kind='none')=>({
    ...identity(objectName,className,token),typeFlags:flags(kind),visible:true,enabled:true,focusPolicy,activeFocusOnTab:true,isFocusScope:false,
    scopedFocusItem:copy(empty),contentItem:copy(contentItem),popupVisible:false,focusReason:1,geometry:copy(geometry)});
  const controls={position:descriptor('worldbookInsertionPosition','QQuickComboBox','a1',identity('','QQuickText','a2'),11,'combo'),
    depth:descriptor('worldbookInsertionDepth','QQuickSpinBox','a3',identity('','QQuickTextInput','a4'),11,'spin'),
    role:descriptor('worldbookInsertionRole','QQuickComboBox','a5',identity('','QQuickText','a6'),11,'combo')};
  const leaf={...descriptor('','QQuickTextInput','a4',empty,0,'input'),focusReason:null},
    after=descriptor('worldbookSecondaryKeywords','QQuickTextField','b1',empty,11,'input'),
    before={...descriptor('','QQuickTextInput','b2',empty,0,'input'),focusReason:null},
    beforeOwner=descriptor('worldbookEntryTokenBudget','QQuickSpinBox','b3',identity('','QQuickTextInput','b2'),11,'spin');
  const actions=['Click','Escape','Tab','Tab','Tab','Backtab','Backtab','Backtab','Backtab','Tab'];
  const keyDispatches=actions.slice(1).map(action=>({keyCode:action==='Escape'?0x01000000:action==='Backtab'?0x01000002:0x01000001,
    modifiers:action==='Backtab'?0x02000000:0}));
  const names=['click','escape','tab-depth','tab-role','tab-outside','backtab-role','backtab-depth','backtab-position','backtab-outside','tab-position'];
  const states=['position','position','depth','role','after','role','depth','position','before','position'];
  const group=copy(input.signals.beforeGroup);
  const snapshots=names.flatMap((name,actionIndex)=>['before','after'].map((side,sideIndex)=>{
    const index=actionIndex*2+sideIndex,state=states[sideIndex?actionIndex:Math.max(0,actionIndex-1)],
      focus=state==='depth'?leaf:controls[state]??(state==='after'?after:before),owner=controls[state]??(state==='before'?beforeOwner:focus);
    return {actionIndex,action:actions[actionIndex],keyCode:actionIndex===0?null:keyDispatches[actionIndex-1].keyCode,
      modifiers:actionIndex===0?0:keyDispatches[actionIndex-1].modifiers,phase:side+'-'+name,capturePoint:'before-boundary-assertion',
      mouseDispatchCount:index===0?0:1,keyDispatchCount:actionIndex===0?0:actionIndex-(sideIndex?0:1),
      positionActivatedSignals:0,depthModifiedSignals:0,roleActivatedSignals:0,values:copy(group),tabFocusBehavior:3,
      nowMs:input.inputAtMs+index*3,elapsedMs:index*3,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
      scope:input.scope,generation:input.generation,step:input.step,frame:input.frame,selectedEntryId:input.selectedEntryId,
      focus:copy(focus),owner:copy(owner),expected:copy(controls[state]??focus),focusInExpected:true,
      groupContains:['position','depth','role'].includes(state),controls:copy(controls)};
  }));
  return {schema:'reverie.qt.worldbook-injection-navigation.v2',step:input.step,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
    selectedEntryId:input.selectedEntryId,scope:input.scope,generation:input.generation,controlObjectName:input.control,
    windowWidth:input.windowWidth,windowHeight:input.windowHeight,tabFocusBehavior:3,beforeGroup:copy(group),afterGroup:copy(group),
    mouseDispatchCount:1,keyDispatchCount:9,keyActions:actions.slice(1),keyDispatches,visited:copy(input.signals.visited),completed:true,snapshots,
    positionActivatedSignals:0,depthModifiedSignals:0,roleActivatedSignals:0};
}
function navigationRecord(spec) {
  const depth=depthRecord({...spec,step:spec.depthStep}),d=depth.boundary;
  const group={position:'at_depth',depth:spec.expectedValue,role:spec.role},opposite=spec.role==='system'?'assistant':'system';
  const input={step:spec.step,stepAtMs:0,inputAtMs:0,selectedEntryId:spec.selectedEntryId,scope:d.scope,generation:d.generation,
    control:'worldbookInsertionPosition',windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,frame:5,
    signals:{beforeGroup:group,visited:N.visited}};
  const navigation=navigationProofFor(input);navigation.tabFocusBehavior=spec.tabFocusBehavior;
  for(const row of depth.depthInput.snapshots) {
    row.target.token='a3';row.editableTextInput.token='a4';row.editor.token='a7';if(row.focus.found)row.focus.token='a4';
  }
  for(const row of d.qualifications)row.target.token='a3';
  for(const [index,row] of navigation.snapshots.entries()) {
    row.nowMs=210+index*3;row.elapsedMs=row.nowMs;row.tabFocusBehavior=spec.tabFocusBehavior;
    if([9,10].includes(index))for(const name of ['focus','owner','expected']) {
      row[name].objectName=spec.afterItemObjectName;
      if(spec.useRegex) {
        row[name].className='QQuickTextArea';
        row[name].typeFlags={textInput:false,textEdit:true,comboBox:false,spinBox:false};
      }
    }
    if([17,18].includes(index)) {
      if(spec.beforeItemObjectName==='')row.owner.objectName=spec.beforeOwnerObjectName;
      else {
        const check={...copy(row.focus),objectName:spec.beforeItemObjectName,className:'QQuickCheckBox',typeFlags:{textInput:false,textEdit:false,comboBox:false,spinBox:false},focusPolicy:11,focusReason:1};
        row.focus=copy(check);row.owner=copy(check);row.expected=copy(check);
      }
    }
  }
  const before={position:'before_char',depth:0,role:opposite},atDepth={...before,position:'at_depth'},edited={...atDepth,depth:spec.expectedValue};
  const ident=value=>Object.fromEntries(['found','objectName','className','token'].map(key=>[key,value[key]]));
  const setup=[{stage:'position',beforeGroup:before,afterGroup:atDepth,beforeIndex:0,afterIndex:2,mouseDispatchCount:1,
    keyDispatchCount:4,activatedSignals:1,nowMs:50,frame:2,target:ident(navigation.snapshots[0].controls.position)},
  {stage:'depth',beforeGroup:atDepth,afterGroup:edited,mouseDispatchCount:1,keyDispatchCount:3,valueModifiedSignals:1,
    nowMs:140,frame:3,target:copy(depth.depthInput.snapshots[0].target)},
  {stage:'role',beforeGroup:edited,afterGroup:group,beforeIndex:spec.role==='system'?2:0,afterIndex:spec.role==='system'?0:2,
    mouseDispatchCount:1,keyDispatchCount:spec.role==='system'?2:4,activatedSignals:1,nowMs:180,frame:4,
    target:ident(navigation.snapshots[0].controls.role)}];
  const boundary={schema:N.boundarySchema,source:'native',caseId:spec.caseId,control:'worldbookInsertionPosition',
    windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,beforeGroup:group,expectedValue:spec.expectedValue,
    selectedEntryId:spec.selectedEntryId,scope:d.scope,generation:d.generation,step:spec.step,stepAtMs:0,inputAtMs:0,
    preparedAtMs:200,prepareFrame:4,wholeVisibility:copy(d.wholeVisibility),layout:copy(d.layout),afterAtMs:270,afterFrame:5,
    tabFocusBehavior:spec.tabFocusBehavior,setup,requestCountsBefore:{archivePut:0,chatSend:0},requestCountsAfter:{archivePut:0,chatSend:0},
    backendRunningBefore:false,backendRunningAfter:false,qualifications:navigation.snapshots.filter((_,index)=>index%2===0).map((row,index)=>({
      index,keyboard:index>0,selector:index===1,nowMs:row.nowMs+1,elapsedMs:row.elapsedMs+1,frame:5,scope:d.scope,generation:d.generation,
      target:ident(row.expected),wholeVisibility:copy(row.expected.geometry),layoutMatches:index===0?true:null,
      focusInTarget:index>0,hit:index?{}:copy(d.qualifications[0].hit)}))};
  Object.assign(boundary.layout.last,{elapsedMs:200,stableSinceMs:160,frameSerial:4,stableFrameSerial:3});
  const context={useRegex:spec.useRegex,entrySettings:Object.fromEntries([['scanDepth',spec.entryScanDepth],['tokenBudget',spec.entryTokenBudget]].map(([name,value])=>
    [name,{value,confirmed:true,editable:true,inherited:value===null,present:true,canOverride:value===null}])),
    beforeItem:ident(navigation.snapshots[17].focus),beforeOwner:ident(navigation.snapshots[17].owner),
    afterItem:ident(navigation.snapshots[9].focus),afterOwner:ident(navigation.snapshots[9].owner)};
  boundary.contextBefore=copy(context);boundary.contextAfter=copy(context);
  return {schema:N.recordSchema,caseId:spec.caseId,navigation,depthInput:depth.depthInput,boundary,depthBoundary:d};
}
function navigationFilesFixture(existingRoot) {
  const root=existingRoot||fs.mkdtempSync(path.join(os.tmpdir(),'injection-navigation-native-'));
  const directory=path.join(root,'navigation'),contractPath=path.join(root,'navigation-contract.json');fs.mkdirSync(directory);
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-injection-navigation-native-evidence-contract.json'),contractPath);
  const manifest={schema:N.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of N.cases) {
    const bytes=Buffer.from(JSON.stringify(navigationRecord(spec)));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'navigation-proof.json')};
}
function depthFilesFixture(existingRoot) {
  const root=existingRoot||fs.mkdtempSync(path.join(os.tmpdir(),'injection-depth-native-'));
  const directory=path.join(root,'depth'),contractPath=path.join(root,'depth-contract.json');fs.mkdirSync(directory);
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-injection-depth-native-evidence-contract.json'),contractPath);
  const manifest={schema:D.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of D.cases) {
    const bytes=Buffer.from(JSON.stringify(depthRecord(spec)));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'depth-proof.json')};
}
const {REGEX_NATIVE_EVIDENCE_CONTRACT:R,verifyNativeWorldbookRegexEvidence}=require('./worldbook-regex-native-evidence-consume.cjs');
const {verifyNativeEvidence}=require('./native-evidence-consume.cjs');
const {ARCHIVE_CONTROL_READINESS_CONTRACT:F,verifyNativeArchiveFocusEvidence}=require('./archive-control-readiness-verdicts.cjs');
const {verifyWorldbookInjectionDepthNativeEvidencePair,writeWorldbookInjectionDepthNativeEvidencePair}=require('./worldbook-injection-depth-native-evidence-pair-consume.cjs');
function regexGeometry(selected) {
  return {controlRect:{x:24,y:140,width:480,height:86},visibleRect:{x:24,y:140,width:480,height:86},
    viewportRect:{x:24,y:140,width:480,height:86},selectionRect:selected?{x:102,y:148,width:8,height:19}:{x:0,y:0,width:0,height:0},
    selectionStart:selected?9:0,selectionEnd:selected?10:0,cursorPosition:selected?10:0,
    hasSelection:selected,selectionFullyVisible:selected,fullyVisible:true,focusInTarget:true,textFormat:0};
}
function regexFilesFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'regex-native-consumer-'));
  const directory=path.join(root,'raw');fs.mkdirSync(directory);
  const contractPath=path.join(root,'contract.json');
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-regex-native-evidence-contract.json'),contractPath);
  const manifest={schema:R.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of R.cases) {
    // This is the JSON number produced by a validated ordinary Qt integer;
    // an enum-name string is deliberately a different, rejected fixture below.
    const value={schema:R.recordSchema,caseId:spec.caseId,control:spec.control,windowWidth:640,windowHeight:560,
      textFormat:0,geometry:regexGeometry(spec.selectionRequired)};
    const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'regex-proof.json')};
}

function legacyRowRecord(expected) {
  const {step,targetId,sourcePersonaId,livePersonaId,scope,generation,root,page}=expected;
  const [,epoch,fingerprint]=scope.split(':');
  const control={found:true,bound:true,geometryValid:true,integerPointInsideClip:true,ready:true,enabled:true,visible:true,
    surfaceClosed:true,inputPointInsideClip:true,scope,fullyVisible:true,pointX:35,pointY:20,
    sceneX:10,sceneY:10,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100,
    scrolls:[{contentY:100,contentHeight:500,sceneX:0,sceneY:0,sceneWidth:100,sceneHeight:100}]};
  const whole={found:true,visible:true,fullyVisible:true,...Object.fromEntries(
    ['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].map(key=>[key,control[key]]))};
  const reveal={expired:false,geometryValid:true,scrollLimit:6,ancestorCount:1,scrollCount:0,elapsedMs:40,
    scrolls:[{index:0,beforeY:100,afterY:100,minimumY:0,maximumY:400,contentHeight:500,viewportHeight:100,
      topYBefore:10,bottomYBefore:30,requestedY:70,scrolled:false,fitsViewport:true,afterObserved:true}]};
  const observed={ready:true,root,page,targetId,sourcePersonaId,livePersonaId,scope,generation,
    listPersonaId:livePersonaId,listActivePersonaId:sourcePersonaId,personaEpoch:Number(epoch),listPersonaEpoch:Number(epoch),
    personaFingerprint:fingerprint,listPersonaFingerprint:fingerprint,liveMatches:true,
    taskSurfaceCount:1,characterTasksCount:1,rowCount:1,controlCount:1,targetProfileCount:1,sourceProfileCount:1,activeProfileCount:1,
    rowId:targetId,rowActive:false,rowIdKnown:true,rowActiveKnown:true,modelDataType:'QJSValue',normalizedModelDataType:'QVariantMap',
    identityMatches:true,rowInactive:true,scopeMatches:true,generationMatches:true,personaMatches:true,surfaceReady:true,effectiveOpacity:1,
    control,whole,hit:{acceptorFound:true,hitResult:'descendant'},reveal};
  const anchor={...copy(observed),elapsedMs:0,frameSerial:20,schedulingIntervalMs:null};anchor.reveal.elapsedMs=0;
  const terminal={...copy(observed),elapsedMs:40,frameSerial:21,schedulingIntervalMs:40,
    layout:{layoutStable:true,stableSinceMs:0,stableFrameSerial:20},stableAnchor:copy(anchor),dispatchElapsedMs:41,
    dispatchFrameSerial:21,dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,mouseElapsedMs:42,
    mouseFrameSerial:21,clickedSignals:1,signalObserverValid:true,status:'performed',failureReason:''};
  terminal.mouse={...copy(observed),elapsedMs:41,frameSerial:21,schedulingIntervalMs:40,layout:copy(terminal.layout)};
  return {step,targetId,sourcePersonaId,livePersonaId,control:'personaSwitch-'+targetId,root,page,scope,generation,stepAtMs:0,
    deadlineMs:4000,pollIntervalMs:40,minimumStableMs:40,sampleLimit:6,polls:2,windowWidth:100,windowHeight:100,
    dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,clickedSignals:1,status:'performed',failureReason:'',terminalCount:1,
    samples:[anchor],terminal,sequence:{performed:true,expired:false,failed:false,busy:false,actionIndex:1,
      actions:[{name:'personaSwitch-'+targetId,index:0,attempted:true,performed:true,failed:false,actionElapsedMs:40}]}};
}
function legacyHeaderWrapper(spec) {
  const e=spec.expected,readId='paired_header_'+spec.caseId.replaceAll('-','_'),text=`待确认 · 第${e.pageNumber}批 · 本批${e.count}条`;
  const [personaId,epoch,fingerprint]=e.scope.split(':');
  const g={found:true,visible:e.visible,fullyVisible:e.visible,sceneX:10,sceneY:10,sceneWidth:360,sceneHeight:20,
    clipX:0,clipY:0,clipWidth:591,clipHeight:650};
  const record={schema:'reverie.candidate-header.v1',objectName:'memoryCandidatePageInfo',rootObjectName:e.rootObjectName,
    objectCount:1,outsideScroll:true,page:e.page,tabIndex:e.tabIndex,live:true,busy:false,pageNumber:e.pageNumber,count:e.count,
    readRequestId:readId,scope:e.scope,generation:e.generation,frameSerial:2,textLength:text.length,textSha256:hash(text),textMatches:true,
    className:'QQuickText',inheritsQuickText:true,textFormat:0,textFormatValid:true,
    textFormatProperty:{exists:true,readable:true,enumProperty:true,readSucceeded:true,enumType:true,conversionSucceeded:true,memberValid:true},
    childInputObjects:{childScanComplete:true,childrenInspected:0,mouseAreaChildren:0,pointerHandlerChildren:0},
    activeFocus:false,activeFocusOnTab:false,acceptedMouseButtons:0,contentWidth:250,contentHeight:18,geometry:g,
    windowWidth:591,windowHeight:650,scrollFound:true,contentYBefore:0,contentYAfter:0};
  const anchor={...copy(record),frameSerial:1,elapsedMs:0},terminal={...copy(record),elapsedMs:40};
  record.settling={minimumStableMs:40,deadlineMs:e.acquisitionDeadlineMs,elapsedMs:40,stableSinceMs:0,frameSerial:2,
    stableFrameSerial:1,polls:2,sampleLimit:6,samples:[copy(anchor),copy(terminal)],anchor,terminal,
    companionAnchor:{},companionTerminal:{},terminalCount:1,ready:true,expired:false,failed:false};
  return {schema:'reverie.native-input-evidence.v1',caseId:spec.caseId,record,
    read:{command:e.readCommand,envelope:{protocol_version:4,request_id:readId,command:e.readCommand,
      persona:{persona_id:personaId,epoch:Number(epoch),fingerprint}},receipt:{type:'memory:candidates:result',request_id:readId,
      payload:{ok:true,status:'pending',persona_id:personaId,persona_epoch:Number(epoch),persona_fingerprint:fingerprint,
        candidates:e.rowIds.map(id=>({id,status:'pending'})),has_more:false,next_cursor:null}}}};
}
function focusSnapshot(index,width,height) {
  const names=['worldbookName','worldbookKeywords','','worldbookContent'];
  const rect={x:20,y:70+index*32,width:120,height:28},windowRect={x:0,y:0,width,height};
  const node=(instanceToken,objectName,className,nodeRect,clip=false)=>({instanceToken,objectName,className,
    visible:true,enabled:true,opacity:1,clip,isFlickable:className==='QQuickFlickable',rect:copy(nodeRect)});
  const leaf=node('focus-'+(index+1),names[index],index===2?'QQuickTextInput':'QQuickTextField',rect);
  const parent=node('focus-20','worldbookEntryScanDepth','QQuickSpinBox',rect);
  const area=node('focus-90','worldbook-form-scroll','QQuickFlickable',{x:10,y:50,width:280,height:180},true);
  const root=node('focus-91','root','QQuickRootItem',windowRect),ancestry=index===2?[leaf,parent,area,root]:[leaf,area,root];
  const owner=index===2?parent:leaf;
  return {instanceToken:leaf.instanceToken,objectName:leaf.objectName,className:leaf.className,windowToken:'window-1',
    owner:{instanceToken:owner.instanceToken,objectName:owner.objectName,className:owner.className},visible:true,enabled:true,opacity:1,
    rect:copy(rect),windowRect,ancestry,ancestryComplete:true,
    clipChain:[{instanceToken:area.instanceToken,objectName:area.objectName,rect:copy(area.rect)}],intersection:copy(rect),
    cursorRect:null,focusReason:1,focusReasonStatus:'known',clipChainComplete:true,scrollsComplete:true,
    scrolls:[{instanceToken:area.instanceToken,objectName:area.objectName,y:100,minimumY:0,maximumY:720,height:180,contentHeight:900}]};
}
function focusWrapper(spec) {
  const records=[];
  for(let index=0;index<24;++index) {
    const bodyFocused=index%4===3;
    records.push({index,step:28,scope:'scope-fixture',generation:1,direction:bodyFocused||index>=12?'Backtab':'Tab',bodyFocused,
      inputCount:1,immediate:true,before:focusSnapshot(index%4,spec.width,spec.height),
      after:focusSnapshot((index+1)%4,spec.width,spec.height),
      causal:{schema:F.focusTraversal.causalSchema,overflow:false,events:[{sequence:0,kind:'observation-start'}]},
      positioningBefore:3,positioningAfter:3,frameBefore:2,frameAfter:2,elapsedBeforeMs:62+index*2,elapsedAfterMs:63+index*2});
  }
  const trace={schema:F.focusTraversal.schema,phase:'tab-visible-controls',step:28,scope:'scope-fixture',generation:1,
    windowToken:'window-1',deadlineMs:4000,startElapsedMs:61,endElapsedMs:109,initialPositioningCount:3,records};
  const boundary={source:'native',caseId:spec.caseId,dataTag:spec.dataTag,scope:trace.scope,generation:trace.generation,
    windowToken:trace.windowToken,windowWidth:spec.width,windowHeight:spec.height,deadlineMs:4000,
    actionElapsedMs:60,afterElapsedMs:110,actionFrame:2,afterFrame:2};
  return {schema:F.nativeFocusEvidence.schema,caseId:spec.caseId,trace,boundary};
}
function pairFilesFixture() {
  const value=regexFilesFixture();
  Object.assign(value,{legacyDirectory:path.join(value.root,'native'),legacyContract:path.join(value.root,'native-contract.json'),
    legacyOutput:path.join(value.root,'native-proof.json'),focusDirectory:path.join(value.root,'focus'),
    focusContract:path.join(value.root,'focus-contract.json'),focusOutput:path.join(value.root,'focus-proof.json')});
  fs.mkdirSync(value.legacyDirectory);fs.mkdirSync(value.focusDirectory);
  fs.copyFileSync(path.join(__dirname,'tests/p1-native-evidence-contract.json'),value.legacyContract);
  fs.copyFileSync(path.join(__dirname,'tests/archive-control-readiness-contract.json'),value.focusContract);
  const legacy=JSON.parse(fs.readFileSync(value.legacyContract,'utf8'));
  const nativeManifest={schema:'reverie.native-input-evidence.manifest.v1',contractSha256:hash(fs.readFileSync(value.legacyContract)),cases:[]};
  for(const spec of legacy.cases) {
    const wrapper=spec.kind==='persona-row'?{schema:'reverie.native-input-evidence.v1',caseId:spec.caseId,record:legacyRowRecord(spec.expected)}:legacyHeaderWrapper(spec);
    const bytes=Buffer.from(JSON.stringify(wrapper));fs.writeFileSync(path.join(value.legacyDirectory,spec.filename),bytes);
    nativeManifest.cases.push({caseId:spec.caseId,filename:spec.filename,kind:spec.kind,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(value.legacyDirectory,'manifest.json'),JSON.stringify(nativeManifest));
  const focusManifest={schema:F.nativeFocusEvidence.manifestSchema,contractSha256:hash(fs.readFileSync(value.focusContract)),cases:[]};
  for(const spec of F.nativeFocusEvidence.cases) {
    const bytes=Buffer.from(JSON.stringify(focusWrapper(spec)));fs.writeFileSync(path.join(value.focusDirectory,spec.filename),bytes);
    focusManifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(value.focusDirectory,'manifest.json'),JSON.stringify(focusManifest));
  return value;
}
function sixFilesFixture() {
  const value=pairFilesFixture(),depth=depthFilesFixture(value.root),navigation=navigationFilesFixture(value.root),hit=hitFilesFixture(value.root);
  return {...value,depthDirectory:depth.directory,depthContract:depth.contractPath,depthOutput:depth.outputPath,
    navigationDirectory:navigation.directory,navigationContract:navigation.contractPath,navigationOutput:navigation.outputPath,
    hitDirectory:hit.directory,hitContract:hit.contractPath,hitOutput:hit.outputPath};
}
const sixOutputs=value=>[value.legacyOutput,value.focusOutput,value.outputPath,value.depthOutput,value.navigationOutput,value.hitOutput];
const sixVerify=value=>verifyWorldbookInjectionHitNativeEvidencePair(value.legacyDirectory,value.legacyContract,
  value.focusDirectory,value.focusContract,value.directory,value.contractPath,value.depthDirectory,value.depthContract,
  value.navigationDirectory,value.navigationContract,value.hitDirectory,value.hitContract);
const sixWrite=value=>writeWorldbookInjectionHitNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.legacyOutput,
  value.focusDirectory,value.focusContract,value.focusOutput,value.directory,value.contractPath,value.outputPath,
  value.depthDirectory,value.depthContract,value.depthOutput,value.navigationDirectory,value.navigationContract,value.navigationOutput,
  value.hitDirectory,value.hitContract,value.hitOutput);
function verifySixWriter(value) {
  const before=sixOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null);
  let proof;
  try {proof=sixWrite(value);} catch(error) {
    assert.deepEqual(sixOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null),before,
      'Rejected six-group evidence wrote or changed a proof');throw error;
  }
  for(const file of sixOutputs(value))fs.unlinkSync(file);
  return proof;
}
test('hit six consumer pair preserves all five old proof objects and all original bytes',()=>{
  const value=sixFilesFixture();
  try {
    const directories=[value.legacyDirectory,value.focusDirectory,value.directory,value.depthDirectory,value.navigationDirectory,value.hitDirectory],
      before=directories.map(directory=>rawSnapshot({directory}));
    const old=verifyWorldbookInjectionNavigationNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.focusDirectory,value.focusContract,
      value.directory,value.contractPath,value.depthDirectory,value.depthContract,value.navigationDirectory,value.navigationContract);
    const expected={...old,hit:verifyNativeWorldbookInjectionHitEvidence(value.hitDirectory,value.hitContract)};
    assert.deepEqual(sixVerify(value),expected);assert.deepEqual(sixWrite(value),expected);
    assert.deepEqual(Object.values(expected).map(proof=>proof.caseIds.length),[4,3,2,3,6,8]);
    for(const [index,key] of ['native','focus','regex','depth','navigation','hit'].entries())
      assert.equal(fs.readFileSync(sixOutputs(value)[index],'utf8'),JSON.stringify(expected[key],null,2)+'\n');
    assert.deepEqual(directories.map(directory=>rawSnapshot({directory})),before);
  } finally {dispose(value);}
});
test('hit six consumer pair writes no proofs when any one independent group fails',()=>{
  const rows=[
    {id:'hit-pair.native-missing',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},
      mutate:v=>fs.unlinkSync(path.join(v.legacyDirectory,'persona-row-default-success.json'))},
    {id:'hit-pair.focus-missing',expectedReason:'ARCHIVE_FOCUS_FILE_SET',expectedContext:{kind:'native-focus'},
      mutate:v=>fs.unlinkSync(path.join(v.focusDirectory,F.nativeFocusEvidence.cases[0].filename))},
    {id:'hit-pair.regex-missing',expectedReason:'REGEX_NATIVE_FILE_SET',expectedContext:{kind:'native-regex'},
      mutate:v=>fs.unlinkSync(path.join(v.directory,R.cases[0].filename))},
    {id:'hit-pair.depth-missing',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_SET',expectedContext:{kind:'native-injection-depth'},
      mutate:v=>fs.unlinkSync(path.join(v.depthDirectory,D.cases[0].filename))},
    {id:'hit-pair.navigation-missing',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_SET',expectedContext:{kind:'native-injection-navigation'},
      mutate:v=>fs.unlinkSync(path.join(v.navigationDirectory,N.cases[0].filename))},
    {id:'hit-pair.hit-missing',expectedReason:'INJECTION_HIT_NATIVE_FILE_SET',expectedContext:context,
      mutate:v=>fs.unlinkSync(path.join(v.hitDirectory,C.cases[0].filename))},
    {id:'hit-pair.hit-source-rejected',expectedReason:'INJECTION_INPUT_HIT_ACCEPTED',expectedContext:primary,
      mutate:v=>recordMutation({directory:v.hitDirectory},record=>{record.sourceInput.inputHit.probe.accepted=false;})},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:sixFilesFixture,verify:verifySixWriter,dispose,kind:'files',...row});
});
test('hit six consumer pair rejects existing overlapping and in evidence destinations before writing',()=>{
  const rows=[
    {id:'hit-pair.output-existing',expectedReason:'INJECTION_HIT_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>fs.writeFileSync(v.hitOutput,'retained')},
    {id:'hit-pair.output-overlapping',expectedReason:'INJECTION_HIT_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>{v.hitOutput=v.legacyOutput;}},
    {id:'hit-pair.output-in-evidence',expectedReason:'INJECTION_HIT_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',expectedContext:{field:'outputs'},
      mutate:v=>{v.hitOutput=path.join(v.navigationDirectory,'hit-proof.json');}},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:sixFilesFixture,verify:verifySixWriter,dispose,kind:'files',...row});
});
