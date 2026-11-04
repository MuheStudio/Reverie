'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT:C,verifyNativeWorldbookInjectionDepthEvidence,
  writeNativeWorldbookInjectionDepthEvidence}=require('./worldbook-injection-depth-native-evidence-consume.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
const context={kind:'native-injection-depth'},primary={...context,caseId:'depth-0-to-1'};
function depthRecord(spec) {
  const scope='default:2:'+'7'.repeat(64),target={found:true,objectName:'worldbookInsertionDepth',className:'QQuickSpinBox',token:'a1'},
    editableTextInput={found:true,objectName:'',className:'QQuickTextInput',token:'a2'},
    editor={found:true,objectName:'',className:'ArchiveEditor',token:'a3'};
  const wholeVisibility={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,
    clipX:0,clipY:0,clipWidth:1380,clipHeight:900};
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
  const boundary={schema:C.boundarySchema,source:'native',caseId:spec.caseId,control:'worldbookInsertionDepth',
    windowWidth:spec.windowWidth,windowHeight:spec.windowHeight,beforeValue:spec.beforeValue,expectedValue:spec.expectedValue,
    selectedEntryId:spec.selectedEntryId,scope,generation:1,step:spec.step,stepAtMs:0,inputAtMs:0,preparedAtMs:50,afterAtMs:140,
    prepareFrame:2,afterFrame:3,wholeVisibility:copy(wholeVisibility),
    layout:{ready:true,polls:2,resets:1,minimumStableMs:40,last:{...copy(wholeVisibility),ready:true,layoutStable:true,enabled:true,
      surfaceClosed:true,scope,elapsedMs:40,stableSinceMs:0,frameSerial:2,stableFrameSerial:1,inputPointInsideClip:true,
      visibleWidth:1380,visibleHeight:900,bound:true,geometryValid:true,integerPointInsideClip:true,pointX:30,pointY:15,
      clipCount:1,scrollCount:1,reason:'ready',scrolls:[{contentY:0,contentHeight:1600,sceneX:0,sceneY:0,sceneWidth:1380,sceneHeight:900}]}},
    qualifications:['before-click','before-select-all','before-digit','before-commit'].map((phase,index)=>({phase,nowMs:65+index*20,
      elapsedMs:65+index*20,frame:3,scope,generation:1,target:copy(target),wholeVisibility:copy(wholeVisibility),layoutMatches:true,
      focusInTarget:index>0,hit:index?{}:{hitResult:'descendant',acceptorFound:true,acceptorName:'',acceptorClass:'QQuickTextInput',
        containing:[{found:true,objectName:'',className:'QQuickTextInput'}],containingCount:1,passiveObservers:[],passiveObserverCount:0,containingLimit:6}}))};
  return {schema:C.recordSchema,caseId:spec.caseId,depthInput,boundary};
}
function depthFilesFixture(existingRoot) {
  const root=existingRoot||fs.mkdtempSync(path.join(os.tmpdir(),'injection-depth-native-'));
  const directory=path.join(root,'depth'),contractPath=path.join(root,'depth-contract.json');fs.mkdirSync(directory);
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-injection-depth-native-evidence-contract.json'),contractPath);
  const manifest={schema:C.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of C.cases) {
    const bytes=Buffer.from(JSON.stringify(depthRecord(spec)));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'depth-proof.json')};
}
const verify=value=>verifyNativeWorldbookInjectionDepthEvidence(value.directory,value.contractPath);
const dispose=value=>fs.rmSync(value.root,{recursive:true,force:true});
function reject(rows,verifier=verify) {
  for(const row of rows)assertRejectedMutation({makeFixture:depthFilesFixture,verify:verifier,dispose,kind:'files',expectedContext:context,...row});
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
function rawSnapshot(value) {
  return Object.fromEntries(fs.readdirSync(value.directory).sort().map(name=>[name,fs.readFileSync(path.join(value.directory,name)).toString('hex')]));
}
test('injection depth native consumer accepts three original serialized transitions and preserves every byte',()=>{
  const value=depthFilesFixture();
  try {
    const before=rawSnapshot(value),proof=verify(value);
    assert.deepEqual(proof.caseIds,['depth-0-to-1','depth-1-to-0','depth-0-to-2']);
    assert.deepEqual(proof.cases.map(row=>[row.proof.beforeValue,row.proof.expectedValue]),[[0,1],[1,0],[0,2]]);
    assert.equal(proof.passed,true);assert.equal(proof.contentCollected,false);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('injection depth native writer emits a fresh proof after verification without changing raw evidence',()=>{
  const value=depthFilesFixture();
  try {
    const before=rawSnapshot(value),expected=verify(value);
    assert.deepEqual(writeNativeWorldbookInjectionDepthEvidence(value.directory,value.contractPath,value.outputPath),expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.outputPath,'utf8')),expected);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('injection depth native records reject missing extra and substituted typed fields',()=>reject([
  {id:'depth-native.record-extra',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.rawText='0';})},
  {id:'depth-native.record-missing',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{delete r.depthInput;})},
  {id:'depth-native.record-schema',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.schema='other';})},
  {id:'depth-native.record-case',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.caseId='depth-0-to-2';})},
  {id:'depth-native.boundary-null',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary=null;})},
  {id:'depth-native.boundary-extra',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.fakeGuiGate=true;})},
  {id:'depth-native.boundary-before-string',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.beforeValue='0';})},
  {id:'depth-native.boundary-narrow',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.windowWidth=760;})},
  {id:'depth-native.boundary-gui',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.source='gui';})},
]));
test('injection depth native preparation keeps its real clock stable frame and whole geometry',()=>reject([
  {id:'depth-native.clock-null',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_CLOCK',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.preparedAtMs=null;})},
  {id:'depth-native.clock-late',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_CLOCK',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.afterAtMs=4000;})},
  {id:'depth-native.frame-reversed',expectedReason:'INJECTION_DEPTH_NATIVE_BOUNDARY_CLOCK',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.prepareFrame=4;})},
  {id:'depth-native.geometry-clipped',expectedReason:'INJECTION_DEPTH_NATIVE_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.wholeVisibility.fullyVisible=false;})},
  {id:'depth-native.layout-unready',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.ready=false;})},
  {id:'depth-native.layout-raw-text',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.text='0';})},
  {id:'depth-native.layout-scroll-omitted',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.scrolls.pop();})},
  {id:'depth-native.layout-scroll-truncated',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.scrollCount=7;})},
  {id:'depth-native.layout-one-frame',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.stableFrameSerial=2;})},
  {id:'depth-native.layout-short',expectedReason:'INJECTION_DEPTH_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.stableSinceMs=1;})},
]));
test('injection depth native records use the same modifier selection replacement and model guards as GUI',()=>reject([
  {id:'depth-native.failed-diagnostic',expectedReason:'INJECTION_DEPTH_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthInput.completed=false;})},
  {id:'depth-native.meta-a',expectedReason:'INJECTION_DEPTH_SEQUENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthInput.dispatchedSequenceCodes=[0x10000041];})},
  {id:'depth-native.missing-phase',expectedReason:'INJECTION_DEPTH_PHASES',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthInput.snapshots.pop();})},
  {id:'depth-native.not-selected',expectedReason:'INJECTION_DEPTH_SELECTION',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{
    const s=r.depthInput.snapshots[4];s.selectionStart=1;s.selectedTextLength=0;s.fullSelection=false;
  })},
  {id:'depth-native.prepended-ten',expectedReason:'INJECTION_DEPTH_REPLACEMENT',expectedContext:{...primary,phase:'after-digit'},mutate:v=>recordMutation(v,r=>{r.depthInput.snapshots[5].editableValue=10;})},
  {id:'depth-native.wrong-model',expectedReason:'INJECTION_DEPTH_VALUES',expectedContext:{...primary,phase:'after-commit'},mutate:v=>recordMutation(v,r=>{r.depthInput.snapshots[7].editorValue=0;})},
  {id:'depth-native.late-capture',expectedReason:'INJECTION_DEPTH_SNAPSHOT',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.depthInput.snapshots[4].capturePoint='after-boundary-assertion';})},
  {id:'depth-native.raw-text',expectedReason:'INJECTION_DEPTH_SNAPSHOT',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.depthInput.snapshots[4].text='0';})},
]));
test('injection depth native qualification rejects missing reordered or wrong target and focus boundaries',()=>reject([
  {id:'depth-native.qual-missing',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATIONS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.qualifications.pop();})},
  {id:'depth-native.qual-reordered',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATIONS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.qualifications.reverse();})},
  {id:'depth-native.qual-extra',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_FIELDS',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].text='0';})},
  {id:'depth-native.qual-unmatched',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_BOUND',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].layoutMatches=false;})},
  {id:'depth-native.qual-focus',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_BOUND',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].focusInTarget=false;})},
  {id:'depth-native.qual-target',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_TARGET',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].target.token='b1';})},
  {id:'depth-native.qual-late',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_CLOCK',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].nowMs=141;})},
  {id:'depth-native.qual-after-digit',expectedReason:'INJECTION_DEPTH_NATIVE_QUALIFICATION_CLOCK',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].nowMs=111;r.boundary.qualifications[2].elapsedMs=111;})},
  {id:'depth-native.qual-hit-rejected',expectedReason:'INJECTION_DEPTH_NATIVE_HIT',expectedContext:{...primary,phase:'before-click'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[0].hit.hitResult='other';})},
  {id:'depth-native.qual-hit-raw-text',expectedReason:'INJECTION_DEPTH_NATIVE_HIT',expectedContext:{...primary,phase:'before-click'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[0].hit.text='0';})},
  {id:'depth-native.qual-key-hit-extra',expectedReason:'INJECTION_DEPTH_NATIVE_HIT',expectedContext:{...primary,phase:'before-digit'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[2].hit={hitResult:'target'};})},
]));
test('injection depth native manifest freezes unique cases order paths byte counts digests and contract',()=>reject([
  {id:'depth-native.contract',expectedReason:'INJECTION_DEPTH_NATIVE_CONTRACT',mutate:v=>fs.writeFileSync(v.contractPath,'{}')},
  {id:'depth-native.manifest-fields',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_FIELDS',mutate:v=>manifestMutation(v,m=>{m.extra=true;})},
  {id:'depth-native.manifest-schema',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.schema='other';})},
  {id:'depth-native.manifest-contract-hash',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.contractSha256='0'.repeat(64);})},
  {id:'depth-native.manifest-duplicate',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases[1]=copy(m.cases[0]);})},
  {id:'depth-native.manifest-reordered',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases.reverse();})},
  {id:'depth-native.manifest-traversal',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].filename='../depth-0-to-1.json';})},
  {id:'depth-native.manifest-byte-string',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes=String(m.cases[0].bytes);})},
  {id:'depth-native.manifest-hash-uppercase',expectedReason:'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].sha256='A'.repeat(64);})},
  {id:'depth-native.manifest-wrong-bytes',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes++;})},
  {id:'depth-native.manifest-wrong-hash',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].sha256='0'.repeat(64);})},
]));
test('injection depth native files reject missing extra links oversized malformed and changed bytes',()=>reject([
  {id:'depth-native.file-missing',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_SET',mutate:v=>fs.unlinkSync(path.join(v.directory,C.cases[0].filename))},
  {id:'depth-native.file-extra',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_SET',mutate:v=>fs.writeFileSync(path.join(v.directory,'extra.json'),'{}')},
  {id:'depth-native.file-link',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_KIND',expectedContext:primary,mutate:v=>{
    const file=path.join(v.directory,C.cases[0].filename),target=path.join(v.root,'moved.json');fs.renameSync(file,target);fs.symlinkSync(target,file);
  }},
  {id:'depth-native.directory-link',expectedReason:'INJECTION_DEPTH_NATIVE_DIRECTORY',mutate:v=>{
    const moved=path.join(v.root,'moved-depth');fs.renameSync(v.directory,moved);fs.symlinkSync(moved,v.directory);
  }},
  {id:'depth-native.file-empty',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'')},
  {id:'depth-native.file-oversized',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),' '.repeat(C.maximumRecordBytes+1))},
  {id:'depth-native.file-json',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_JSON',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'{')},
  {id:'depth-native.file-appended',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>fs.appendFileSync(path.join(v.directory,C.cases[0].filename),' ')},
  {id:'depth-native.file-changed',expectedReason:'INJECTION_DEPTH_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>{
    const file=path.join(v.directory,C.cases[0].filename);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('1380','1381'));
  }},
]));
function verifyWriter(value) {
  const before=fs.existsSync(value.outputPath)?fs.readFileSync(value.outputPath):null;
  try {
    const proof=writeNativeWorldbookInjectionDepthEvidence(value.directory,value.contractPath,value.outputPath);
    fs.unlinkSync(value.outputPath);return proof;
  } catch(error) {
    if(before===null)assert.equal(fs.existsSync(value.outputPath),false,'Rejected depth evidence wrote a proof');
    else assert.deepEqual(fs.readFileSync(value.outputPath),before,'Rejected depth evidence changed existing output');
    throw error;
  }
}
test('injection depth native writer requires a fresh outside destination and leaves no proof on rejection',()=>reject([
  {id:'depth-native.output-existing',expectedReason:'INJECTION_DEPTH_NATIVE_OUTPUT_NOT_FRESH',expectedContext:{field:'output'},mutate:v=>fs.writeFileSync(v.outputPath,'retained')},
  {id:'depth-native.output-inside',expectedReason:'INJECTION_DEPTH_NATIVE_OUTPUT_IN_EVIDENCE',expectedContext:{field:'output'},mutate:v=>{v.outputPath=path.join(v.directory,'proof.json');}},
  {id:'depth-native.output-bad-proof',expectedReason:'INJECTION_DEPTH_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthInput.completed=false;})},
],verifyWriter));

// Complete controlled fixtures for the unchanged three consumers; no test
// module is imported, no verifier is stubbed, and every old group is checked.
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
function jointFilesFixture() {
  const value=pairFilesFixture(),depth=depthFilesFixture(value.root);
  return {...value,depthDirectory:depth.directory,depthContract:depth.contractPath,depthOutput:depth.outputPath};
}
const jointOutputs=value=>[value.legacyOutput,value.focusOutput,value.outputPath,value.depthOutput];
const jointVerify=value=>verifyWorldbookInjectionDepthNativeEvidencePair(value.legacyDirectory,value.legacyContract,
  value.focusDirectory,value.focusContract,value.directory,value.contractPath,value.depthDirectory,value.depthContract);
const jointWrite=value=>writeWorldbookInjectionDepthNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.legacyOutput,
  value.focusDirectory,value.focusContract,value.focusOutput,value.directory,value.contractPath,value.outputPath,
  value.depthDirectory,value.depthContract,value.depthOutput);
function verifyJointWriter(value) {
  const before=jointOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null);
  let proof;
  try {proof=jointWrite(value);} catch(error) {
    assert.deepEqual(jointOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null),before,
      'Rejected four-group evidence wrote or changed a proof');
    throw error;
  }
  for(const file of jointOutputs(value))fs.unlinkSync(file);
  return proof;
}
test('injection depth four-consumer pair retains old proof objects and writes four only after complete success',()=>{
  const value=jointFilesFixture();
  try {
    const directories=[value.legacyDirectory,value.focusDirectory,value.directory,value.depthDirectory];
    const before=directories.map(directory=>rawSnapshot({directory}));
    const expected={native:verifyNativeEvidence(value.legacyDirectory,value.legacyContract),
      focus:verifyNativeArchiveFocusEvidence(value.focusDirectory,value.focusContract),
      regex:verifyNativeWorldbookRegexEvidence(value.directory,value.contractPath),
      depth:verifyNativeWorldbookInjectionDepthEvidence(value.depthDirectory,value.depthContract)};
    assert.deepEqual(jointVerify(value),expected);assert.deepEqual(jointWrite(value),expected);
    assert.deepEqual(Object.values(expected).map(proof=>proof.caseIds.length),[4,3,2,3]);
    for(const [index,key] of ['native','focus','regex','depth'].entries())
      assert.equal(fs.readFileSync(jointOutputs(value)[index],'utf8'),JSON.stringify(expected[key],null,2)+'\n');
    assert.deepEqual(directories.map(directory=>rawSnapshot({directory})),before);
  } finally {dispose(value);}
});
test('injection depth four-consumer pair emits no proof for a mutation in each independently validated group',()=>{
  const rows=[
    {id:'depth-pair.legacy-missing',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},
      mutate:v=>fs.unlinkSync(path.join(v.legacyDirectory,'persona-row-default-success.json'))},
    {id:'depth-pair.focus-missing',expectedReason:'ARCHIVE_FOCUS_FILE_SET',expectedContext:{kind:'native-focus'},
      mutate:v=>fs.unlinkSync(path.join(v.focusDirectory,F.nativeFocusEvidence.cases[0].filename))},
    {id:'depth-pair.regex-missing',expectedReason:'REGEX_NATIVE_FILE_SET',expectedContext:{kind:'native-regex'},
      mutate:v=>fs.unlinkSync(path.join(v.directory,R.cases[0].filename))},
    {id:'depth-pair.depth-failed',expectedReason:'INJECTION_DEPTH_EVIDENCE',expectedContext:primary,
      mutate:v=>recordMutation({directory:v.depthDirectory},record=>{record.depthInput.completed=false;})},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:jointFilesFixture,verify:verifyJointWriter,dispose,kind:'files',...row});
});
test('injection depth four-consumer pair rejects existing overlapping and in-evidence destinations without writing',()=>{
  const rows=[
    {id:'depth-pair.output-existing',expectedReason:'INJECTION_DEPTH_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>fs.writeFileSync(v.depthOutput,'retained')},
    {id:'depth-pair.output-overlapping',expectedReason:'INJECTION_DEPTH_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>{v.depthOutput=v.legacyOutput;}},
    {id:'depth-pair.output-in-evidence',expectedReason:'INJECTION_DEPTH_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',expectedContext:{field:'outputs'},
      mutate:v=>{v.depthOutput=path.join(v.depthDirectory,'new-proof.json');}},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:jointFilesFixture,verify:verifyJointWriter,dispose,kind:'files',...row});
});
