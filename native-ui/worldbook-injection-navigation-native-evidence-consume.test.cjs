'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {INJECTION_NAVIGATION_NATIVE_EVIDENCE_CONTRACT:C,verifyNativeWorldbookInjectionNavigationEvidence,
  writeNativeWorldbookInjectionNavigationEvidence}=require('./worldbook-injection-navigation-native-evidence-consume.cjs');
const {INJECTION_DEPTH_NATIVE_EVIDENCE_CONTRACT:D,verifyNativeWorldbookInjectionDepthEvidence}=require('./worldbook-injection-depth-native-evidence-consume.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));
const context={kind:'native-injection-navigation'},primary={...context,caseId:'navigation-wide-policy-3'};
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,
  clipX:0,clipY:0,clipWidth:100,clipHeight:100};
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
    signals:{beforeGroup:group,visited:C.visited}};
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
  const boundary={schema:C.boundarySchema,source:'native',caseId:spec.caseId,control:'worldbookInsertionPosition',
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
  return {schema:C.recordSchema,caseId:spec.caseId,navigation,depthInput:depth.depthInput,boundary,depthBoundary:d};
}
function navigationFilesFixture(existingRoot) {
  const root=existingRoot||fs.mkdtempSync(path.join(os.tmpdir(),'injection-navigation-native-'));
  const directory=path.join(root,'navigation'),contractPath=path.join(root,'navigation-contract.json');fs.mkdirSync(directory);
  fs.copyFileSync(path.join(__dirname,'tests/worldbook-injection-navigation-native-evidence-contract.json'),contractPath);
  const manifest={schema:C.manifestSchema,contractSha256:hash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of C.cases) {
    const bytes=Buffer.from(JSON.stringify(navigationRecord(spec)));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,bytes:bytes.length,sha256:hash(bytes)});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath,outputPath:path.join(root,'navigation-proof.json')};
}
const verify=value=>verifyNativeWorldbookInjectionNavigationEvidence(value.directory,value.contractPath);
const dispose=value=>fs.rmSync(value.root,{recursive:true,force:true});
function reject(rows,verifier=verify) {
  for(const row of rows)assertRejectedMutation({makeFixture:navigationFilesFixture,verify:verifier,dispose,kind:'files',expectedContext:context,...row});
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
test('navigation native consumer preserves six original records across three dimensions and both policies',()=>{
  const value=navigationFilesFixture();
  try {
    const before=rawSnapshot(value),proof=verify(value);assert.equal(proof.passed,true);assert.equal(proof.contentCollected,false);
    assert.deepEqual(proof.caseIds,C.cases.map(spec=>spec.caseId));assert.deepEqual(rawSnapshot(value),before);
    assert.deepEqual(proof.cases.map(row=>[row.proof.step,row.proof.tabFocusBehavior]),[[213,3],[244,255],[244,3],[213,255],[213,3],[244,255]]);
  } finally {dispose(value);}
});
test('navigation native writer writes a fresh proof only after preserving all source bytes',()=>{
  const value=navigationFilesFixture();
  try {
    const before=rawSnapshot(value),expected=verify(value);
    assert.deepEqual(writeNativeWorldbookInjectionNavigationEvidence(value.directory,value.contractPath,value.outputPath),expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(value.outputPath,'utf8')),expected);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
});
test('navigation native evidence binds exact schema source dimensions and case policy',()=>reject([
  {id:'navigation-native.record-extra',expectedReason:'INJECTION_NAVIGATION_NATIVE_RECORD_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.rawText='private';})},
  {id:'navigation-native.record-old-gui-gate',expectedReason:'INJECTION_NAVIGATION_NATIVE_BOUNDARY_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary={step:213,signals:{kind:'insertion-tab-backtab'},passed:true};})},
  {id:'navigation-native.source-gui',expectedReason:'INJECTION_NAVIGATION_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.source='gui';})},
  {id:'navigation-native.wrong-policy',expectedReason:'INJECTION_NAVIGATION_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.tabFocusBehavior=255;})},
  {id:'navigation-native.wrong-height',expectedReason:'INJECTION_NAVIGATION_NATIVE_BOUNDARY_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.windowHeight=650;})},
]));
test('navigation native preparation rejects zero clipped and unbounded geometry or a restarted deadline',()=>reject([
  {id:'navigation-native.zero-boundary',expectedReason:'INJECTION_NAVIGATION_NATIVE_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.wholeVisibility.clipWidth=0;})},
  {id:'navigation-native.truncated-boundary',expectedReason:'INJECTION_NAVIGATION_NATIVE_GEOMETRY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{delete r.boundary.wholeVisibility.clipHeight;})},
  {id:'navigation-native.clock-expired',expectedReason:'INJECTION_NAVIGATION_NATIVE_BOUNDARY_CLOCK',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.afterAtMs=4000;})},
  {id:'navigation-native.clock-reset',expectedReason:'INJECTION_NAVIGATION_NATIVE_SETUP_CLOCK',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthBoundary.stepAtMs=1;r.depthBoundary.inputAtMs=1;})},
  {id:'navigation-native.layout-unstable',expectedReason:'INJECTION_NAVIGATION_NATIVE_LAYOUT',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.layout.last.stableFrameSerial=r.boundary.prepareFrame;})},
]));
test('navigation native shared consumer rejects missing replaced delayed and postfailure successful samples',()=>reject([
  {id:'navigation-native.missing-sample',expectedReason:'INJECTION_NAVIGATION_PHASES',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.snapshots.splice(7,1);})},
  {id:'navigation-native.replaced-sample',expectedReason:'INJECTION_NAVIGATION_PHASES',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7]=copy(r.navigation.snapshots[19]);})},
  {id:'navigation-native.delayed-sample',expectedReason:'INJECTION_NAVIGATION_CLOCK',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].nowMs=271;r.navigation.snapshots[7].elapsedMs=271;})},
  {id:'navigation-native.failure-then-success',expectedReason:'INJECTION_NAVIGATION_PHASES',expectedContext:primary,mutate:v=>recordMutation(v,r=>{const failed=copy(r.navigation.snapshots[7]);failed.focusInExpected=false;r.navigation.snapshots.splice(7,0,failed);})},
  {id:'navigation-native.after-assertion-success',expectedReason:'INJECTION_NAVIGATION_SNAPSHOT',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].capturePoint='after-boundary-assertion';})},
]));
test('navigation native proof checks real leaf owner content identity and exact input counters',()=>reject([
  {id:'navigation-native.wrong-leaf',expectedReason:'INJECTION_NAVIGATION_FOCUS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.token='c1';})},
  {id:'navigation-native.wrong-owner',expectedReason:'INJECTION_NAVIGATION_OWNER',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].owner.token='c1';})},
  {id:'navigation-native.identity-overlong',expectedReason:'INJECTION_NAVIGATION_DESCRIPTOR',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].owner.objectName='x'.repeat(81);})},
  {id:'navigation-native.value-changed',expectedReason:'INJECTION_NAVIGATION_VALUES',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].values.depth=2;})},
  {id:'navigation-native.key-extra',expectedReason:'INJECTION_NAVIGATION_COUNTS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.keyDispatchCount=10;})},
  {id:'navigation-native.backtab-as-tab',expectedReason:'INJECTION_NAVIGATION_KEYS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.keyDispatches[4].keyCode=0x01000001;})},
  {id:'navigation-native.backtab-modifier',expectedReason:'INJECTION_NAVIGATION_KEYS',expectedContext:{...primary,phase:'after-backtab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[11].modifiers=0;})},
  {id:'navigation-native.outside-policy-violation',expectedReason:'INJECTION_NAVIGATION_OUTSIDE',expectedContext:{...primary,phase:'after-tab-outside'},mutate:v=>recordMutation(v,r=>{for(const name of ['focus','owner','expected']) {r.navigation.snapshots[9][name].className='QQuickCheckBox';r.navigation.snapshots[9][name].typeFlags={textInput:false,textEdit:false,comboBox:false,spinBox:false};}})},
  {id:'navigation-native.signal-extra',expectedReason:'INJECTION_NAVIGATION_COUNTS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].roleActivatedSignals=1;})},
]));
test('navigation native setup remains an actual position depth role editing chain',()=>reject([
  {id:'navigation-native.setup-removed',expectedReason:'INJECTION_NAVIGATION_NATIVE_SETUP',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.setup.splice(0,1);})},
  {id:'navigation-native.setup-role-unchanged',expectedReason:'INJECTION_NAVIGATION_NATIVE_SETUP',expectedContext:{...primary,stage:'role'},mutate:v=>recordMutation(v,r=>{r.boundary.setup[2].beforeGroup.role='system';})},
  {id:'navigation-native.setup-key-count',expectedReason:'INJECTION_NAVIGATION_NATIVE_SETUP_COUNTS',expectedContext:{...primary,stage:'position'},mutate:v=>recordMutation(v,r=>{r.boundary.setup[0].keyDispatchCount=3;})},
  {id:'navigation-native.setup-target-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_SETUP_TARGET',expectedContext:{...primary,stage:'role'},mutate:v=>recordMutation(v,r=>{r.boundary.setup[2].target.token='c1';})},
  {id:'navigation-native.depth-incomplete',expectedReason:'INJECTION_DEPTH_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.depthInput.completed=false;})},
  {id:'navigation-native.context-missing',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_FIELDS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.contextBefore=null;})},
  {id:'navigation-native.literal-mode-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_MODE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])r.boundary[field].useRegex=true;})},
  {id:'navigation-native.regex-mode-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_MODE',expectedContext:{...context,caseId:'navigation-narrow-policy-3'},mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])r.boundary[field].useRegex=false;},4)},
  {id:'navigation-native.inherited-budget-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])r.boundary[field].entrySettings.tokenBudget={value:100,confirmed:true,editable:true,inherited:false,present:true,canOverride:false};})},
  {id:'navigation-native.custom-budget-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',expectedContext:{...context,caseId:'navigation-compact-policy-3'},mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])r.boundary[field].entrySettings.tokenBudget={value:null,confirmed:true,editable:true,inherited:true,present:true,canOverride:true};},2)},
  {id:'navigation-native.entry-setting-unconfirmed',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.contextBefore.entrySettings.scanDepth.confirmed=false;})},
  {id:'navigation-native.custom-can-override-forged',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_SETTINGS',expectedContext:{...context,caseId:'navigation-compact-policy-3'},mutate:v=>recordMutation(v,r=>{r.boundary.contextBefore.entrySettings.tokenBudget.canOverride=true;},2)},
  {id:'navigation-native.context-changed-during-traversal',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_STABILITY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.contextAfter.beforeItem.token='c1';})},
  {id:'navigation-native.inherited-before-owner-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])r.boundary[field].beforeOwner.objectName='worldbookEntryTokenBudget';})},
  {id:'navigation-native.literal-after-neighbor-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])for(const name of ['afterItem','afterOwner'])r.boundary[field][name].objectName='worldbookRegexSecondaryKeywords';})},
  {id:'navigation-native.regex-after-neighbor-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',expectedContext:{...context,caseId:'navigation-narrow-policy-3'},mutate:v=>recordMutation(v,r=>{for(const field of ['contextBefore','contextAfter'])for(const name of ['afterItem','afterOwner'])r.boundary[field][name].objectName='worldbookSecondaryKeywords';},4)},
  {id:'navigation-native.actual-before-owner-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const index of [17,18])r.navigation.snapshots[index].owner.objectName='unrelatedSpinBox';})},
  {id:'navigation-native.actual-after-neighbor-replaced',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_NEIGHBOR',expectedContext:primary,mutate:v=>recordMutation(v,r=>{for(const index of [9,10])for(const name of ['focus','owner','expected'])r.navigation.snapshots[index][name].objectName='unrelatedTextField';})},
]));
test('navigation native qualifications bind each immediate predispatch observation',()=>reject([
  {id:'navigation-native.qualification-removed',expectedReason:'INJECTION_NAVIGATION_NATIVE_QUALIFICATIONS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.qualifications.pop();})},
  {id:'navigation-native.keyboard-fake-layout',expectedReason:'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_BOUND',expectedContext:{...primary,phase:'before-tab-role'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[3].layoutMatches=true;})},
  {id:'navigation-native.qualification-late',expectedReason:'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_CLOCK',expectedContext:{...primary,phase:'before-tab-role'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[3].nowMs=269;r.boundary.qualifications[3].elapsedMs=269;})},
  {id:'navigation-native.qualification-target',expectedReason:'INJECTION_NAVIGATION_NATIVE_QUALIFICATION_TARGET',expectedContext:{...primary,phase:'before-tab-role'},mutate:v=>recordMutation(v,r=>{r.boundary.qualifications[3].target.token='c1';})},
]));
test('navigation native request counters prove no archive write chat send or backend startup',()=>reject([
  {id:'navigation-native.archive-put',expectedReason:'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.requestCountsAfter.archivePut=1;})},
  {id:'navigation-native.chat-send',expectedReason:'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.requestCountsAfter.chatSend=1;})},
  {id:'navigation-native.backend-started',expectedReason:'INJECTION_NAVIGATION_NATIVE_REQUEST_COUNTS',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.backendRunningAfter=true;})},
]));
test('navigation native contract and manifest bind the exact independent six file set',()=>reject([
  {id:'navigation-native.contract-changed',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTRACT',mutate:v=>{const contract=JSON.parse(fs.readFileSync(v.contractPath,'utf8'));contract.maximumRecordBytes++;fs.writeFileSync(v.contractPath,JSON.stringify(contract));}},
  {id:'navigation-native.file-missing',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_SET',mutate:v=>fs.unlinkSync(path.join(v.directory,C.cases[0].filename))},
  {id:'navigation-native.file-extra',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_SET',mutate:v=>fs.writeFileSync(path.join(v.directory,'gui-proof.json'),'{}')},
  {id:'navigation-native.manifest-schema',expectedReason:'INJECTION_NAVIGATION_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.schema='gui-gate';})},
  {id:'navigation-native.manifest-order',expectedReason:'INJECTION_NAVIGATION_NATIVE_MANIFEST_CASES',mutate:v=>manifestMutation(v,m=>{m.cases.reverse();})},
  {id:'navigation-native.manifest-file',expectedReason:'INJECTION_NAVIGATION_NATIVE_MANIFEST_ENTRY',expectedContext:primary,mutate:v=>manifestMutation(v,m=>{m.cases[0].filename=C.cases[1].filename;})},
]));
test('navigation native reader rejects swapped tampered truncated oversized and symbolic raw files',()=>reject([
  {id:'navigation-native.file-swapped',expectedReason:'INJECTION_NAVIGATION_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>{const a=path.join(v.directory,C.cases[0].filename),b=path.join(v.directory,C.cases[1].filename),bytes=fs.readFileSync(a);fs.writeFileSync(a,fs.readFileSync(b));fs.writeFileSync(b,bytes);}},
  {id:'navigation-native.file-tampered',expectedReason:'INJECTION_NAVIGATION_NATIVE_RECORD_HASH',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('1380','1381'));}},
  {id:'navigation-native.file-appended',expectedReason:'INJECTION_NAVIGATION_NATIVE_RECORD_BYTES',expectedContext:primary,mutate:v=>fs.appendFileSync(path.join(v.directory,C.cases[0].filename),' ')},
  {id:'navigation-native.file-empty',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'')},
  {id:'navigation-native.file-large',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_BOUND',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),' '.repeat(C.maximumRecordBytes+1))},
  {id:'navigation-native.file-json',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_JSON',expectedContext:primary,mutate:v=>fs.writeFileSync(path.join(v.directory,C.cases[0].filename),'{')},
  {id:'navigation-native.file-link',expectedReason:'INJECTION_NAVIGATION_NATIVE_FILE_KIND',expectedContext:primary,mutate:v=>{const file=path.join(v.directory,C.cases[0].filename),target=path.join(v.root,'retained.json');fs.renameSync(file,target);fs.symlinkSync(target,file);}},
  {id:'navigation-native.directory-link',expectedReason:'INJECTION_NAVIGATION_NATIVE_DIRECTORY',mutate:v=>{const target=path.join(v.root,'retained');fs.renameSync(v.directory,target);fs.symlinkSync(target,v.directory);}},
]));
function verifyWriter(value) {
  const before=fs.existsSync(value.outputPath)?fs.readFileSync(value.outputPath):null;
  try {const proof=writeNativeWorldbookInjectionNavigationEvidence(value.directory,value.contractPath,value.outputPath);fs.unlinkSync(value.outputPath);return proof;}
  catch(error) {
    if(before===null)assert.equal(fs.existsSync(value.outputPath),false,'Rejected navigation evidence wrote a proof');
    else assert.deepEqual(fs.readFileSync(value.outputPath),before,'Rejected navigation evidence changed existing output');
    throw error;
  }
}
test('navigation native writer rejects existing and in evidence outputs without writing',()=>reject([
  {id:'navigation-native.output-existing',expectedReason:'INJECTION_NAVIGATION_NATIVE_OUTPUT_NOT_FRESH',expectedContext:{field:'output'},mutate:v=>fs.writeFileSync(v.outputPath,'retained')},
  {id:'navigation-native.output-inside',expectedReason:'INJECTION_NAVIGATION_NATIVE_OUTPUT_IN_EVIDENCE',expectedContext:{field:'output'},mutate:v=>{v.outputPath=path.join(v.directory,'proof.json');}},
  {id:'navigation-native.output-incomplete',expectedReason:'INJECTION_NAVIGATION_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.completed=false;})},
],verifyWriter));

// Independent complete controlled inputs for the unchanged four consumers.
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
const {verifyWorldbookInjectionNavigationNativeEvidencePair,writeWorldbookInjectionNavigationNativeEvidencePair}=require('./worldbook-injection-navigation-native-evidence-pair-consume.cjs');
function jointFilesFixture() {
  const value=pairFilesFixture(),depth=depthFilesFixture(value.root),navigation=navigationFilesFixture(value.root);
  return {...value,depthDirectory:depth.directory,depthContract:depth.contractPath,depthOutput:depth.outputPath,
    navigationDirectory:navigation.directory,navigationContract:navigation.contractPath,navigationOutput:navigation.outputPath};
}
const jointOutputs=value=>[value.legacyOutput,value.focusOutput,value.outputPath,value.depthOutput,value.navigationOutput];
const jointVerify=value=>verifyWorldbookInjectionNavigationNativeEvidencePair(value.legacyDirectory,value.legacyContract,
  value.focusDirectory,value.focusContract,value.directory,value.contractPath,value.depthDirectory,value.depthContract,
  value.navigationDirectory,value.navigationContract);
const jointWrite=value=>writeWorldbookInjectionNavigationNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.legacyOutput,
  value.focusDirectory,value.focusContract,value.focusOutput,value.directory,value.contractPath,value.outputPath,
  value.depthDirectory,value.depthContract,value.depthOutput,value.navigationDirectory,value.navigationContract,value.navigationOutput);
function verifyJointWriter(value) {
  const before=jointOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null);
  let proof;
  try {proof=jointWrite(value);} catch(error) {
    assert.deepEqual(jointOutputs(value).map(file=>fs.existsSync(file)?fs.readFileSync(file).toString('hex'):null),before,
      'Rejected five-group evidence wrote or changed a proof');throw error;
  }
  for(const file of jointOutputs(value))fs.unlinkSync(file);
  return proof;
}
test('navigation five consumer pair preserves the original four proof objects and writes after all five succeed',()=>{
  const value=jointFilesFixture();
  try {
    const directories=[value.legacyDirectory,value.focusDirectory,value.directory,value.depthDirectory,value.navigationDirectory],
      before=directories.map(directory=>rawSnapshot({directory}));
    const old=verifyWorldbookInjectionDepthNativeEvidencePair(value.legacyDirectory,value.legacyContract,value.focusDirectory,value.focusContract,
      value.directory,value.contractPath,value.depthDirectory,value.depthContract);
    const expected={...old,navigation:verifyNativeWorldbookInjectionNavigationEvidence(value.navigationDirectory,value.navigationContract)};
    assert.deepEqual(jointVerify(value),expected);assert.deepEqual(jointWrite(value),expected);
    assert.deepEqual(Object.values(expected).map(proof=>proof.caseIds.length),[4,3,2,3,6]);
    for(const [index,key] of ['native','focus','regex','depth','navigation'].entries())
      assert.equal(fs.readFileSync(jointOutputs(value)[index],'utf8'),JSON.stringify(expected[key],null,2)+'\n');
    assert.deepEqual(directories.map(directory=>rawSnapshot({directory})),before);
  } finally {dispose(value);}
});
test('navigation five consumer pair writes no proof when any independent evidence group is invalid',()=>{
  const rows=[
    {id:'navigation-pair.native-missing',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},
      mutate:v=>fs.unlinkSync(path.join(v.legacyDirectory,'persona-row-default-success.json'))},
    {id:'navigation-pair.focus-missing',expectedReason:'ARCHIVE_FOCUS_FILE_SET',expectedContext:{kind:'native-focus'},
      mutate:v=>fs.unlinkSync(path.join(v.focusDirectory,F.nativeFocusEvidence.cases[0].filename))},
    {id:'navigation-pair.regex-missing',expectedReason:'REGEX_NATIVE_FILE_SET',expectedContext:{kind:'native-regex'},
      mutate:v=>fs.unlinkSync(path.join(v.directory,R.cases[0].filename))},
    {id:'navigation-pair.depth-missing',expectedReason:'INJECTION_DEPTH_NATIVE_FILE_SET',expectedContext:{kind:'native-injection-depth'},
      mutate:v=>fs.unlinkSync(path.join(v.depthDirectory,D.cases[0].filename))},
    {id:'navigation-pair.navigation-incomplete',expectedReason:'INJECTION_NAVIGATION_EVIDENCE',expectedContext:primary,
      mutate:v=>recordMutation({directory:v.navigationDirectory},record=>{record.navigation.completed=false;})},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:jointFilesFixture,verify:verifyJointWriter,dispose,kind:'files',...row});
});
test('navigation five consumer pair rejects existing overlapping and in evidence outputs without writing',()=>{
  const rows=[
    {id:'navigation-pair.output-existing',expectedReason:'INJECTION_NAVIGATION_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>fs.writeFileSync(v.navigationOutput,'retained')},
    {id:'navigation-pair.output-overlapping',expectedReason:'INJECTION_NAVIGATION_NATIVE_PAIR_OUTPUT_NOT_FRESH',expectedContext:{field:'outputs'},
      mutate:v=>{v.navigationOutput=v.legacyOutput;}},
    {id:'navigation-pair.output-in-evidence',expectedReason:'INJECTION_NAVIGATION_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',expectedContext:{field:'outputs'},
      mutate:v=>{v.navigationOutput=path.join(v.depthDirectory,'navigation-proof.json');}},
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:jointFilesFixture,verify:verifyJointWriter,dispose,kind:'files',...row});
});

// R5 synthetic file fixtures start from a fresh v2 baseline and retain original
// bytes through verification. No historical Qt record is patched into a pass.
const navigationTypeFlags=kind=>({textInput:kind==='input',textEdit:kind==='edit',comboBox:kind==='combo',spinBox:kind==='spin'});
const fullNavigationDescriptors=record=>record.navigation.snapshots.flatMap(row=>[...Object.values(row.controls),row.focus,row.owner,row.expected]);
function renameRecordIdentity(record,token,className) {
  function visit(value) {
    if(!value||typeof value!=='object')return;
    if(value.token===token&&Object.hasOwn(value,'className'))value.className=className;
    for(const child of Object.values(value))visit(child);
  }
  visit(record);
}
function setRecordNavigationType(record,token,kind) {
  for(const descriptor of fullNavigationDescriptors(record))if(descriptor.token===token)descriptor.typeFlags=navigationTypeFlags(kind);
}
function acceptNativeNavigationMutation(index,mutate) {
  const value=navigationFilesFixture();
  try {
    assert.equal(verify(value).passed,true);recordMutation(value,mutate,index);
    const before=rawSnapshot(value);assert.equal(verify(value).passed,true);assert.deepEqual(rawSnapshot(value),before);
  } finally {dispose(value);}
}
test('navigation native version two raw contracts retain the version one proof format',()=>{
  const value=navigationFilesFixture();
  try {
    const proof=verify(value);
    assert.equal(C.schema,'reverie.qt.worldbook-injection-navigation-native-contract.v2');
    assert.equal(C.recordSchema,'reverie.qt.worldbook-injection-navigation-native-evidence.v2');
    assert.equal(C.manifestSchema,'reverie.qt.worldbook-injection-navigation-native-manifest.v2');
    assert.equal(C.navigationSchema,'reverie.qt.worldbook-injection-navigation.v2');
    assert.equal(C.boundarySchema,'reverie.qt.worldbook-injection-navigation-native-boundary.v1');
    assert.equal(proof.schema,'reverie.qt.worldbook-injection-navigation-native-verdict.v1');
    const record=JSON.parse(fs.readFileSync(path.join(value.directory,C.cases[0].filename),'utf8'));
    for(const identity of [record.navigation.snapshots[0].controls.depth.contentItem,record.navigation.snapshots[0].controls.depth.scopedFocusItem,
      record.boundary.contextBefore.beforeItem,record.boundary.contextBefore.beforeOwner])
      assert.deepEqual(Object.keys(identity).sort(),['className','found','objectName','token']);
  } finally {dispose(value);}
});
test('navigation native controlled GlassField and anonymous TextArea aliases keep actual semantic flags',()=>{
  acceptNativeNavigationMutation(0,record=>renameRecordIdentity(record,'b1','GlassField_QMLTYPE_787'));
  acceptNativeNavigationMutation(4,record=>renameRecordIdentity(record,'b1','AnonymousArea_QML_797'));
});
test('navigation native controlled derived selectors and spin boxes use semantic flags',()=>{
  acceptNativeNavigationMutation(0,record=>{
    renameRecordIdentity(record,'a1','PositionPicker_QMLTYPE_809');
    renameRecordIdentity(record,'a5','RolePicker_QMLTYPE_811');
    renameRecordIdentity(record,'a3','DepthStepper_QMLTYPE_821');
    renameRecordIdentity(record,'b3','BudgetStepper_QMLTYPE_823');
  });
});
test('navigation native semantic flags reject absent malformed and conflicting booleans',()=>reject([
  {id:'navigation-native.flags-missing',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{delete r.navigation.snapshots[7].focus.typeFlags;})},
  {id:'navigation-native.flags-null',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags=null;})},
  {id:'navigation-native.flags-number',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags=1;})},
  {id:'navigation-native.flags-string',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags='true';})},
  {id:'navigation-native.flag-string',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags.comboBox='true';})},
  {id:'navigation-native.flags-conflict',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags.textInput=true;})},
]));
test('navigation native semantic context binds literal regex and boundary owner types',()=>reject([
  {id:'navigation-native.context-literal-wrong-type',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_TYPE_BINDING',expectedContext:{...context,caseId:'navigation-wide-policy-255'},mutate:v=>recordMutation(v,r=>{setRecordNavigationType(r,'b1','edit');},1)},
  {id:'navigation-native.context-regex-wrong-type',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_TYPE_BINDING',expectedContext:{...context,caseId:'navigation-narrow-policy-3'},mutate:v=>recordMutation(v,r=>{setRecordNavigationType(r,'b1','input');},4)},
  {id:'navigation-native.context-owner-wrong-type',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_TYPE_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{setRecordNavigationType(r,'b3','none');})},
  {id:'navigation-native.context-forged-type-fields',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTEXT_IDENTITY',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.boundary.contextBefore.afterItem.typeFlags=navigationTypeFlags('input');})},
]));
test('navigation native semantic flags reject text selector and spin box name impersonation',()=>reject([
  {id:'navigation-native.name-textfield-impostor',expectedReason:'INJECTION_NAVIGATION_OUTSIDE',expectedContext:{...primary,phase:'after-tab-outside'},mutate:v=>recordMutation(v,r=>{renameRecordIdentity(r,'b1','DecorativeTextField_QMLTYPE_827');setRecordNavigationType(r,'b1','none');})},
  {id:'navigation-native.name-selector-impostor',expectedReason:'INJECTION_NAVIGATION_CONTROLS',expectedContext:{...primary,phase:'before-click'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[0].controls.role.typeFlags=navigationTypeFlags('none');})},
  {id:'navigation-native.name-spinbox-impostor',expectedReason:'INJECTION_NAVIGATION_CONTROLS',expectedContext:{...primary,phase:'before-click'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[0].controls.depth.typeFlags=navigationTypeFlags('none');})},
  {id:'navigation-native.name-depth-input-impostor',expectedReason:'INJECTION_NAVIGATION_POLICY',expectedContext:{...primary,phase:'after-tab-depth'},mutate:v=>recordMutation(v,r=>{setRecordNavigationType(r,'a4','none');})},
]));
test('navigation native semantic flags cannot change for the same live token',()=>reject([
  {id:'navigation-native.object-type-changed',expectedReason:'INJECTION_NAVIGATION_TYPE_BINDING',expectedContext:{...primary,phase:'after-tab-role'},mutate:v=>recordMutation(v,r=>{r.navigation.snapshots[7].focus.typeFlags=navigationTypeFlags('edit');})},
]));
test('navigation native version two rejects old contracts manifests records and missing semantics',()=>reject([
  {id:'navigation-native.old-contract-schema',expectedReason:'INJECTION_NAVIGATION_NATIVE_CONTRACT',mutate:v=>{const file=JSON.parse(fs.readFileSync(v.contractPath,'utf8'));file.schema='reverie.qt.worldbook-injection-navigation-native-contract.v1';fs.writeFileSync(v.contractPath,JSON.stringify(file));}},
  {id:'navigation-native.old-manifest-schema',expectedReason:'INJECTION_NAVIGATION_NATIVE_MANIFEST_BINDING',mutate:v=>manifestMutation(v,m=>{m.schema='reverie.qt.worldbook-injection-navigation-native-manifest.v1';})},
  {id:'navigation-native.old-record-schema',expectedReason:'INJECTION_NAVIGATION_NATIVE_RECORD_BINDING',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.schema='reverie.qt.worldbook-injection-navigation-native-evidence.v1';})},
  {id:'navigation-native.old-navigation-schema',expectedReason:'INJECTION_NAVIGATION_EVIDENCE',expectedContext:primary,mutate:v=>recordMutation(v,r=>{r.navigation.schema='reverie.qt.worldbook-injection-navigation.v1';})},
  {id:'navigation-native.old-observations-no-semantics',expectedReason:'INJECTION_NAVIGATION_TYPE_FLAGS',expectedContext:{...primary,phase:'before-click'},mutate:v=>recordMutation(v,r=>{for(const descriptor of fullNavigationDescriptors(r))delete descriptor.typeFlags;})},
]));
