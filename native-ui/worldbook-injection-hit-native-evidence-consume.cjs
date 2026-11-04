'use strict';
// Read original serialized Qt measurements. The GUI and native paths use the
// same hit/coordinate/actual-dispatch validator without repairing raw records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyInputHit}=require('./worldbook-injection-verdicts.cjs');
const {verdictReason,rejectionIdentity}=require('./verdict-test-support.cjs');
const INJECTION_HIT_NATIVE_EVIDENCE_CONTRACT=Object.freeze({
  schema:'reverie.qt.worldbook-injection-hit-native-contract.v1',
  recordSchema:'reverie.qt.worldbook-injection-hit-native-evidence.v1',
  manifestSchema:'reverie.qt.worldbook-injection-hit-native-manifest.v1',
  inputHitSchema:'reverie.qt.worldbook-injection-input-hit.v1',
  environment:'REVERIE_P1_INJECTION_HIT_EVIDENCE_DIR',maximumRecordBytes:131072,
  cases:Object.freeze([
    ['hit-button','worldbookEnabled','button','none',true,'priority-a'],
    ['hit-text','worldbookName','text','none',true,'priority-a'],
    ['hit-selector','worldbookInsertionPosition','selector','none',true,'priority-a'],
    ['hit-depth','worldbookInsertionDepth','depth-keyboard','none',true,'priority-a'],
    ['hit-navigation','worldbookInsertionPosition','insertion-tab-backtab','none',true,'priority-a'],
    ['hit-dispatch-coordinate-mismatch','worldbookEnabled','button','dispatch-coordinate-mismatch',false,'priority-a'],
    ['hit-legacy-without-envelope','worldbookEnabled','button','legacy-input-without-envelope',false,'priority-a'],
    ['hit-entry-selector','worldbookEntrySelector','selector','none',true,'priority-b'],
  ].map(([caseId,control,kind,fault,expectedPassed,selectedEntryId],index)=>Object.freeze({caseId,filename:caseId+'.json',dataTag:caseId,
    windowWidth:1380,windowHeight:900,step:601+index,control,kind,selectedEntryIdBefore:'priority-a',selectedEntryId,fault,expectedPassed}))),
});
const C=INJECTION_HIT_NATIVE_EVIDENCE_CONTRACT;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const guard=(condition,reason,context)=>assert(condition,verdictReason(reason,context));
const equal=(actual,expected,reason,context)=>assert.deepEqual(actual,expected,verdictReason(reason,context));
function exactKeys(value,keys,reason,context) {
  guard(object(value),reason,context);equal(Object.keys(value).sort(),keys.slice().sort(),reason,context);
}
function readEvidenceFile(file,limit,context) {
  guard(typeof file==='string'&&file.length>0&&fs.existsSync(file),'INJECTION_HIT_NATIVE_FILE_MISSING',context);
  const info=fs.lstatSync(file);
  guard(info.isFile()&&!info.isSymbolicLink(),'INJECTION_HIT_NATIVE_FILE_KIND',context);
  guard(info.size>0&&info.size<=limit,'INJECTION_HIT_NATIVE_FILE_BOUND',context);
  const bytes=fs.readFileSync(file);guard(bytes.length===info.size,'INJECTION_HIT_NATIVE_FILE_BYTES',context);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch {guard(false,'INJECTION_HIT_NATIVE_FILE_JSON',context);}
  return {bytes,value};
}
function verifyNativeWorldbookInjectionHitEvidenceRecord(record,spec) {
  guard(object(spec),'INJECTION_HIT_NATIVE_CASE_SPEC',{kind:'native-injection-hit'});
  equal(spec,C.cases.find(row=>row.caseId===spec.caseId),'INJECTION_HIT_NATIVE_CASE_SPEC',{kind:'native-injection-hit'});
  const context={kind:'native-injection-hit',caseId:spec.caseId};
  exactKeys(record,['schema','caseId','sourceInput','input'],'INJECTION_HIT_NATIVE_RECORD_FIELDS',context);
  equal([record.schema,record.caseId],[C.recordSchema,spec.caseId],'INJECTION_HIT_NATIVE_RECORD_BINDING',context);
  // A separately retained successful measurement is always verified first.
  // Only the candidate is faulted; no absent field is inferred from it.
  const input=record.sourceInput;
  const keys=['step','control','scope','generation','stepAtMs','inputAtMs','elapsedMs','frame','selectedEntryId','selectedEntryIdBefore',
    'layout','hit','windowWidth','windowHeight','signals'];
  keys.push('inputHit');
  exactKeys(input,keys,'INJECTION_HIT_NATIVE_INPUT_FIELDS',context);
  equal([input.step,input.control,input.windowWidth,input.windowHeight,input.selectedEntryId,input.selectedEntryIdBefore],
    [spec.step,spec.control,spec.windowWidth,spec.windowHeight,spec.selectedEntryId,spec.selectedEntryIdBefore],'INJECTION_HIT_NATIVE_INPUT_BINDING',context);
  exactKeys(input.signals,['kind','mouseDispatchCount'],'INJECTION_HIT_NATIVE_SIGNALS',context);
  guard(input.signals.kind===spec.kind&&input.signals.mouseDispatchCount===1,'INJECTION_HIT_NATIVE_SIGNALS',context);
  guard(typeof input.scope==='string'&&input.scope.length>0&&input.scope.length<=256&&integer(input.generation)&&
    [input.stepAtMs,input.inputAtMs,input.elapsedMs,input.frame].every(integer)&&input.stepAtMs<=input.inputAtMs&&
    input.elapsedMs<4000&&Number.isSafeInteger(input.inputAtMs+input.elapsedMs),'INJECTION_HIT_NATIVE_INPUT_CLOCK',context);
  exactKeys(input.layout,['ready','polls','resets','minimumStableMs','last'],'INJECTION_HIT_NATIVE_LAYOUT',context);
  const last=input.layout.last;
  exactKeys(last,['found','enabled','visible','inputPointInsideClip','surfaceClosed','ready','visibleWidth','visibleHeight',
    'scope','bound','geometryValid','integerPointInsideClip','pointX','pointY','clipCount','scrollCount','reason',
    'sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight','scrolls','fullyVisible',
    'elapsedMs','frameSerial','layoutStable','stableSinceMs','stableFrameSerial'],'INJECTION_HIT_NATIVE_LAYOUT',context);
  guard(input.layout.ready===true&&input.layout.minimumStableMs===40&&integer(input.layout.polls)&&input.layout.polls>=2&&
    integer(input.layout.resets)&&object(last)&&last.ready===true&&last.layoutStable===true&&last.found===true&&last.enabled===true&&
    last.visible===true&&last.fullyVisible===true&&last.surfaceClosed===true&&last.scope===input.scope&&last.bound===true&&
    last.geometryValid===true&&last.integerPointInsideClip===true&&last.inputPointInsideClip===true&&last.reason==='ready'&&
    integer(last.elapsedMs)&&last.elapsedMs<=input.elapsedMs&&integer(last.stableSinceMs)&&last.elapsedMs-last.stableSinceMs>=40&&
    integer(last.frameSerial)&&last.frameSerial<=input.frame&&integer(last.stableFrameSerial)&&last.frameSerial>last.stableFrameSerial,
    'INJECTION_HIT_NATIVE_LAYOUT',context);
  guard(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(key=>Number.isFinite(last[key]))&&
    last.sceneWidth>1&&last.sceneHeight>1&&last.clipWidth>0&&last.clipHeight>0&&last.clipX>=-.5&&last.clipY>=-.5&&
    last.clipX+last.clipWidth<=input.windowWidth+.5&&last.clipY+last.clipHeight<=input.windowHeight+.5&&
    last.sceneX+.5>=last.clipX&&last.sceneY+.5>=last.clipY&&last.sceneX+last.sceneWidth-.5<=last.clipX+last.clipWidth&&
    last.sceneY+last.sceneHeight-.5<=last.clipY+last.clipHeight,'INJECTION_HIT_NATIVE_LAYOUT',context);
  guard(Number.isFinite(last.visibleWidth)&&last.visibleWidth>1&&Number.isFinite(last.visibleHeight)&&last.visibleHeight>1&&
    integer(last.clipCount)&&integer(last.scrollCount)&&last.scrollCount<=6&&Array.isArray(last.scrolls)&&
    last.scrolls.length===last.scrollCount,'INJECTION_HIT_NATIVE_LAYOUT',context);
  for(const scroll of last.scrolls) {
    exactKeys(scroll,['contentY','contentHeight','sceneX','sceneY','sceneWidth','sceneHeight'],'INJECTION_HIT_NATIVE_LAYOUT',context);
    guard(Object.values(scroll).every(Number.isFinite)&&scroll.contentHeight>=0&&scroll.sceneWidth>0&&scroll.sceneHeight>0,
      'INJECTION_HIT_NATIVE_LAYOUT',context);
  }
  const boundary={kind:input.signals.kind,step:input.step,control:input.control,scope:input.scope,generation:input.generation,
    selectedEntryId:input.selectedEntryIdBefore,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,windowWidth:input.windowWidth,
    windowHeight:input.windowHeight,layoutLast:last,hit:input.hit,mouseDispatchCount:input.signals.mouseDispatchCount,
    afterAtMs:input.inputAtMs+input.elapsedMs,afterFrame:input.frame};
  const sourceProof=verifyInputHit(input.inputHit,boundary,context);
  const candidate=record.input;
  const expected=JSON.parse(JSON.stringify(input));
  if(spec.fault==='dispatch-coordinate-mismatch')expected.inputHit.dispatch.point.x+=1;
  if(spec.fault==='legacy-input-without-envelope')delete expected.inputHit;
  equal(candidate,expected,'INJECTION_HIT_NATIVE_CANDIDATE_MUTATION',context);
  if(spec.expectedPassed)return sourceProof;
  const expectedReason=spec.fault==='dispatch-coordinate-mismatch'?'INJECTION_INPUT_HIT_COORDINATES':'INJECTION_INPUT_HIT_EVIDENCE';
  let failure;
  try {verifyInputHit(candidate.inputHit,boundary,context);} catch(error) {failure=error;}
  equal(rejectionIdentity(failure),{reason:expectedReason,context:Object.fromEntries(Object.entries(context).map(([key,value])=>[key,String(value)]))},
    'INJECTION_HIT_NATIVE_EXPECTED_REJECTION',context);
  return {passed:true,kind:spec.kind,expectedPassed:false,rejectedReason:expectedReason};
}
function verifyNativeWorldbookInjectionHitEvidence(directory,contractPath) {
  const context={kind:'native-injection-hit'};
  const contract=readEvidenceFile(contractPath,65536,{...context,file:'contract'});
  equal(contract.value,C,'INJECTION_HIT_NATIVE_CONTRACT',context);
  guard(typeof directory==='string'&&directory.length>0&&fs.existsSync(directory),'INJECTION_HIT_NATIVE_DIRECTORY',context);
  const info=fs.lstatSync(directory);
  guard(info.isDirectory()&&!info.isSymbolicLink(),'INJECTION_HIT_NATIVE_DIRECTORY',context);
  equal(fs.readdirSync(directory).sort(),['manifest.json',...C.cases.map(spec=>spec.filename)].sort(),'INJECTION_HIT_NATIVE_FILE_SET',context);
  const manifest=readEvidenceFile(path.join(directory,'manifest.json'),65536,{...context,file:'manifest.json'});
  exactKeys(manifest.value,['schema','contractSha256','cases'],'INJECTION_HIT_NATIVE_MANIFEST_FIELDS',context);
  equal([manifest.value.schema,manifest.value.contractSha256],[C.manifestSchema,hash(contract.bytes)],'INJECTION_HIT_NATIVE_MANIFEST_BINDING',context);
  guard(Array.isArray(manifest.value.cases),'INJECTION_HIT_NATIVE_MANIFEST_CASES',context);
  equal(manifest.value.cases.map(row=>row?.caseId),C.cases.map(spec=>spec.caseId),'INJECTION_HIT_NATIVE_MANIFEST_CASES',context);
  const cases=[],recordsSha256={};
  for(const [index,spec] of C.cases.entries()) {
    const nested={...context,caseId:spec.caseId},ref=manifest.value.cases[index];
    exactKeys(ref,['caseId','filename','sha256','bytes'],'INJECTION_HIT_NATIVE_MANIFEST_ENTRY',nested);
    equal([ref.caseId,ref.filename],[spec.caseId,spec.filename],'INJECTION_HIT_NATIVE_MANIFEST_ENTRY',nested);
    guard(integer(ref.bytes)&&ref.bytes>0&&ref.bytes<=C.maximumRecordBytes&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),
      'INJECTION_HIT_NATIVE_MANIFEST_ENTRY',nested);
    const record=readEvidenceFile(path.join(directory,spec.filename),C.maximumRecordBytes,nested);
    equal(record.bytes.length,ref.bytes,'INJECTION_HIT_NATIVE_RECORD_BYTES',nested);
    equal(hash(record.bytes),ref.sha256,'INJECTION_HIT_NATIVE_RECORD_HASH',nested);
    recordsSha256[spec.filename]=ref.sha256;
    cases.push({caseId:spec.caseId,proof:verifyNativeWorldbookInjectionHitEvidenceRecord(record.value,spec)});
  }
  return {schema:'reverie.qt.worldbook-injection-hit-native-verdict.v1',passed:true,contractSha256:hash(contract.bytes),
    manifestSha256:hash(manifest.bytes),recordsSha256,caseIds:C.cases.map(spec=>spec.caseId),cases,contentCollected:false};
}
function writeNativeWorldbookInjectionHitEvidence(directory,contractPath,outputPath) {
  guard(typeof outputPath==='string'&&outputPath.length>0,'INJECTION_HIT_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  let exists=false;
  try {fs.lstatSync(outputPath);exists=true;} catch(error) {if(error.code!=='ENOENT')throw error;}
  guard(!exists,'INJECTION_HIT_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  const proof=verifyNativeWorldbookInjectionHitEvidence(directory,contractPath);
  const destination=path.join(fs.realpathSync(path.dirname(path.resolve(outputPath))),path.basename(outputPath));
  const relative=path.relative(fs.realpathSync(directory),destination);
  guard(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'INJECTION_HIT_NATIVE_OUTPUT_IN_EVIDENCE',{field:'output'});
  fs.writeFileSync(outputPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,5,verdictReason('INJECTION_HIT_NATIVE_CLI',{field:'argc'},
      'Usage: worldbook-injection-hit-native-evidence-consume.cjs evidenceDir fixedContract newVerdict'));
    const proof=writeNativeWorldbookInjectionHitEvidence(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,caseIds:proof.caseIds,contractSha256:proof.contractSha256})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={INJECTION_HIT_NATIVE_EVIDENCE_CONTRACT,verifyNativeWorldbookInjectionHitEvidence,
  verifyNativeWorldbookInjectionHitEvidenceRecord,writeNativeWorldbookInjectionHitEvidence};
