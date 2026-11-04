'use strict';
// Consume original, bounded Qt JSON bytes. GUI and native evidence share the
// same navigation validator; native boundaries are never converted to GUI gates.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyDepthInput,verifyNavigationInput}=require('./worldbook-injection-verdicts.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
const actions=Object.freeze(['Click','Escape','Tab','Tab','Tab','Backtab','Backtab','Backtab','Backtab','Tab']);
const phases=Object.freeze(['click','escape','tab-depth','tab-role','tab-outside','backtab-role','backtab-depth','backtab-position','backtab-outside','tab-position'].flatMap(name=>['before-'+name,'after-'+name]));
const visited=Object.freeze(['worldbookInsertionPosition','worldbookInsertionDepth','worldbookInsertionRole','after-group','worldbookInsertionRole','worldbookInsertionDepth','worldbookInsertionPosition','before-group','worldbookInsertionPosition']);
const INJECTION_NAVIGATION_NATIVE_EVIDENCE_CONTRACT=Object.freeze({
  schema:'reverie.qt.worldbook-injection-navigation-native-contract.v2',
  recordSchema:'reverie.qt.worldbook-injection-navigation-native-evidence.v2',
  manifestSchema:'reverie.qt.worldbook-injection-navigation-native-manifest.v2',
  boundarySchema:'reverie.qt.worldbook-injection-navigation-native-boundary.v1',
  navigationSchema:'reverie.qt.worldbook-injection-navigation.v2',
  environment:'REVERIE_P1_INJECTION_NAVIGATION_EVIDENCE_DIR',maximumRecordBytes:131072,maximumSnapshots:32,snapshotCount:20,
  actions,phases,keyActions:Object.freeze(actions.slice(1)),
  keyDispatches:Object.freeze(actions.slice(1).map(action=>Object.freeze({keyCode:action==='Escape'?0x01000000:action==='Backtab'?0x01000002:0x01000001,
    modifiers:action==='Backtab'?0x02000000:0}))),visited,
  cases:Object.freeze([
    ['wide',1380,3,213,'inherited','literal'],['wide',1380,255,244,'inherited','literal'],
    ['compact',950,3,244,'custom-budget','literal'],['compact',950,255,213,'custom-budget','literal'],
    ['narrow',760,3,213,'inherited','regex'],['narrow',760,255,244,'inherited','regex'],
  ].map(([size,windowWidth,tabFocusBehavior,step,boundaryMode,patternMode])=>Object.freeze({
    caseId:`navigation-${size}-policy-${tabFocusBehavior}`,filename:`navigation-${size}-policy-${tabFocusBehavior}.json`,
    dataTag:`${size}-policy-${tabFocusBehavior}`,windowWidth,windowHeight:size==='wide'?900:size==='compact'?760:650,tabFocusBehavior,step,
    depthStep:step===213?212:242,beforeValue:0,expectedValue:step===213?1:2,role:step===213?'system':'assistant',
    boundaryMode,patternMode,selectedEntryId:'priority-a',useRegex:patternMode==='regex',entryScanDepth:null,
    entryTokenBudget:boundaryMode==='custom-budget'?100:null,
    beforeItemObjectName:boundaryMode==='inherited'&&tabFocusBehavior===255?'worldbookEntryTokenBudgetInherit':'',
    beforeOwnerObjectName:boundaryMode==='custom-budget'?'worldbookEntryTokenBudget':tabFocusBehavior===255?'worldbookEntryTokenBudgetInherit':'worldbookPriority',
    afterItemObjectName:patternMode==='regex'?'worldbookRegexSecondaryKeywords':'worldbookSecondaryKeywords'}))),
});
const C=INJECTION_NAVIGATION_NATIVE_EVIDENCE_CONTRACT;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const guard=(condition,reason,context)=>assert(condition,verdictReason(reason,context));
const equal=(actual,expected,reason,context)=>assert.deepEqual(actual,expected,verdictReason(reason,context));
function exactKeys(value,keys,reason,context) {
  guard(object(value),reason,context);equal(Object.keys(value).sort(),keys.slice().sort(),reason,context);
}
function readEvidenceFile(file,limit,context) {
  guard(typeof file==='string'&&file.length>0&&fs.existsSync(file),'INJECTION_NAVIGATION_NATIVE_FILE_MISSING',context);
  const info=fs.lstatSync(file);
  guard(info.isFile()&&!info.isSymbolicLink(),'INJECTION_NAVIGATION_NATIVE_FILE_KIND',context);
  guard(info.size>0&&info.size<=limit,'INJECTION_NAVIGATION_NATIVE_FILE_BOUND',context);
  const bytes=fs.readFileSync(file);guard(bytes.length===info.size,'INJECTION_NAVIGATION_NATIVE_FILE_BYTES',context);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch {guard(false,'INJECTION_NAVIGATION_NATIVE_FILE_JSON',context);}
  return {bytes,value};
}
const visibilityKeys=['found','visible','fullyVisible','sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'];
function visibility(value,width,height,context,full=true) {
  exactKeys(value,visibilityKeys,'INJECTION_NAVIGATION_NATIVE_GEOMETRY',context);
  guard(value.found===true&&value.visible===true&&typeof value.fullyVisible==='boolean'&&(!full||value.fullyVisible===true)&&
    visibilityKeys.slice(3).every(key=>Number.isFinite(value[key]))&&value.sceneWidth>1&&value.sceneHeight>1&&
    value.clipWidth>=0&&value.clipHeight>=0&&value.clipX>=-.5&&value.clipY>=-.5&&value.clipX+value.clipWidth<=width+.5&&
    value.clipY+value.clipHeight<=height+.5&&(!full||value.clipWidth>0&&value.clipHeight>0&&
      value.sceneX+.5>=value.clipX&&value.sceneY+.5>=value.clipY&&value.sceneX+value.sceneWidth-.5<=value.clipX+value.clipWidth&&
      value.sceneY+value.sceneHeight-.5<=value.clipY+value.clipHeight),'INJECTION_NAVIGATION_NATIVE_GEOMETRY',context);
}
function layout(value,b,context) {
  exactKeys(value,['ready','polls','resets','minimumStableMs','last'],'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
  const last=value.last;
  exactKeys(last,['found','enabled','visible','inputPointInsideClip','surfaceClosed','ready','visibleWidth','visibleHeight',
    'scope','bound','geometryValid','integerPointInsideClip','pointX','pointY','clipCount','scrollCount','reason',
    'sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight','scrolls','fullyVisible',
    'elapsedMs','frameSerial','layoutStable','stableSinceMs','stableFrameSerial'],'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
  guard(value.ready===true&&value.minimumStableMs===40&&integer(value.polls)&&value.polls>=2&&integer(value.resets)&&
    last.ready===true&&last.layoutStable===true&&last.enabled===true&&last.bound===true&&last.geometryValid===true&&
    last.integerPointInsideClip===true&&last.inputPointInsideClip===true&&last.reason==='ready'&&last.surfaceClosed===true&&
    last.scope===b.scope&&integer(last.elapsedMs)&&last.elapsedMs<=b.preparedAtMs-b.inputAtMs&&integer(last.stableSinceMs)&&
    last.elapsedMs-last.stableSinceMs>=40&&integer(last.frameSerial)&&integer(last.stableFrameSerial)&&
    last.frameSerial>last.stableFrameSerial&&last.frameSerial<=b.prepareFrame,'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
  visibility(Object.fromEntries(visibilityKeys.map(key=>[key,last[key]])),b.windowWidth,b.windowHeight,context);
  guard(Number.isFinite(last.visibleWidth)&&last.visibleWidth>1&&Number.isFinite(last.visibleHeight)&&last.visibleHeight>1&&
    integer(last.pointX)&&integer(last.pointY)&&last.pointX>=last.clipX&&last.pointY>=last.clipY&&
    last.pointX<last.clipX+last.clipWidth&&last.pointY<last.clipY+last.clipHeight&&integer(last.clipCount)&&integer(last.scrollCount)&&
    last.scrollCount<=6&&Array.isArray(last.scrolls)&&last.scrolls.length===last.scrollCount,'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
  for(const scroll of last.scrolls) {
    exactKeys(scroll,['contentY','contentHeight','sceneX','sceneY','sceneWidth','sceneHeight'],'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
    guard(Object.values(scroll).every(Number.isFinite)&&scroll.contentHeight>=0&&scroll.sceneWidth>0&&scroll.sceneHeight>0,
      'INJECTION_NAVIGATION_NATIVE_LAYOUT',context);
  }
}
function boundaryClock(b,context) {
  guard(typeof b.scope==='string'&&b.scope.length>0&&b.scope.length<=256&&integer(b.generation)&&
    [b.stepAtMs,b.inputAtMs,b.preparedAtMs,b.afterAtMs,b.prepareFrame,b.afterFrame].every(integer)&&b.stepAtMs<=b.inputAtMs&&
    b.inputAtMs<=b.preparedAtMs&&b.preparedAtMs<=b.afterAtMs&&b.afterAtMs-b.inputAtMs<4000&&b.prepareFrame<=b.afterFrame,
    'INJECTION_NAVIGATION_NATIVE_BOUNDARY_CLOCK',context);
  visibility(b.wholeVisibility,b.windowWidth,b.windowHeight,context);layout(b.layout,b,context);
}
function hit(value,context) {
  exactKeys(value,['hitResult','acceptorFound','acceptorName','acceptorClass','containing','containingCount','passiveObservers',
    'passiveObserverCount','containingLimit'],'INJECTION_NAVIGATION_NATIVE_HIT',context);
  guard(value.acceptorFound===true&&['target','descendant'].includes(value.hitResult)&&typeof value.acceptorName==='string'&&
    value.acceptorName.length<=80&&typeof value.acceptorClass==='string'&&value.acceptorClass.length>0&&value.acceptorClass.length<=80&&
    value.containingLimit===6&&integer(value.containingCount)&&value.containingCount>0&&integer(value.passiveObserverCount)&&
    Array.isArray(value.containing)&&value.containing.length===Math.min(6,value.containingCount)&&Array.isArray(value.passiveObservers)&&
    value.passiveObservers.length===Math.min(6,value.passiveObserverCount),'INJECTION_NAVIGATION_NATIVE_HIT',context);
  for(const item of [...value.containing,...value.passiveObservers]) {
    exactKeys(item,['found','objectName','className'],'INJECTION_NAVIGATION_NATIVE_HIT',context);
    guard(item.found===true&&typeof item.objectName==='string'&&item.objectName.length<=80&&typeof item.className==='string'&&
      item.className.length>0&&item.className.length<=80,'INJECTION_NAVIGATION_NATIVE_HIT',context);
  }
}
const identityKeys=['found','objectName','className','token'];
const identityOf=value=>Object.fromEntries(identityKeys.map(key=>[key,value[key]]));
function verifyPageContext(value,spec,context) {
  exactKeys(value,['useRegex','entrySettings','beforeItem','beforeOwner','afterItem','afterOwner'],'INJECTION_NAVIGATION_NATIVE_CONTEXT_FIELDS',context);
  guard(value.useRegex===spec.useRegex,'INJECTION_NAVIGATION_NATIVE_CONTEXT_MODE',context);
  exactKeys(value.entrySettings,['scanDepth','tokenBudget'],'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',context);
  for(const name of ['scanDepth','tokenBudget']) {
    const setting=value.entrySettings[name],expected=name==='scanDepth'?spec.entryScanDepth:spec.entryTokenBudget;
    exactKeys(setting,['value','confirmed','editable','inherited','present','canOverride'],'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',context);
    equal(setting,{value:expected,confirmed:true,editable:true,inherited:expected===null,present:true,canOverride:expected===null},
      'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',context);
  }
  for(const name of ['beforeItem','beforeOwner','afterItem','afterOwner']) {
    const identity=value[name];exactKeys(identity,identityKeys,'INJECTION_NAVIGATION_NATIVE_CONTEXT_IDENTITY',context);
    guard(identity.found===true&&typeof identity.objectName==='string'&&identity.objectName.length<=80&&
      typeof identity.className==='string'&&identity.className.length>0&&identity.className.length<=80&&
      typeof identity.token==='string'&&/^[a-f0-9]{1,16}$/.test(identity.token),'INJECTION_NAVIGATION_NATIVE_CONTEXT_IDENTITY',context);
  }
  equal([value.beforeItem.objectName,value.beforeOwner.objectName,value.afterItem.objectName,value.afterOwner.objectName],
    [spec.beforeItemObjectName,spec.beforeOwnerObjectName,spec.afterItemObjectName,spec.afterItemObjectName],
    'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',context);
}
function verifyPageContextSnapshots(record,spec,context) {
  const value=record.boundary.contextBefore,snapshots=record.navigation.snapshots;
  for(const [name,indices] of [['before',[17,18]],['after',[9,10]]])for(const index of indices) {
    equal(value[name+'Item'],identityOf(snapshots[index].focus),'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',context);
    equal(value[name+'Owner'],identityOf(snapshots[index].owner),'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',context);
  }
  // Context identities stay bounded four-field observations. Their actual Qt
  // semantics come from the full, identity-matched navigation descriptors.
  for(const index of [9,10]) {
    const row=snapshots[index],key=spec.useRegex?'textEdit':'textInput';
    guard(row.focus.typeFlags[key]&&row.owner.typeFlags[key],'INJECTION_NAVIGATION_NATIVE_CONTEXT_TYPE_BINDING',context);
  }
  for(const index of [17,18]) {
    const row=snapshots[index];
    guard(spec.beforeItemObjectName===''?row.focus.typeFlags.textInput&&row.owner.typeFlags.spinBox:
      Object.values(row.focus.typeFlags).every(flag=>flag===false)&&Object.values(row.owner.typeFlags).every(flag=>flag===false),
      'INJECTION_NAVIGATION_NATIVE_CONTEXT_TYPE_BINDING',context);
  }
}
function verifyNativeWorldbookInjectionNavigationEvidenceRecord(record,spec) {
  guard(object(spec),'INJECTION_NAVIGATION_NATIVE_CASE_SPEC',{kind:'native-injection-navigation'});
  equal(spec,C.cases.find(entry=>entry.caseId===spec.caseId),'INJECTION_NAVIGATION_NATIVE_CASE_SPEC',{kind:'native-injection-navigation'});
  const context={kind:'native-injection-navigation',caseId:spec.caseId};
  exactKeys(record,['schema','caseId','navigation','depthInput','boundary','depthBoundary'],'INJECTION_NAVIGATION_NATIVE_RECORD_FIELDS',context);
  equal([record.schema,record.caseId],[C.recordSchema,spec.caseId],'INJECTION_NAVIGATION_NATIVE_RECORD_BINDING',context);
  const b=record.boundary,group={position:'at_depth',depth:spec.expectedValue,role:spec.role};
  exactKeys(b,['schema','source','caseId','control','windowWidth','windowHeight','beforeGroup','expectedValue','selectedEntryId',
    'scope','generation','step','stepAtMs','inputAtMs','preparedAtMs','prepareFrame','wholeVisibility','layout','afterAtMs','afterFrame',
    'qualifications','tabFocusBehavior','setup','requestCountsBefore','requestCountsAfter','backendRunningBefore','backendRunningAfter',
    'contextBefore','contextAfter'],
    'INJECTION_NAVIGATION_NATIVE_BOUNDARY_FIELDS',context);
  equal([b.schema,b.source,b.caseId,b.control,b.windowWidth,b.windowHeight,b.expectedValue,b.step,b.selectedEntryId,b.tabFocusBehavior],
    [C.boundarySchema,'native',spec.caseId,'worldbookInsertionPosition',spec.windowWidth,spec.windowHeight,spec.expectedValue,spec.step,
      spec.selectedEntryId,spec.tabFocusBehavior],'INJECTION_NAVIGATION_NATIVE_BOUNDARY_BINDING',context);
  equal(b.beforeGroup,group,'INJECTION_NAVIGATION_NATIVE_BOUNDARY_BINDING',context);boundaryClock(b,context);
  verifyPageContext(b.contextBefore,spec,context);verifyPageContext(b.contextAfter,spec,context);
  equal(b.contextBefore,b.contextAfter,'INJECTION_NAVIGATION_NATIVE_CONTEXT_STABILITY',context);
  for(const counts of [b.requestCountsBefore,b.requestCountsAfter]) {
    exactKeys(counts,['archivePut','chatSend'],'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',context);
    guard(counts.archivePut===0&&counts.chatSend===0,'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',context);
  }
  guard(b.backendRunningBefore===false&&b.backendRunningAfter===false,'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',context);
  const d=record.depthBoundary;
  exactKeys(d,['schema','source','caseId','control','windowWidth','windowHeight','beforeValue','expectedValue','selectedEntryId',
    'scope','generation','step','stepAtMs','inputAtMs','preparedAtMs','afterAtMs','prepareFrame','afterFrame','wholeVisibility','layout','qualifications'],
    'INJECTION_NAVIGATION_NATIVE_DEPTH_BOUNDARY',context);
  equal([d.schema,d.source,d.caseId,d.control,d.windowWidth,d.windowHeight,d.beforeValue,d.expectedValue,d.selectedEntryId,d.scope,d.generation,d.step],
    ['reverie.qt.worldbook-injection-depth-native-boundary.v1','native',spec.caseId,'worldbookInsertionDepth',spec.windowWidth,spec.windowHeight,
      spec.beforeValue,spec.expectedValue,spec.selectedEntryId,b.scope,b.generation,spec.depthStep],'INJECTION_NAVIGATION_NATIVE_DEPTH_BOUNDARY',context);
  boundaryClock(d,context);
  guard(d.stepAtMs===b.stepAtMs&&d.inputAtMs===b.inputAtMs&&d.afterAtMs<=b.preparedAtMs&&d.afterFrame<=b.prepareFrame,
    'INJECTION_NAVIGATION_NATIVE_SETUP_CLOCK',context);
  verifyDepthInput(record.depthInput,d,context);
  guard(record.depthInput.snapshots[0].nowMs>=d.preparedAtMs&&record.depthInput.snapshots[0].frame>=d.prepareFrame,
    'INJECTION_NAVIGATION_NATIVE_DEPTH_BOUNDARY',context);
  // Setup and qualifications are checked below without manufacturing a GUI row.
  verifyNavigationInput(record.navigation,b,context);
  verifyPageContextSnapshots(record,spec,context);
  equal(record.depthInput.snapshots[0].target,Object.fromEntries(['found','objectName','className','token'].map(key=>
    [key,record.navigation.snapshots[0].controls.depth[key]])),'INJECTION_NAVIGATION_NATIVE_DEPTH_TARGET',context);
  equal(record.depthInput.snapshots[0].editableTextInput,record.navigation.snapshots[0].controls.depth.contentItem,
    'INJECTION_NAVIGATION_NATIVE_DEPTH_TARGET',context);
  guard(record.navigation.snapshots[0].nowMs>=b.preparedAtMs&&record.navigation.snapshots[0].frame>=b.prepareFrame,
    'INJECTION_NAVIGATION_NATIVE_BOUNDARY_CLOCK',context);
  verifyNativeSetupAndQualifications(record,spec,context);
  return {passed:true,step:spec.step,depthStep:spec.depthStep,tabFocusBehavior:spec.tabFocusBehavior,
    beforeValue:spec.beforeValue,expectedValue:spec.expectedValue,mouseDispatchCount:1,keyDispatchCount:9,snapshotCount:20};
}
function verifyNativeSetupAndQualifications(record,spec,context) {
  const b=record.boundary,d=record.depthBoundary;
  guard(Array.isArray(b.setup)&&b.setup.length===3&&b.setup.every(object),'INJECTION_NAVIGATION_NATIVE_SETUP',context);
  equal(b.setup.map(row=>row.stage),['position','depth','role'],'INJECTION_NAVIGATION_NATIVE_SETUP',context);
  const oppositeRole=spec.role==='system'?'assistant':'system';
  const groups=[{position:'before_char',depth:0,role:oppositeRole},{position:'at_depth',depth:0,role:oppositeRole},
    {position:'at_depth',depth:spec.expectedValue,role:oppositeRole},{position:'at_depth',depth:spec.expectedValue,role:spec.role}];
  let setupAt=b.inputAtMs,setupFrame=0;
  for(const [index,row] of b.setup.entries()) {
    const c={...context,stage:row.stage},isDepth=index===1;
    exactKeys(row,isDepth?['stage','beforeGroup','afterGroup','mouseDispatchCount','keyDispatchCount','valueModifiedSignals','nowMs','frame','target']:
      ['stage','beforeGroup','afterGroup','beforeIndex','afterIndex','mouseDispatchCount','keyDispatchCount','activatedSignals','nowMs','frame','target'],
      'INJECTION_NAVIGATION_NATIVE_SETUP_FIELDS',c);
    equal(row.beforeGroup,groups[index],'INJECTION_NAVIGATION_NATIVE_SETUP',c);
    equal(row.afterGroup,groups[index+1],'INJECTION_NAVIGATION_NATIVE_SETUP',c);
    guard(row.mouseDispatchCount===1&&row.keyDispatchCount===(isDepth?3:index===0?4:spec.role==='system'?2:4)&&
      (isDepth?row.valueModifiedSignals===1:row.activatedSignals===1&&row.beforeIndex===(index===0?0:spec.role==='system'?2:0)&&
        row.afterIndex===(index===0?2:spec.role==='system'?0:2)),'INJECTION_NAVIGATION_NATIVE_SETUP_COUNTS',c);
    guard(integer(row.nowMs)&&row.nowMs>=setupAt&&row.nowMs<=b.preparedAtMs&&row.nowMs-b.inputAtMs<4000&&
      integer(row.frame)&&row.frame>=setupFrame&&row.frame<=b.prepareFrame,'INJECTION_NAVIGATION_NATIVE_SETUP_CLOCK',c);
    setupAt=row.nowMs;setupFrame=row.frame;
    const target=isDepth?record.depthInput.snapshots[0].target:
      Object.fromEntries(['found','objectName','className','token'].map(key=>[key,record.navigation.snapshots[0].controls[index===0?'position':'role'][key]]));
    equal(row.target,target,'INJECTION_NAVIGATION_NATIVE_SETUP_TARGET',c);
  }
  guard(b.setup[0].nowMs<=d.preparedAtMs&&b.setup[0].frame<=d.prepareFrame&&b.setup[1].nowMs>=d.afterAtMs&&
    b.setup[1].frame>=d.afterFrame,'INJECTION_NAVIGATION_NATIVE_SETUP_CLOCK',context);
  function qualifications(rows,snapshots,boundary,depth) {
    const phases=depth?['before-click','before-select-all','before-digit','before-commit']:null;
    guard(Array.isArray(rows)&&rows.length===(depth?4:10)&&rows.every(object),'INJECTION_NAVIGATION_NATIVE_QUALIFICATIONS',context);
    if(depth)equal(rows.map(row=>row.phase),phases,'INJECTION_NAVIGATION_NATIVE_QUALIFICATIONS',context);
    let previousAt=boundary.preparedAtMs,previousFrame=boundary.prepareFrame;
    for(const [index,row] of rows.entries()) {
      const c={...context,phase:snapshots[index*2].phase};
      exactKeys(row,depth?['phase','nowMs','elapsedMs','frame','scope','generation','target','wholeVisibility','layoutMatches','focusInTarget','hit']:
        ['index','keyboard','selector','nowMs','elapsedMs','frame','scope','generation','target','wholeVisibility','layoutMatches','focusInTarget','hit'],
        'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_FIELDS',c);
      guard(row.scope===boundary.scope&&row.generation===boundary.generation&&typeof row.focusInTarget==='boolean'&&
        (index===0||row.focusInTarget===true)&&(depth?row.layoutMatches===true:row.index===index&&row.keyboard===(index>0)&&
          row.selector===(index===1)&&row.layoutMatches===(index===0?true:null)),'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_BOUND',c);
      guard(integer(row.nowMs)&&row.nowMs>=previousAt&&row.nowMs<=boundary.afterAtMs&&integer(row.elapsedMs)&&
        row.nowMs===boundary.inputAtMs+row.elapsedMs&&row.elapsedMs<4000&&integer(row.frame)&&row.frame>=previousFrame&&
        row.frame<=boundary.afterFrame,'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_CLOCK',c);
      previousAt=row.nowMs;previousFrame=row.frame;
      const before=snapshots[index*2],after=snapshots[index*2+1];
      guard(row.nowMs>=before.nowMs&&row.nowMs<=after.nowMs&&row.frame>=before.frame&&row.frame<=after.frame,
        'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_CLOCK',c);
      equal(row.target,depth?snapshots[0].target:Object.fromEntries(['found','objectName','className','token'].map(key=>[key,before.expected[key]])),
        'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_TARGET',c);
      visibility(row.wholeVisibility,boundary.windowWidth,boundary.windowHeight,c,depth||index===0);
      if(index===0)hit(row.hit,c);else exactKeys(row.hit,[],'INJECTION_NAVIGATION_NATIVE_HIT',c);
    }
  }
  qualifications(d.qualifications,record.depthInput.snapshots,d,true);
  qualifications(b.qualifications,record.navigation.snapshots,b,false);
}
function verifyNativeWorldbookInjectionNavigationEvidence(directory,contractPath) {
  const context={kind:'native-injection-navigation'},contract=readEvidenceFile(contractPath,65536,{...context,file:'contract'});
  equal(contract.value,C,'INJECTION_NAVIGATION_NATIVE_CONTRACT',context);
  guard(typeof directory==='string'&&directory.length>0&&fs.existsSync(directory),'INJECTION_NAVIGATION_NATIVE_DIRECTORY',context);
  const info=fs.lstatSync(directory);guard(info.isDirectory()&&!info.isSymbolicLink(),'INJECTION_NAVIGATION_NATIVE_DIRECTORY',context);
  equal(fs.readdirSync(directory).sort(),['manifest.json',...C.cases.map(spec=>spec.filename)].sort(),'INJECTION_NAVIGATION_NATIVE_FILE_SET',context);
  const manifest=readEvidenceFile(path.join(directory,'manifest.json'),65536,{...context,file:'manifest.json'});
  exactKeys(manifest.value,['schema','contractSha256','cases'],'INJECTION_NAVIGATION_NATIVE_MANIFEST_FIELDS',context);
  equal([manifest.value.schema,manifest.value.contractSha256],[C.manifestSchema,hash(contract.bytes)],'INJECTION_NAVIGATION_NATIVE_MANIFEST_BINDING',context);
  guard(Array.isArray(manifest.value.cases),'INJECTION_NAVIGATION_NATIVE_MANIFEST_CASES',context);
  equal(manifest.value.cases.map(row=>row?.caseId),C.cases.map(spec=>spec.caseId),'INJECTION_NAVIGATION_NATIVE_MANIFEST_CASES',context);
  const cases=[],recordsSha256={};
  for(const [index,spec] of C.cases.entries()) {
    const nested={...context,caseId:spec.caseId},ref=manifest.value.cases[index];
    exactKeys(ref,['caseId','filename','sha256','bytes'],'INJECTION_NAVIGATION_NATIVE_MANIFEST_ENTRY',nested);
    equal([ref.caseId,ref.filename],[spec.caseId,spec.filename],'INJECTION_NAVIGATION_NATIVE_MANIFEST_ENTRY',nested);
    guard(integer(ref.bytes)&&ref.bytes>0&&ref.bytes<=C.maximumRecordBytes&&typeof ref.sha256==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256),
      'INJECTION_NAVIGATION_NATIVE_MANIFEST_ENTRY',nested);
    const record=readEvidenceFile(path.join(directory,spec.filename),C.maximumRecordBytes,nested);
    equal(record.bytes.length,ref.bytes,'INJECTION_NAVIGATION_NATIVE_RECORD_BYTES',nested);
    equal(hash(record.bytes),ref.sha256,'INJECTION_NAVIGATION_NATIVE_RECORD_HASH',nested);recordsSha256[spec.filename]=ref.sha256;
    cases.push({caseId:spec.caseId,proof:verifyNativeWorldbookInjectionNavigationEvidenceRecord(record.value,spec)});
  }
  return {schema:'reverie.qt.worldbook-injection-navigation-native-verdict.v1',passed:true,contractSha256:hash(contract.bytes),
    manifestSha256:hash(manifest.bytes),recordsSha256,caseIds:C.cases.map(spec=>spec.caseId),cases,contentCollected:false};
}
function writeNativeWorldbookInjectionNavigationEvidence(directory,contractPath,outputPath) {
  guard(typeof outputPath==='string'&&outputPath.length>0,'INJECTION_NAVIGATION_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  let exists=false;
  try {fs.lstatSync(outputPath);exists=true;} catch(error) {if(error.code!=='ENOENT')throw error;}
  guard(!exists,'INJECTION_NAVIGATION_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  const proof=verifyNativeWorldbookInjectionNavigationEvidence(directory,contractPath);
  const destination=path.join(fs.realpathSync(path.dirname(path.resolve(outputPath))),path.basename(outputPath));
  const relative=path.relative(fs.realpathSync(directory),destination);
  guard(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),'INJECTION_NAVIGATION_NATIVE_OUTPUT_IN_EVIDENCE',{field:'output'});
  fs.writeFileSync(outputPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,5,verdictReason('INJECTION_NAVIGATION_NATIVE_CLI',{field:'argc'},
      'Usage: worldbook-injection-navigation-native-evidence-consume.cjs evidenceDir fixedContract newVerdict'));
    const proof=writeNativeWorldbookInjectionNavigationEvidence(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,caseIds:proof.caseIds,contractSha256:proof.contractSha256})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={INJECTION_NAVIGATION_NATIVE_EVIDENCE_CONTRACT,verifyNativeWorldbookInjectionNavigationEvidence,
  verifyNativeWorldbookInjectionNavigationEvidenceRecord,writeNativeWorldbookInjectionNavigationEvidence};
