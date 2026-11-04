'use strict';
// Consume the original serialized Qt observations without rewriting them. The
// numeric replacement validator is also used by the GUI injection verdict.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyDepthInput}=require('./worldbook-injection-verdicts.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
const INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT=Object.freeze({
  schema:'reverie.qt.worldbook-injection-depth-native-contract.v1',
  recordSchema:'reverie.qt.worldbook-injection-depth-native-evidence.v1',
  manifestSchema:'reverie.qt.worldbook-injection-depth-native-manifest.v1',
  boundarySchema:'reverie.qt.worldbook-injection-depth-native-boundary.v1',
  environment:'REVERIE_P1_INJECTION_DEPTH_EVIDENCE_DIR',maximumRecordBytes:131072,
  cases:Object.freeze([[0,1,212],[1,0,231],[0,2,242]].map(([beforeValue,expectedValue,step])=>Object.freeze({
    caseId:`depth-${beforeValue}-to-${expectedValue}`,filename:`depth-${beforeValue}-to-${expectedValue}.json`,
    dataTag:`wide-${beforeValue}-to-${expectedValue}`,windowWidth:1380,windowHeight:900,
    beforeValue,expectedValue,step,selectedEntryId:'priority-a'}))),
});
const C=INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const guard=(condition,reason,context)=>assert(condition,verdictReason(reason,context));
const equal=(actual,expected,reason,context)=>assert.deepEqual(actual,expected,verdictReason(reason,context));
function exactKeys(value,keys,reason,context) {
  guard(object(value),reason,context);equal(Object.keys(value).sort(),keys.slice().sort(),reason,context);
}
function readEvidenceFile(file,limit,context) {
  guard(typeof file==='string'&&file.length>0&&fs.existsSync(file),'INJECTION_DEPTH_NATIVE_FILE_MISSING',context);
  const info=fs.lstatSync(file);
  guard(info.isFile()&&!info.isSymbolicLink(),'INJECTION_DEPTH_NATIVE_FILE_KIND',context);
  guard(info.size>0&&info.size<=limit,'INJECTION_DEPTH_NATIVE_FILE_BOUND',context);
  const bytes=fs.readFileSync(file);guard(bytes.length===info.size,'INJECTION_DEPTH_NATIVE_FILE_BYTES',context);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch {guard(false,'INJECTION_DEPTH_NATIVE_FILE_JSON',context);}
  return {bytes,value};
}
function visibility(value,width,height,context) {
  exactKeys(value,['found','visible','fullyVisible','sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'],
    'INJECTION_DEPTH_NATIVE_GEOMETRY',context);
  guard(value.found===true&&value.visible===true&&value.fullyVisible===true&&
    ['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(key=>Number.isFinite(value[key]))&&
    value.sceneWidth>1&&value.sceneHeight>1&&value.clipWidth>0&&value.clipHeight>0&&value.clipX>=-.5&&value.clipY>=-.5&&
    value.clipX+value.clipWidth<=width+.5&&value.clipY+value.clipHeight<=height+.5&&
    value.sceneX+.5>=value.clipX&&value.sceneY+.5>=value.clipY&&
    value.sceneX+value.sceneWidth-.5<=value.clipX+value.clipWidth&&
    value.sceneY+value.sceneHeight-.5<=value.clipY+value.clipHeight,'INJECTION_DEPTH_NATIVE_GEOMETRY',context);
}
function verifyNativeWorldbookInjectionDepthEvidenceRecord(record,spec) {
  guard(object(spec),'INJECTION_DEPTH_NATIVE_CASE_SPEC',{kind:'native-injection-depth'});
  equal(spec,C.cases.find(entry=>entry.caseId===spec.caseId),'INJECTION_DEPTH_NATIVE_CASE_SPEC',{kind:'native-injection-depth'});
  const context={kind:'native-injection-depth',caseId:spec.caseId};
  exactKeys(record,['schema','caseId','depthInput','boundary'],'INJECTION_DEPTH_NATIVE_RECORD_FIELDS',context);
  equal([record.schema,record.caseId],[C.recordSchema,spec.caseId],'INJECTION_DEPTH_NATIVE_RECORD_BINDING',context);
  const b=record.boundary;
  exactKeys(b,['schema','source','caseId','control','windowWidth','windowHeight','beforeValue','expectedValue','selectedEntryId',
    'scope','generation','step','stepAtMs','inputAtMs','preparedAtMs','afterAtMs','prepareFrame','afterFrame','wholeVisibility','layout','qualifications'],
    'INJECTION_DEPTH_NATIVE_BOUNDARY_FIELDS',context);
  equal([b.schema,b.source,b.caseId,b.control,b.windowWidth,b.windowHeight,b.beforeValue,b.expectedValue,b.step,b.selectedEntryId],
    [C.boundarySchema,'native',spec.caseId,'worldbookInsertionDepth',spec.windowWidth,spec.windowHeight,
      spec.beforeValue,spec.expectedValue,spec.step,spec.selectedEntryId],'INJECTION_DEPTH_NATIVE_BOUNDARY_BINDING',context);
  guard(typeof b.scope==='string'&&b.scope.length>0&&b.scope.length<=256&&integer(b.generation)&&
    [b.stepAtMs,b.inputAtMs,b.preparedAtMs,b.afterAtMs,b.prepareFrame,b.afterFrame].every(integer)&&
    b.stepAtMs<=b.inputAtMs&&b.inputAtMs<=b.preparedAtMs&&b.preparedAtMs<=b.afterAtMs&&
    b.afterAtMs-b.inputAtMs<4000&&b.prepareFrame<=b.afterFrame,'INJECTION_DEPTH_NATIVE_BOUNDARY_CLOCK',context);
  visibility(b.wholeVisibility,b.windowWidth,b.windowHeight,context);
  exactKeys(b.layout,['ready','polls','resets','minimumStableMs','last'],'INJECTION_DEPTH_NATIVE_LAYOUT',context);
  const last=b.layout?.last;
  exactKeys(last,['found','enabled','visible','inputPointInsideClip','surfaceClosed','ready','visibleWidth','visibleHeight',
    'scope','bound','geometryValid','integerPointInsideClip','pointX','pointY','clipCount','scrollCount','reason',
    'sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight','scrolls','fullyVisible',
    'elapsedMs','frameSerial','layoutStable','stableSinceMs','stableFrameSerial'],'INJECTION_DEPTH_NATIVE_LAYOUT',context);
  guard(b.layout?.ready===true&&b.layout.minimumStableMs===40&&integer(b.layout.polls)&&b.layout.polls>=2&&
    integer(b.layout.resets)&&object(last)&&last.ready===true&&last.layoutStable===true&&last.enabled===true&&
    last.found===true&&last.visible===true&&last.fullyVisible===true&&last.bound===true&&last.geometryValid===true&&
    last.integerPointInsideClip===true&&last.inputPointInsideClip===true&&last.reason==='ready'&&
    last.surfaceClosed===true&&last.scope===b.scope&&integer(last.elapsedMs)&&last.elapsedMs<=b.preparedAtMs-b.inputAtMs&&
    integer(last.stableSinceMs)&&last.elapsedMs-last.stableSinceMs>=40&&integer(last.frameSerial)&&
    integer(last.stableFrameSerial)&&last.frameSerial>last.stableFrameSerial&&last.frameSerial<=b.prepareFrame,
    'INJECTION_DEPTH_NATIVE_LAYOUT',context);
  const layoutVisibility=Object.fromEntries(Object.keys(b.wholeVisibility).map(key=>[key,last[key]]));
  visibility(layoutVisibility,b.windowWidth,b.windowHeight,context);
  guard(Number.isFinite(last.visibleWidth)&&last.visibleWidth>1&&Number.isFinite(last.visibleHeight)&&last.visibleHeight>1&&
    integer(last.pointX)&&integer(last.pointY)&&last.pointX>=last.clipX&&last.pointY>=last.clipY&&
    last.pointX<last.clipX+last.clipWidth&&last.pointY<last.clipY+last.clipHeight&&integer(last.clipCount)&&integer(last.scrollCount)&&
    last.scrollCount<=6&&Array.isArray(last.scrolls)&&last.scrolls.length===last.scrollCount,'INJECTION_DEPTH_NATIVE_LAYOUT',context);
  for(const scroll of last.scrolls) {
    exactKeys(scroll,['contentY','contentHeight','sceneX','sceneY','sceneWidth','sceneHeight'],'INJECTION_DEPTH_NATIVE_LAYOUT',context);
    guard(Object.values(scroll).every(Number.isFinite)&&scroll.contentHeight>=0&&scroll.sceneWidth>0&&scroll.sceneHeight>0,
      'INJECTION_DEPTH_NATIVE_LAYOUT',context);
  }
  guard(Array.isArray(b.qualifications)&&b.qualifications.length===4&&b.qualifications.every(object),
    'INJECTION_DEPTH_NATIVE_QUALIFICATIONS',context);
  equal(b.qualifications.map(row=>row.phase),['before-click','before-select-all','before-digit','before-commit'],
    'INJECTION_DEPTH_NATIVE_QUALIFICATIONS',context);
  // The common production validator reads the genuine native boundary. There
  // is no fabricated GUI input row, gate result or rewritten depthInput map.
  verifyDepthInput(record.depthInput,b,context);
  guard(record.depthInput.snapshots[0].nowMs>=b.preparedAtMs&&record.depthInput.snapshots[0].frame>=b.prepareFrame,
    'INJECTION_DEPTH_NATIVE_BOUNDARY_CLOCK',context);
  let previousAt=b.preparedAtMs,previousFrame=b.prepareFrame;
  for(const [index,row] of b.qualifications.entries()) {
    const nested={...context,phase:row.phase};
    exactKeys(row,['phase','nowMs','elapsedMs','frame','scope','generation','target','wholeVisibility','layoutMatches','focusInTarget','hit'],
      'INJECTION_DEPTH_NATIVE_QUALIFICATION_FIELDS',nested);
    guard(row.scope===b.scope&&row.generation===b.generation&&row.layoutMatches===true&&
      typeof row.focusInTarget==='boolean'&&(index===0||row.focusInTarget===true),
      'INJECTION_DEPTH_NATIVE_QUALIFICATION_BOUND',nested);
    guard(integer(row.nowMs)&&row.nowMs>=previousAt&&row.nowMs<=b.afterAtMs&&integer(row.elapsedMs)&&
      row.nowMs===b.inputAtMs+row.elapsedMs&&row.elapsedMs<4000&&integer(row.frame)&&row.frame>=previousFrame&&row.frame<=b.afterFrame,
      'INJECTION_DEPTH_NATIVE_QUALIFICATION_CLOCK',nested);
    previousAt=row.nowMs;previousFrame=row.frame;
    equal(row.target,record.depthInput.snapshots[0].target,'INJECTION_DEPTH_NATIVE_QUALIFICATION_TARGET',nested);
    visibility(row.wholeVisibility,b.windowWidth,b.windowHeight,nested);
    if(index===0) {
      exactKeys(row.hit,['hitResult','acceptorFound','acceptorName','acceptorClass','containing','containingCount',
        'passiveObservers','passiveObserverCount','containingLimit'],'INJECTION_DEPTH_NATIVE_HIT',nested);
      guard(row.hit.acceptorFound===true&&['target','descendant'].includes(row.hit.hitResult)&&
        typeof row.hit.acceptorName==='string'&&row.hit.acceptorName.length<=80&&typeof row.hit.acceptorClass==='string'&&
        row.hit.acceptorClass.length>0&&row.hit.acceptorClass.length<=80&&row.hit.containingLimit===6&&
        integer(row.hit.containingCount)&&row.hit.containingCount>0&&integer(row.hit.passiveObserverCount)&&
        Array.isArray(row.hit.containing)&&row.hit.containing.length===Math.min(6,row.hit.containingCount)&&
        Array.isArray(row.hit.passiveObservers)&&row.hit.passiveObservers.length===Math.min(6,row.hit.passiveObserverCount),
        'INJECTION_DEPTH_NATIVE_HIT',nested);
      for(const item of [...row.hit.containing,...row.hit.passiveObservers]) {
        exactKeys(item,['found','objectName','className'],'INJECTION_DEPTH_NATIVE_HIT',nested);
        guard(item.found===true&&typeof item.objectName==='string'&&item.objectName.length<=80&&
          typeof item.className==='string'&&item.className.length>0&&item.className.length<=80,'INJECTION_DEPTH_NATIVE_HIT',nested);
      }
    }
    else exactKeys(row.hit,[],'INJECTION_DEPTH_NATIVE_HIT',nested);
    const snapshotIndex=[0,2,4,6][index],before=record.depthInput.snapshots[snapshotIndex],after=record.depthInput.snapshots[snapshotIndex+1];
    guard(row.nowMs>=before.nowMs&&row.nowMs<=after.nowMs&&row.frame>=before.frame&&row.frame<=after.frame,
      'INJECTION_DEPTH_NATIVE_QUALIFICATION_CLOCK',nested);
  }
  return {passed:true,step:spec.step,beforeValue:spec.beforeValue,expectedValue:spec.expectedValue,
    mouseDispatchCount:1,keyDispatchCount:3,valueModifiedSignals:1};
}
function verifyNativeWorldbookInjectionDepthEvidence(directory,contractPath) {
  const context={kind:'native-injection-depth'};
  const contract=readEvidenceFile(contractPath,65536,{...context,file:'contract'});
  equal(contract.value,C,'INJECTION_DEPTH_NATIVE_CONTRACT',context);
  guard(typeof directory==='string'&&directory.length>0&&fs.existsSync(directory),'INJECTION_DEPTH_NATIVE_DIRECTORY',context);
  const info=fs.lstatSync(directory);
  guard(info.isDirectory()&&!info.isSymbolicLink(),'INJECTION_DEPTH_NATIVE_DIRECTORY',context);
  equal(fs.readdirSync(directory).sort(),['manifest.json',...C.cases.map(spec=>spec.filename)].sort(),
    'INJECTION_DEPTH_NATIVE_FILE_SET',context);
  const manifest=readEvidenceFile(path.join(directory,'manifest.json'),65536,{...context,file:'manifest.json'});
  exactKeys(manifest.value,['schema','contractSha256','cases'],'INJECTION_DEPTH_NATIVE_MANIFEST_FIELDS',context);
  equal([manifest.value.schema,manifest.value.contractSha256],[C.manifestSchema,hash(contract.bytes)],
    'INJECTION_DEPTH_NATIVE_MANIFEST_BINDING',context);
  guard(Array.isArray(manifest.value.cases),'INJECTION_DEPTH_NATIVE_MANIFEST_CASES',context);
  equal(manifest.value.cases.map(row=>row?.caseId),C.cases.map(spec=>spec.caseId),'INJECTION_DEPTH_NATIVE_MANIFEST_CASES',context);
  const cases=[],recordsSha256={};
  for(const [index,spec] of C.cases.entries()) {
    const nested={...context,caseId:spec.caseId},ref=manifest.value.cases[index];
    exactKeys(ref,['caseId','filename','sha256','bytes'],'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',nested);
    equal([ref.caseId,ref.filename],[spec.caseId,spec.filename],'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',nested);
    guard(integer(ref.bytes)&&ref.bytes>0&&ref.bytes<=C.maximumRecordBytes&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),
      'INJECTION_DEPTH_NATIVE_MANIFEST_ENTRY',nested);
    const record=readEvidenceFile(path.join(directory,spec.filename),C.maximumRecordBytes,nested);
    equal(record.bytes.length,ref.bytes,'INJECTION_DEPTH_NATIVE_RECORD_BYTES',nested);
    equal(hash(record.bytes),ref.sha256,'INJECTION_DEPTH_NATIVE_RECORD_HASH',nested);
    recordsSha256[spec.filename]=ref.sha256;
    cases.push({caseId:spec.caseId,proof:verifyNativeWorldbookInjectionDepthEvidenceRecord(record.value,spec)});
  }
  return {schema:'reverie.qt.worldbook-injection-depth-native-verdict.v1',passed:true,contractSha256:hash(contract.bytes),
    manifestSha256:hash(manifest.bytes),recordsSha256,caseIds:C.cases.map(spec=>spec.caseId),cases,contentCollected:false};
}
function writeNativeWorldbookInjectionDepthEvidence(directory,contractPath,outputPath) {
  guard(typeof outputPath==='string'&&outputPath.length>0,'INJECTION_DEPTH_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  let exists=false;
  try {fs.lstatSync(outputPath);exists=true;} catch(error) {if(error.code!=='ENOENT')throw error;}
  guard(!exists,'INJECTION_DEPTH_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  const proof=verifyNativeWorldbookInjectionDepthEvidence(directory,contractPath);
  const destination=path.join(fs.realpathSync(path.dirname(path.resolve(outputPath))),path.basename(outputPath));
  const relative=path.relative(fs.realpathSync(directory),destination);
  guard(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),
    'INJECTION_DEPTH_NATIVE_OUTPUT_IN_EVIDENCE',{field:'output'});
  fs.writeFileSync(outputPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,5,verdictReason('INJECTION_DEPTH_NATIVE_CLI',{field:'argc'},
      'Usage: worldbook-injection-depth-native-evidence-consume.cjs evidenceDir fixedContract newVerdict'));
    const proof=writeNativeWorldbookInjectionDepthEvidence(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,caseIds:proof.caseIds,contractSha256:proof.contractSha256})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT,verifyNativeWorldbookInjectionDepthEvidence,
  verifyNativeWorldbookInjectionDepthEvidenceRecord,writeNativeWorldbookInjectionDepthEvidence};
