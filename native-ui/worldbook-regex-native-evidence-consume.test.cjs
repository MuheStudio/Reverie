'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {REGEX_NATIVE_EVIDENCE_CONTRACT:C,verifyNativeWorldbookRegexEvidence,writeNativeWorldbookRegexEvidence}=
  require('./worldbook-regex-native-evidence-consume.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const context={kind:'native-regex'},primary={...context,caseId:C.cases[0].caseId},secondary={...context,caseId:C.cases[1].caseId};
function geometry(selected) {
  return {controlRect:{x:24,y:140,width:480,height:86},visibleRect:{x:24,y:140,width:480,height:86},
    viewportRect:{x:24,y:140,width:480,height:86},selectionRect:selected?{x:102,y:148,width:8,height:19}:{x:0,y:0,width:0,height:0},
    selectionStart:selected?9:0,selectionEnd:selected?10:0,cursorPosition:selected?10:0,
    hasSelection:selected,selectionFullyVisible:selected,fullyVisible:true,focusInTarget:true,textFormat:0};
}
function filesFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'regex-native-consumer-'));
  const directory=path.join(root,'raw');fs.mkdirSync(directory);
  const contractPath=path.join(root,'contract.json');
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-regex-native-evidence-contract.json'),contractPath);
  const manifest={schema:C.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of C.cases) {
    // This is the JSON number produced by a validated ordinary Qt integer;
    // an enum-name string is deliberately a different, rejected fixture below.
    const value={schema:C.recordSchema,caseId:spec.caseId,control:spec.control,windowWidth:640,windowHeight:560,
      textFormat:0,geometry:geometry(spec.selectionRequired)};
    const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'regex-proof.json')};
}
const verify=value=>verifyNativeWorldbookRegexEvidence(value.directory,value.contractPath);
const dispose=value=>fs.rmSync(value.root,{recursive:true,force:true});
function reject(rows,verifier=verify) {
  for(const row of rows) assertRejectedMutation({makeFixture:filesFixture,verify:verifier,dispose,kind:'files',expectedContext:context,...row});
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
test('regex native consumer accepts two serialized numeric-zero records and preserves every raw byte',()=>{
  const value=filesFixture();
  try {
    const before=rawSnapshot(value),proof=verify(value);
    assert.deepEqual(proof.caseIds,['regex-primary-selected','regex-secondary-plain']);
    assert.equal(proof.schema,'reverie.regex-native-evidence-verdict.v1');
    assert.equal(proof.passed,true);assert.equal(proof.contentCollected,false);
    assert.deepEqual(proof.cases.map(row=>row.proof.textFormat),[0,0]);
    assert.deepEqual(JSON.parse(JSON.stringify(proof)),proof);
    assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('regex standalone writer writes a fresh proof only after complete verification and preserves raw bytes',()=>{
  const value=filesFixture();
  try {
    const before=rawSnapshot(value),expected=verify(value),proof=writeNativeWorldbookRegexEvidence(value.directory,value.contractPath,value.outputPath);
    assert.deepEqual(proof,expected);assert.deepEqual(JSON.parse(fs.readFileSync(value.outputPath,'utf8')),expected);
    assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('regex native consumer rejects missing, extra and substituted record fields independently',()=>reject([
  {id:'regex-native.record-null',expectedReason:'REGEX_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const key of Object.keys(r))delete r[key];})},
  {id:'regex-native.record-extra',expectedReason:'REGEX_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.rawText='unregistered';})},
  {id:'regex-native.record-format-missing',expectedReason:'REGEX_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{delete r.textFormat;})},
  {id:'regex-native.record-schema',expectedReason:'REGEX_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.schema='reverie.regex-native-evidence.v2';})},
  {id:'regex-native.record-case-swapped',expectedReason:'REGEX_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.caseId=C.cases[1].caseId;})},
  {id:'regex-native.record-control-swapped',expectedReason:'REGEX_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.control=C.cases[1].control;})},
  {id:'regex-native.record-geometry-null',expectedReason:'REGEX_NATIVE_GEOMETRY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry=null;})},
  {id:'regex-native.record-geometry-extra',expectedReason:'REGEX_NATIVE_GEOMETRY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.text='unregistered';})},
  {id:'regex-native.record-geometry-format-missing',expectedReason:'REGEX_NATIVE_GEOMETRY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{delete r.geometry.textFormat;})},
]));
test('regex native consumer shares the exact production geometry, focus and selected-range rejection guards',()=>reject([
  {id:'regex-native.geometry-not-visible',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.fullyVisible=false;})},
  {id:'regex-native.geometry-no-focus',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.focusInTarget=false;})},
  {id:'regex-native.geometry-nonnumeric-rect',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.controlRect.x='24';})},
  {id:'regex-native.geometry-negative-height',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.visibleRect.height=-1;})},
  {id:'regex-native.geometry-invalid-window',expectedReason:'REGEX_PATTERN_CONTAINMENT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.windowWidth=null;})},
  {id:'regex-native.geometry-window-clipped',expectedReason:'REGEX_PATTERN_CONTAINMENT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.windowHeight=200;})},
  {id:'regex-native.geometry-viewport-clipped',expectedReason:'REGEX_PATTERN_CONTAINMENT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.viewportRect.width=300;})},
  {id:'regex-native.geometry-viewport-as-visible',expectedReason:'REGEX_PATTERN_VISIBLE_RECT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.visibleRect={x:0,y:0,width:640,height:560};r.geometry.viewportRect={x:0,y:0,width:640,height:560};})},
  {id:'regex-native.geometry-invalid-selection-shape',expectedReason:'REGEX_PATTERN_SELECTION_SHAPE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionEnd=8;})},
  {id:'regex-native.geometry-primary-not-selected',expectedReason:'REGEX_PATTERN_SELECTION_VISIBLE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.hasSelection=false;})},
  {id:'regex-native.geometry-primary-wrong-range',expectedReason:'REGEX_PATTERN_SELECTION_VISIBLE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionStart=8;})},
  {id:'regex-native.geometry-selection-clipped',expectedReason:'REGEX_PATTERN_SELECTION_VISIBLE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionRect.x=630;})},
]));
test('regex native consumer rejects old enum-name serialization and all unsupported PlainText representations',()=>reject([
  {id:'regex-native.format-old-real-plaintext',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat='PlainText';r.geometry.textFormat='PlainText';})},
  {id:'regex-native.format-string-zero',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat='0';r.geometry.textFormat='0';})},
  {id:'regex-native.format-null',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat=null;r.geometry.textFormat=null;})},
  {id:'regex-native.format-false',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat=false;r.geometry.textFormat=false;})},
  {id:'regex-native.format-true',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat=true;r.geometry.textFormat=true;})},
  {id:'regex-native.format-unknown',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat=91;r.geometry.textFormat=91;})},
  {id:'regex-native.format-rich',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat=1;r.geometry.textFormat=1;})},
  {id:'regex-native.format-top-disagrees',expectedReason:'REGEX_NATIVE_FORMAT_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat='PlainText';})},
  {id:'regex-native.format-geometry-disagrees',expectedReason:'REGEX_NATIVE_FORMAT_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.geometry.textFormat='PlainText';})},
]));
test('regex native consumer requires the secondary control to have no selection',()=>reject([
  {id:'regex-native.secondary-selected',expectedReason:'REGEX_NATIVE_SECONDARY_SELECTION',expectedContext:secondary,mutate:v=>recordMutation(v,r=>{r.geometry.hasSelection=true;},1)},
  {id:'regex-native.secondary-selection-visible',expectedReason:'REGEX_NATIVE_SECONDARY_SELECTION',expectedContext:secondary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionFullyVisible=true;},1)},
  {id:'regex-native.secondary-range-not-collapsed',expectedReason:'REGEX_NATIVE_SECONDARY_SELECTION',expectedContext:secondary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionEnd=1;},1)},
  {id:'regex-native.secondary-selection-rect-not-empty',expectedReason:'REGEX_NATIVE_SECONDARY_SELECTION',expectedContext:secondary,mutate:v=>recordMutation(v,r=>{r.geometry.selectionRect.width=1;},1)},
]));
test('regex native consumer freezes contract, manifest identity, full case set, order, names, byte counts and digests',()=>reject([
  {id:'regex-native.contract-substitution',expectedReason:'REGEX_NATIVE_CONTRACT',mutate:v=>fs.writeFileSync(v.contractPath,'{}')},
  {id:'regex-native.contract-limit',expectedReason:'REGEX_NATIVE_CONTRACT',mutate:v=>{const c=JSON.parse(fs.readFileSync(v.contractPath));c.maximumRecordBytes++;fs.writeFileSync(v.contractPath,JSON.stringify(c));}},
  {id:'regex-native.manifest-extra',expectedReason:'REGEX_NATIVE_MANIFEST_FIELDS',mutate:v=>manifestMutation(v,m=>{m.extra=true;})},
  {id:'regex-native.manifest-schema',expectedReason:'REGEX_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.schema='other';})},
  {id:'regex-native.manifest-contract-hash',expectedReason:'REGEX_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.contractSha256='0'.repeat(64);})},
  {id:'regex-native.manifest-missing-case',expectedReason:'REGEX_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases.pop();})},
  {id:'regex-native.manifest-extra-case',expectedReason:'REGEX_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases.push({...m.cases[0]});})},
  {id:'regex-native.manifest-duplicate',expectedReason:'REGEX_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases[1]={...m.cases[0]};})},
  {id:'regex-native.manifest-swapped',expectedReason:'REGEX_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases.reverse();})},
  {id:'regex-native.manifest-entry-extra',expectedReason:'REGEX_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].extra=true;})},
  {id:'regex-native.manifest-traversal',expectedReason:'REGEX_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].filename='../regex-primary-selected.json';})},
  {id:'regex-native.manifest-byte-string',expectedReason:'REGEX_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes=String(m.cases[0].bytes);})},
  {id:'regex-native.manifest-byte-over-bound',expectedReason:'REGEX_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes=C.maximumRecordBytes+1;})},
  {id:'regex-native.manifest-hash-uppercase',expectedReason:'REGEX_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].sha256='A'.repeat(64);})},
  {id:'regex-native.manifest-wrong-bytes',expectedReason:'REGEX_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].bytes++;})},
  {id:'regex-native.manifest-wrong-digest',expectedReason:'REGEX_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].sha256='0'.repeat(64);})},
]));
test('regex native consumer rejects missing, extra, symlinked, oversized, malformed and changed raw files',()=>reject([
  {id:'regex-native.file-missing',expectedReason:'REGEX_NATIVE_FILE_SET',mutate:v=>fs.unlinkSync(path.join(v.directory,C.cases[0].filename))},
  {id:'regex-native.file-extra',expectedReason:'REGEX_NATIVE_FILE_SET',mutate:v=>fs.writeFileSync(path.join(v.directory,'extra.json'),'{}')},
  {id:'regex-native.file-symlink',expectedReason:'REGEX_NATIVE_FILE_KIND',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename),target=path.join(v.root,'moved.json');fs.renameSync(file,target);fs.symlinkSync(target,file);}},
  {id:'regex-native.directory-symlink',expectedReason:'REGEX_NATIVE_DIRECTORY',mutate:v=>{const moved=path.join(v.root,'moved-raw');fs.renameSync(v.directory,moved);fs.symlinkSync(moved,v.directory);}},
  {id:'regex-native.file-empty',expectedReason:'REGEX_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'')},
  {id:'regex-native.file-oversized',expectedReason:'REGEX_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),' '.repeat(C.maximumRecordBytes+1))},
  {id:'regex-native.file-json',expectedReason:'REGEX_NATIVE_FILE_JSON',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'{')},
  {id:'regex-native.file-changed-size',expectedReason:'REGEX_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>fs.appendFileSync(path.join(v.directory,C.cases[0].filename),' ')},
  {id:'regex-native.file-changed-same-size',expectedReason:'REGEX_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename),bytes=fs.readFileSync(file,'utf8');fs.writeFileSync(file,bytes.replace('640','641'));}},
]));
function verifyWriter(value) {
  const before=fs.existsSync(value.outputPath)?fs.readFileSync(value.outputPath):null;
  let proof;
  try {proof=writeNativeWorldbookRegexEvidence(value.directory,value.contractPath,value.outputPath);} catch(error) {
    if(before===null)assert.equal(fs.existsSync(value.outputPath),false,'Rejected evidence wrote a proof');
    else assert.deepEqual(fs.readFileSync(value.outputPath),before,'Rejected evidence overwrote an existing output');
    throw error;
  }
  fs.unlinkSync(value.outputPath);return proof;
}
test('regex standalone writer requires fresh outputs outside evidence and writes no proof after rejection',()=>reject([
  {id:'regex-native.output-existing',expectedReason:'REGEX_NATIVE_OUTPUT_NOT_FRESH',expectedContext:{field:'output'},mutate:v=>fs.writeFileSync(v.outputPath,'retained')},
  {id:'regex-native.output-in-evidence',expectedReason:'REGEX_NATIVE_OUTPUT_IN_EVIDENCE',expectedContext:{field:'output'},mutate:v=>{v.outputPath=path.join(v.directory,'new-proof.json');}},
  {id:'regex-native.output-bad-record',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.textFormat='PlainText';r.geometry.textFormat='PlainText';})},
],verifyWriter));

// Controlled complete file sets for the three real consumers. These reproduce
// the existing dedicated row/header/focus fixture shapes without importing a
// test module or replacing any verifier with a stub.
const {verifyNativeEvidence}=require('./native-evidence-consume.cjs');
const {ARCHIVE_CONTROL_READINESS_CONTRACT:F,verifyNativeArchiveFocusEvidence}=require('./archive-control-readiness-verdicts.cjs');
const {verifyWorldbookRegexNativeEvidencePair,writeWorldbookRegexNativeEvidencePair}=
  require('./worldbook-regex-native-evidence-pair-consume.cjs');
const copy=value=>JSON.parse(JSON.stringify(value));
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
  const value=filesFixture();
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
const pairOutputs=value=>[value.legacyOutput,value.focusOutput,value.outputPath];
const pairVerify=value=>verifyWorldbookRegexNativeEvidencePair(value.legacyDirectory,value.legacyContract,
  value.focusDirectory,value.focusContract,value.directory,value.contractPath);
const pairWrite=value=>writeWorldbookRegexNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.legacyOutput,
  value.focusDirectory,value.focusContract,value.focusOutput,value.directory,value.contractPath,value.outputPath);
function pairRawSnapshot(value) {
  return [value.legacyDirectory,value.focusDirectory,value.directory].map(directory=>rawSnapshot({directory}));
}
function verifyPairWriter(value) {
  let proof;
  try {proof=pairWrite(value);} catch(error) {
    assert.deepEqual(pairOutputs(value).map(file=>fs.existsSync(file)),[false,false,false],'Failed member emitted a proof');
    throw error;
  }
  for(const file of pairOutputs(value))fs.unlinkSync(file);
  return proof;
}
test('regex three-consumer pair preserves old proof objects and writes three independent proofs after full success',()=>{
  const value=pairFilesFixture();
  try {
    const before=pairRawSnapshot(value),expected={native:verifyNativeEvidence(value.legacyDirectory,value.legacyContract),
      focus:verifyNativeArchiveFocusEvidence(value.focusDirectory,value.focusContract),regex:verify(value)};
    assert.deepEqual(pairVerify(value),expected);
    assert.deepEqual(expected.native.caseIds.length,4);assert.deepEqual(expected.focus.caseIds.length,3);assert.deepEqual(expected.regex.caseIds.length,2);
    const actual=pairWrite(value);assert.deepEqual(actual,expected);
    for(const [index,key] of ['native','focus','regex'].entries())
      assert.equal(fs.readFileSync(pairOutputs(value)[index],'utf8'),JSON.stringify(expected[key],null,2)+'\n');
    assert.deepEqual(pairRawSnapshot(value),before);
  } finally {dispose(value);}
});
test('regex three-consumer pair emits no proof if any complete independently validated member is mutated',()=>{
  const rows=[
    {id:'regex-pair.native-member-missing',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},
      mutate:v=>fs.unlinkSync(path.join(v.legacyDirectory,'persona-row-default-success.json'))},
    {id:'regex-pair.focus-member-missing',expectedReason:'ARCHIVE_FOCUS_FILE_SET',expectedContext:{kind:'native-focus'},
      mutate:v=>fs.unlinkSync(path.join(v.focusDirectory,F.nativeFocusEvidence.cases[0].filename))},
    {id:'regex-pair.regex-member-old-serialization',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:primary,
      mutate:v=>recordMutation(v,r=>{r.textFormat='PlainText';r.geometry.textFormat='PlainText';})},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:pairFilesFixture,verify:verifyPairWriter,kind:'files',dispose,...row});
});
