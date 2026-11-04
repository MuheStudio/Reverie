'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {INJECTION_TEXTS,INJECTION_REPLY,INJECTION_BOOK_ID,ENTRY_IDS,MARKERS,FIRST_CHECKS,RESTART_CHECKS,INPUT_STEPS,CONTROLS,HEADINGS,SAFETY,injectionModelMetadata,verifyModel,verifyWorldbookInjection}=require('./worldbook-injection-verdicts.cjs');
const clone=v=>JSON.parse(JSON.stringify(v)),h=n=>n.toString(16).padStart(64,'0');
const placements=[
  [['before_char',0,'system'],['before_char',0,'system'],['before_char',0,'system'],['before_char',0,'system']],
  [['before_char',0,'system'],['after_char',0,'system'],['before_char',0,'system'],['before_char',0,'system']],
  [['before_char',0,'system'],['after_char',0,'system'],['at_depth',1,'system'],['before_char',0,'system']],
  [['before_char',0,'system'],['after_char',0,'system'],['at_depth',0,'user'],['before_char',0,'system']],
  [['before_char',0,'system'],['after_char',0,'system'],['at_depth',0,'user'],['at_depth',2,'assistant']]
].map(rows=>rows.map(([position,depth,role])=>({position,depth,role})));
function book(state) {
  return {id:'p1_injection_book',name:'插入验收资料',scanDepth:1,tokenBudget:1000,recursiveScanning:false,
    entries:['p','q','r','s'].map((name,i)=>({id:`p1_injection_${name}`,comment:'插入 '+name.toUpperCase(),content:`INJECTION_${name.toUpperCase()}_ONLY`,
      insertionOrder:[40,10,30,20][i],priority:1000,enabled:true,alwaysActive:true,useRegex:false,caseSensitive:false,
      selectiveLogic:'and_any',keywords:[],secondaryKeywords:[],scanDepth:null,tokenBudget:null,...placements[state][i]}))};
}
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100};
function layout(scope,elapsed,frame,enabled=true) {return {ready:true,minimumStableMs:40,last:{...geometry,ready:true,layoutStable:true,enabled,surfaceClosed:true,scope,elapsedMs:elapsed,stableSinceMs:elapsed-40,frameSerial:frame,stableFrameSerial:frame-1,pointX:30,pointY:15}};}
const effective=['系统提示 · 身份段之后（深度、角色此时不生效）','系统提示 · 角色状态之后（深度、角色此时不生效）','对话中按深度插入 · 深度 0 · 用户','对话中按深度插入 · 深度 2 · 助手'];
// R7 synthetic measurements follow the production serialization. Coordinates
// belong to independent measurement operands; the original Hit has nine keys.
function inputHitProofFor(input) {
  const target={found:true,objectName:input.control,className:'QQuickItem',token:'c1'},
    window={found:true,objectName:'',className:'QQuickWindow',token:'c2'},point={x:30,y:15};
  const metadata=()=>({nowMs:input.inputAtMs+input.elapsedMs,elapsedMs:input.elapsedMs,frame:input.frame,
    scope:input.scope,generation:input.generation,step:input.step,control:input.control,selectedEntryId:input.selectedEntryIdBefore,
    stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,window:clone(window),target:clone(target)});
  input.hit={hitResult:'descendant',acceptorFound:true,acceptorName:'',acceptorClass:'QQuickMouseArea',
    containing:[{found:true,objectName:'',className:'QQuickMouseArea'}],containingCount:1,
    passiveObservers:[],passiveObserverCount:0,containingLimit:6};
  return {schema:'reverie.qt.worldbook-injection-input-hit.v1',kind:input.signals.kind,scope:input.scope,generation:input.generation,
    step:input.step,control:input.control,selectedEntryId:input.selectedEntryIdBefore,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
    windowWidth:input.windowWidth,windowHeight:input.windowHeight,window:clone(window),target:clone(target),readinessPoint:clone(point),
    probe:{point:clone(point),accepted:true,hit:clone(input.hit),metadata:metadata()},
    dispatch:{point:clone(point),button:1,modifiers:0,delayMs:0,mouseDispatchCount:1,before:metadata(),after:metadata(),
      events:['press','release'].map((type,index)=>({type,x:30,y:15,button:1,buttons:index===0?1:0,modifiers:0,
        timestampMs:1000+index,metadata:metadata()}))}};
}
function rawMessages(stage) {
  const block=(kind,indices)=>HEADINGS[kind]+indices.map(i=>MARKERS[i]).join('\n\n')+'\n'+SAFETY;
  const messages=[{role:'system',content:'=== IDENTITY (HIGHEST PRIORITY) ===\nidentity\n=== CONTINUITY ORDER ===\ncontinuity\n'+block('before_char',stage===1?[1,3,2,0]:stage===2?[3,0]:[0])+'\n\n=== ABSOLUTE PROHIBITIONS ===\nprohibitions\n=== SPEAKING RULES ===\nspeaking\n=== CURRENT EMOTIONAL STATE ===\nemotion\n=== 用户选择的缺点 ===\nflaws'+(stage>1?'\n\n'+block('after_char',[1]):'')+'\n\n=== REALITY ANCHOR ===\ntime'}];
  const history=Array.from({length:stage===1?4:stage===2?6:8},(_,i)=>({role:i%2?'assistant':'user',content:`普通历史 ${i}`}));
  if(stage===2)history.splice(history.length-1,0,{role:'system',content:block('at_depth',[2])});
  if(stage===3){history.splice(history.length-2,0,{role:'assistant',content:MARKERS[3]});history.push({role:'user',content:MARKERS[2]});}
  return [...messages,...history,{role:'user',content:INJECTION_TEXTS[stage-1]}];
}
function historyReceipt(requestId,scope,generation,messageIds) {
  return {schema:'reverie.qt.worldbook-injection-history-read.v1',requestId,command:'chat:history',scope,generation,personaId:'default',runtimePersonaId:'builtin_default_persona',
    errorPresent:false,okPresent:false,okValue:null,itemsArray:true,hasMore:false,nextCursorNull:true,rowsInScope:true,messageIds:messageIds.slice(),markerCounts:[0,0,0,0]};
}
// R3 valid-fixture adaptation only: preserve the original 23 outer test bodies
// while supplying the newly required operands from the shared real-input path.
function depthProofFor(input) {
  const phases=['before-click','after-click','before-select-all','after-select-all','before-digit','after-digit','before-commit','after-commit'];
  const target={found:true,objectName:input.control,className:'QQuickSpinBox',token:'a1'},
    editableTextInput={found:true,objectName:'',className:'QQuickTextInput',token:'a2'},
    editor={found:true,objectName:'',className:'ArchiveEditor',token:'a3'};
  return {schema:'reverie.qt.worldbook-injection-depth-input.v1',step:input.step,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
    expectedValue:input.afterValue,beforeValue:input.beforeValue,selectedEntryId:input.selectedEntryId,scope:input.scope,generation:input.generation,
    controlObjectName:input.control,standardKey:'SelectAll',sequenceMatchesStandardKey:true,
    dispatchedSequencePortableText:'Ctrl+A',standardSequencePortableText:'Ctrl+A',dispatchedSequenceCodes:[0x04000041],
    standardSequenceCodes:[0x04000041],standardBindingIndex:0,keyActions:['SelectAll',`Digit${input.afterValue}`,'Return'],
    mouseDispatchCount:1,keyDispatchCount:3,valueModifiedSignals:1,completed:true,
    snapshots:phases.map((phase,index)=>({phase,capturePoint:'before-boundary-assertion',nowMs:input.inputAtMs+index*10,
      elapsedMs:index*10,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,scope:input.scope,generation:input.generation,step:input.step,frame:input.frame,selectedEntryId:input.selectedEntryId,
      target:clone(target),editableTextInput:clone(editableTextInput),editor:clone(editor),
      focus:index===0?{found:false,objectName:'',className:'',token:''}:clone(editableTextInput),
      controlObjectName:input.control,targetMatchesBound:true,editableMatchesBound:true,focusInTarget:index>0,focusInEditable:index>0,
      propertiesValid:true,selectionBoundsValid:true,fullSelection:index===3||index===4,textLength:1,cursorPosition:1,
      selectionStart:index===3||index===4?0:1,selectionEnd:1,selectedTextLength:index===3||index===4?1:0,
      textNumeric:true,editableValue:index<5?input.beforeValue:input.afterValue,
      controlValue:index===7?input.afterValue:input.beforeValue,editorValue:index===7?input.afterValue:input.beforeValue,
      valueModifiedSignals:index===7?1:0,mouseDispatchCount:index===0?0:1,keyDispatchCount:[0,0,0,1,1,2,2,3][index]}))};
}
// R4 fixture scaffolding supplies observations required by the shared genuine
// navigation consumer. R5 retains the outer identities; the old class-only
// negative payload explicitly carries nontext flags below.
function navigationProofFor(input) {
  const flags=kind=>({textInput:kind==='input',textEdit:kind==='edit',comboBox:kind==='combo',spinBox:kind==='spin'});
  const empty={found:false,objectName:'',className:'',token:''};
  const identity=(objectName,className,token)=>({found:true,objectName,className,token});
  const descriptor=(objectName,className,token,contentItem=empty,focusPolicy=11,kind='none')=>({
    ...identity(objectName,className,token),typeFlags:flags(kind),visible:true,enabled:true,focusPolicy,activeFocusOnTab:true,isFocusScope:false,
    scopedFocusItem:clone(empty),contentItem:clone(contentItem),popupVisible:false,focusReason:1,geometry:clone(geometry)});
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
  const group=clone(input.signals.beforeGroup);
  const snapshots=names.flatMap((name,actionIndex)=>['before','after'].map((side,sideIndex)=>{
    const index=actionIndex*2+sideIndex,state=states[sideIndex?actionIndex:Math.max(0,actionIndex-1)],
      focus=state==='depth'?leaf:controls[state]??(state==='after'?after:before),owner=controls[state]??(state==='before'?beforeOwner:focus);
    return {actionIndex,action:actions[actionIndex],keyCode:actionIndex===0?null:keyDispatches[actionIndex-1].keyCode,
      modifiers:actionIndex===0?0:keyDispatches[actionIndex-1].modifiers,phase:side+'-'+name,capturePoint:'before-boundary-assertion',
      mouseDispatchCount:index===0?0:1,keyDispatchCount:actionIndex===0?0:actionIndex-(sideIndex?0:1),
      positionActivatedSignals:0,depthModifiedSignals:0,roleActivatedSignals:0,values:clone(group),tabFocusBehavior:3,
      nowMs:input.inputAtMs+index*3,elapsedMs:index*3,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
      scope:input.scope,generation:input.generation,step:input.step,frame:input.frame,selectedEntryId:input.selectedEntryId,
      focus:clone(focus),owner:clone(owner),expected:clone(controls[state]??focus),focusInExpected:true,
      groupContains:['position','depth','role'].includes(state),controls:clone(controls)};
  }));
  return {schema:'reverie.qt.worldbook-injection-navigation.v2',step:input.step,stepAtMs:input.stepAtMs,inputAtMs:input.inputAtMs,
    selectedEntryId:input.selectedEntryId,scope:input.scope,generation:input.generation,controlObjectName:input.control,
    windowWidth:input.windowWidth,windowHeight:input.windowHeight,tabFocusBehavior:3,beforeGroup:clone(group),afterGroup:clone(group),
    mouseDispatchCount:1,keyDispatchCount:9,keyActions:actions.slice(1),keyDispatches,visited:clone(input.signals.visited),completed:true,snapshots,
    positionActivatedSignals:0,depthModifiedSignals:0,roleActivatedSignals:0};
}
function fixture() {
  const calls=[...['probe','chat','reading-fixture','reading-fixture','stop-fixture','combined-fixture'].map(kind=>({cycle:1,kind})),
    ...[1,2,3].map(stage=>({cycle:1,kind:'injection-fixture',stage,injectionText:INJECTION_TEXTS[stage-1],...injectionModelMetadata(rawMessages(stage))})),{cycle:2,kind:'probe'}];
  const events=[],reports=[];let terminalIds;
  for(let cycle=1;cycle<=2;cycle++) {
    const restart=cycle===2,generation=cycle*10,epoch=cycle+1,scope=`builtin_default_persona:${epoch}:${h(70)}`,rest=h(80),observed={scope,runtimePersonaId:'builtin_default_persona',restHash:rest,elapsedMs:restart?5000:12000,
      startState:{dirty:false,activeId:'default',draftMatches:true,draftLength:restart?10:0,expectedDraftLength:restart?10:0},
      baselineReadId:`baseline-read-${cycle}`,baselineRevision:restart?25:20,baselineArchiveHash:h(restart?25:20),
      baselineMessageIds:restart?terminalIds.slice():['initial-user','initial-assistant'],terminalRevision:25,terminalArchiveHash:h(25),
      finalReadId:`terminal-read-${cycle}`,historyReadId:`history-read-${cycle}`,historyReadReceived:true,historyMarkerCount:0,book:book(4),putCount:restart?0:5,terminalDraftMatches:true};
    const report={passed:true,error:'',mode:restart?'restart-readback':'change-and-effect',deadlineMs:restart?20000:45000,observed,
      checks:(restart?RESTART_CHECKS:FIRST_CHECKS).map(name=>({name,passed:true})),receipts:[],saves:[],chats:[],inputs:[],samples:[]};
    const receipt=(id,command,revision,value)=>{const v={requestId:id,command,generation,scope,personaId:'default',runtimePersonaId:'builtin_default_persona',ok:true,exists:true,revision,archiveHash:h(revision),restHash:rest,book:clone(value)};report.receipts.push(v);return v;};
    receipt(observed.baselineReadId,'archive:get',observed.baselineRevision,restart?book(4):{});
    events.push({event:'bootstrap_started',cycle});
    if(!restart) {
      Object.assign(observed,{prepareWriteId:'prepare-write-1',prepareReadId:'prepare-read-1',preparedExpectedRevision:20,preparedRevision:21});
      receipt(observed.prepareWriteId,'archive:put',21,book(0));receipt(observed.prepareReadId,'archive:get',21,book(0));
      const eventScope={persona_id:'builtin_default_persona',persona_epoch:epoch,persona_fingerprint:h(70)};
      const writes=[{event:'injection_archive_put_dispatch',cycle:1,request_id:observed.prepareWriteId,expected_revision:20,...eventScope}];
      for(let n=0;n<4;n++) {
        const revision=22+n,entry=[1,2,2,3][n],writeId=`injection-write-${n+1}`,readId=`injection-read-${n+1}`;
        const save={stage:n+1,writeId,readId,scope,generation,personaId:'default',expectedRevision:revision-1,revision,entryId:ENTRY_IDS[entry],placement:clone(placements[n+1][entry]),
          book:book(n+1),archiveHash:h(revision),restHash:rest,feedback:'已保存 · 下一轮聊天使用新 revision',
          binding:{armed:true,status:'matched',failureReason:'',requestId:writeId,scope,generation,baselineCount:n+1},
          readAtMs:1000+n*1000,feedbackInputAtMs:1050+n*1000,feedbackGeometry:clone(geometry),windowWidth:100,windowHeight:100,
          screenshot:`cycle-1.json.worldbook-injection-save-${n+1}.png`};
        report.saves.push(save);receipt(writeId,'archive:put',revision,book(n+1));receipt(readId,'archive:get',revision,book(n+1));
        writes.push({event:'injection_archive_put_dispatch',cycle:1,request_id:writeId,expected_revision:revision-1,...eventScope});
      }
      let ids=observed.baselineMessageIds.slice();events.push(writes[0]);
      for(let n=0;n<3;n++) {
        if(n===1)events.push(writes[1],writes[2]);if(n===2)events.push(writes[3],writes[4]);
        const stage=n+1,requestId=`injection-request-${stage}`,userId=`injection-user-${stage}`,assistantId=`injection-assistant-${stage}`,beforeIds=ids.slice();ids.push(userId,assistantId);
        const chatReadId=stage===3?observed.finalReadId:`chat-archive-read-${stage}`;
        if(stage!==3)receipt(chatReadId,'archive:get',[21,23,25][n],book([0,2,4][n]));
        report.chats.push({readId:chatReadId,historyReadId:stage===3?observed.historyReadId:`chat-history-read-${stage}`,historyReadReceived:true,
          historyReceipt:historyReceipt(stage===3?observed.historyReadId:`chat-history-read-${stage}`,scope,generation,ids),readMessageIds:ids.slice(),readRevision:[21,23,25][n],readArchiveHash:h([21,23,25][n]),stage,requestId,scope,generation,personaId:'default',beforeIds,afterIds:ids.slice(),userId,assistantId,text:INJECTION_TEXTS[n],reply:INJECTION_REPLY,revision:[21,23,25][n],archiveHash:h([21,23,25][n]),historyMarkerCount:0});
        events.push({event:'injection_dispatch',cycle:1,stage,request_id:requestId,...eventScope},{event:'injection_timing',cycle:1,stage,start_delay_ms:0,delivery_delay_ms:100});
      }
      terminalIds=ids.slice();observed.terminalMessageIds=ids.slice();
    } else {
      observed.terminalMessageIds=terminalIds.slice();
      report.samples=ENTRY_IDS.flatMap((entryId,i)=>['worldbookInsertionPosition','worldbookInsertionDepth','worldbookInsertionRole','worldbookInsertionEffective'].map((control,j)=>{
        const inputAtMs=500+i*500,elapsed=80+j*80,frame=20+i*8+j;
        return {step:400+i,entryId,control,value:control==='worldbookInsertionPosition'?[0,1,2,2][i]:control==='worldbookInsertionDepth'?[0,0,0,2][i]:control==='worldbookInsertionRole'?[0,0,1,2][i]:'实际生效：'+effective[i],
          placement:clone(placements[4][i]),effectiveText:effective[i],scope,generation,personaId:'default',revision:25,archiveHash:h(25),
          stepAtMs:inputAtMs-50,inputAtMs,sampledAtMs:inputAtMs+elapsed,frame,
          layout:layout(scope,elapsed,frame,!(i<2&&['worldbookInsertionDepth','worldbookInsertionRole'].includes(control))),geometry:clone(geometry),windowWidth:100,windowHeight:100};
      }));
    }
    observed.historyReceipt=historyReceipt(observed.historyReadId,scope,generation,observed.terminalMessageIds);
    receipt(observed.finalReadId,'archive:get',25,book(4));
    let saveInputIndex=0,composerInputIndex=0;
    report.inputs=INPUT_STEPS[cycle-1].map((step,n)=>{
      const frame=n+2,elapsed=80,control=CONTROLS[step],at=restart?[0,200,400,900,1400,1900,2400][n]:n*200,input={step,control,scope,generation,stepAtMs:at,inputAtMs:at,elapsedMs:elapsed,frame,
        selectedEntryId:ENTRY_IDS[0],beforeValue:null,afterValue:null,layout:layout(scope,elapsed,frame),windowWidth:100,windowHeight:100};
      if([202,203,204,210,211,232,240,241,243].includes(step)) {
        const after={202:3,203:2,204:1,210:3,211:2,232:1,240:4,241:2,243:2}[step];
        input.beforeValue=({203:1,210:2,240:3}[step]??0);input.afterValue=after;input.signals={kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:after};
      } else if([212,231,242].includes(step)) {
        input.beforeValue=step===231?1:0;input.afterValue=step===212?1:step===231?0:2;
        input.signals={kind:'depth-keyboard',mouseDispatchCount:1,valueModifiedSignals:1,keyDispatchCount:3,focusInTarget:true};
      } else if([213,244].includes(step)) {
        const group={position:'at_depth',depth:step===213?1:2,role:step===213?'system':'assistant'};
        input.beforeValue=input.afterValue=2;input.signals={kind:'insertion-tab-backtab',mouseDispatchCount:1,keyDispatchCount:9,forwardOutsideGroup:true,backwardOutsideGroup:true,beforeGroup:clone(group),afterGroup:clone(group),visited:['worldbookInsertionPosition','worldbookInsertionDepth','worldbookInsertionRole','after-group','worldbookInsertionRole','worldbookInsertionDepth','worldbookInsertionPosition','before-group','worldbookInsertionPosition']};
      } else if(step===101)input.signals={kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true};
      else input.signals={kind:'button',mouseDispatchCount:1,clickedSignals:1};
      const entryIndex={202:0,203:1,204:1,210:2,211:2,212:2,213:2,231:2,232:2,240:3,241:3,242:3,243:3,244:3}[step];
      if(entryIndex!==undefined)input.selectedEntryId=ENTRY_IDS[entryIndex];
      if(step===205)input.selectedEntryId=ENTRY_IDS[[1,2,2,3][saveInputIndex++]];
      if(step===101){input.beforeValue='';input.afterValue=INJECTION_TEXTS[composerInputIndex++];}
      if(input.signals.kind==='depth-keyboard')input.signals.depthInput=depthProofFor(input);
      if(input.signals.kind==='insertion-tab-backtab')input.signals.navigation=navigationProofFor(input);
      input.selectedEntryIdBefore=input.selectedEntryId;
      input.inputHit=inputHitProofFor(input);
      return input;
    });
    reports.push({worldbookInjection:report});
  }
  return {reports,calls,events};
}
const verify=v=>verifyWorldbookInjection(v.reports,v.calls,v.events);
function reject(id,reason,mutate,expectedContext={}) {return assertRejectedMutation({id,makeFixture:fixture,verify,mutate,expectedReason:reason,expectedContext});}
test('independent insertion fixture proves 10 requests, five writes and read-only restart',()=>assert.deepEqual(verify(fixture()),{passed:true,cycles:2,checks:[10,6],modelRequests:10,injectionChats:3,prepareWrites:1,guiSaves:4,writeCounts:[5,0],inputCounts:[30,7],restartSamples:16}));
test('raw request extractor recomputes marker placement and history depth',()=>{
  for(const stage of [1,2,3])verifyModel(injectionModelMetadata(rawMessages(stage)),stage);
  const value=injectionModelMetadata(rawMessages(3));assert.deepEqual(value.insertions.map(v=>[v.markers,v.role,v.effectiveDepth]),[[[3],'assistant',2],[[2],'user',0]]);
  assert.deepEqual([value.locations[2][0].kind,value.locations[3][0].kind],['at_depth','at_depth']);
  reject('unwrapped-system','INJECTION_MARKER_PLACEMENT',v=>{const messages=rawMessages(2);messages.find(m=>m.content.startsWith(HEADINGS.at_depth)).content=MARKERS[2];Object.assign(v.calls[7],injectionModelMetadata(messages));},{stage:2,marker:2});
  reject('history-prose','INJECTION_MARKER_PLACEMENT',v=>{const messages=rawMessages(3);messages.find(m=>m.content===MARKERS[2]).content+=' copied history text';Object.assign(v.calls[8],injectionModelMetadata(messages));},{stage:3,marker:2});
});
test('duplicate marker anywhere is rejected',()=>reject('duplicate-marker','INJECTION_MARKER_COUNTS',v=>{
  const messages=rawMessages(1);messages[1].content+=' '+MARKERS[0];Object.assign(v.calls[6],injectionModelMetadata(messages));
},{stage:1}));
test('depth off by one is rejected from raw messages',()=>reject('depth-one-off','INJECTION_INSERTION_DEPTH',v=>{
  const messages=rawMessages(2),i=messages.findIndex(m=>m.content.startsWith(HEADINGS.at_depth));const [inserted]=messages.splice(i,1);messages.splice(i-1,0,inserted);Object.assign(v.calls[7],injectionModelMetadata(messages));
},{stage:2,marker:2}));
test('wrong role is rejected from raw messages',()=>reject('wrong-role','INJECTION_MARKER_PLACEMENT',v=>{
  const messages=rawMessages(3);messages.find(m=>m.content===MARKERS[2]).role='assistant';Object.assign(v.calls[8],injectionModelMetadata(messages));
},{stage:3,marker:2}));
test('wrong adjacent merge is rejected from raw messages',()=>reject('adjacent-merge','INJECTION_MARKER_PLACEMENT',v=>{
  const messages=rawMessages(3),r=messages.findIndex(m=>m.content===MARKERS[2]),s=messages.findIndex(m=>m.content===MARKERS[3]);messages[s].content+='\n\n'+MARKERS[2];messages.splice(r,1);Object.assign(v.calls[8],injectionModelMetadata(messages));
},{stage:3,marker:2}));
test('last message must be actual current user',()=>reject('final-user','INJECTION_FINAL_USER',v=>{v.calls[8].lastRole='assistant';},{stage:3}));
test('permutation matching array order is rejected',()=>{
  reject('array-order','INJECTION_SECTION_ORDER',v=>{v.calls[6].sections[0].markerOrder=[0,1,2,3];},{stage:1,kind:'before_char'});
  for(const [stage,kind] of [[1,'before_char'],[2,'after_char']])reject(`moved-${kind}`,'INJECTION_SECTION_MESSAGE',v=>{
    const messages=rawMessages(stage),text=messages[0].content,start=text.indexOf(HEADINGS[kind]),end=text.indexOf('\n'+SAFETY,start)+1+SAFETY.length;
    const moved=text.slice(start,end);messages[0].content=text.slice(0,start)+text.slice(end);messages.splice(1,0,{role:'system',content:moved});
    Object.assign(v.calls[5+stage],injectionModelMetadata(messages));
  },{stage,kind});
  reject('after-before-character-state','INJECTION_SECTION_ANCHOR_ORDER',v=>{
    const messages=rawMessages(2),text=messages[0].content,start=text.indexOf(HEADINGS.after_char),end=text.indexOf('\n'+SAFETY,start)+1+SAFETY.length;
    const moved=text.slice(start,end),remaining=text.slice(0,start)+text.slice(end),at=remaining.indexOf('=== SPEAKING RULES ===');
    messages[0].content=remaining.slice(0,at)+moved+'\n\n'+remaining.slice(at);Object.assign(v.calls[7],injectionModelMetadata(messages));
  },{stage:2,kind:'after_char'});
});
test('an extra restart write is rejected',()=>reject('restart-write','INJECTION_WRITE_DISPATCH_COUNT',v=>v.events.push({...v.events[1],cycle:2})));
test('stale ACK revision is rejected',()=>reject('stale-ack','INJECTION_SAVE_ACK_READ',v=>{v.reports[0].worldbookInjection.receipts.find(r=>r.requestId==='injection-write-1').revision--;},{cycle:1,save:1}));
test('ACK missing an unchanged member of the group is rejected',()=>reject('missing-role','INJECTION_ENTRY_PLACEMENT',v=>{delete v.reports[0].worldbookInjection.receipts.find(r=>r.requestId==='injection-write-1').book.entries[1].role;},{cycle:1,save:1,entry:1}));
test('save request bound to a different scope is rejected',()=>reject('save-scope','INJECTION_SAVE_BOUND',v=>{v.reports[0].worldbookInjection.saves[0].scope='other';},{cycle:1,save:1}));
test('save input must bind the actually dispatched write',()=>reject('save-binding','INJECTION_SAVE_BINDING',v=>{v.reports[0].worldbookInjection.saves[0].binding.requestId='other-write';},{cycle:1,save:1}));
test('fresh read cannot reuse ACK',()=>reject('read-is-ack','INJECTION_RECEIPT_BOUND',v=>{v.reports[0].worldbookInjection.saves[0].readId='injection-write-1';},{cycle:1,role:'save-1-read'}));
test('restart sample must have saved effective text',()=>reject('effective-text','INJECTION_SAMPLE_EFFECTIVE',v=>{v.reports[1].worldbookInjection.samples[12].effectiveText='wrong';},{cycle:2,entry:3,control:'worldbookInsertionPosition'}));
test('history pollution is rejected after authoritative readback',()=>{
  reject('history-pollution','INJECTION_TERMINAL_READ',v=>{v.reports[0].worldbookInjection.observed.historyMarkerCount=1;},{cycle:1});
  reject('history-error-with-cached-ids','INJECTION_HISTORY_RECEIPT_SUCCESS',v=>{v.reports[0].worldbookInjection.observed.historyReceipt.errorPresent=true;},{cycle:1,role:'terminal-history'});
  reject('history-ok-false-with-cached-ids','INJECTION_HISTORY_RECEIPT_SUCCESS',v=>{const r=v.reports[0].worldbookInjection.chats[0].historyReceipt;r.okPresent=true;r.okValue=false;},{cycle:1,stage:1,role:'chat-history'});
  reject('history-stale-order','INJECTION_HISTORY_RECEIPT_IDS',v=>{v.reports[1].worldbookInjection.observed.historyReceipt.messageIds.reverse();},{cycle:2,role:'terminal-history'});
  reject('history-raw-marker','INJECTION_HISTORY_RECEIPT_MARKERS',v=>{v.reports[0].worldbookInjection.chats[1].historyReceipt.markerCounts[2]=1;},{cycle:1,stage:2,role:'chat-history'});
  reject('history-receipt-other-scope','INJECTION_HISTORY_RECEIPT_BOUND',v=>{v.reports[0].worldbookInjection.chats[0].historyReceipt.scope='other';},{cycle:1,stage:1,role:'chat-history'});
});
test('Tab and Backtab must preserve all group values',()=>reject('tab-mutates','INJECTION_TAB_VALUE',v=>{v.reports[0].worldbookInjection.inputs.find(r=>r.step===213).signals.afterGroup.depth=2;},{cycle:1,input:13}));
test('input cannot use a later generation',()=>reject('input-generation','INJECTION_INPUT_BOUND',v=>{v.reports[0].worldbookInjection.inputs[0].generation++;},{cycle:1,input:1}));
test('input needs a stable second frame',()=>{
  reject('unstable-frame','INJECTION_INPUT_STABILITY',v=>{v.reports[0].worldbookInjection.inputs[0].layout.last.stableFrameSerial=v.reports[0].worldbookInjection.inputs[0].frame;},{cycle:1,input:1});
  reject('future-input-start','INJECTION_INPUT_BOUND',v=>{const r=v.reports[0].worldbookInjection;r.inputs[0].stepAtMs=r.observed.elapsedMs+1;r.inputs[0].inputAtMs=r.observed.elapsedMs+1;},{cycle:1,input:1});
  reject('input-after-terminal','INJECTION_INPUT_BOUND',v=>{const r=v.reports[0].worldbookInjection,input=r.inputs.at(-1);input.inputAtMs=r.observed.elapsedMs-input.elapsedMs+1;},{cycle:1,input:30});
  reject('future-sample-start','INJECTION_SAMPLE_CLOCK',v=>{const r=v.reports[1].worldbookInjection,s=r.samples.at(-1);s.inputAtMs=r.observed.elapsedMs+1;s.sampledAtMs=s.inputAtMs+s.layout.last.elapsedMs;},{cycle:2,entry:3,control:'worldbookInsertionEffective'});
  reject('sample-after-terminal','INJECTION_SAMPLE_CLOCK',v=>{const r=v.reports[1].worldbookInjection,s=r.samples.at(-1);s.inputAtMs=r.observed.elapsedMs-s.layout.last.elapsedMs+1;s.sampledAtMs=r.observed.elapsedMs+1;},{cycle:2,entry:3,control:'worldbookInsertionEffective'});
  reject('sample-time-reversal','INJECTION_SAMPLE_ORDER',v=>{const r=v.reports[1].worldbookInjection,s=r.samples[1];s.inputAtMs=400;s.sampledAtMs=560;s.stepAtMs=350;},{cycle:2,entry:0,control:'worldbookInsertionDepth'});
  const inclusive=fixture(),r=inclusive.reports[0].worldbookInjection,last=r.inputs.at(-1);
  // Keep all evidence clocks/frames intact and exercise an inclusive terminal boundary.
  r.observed.elapsedMs=last.inputAtMs+last.elapsedMs;assert.equal(verify(inclusive).passed,true);
});
// The original mutation bodies and IDs are retained. The kind mutation now
// first rejects at the input-measurement binding in the original hit slot.
test('keyboard evidence is bound to the selected fixture entry',()=>reject('wrong-selected-entry','INJECTION_INPUT_ENTRY',v=>{v.reports[0].worldbookInjection.inputs.find(r=>r.step===212).selectedEntryId=ENTRY_IDS[3];},{cycle:1,input:12}));
test('a depth input cannot claim selector signals',()=>reject('wrong-input-kind','INJECTION_INPUT_HIT_BOUND',v=>{v.reports[0].worldbookInjection.inputs.find(r=>r.step===212).signals={kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1};},{cycle:1,input:12}));
test('business kind and entry checks reject independently after valid correlated hit measurements',()=>{
  reject('hit-correlated-wrong-input-kind','INJECTION_INPUT_KIND',value=>{
    const input=value.reports[0].worldbookInjection.inputs.find(row=>row.step===212);
    input.signals={kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1};input.inputHit.kind='selector';
  },{cycle:1,input:12});
  reject('hit-correlated-wrong-selected-entry','INJECTION_INPUT_ENTRY',value=>{
    const input=value.reports[0].worldbookInjection.inputs.find(row=>row.step===212),proof=input.inputHit;
    input.selectedEntryId=ENTRY_IDS[3];input.selectedEntryIdBefore=ENTRY_IDS[3];proof.selectedEntryId=ENTRY_IDS[3];
    for(const row of [proof.probe.metadata,proof.dispatch.before,...proof.dispatch.events.map(event=>event.metadata),proof.dispatch.after])
      row.selectedEntryId=ENTRY_IDS[3];
  },{cycle:1,input:12});
});
test('all 37 GUI inputs consume real shaped hit measurements and reject legacy rows',()=>{
  const value=fixture(),inputs=value.reports.flatMap(report=>report.worldbookInjection.inputs);
  assert.equal(inputs.length,37);assert(inputs.every(input=>Object.keys(input.hit).length===9&&input.inputHit.dispatch.events.length===2));
  assert.equal(verify(value).passed,true);
  reject('gui-hit-legacy-no-envelope','INJECTION_INPUT_HIT_EVIDENCE',v=>{delete v.reports[0].worldbookInjection.inputs[0].inputHit;},{cycle:1,input:1});
});
test('dispatch order cannot reorder a saved transition around a chat',()=>reject('dispatch-order','INJECTION_EVENT_ORDER',v=>{const hold=v.events[4];v.events[4]=v.events[6];v.events[6]=hold;}));
test('insertion fixture identifiers match bootstrap and GUI sources',()=>{
  const fs=require('node:fs'),path=require('node:path'),driver=fs.readFileSync(path.join(__dirname,'tests/WorldbookInjectionCheck.cpp'),'utf8'),bootstrap=fs.readFileSync(path.join(__dirname,'tests/p1_worldbook_injection_backend_bootstrap.py'),'utf8');
  assert(driver.includes(INJECTION_BOOK_ID)&&bootstrap.includes(INJECTION_BOOK_ID));for(const text of INJECTION_TEXTS)assert(driver.includes(text)&&bootstrap.includes(text));
  assert(INJECTION_TEXTS.every(text=>!MARKERS.some(marker=>text.includes(marker)))&&!MARKERS.some(marker=>INJECTION_REPLY.includes(marker)));
});
const depthRow=(value,step=212)=>value.reports[0].worldbookInjection.inputs.find(input=>input.step===step);
function rejectDepth(id,reason,mutate,phase,step=212) {
  return reject(id,reason,value=>mutate(depthRow(value,step).signals.depthInput,depthRow(value,step),value),
    {cycle:1,input:{212:12,231:19,242:24}[step],...(phase?{phase}:{})});
}
test('depth keyboard proof binds all three shared replacement sequences',()=>{
  const value=fixture();assert.equal(verify(value).passed,true);
  assert.deepEqual([212,231,242].map(step=>{const input=depthRow(value,step);return [input.step,input.signals.depthInput.beforeValue,input.signals.depthInput.expectedValue];}),
    [[212,0,1],[231,1,0],[242,0,2]]);
});
test('depth keyboard proof cannot omit the bounded operands',()=>{
  rejectDepth('depth-missing-evidence','INJECTION_DEPTH_EVIDENCE',(_proof,input)=>{delete input.signals.depthInput;});
  rejectDepth('depth-null-evidence','INJECTION_DEPTH_EVIDENCE',(_proof,input)=>{input.signals.depthInput=null;});
});
test('failed depth diagnostics cannot become successful input proof',()=>{
  rejectDepth('depth-incomplete-diagnostic','INJECTION_DEPTH_EVIDENCE',proof=>{proof.completed=false;});
  rejectDepth('depth-failed-phase-diagnostic','INJECTION_DEPTH_EVIDENCE',proof=>{proof.completed=false;proof.snapshots.splice(5);});
});
test('depth SelectAll validates actual Qt modifier and chord codes',()=>{
  rejectDepth('depth-meta-key-label','INJECTION_DEPTH_SEQUENCE',proof=>{proof.dispatchedSequencePortableText='Meta+A';});
  rejectDepth('depth-meta-key-code','INJECTION_DEPTH_SEQUENCE',proof=>{proof.dispatchedSequenceCodes=[0x10000041];});
  rejectDepth('depth-false-standard-code','INJECTION_DEPTH_SEQUENCE',proof=>{proof.standardSequenceCodes=[0x10000041];});
  rejectDepth('depth-forged-matching-meta','INJECTION_DEPTH_SEQUENCE',proof=>{
    proof.dispatchedSequenceCodes=proof.standardSequenceCodes=[0x10000041];
    proof.dispatchedSequencePortableText=proof.standardSequencePortableText='Meta+A';
  });
  rejectDepth('depth-multiple-chords','INJECTION_DEPTH_SEQUENCE',proof=>{proof.dispatchedSequenceCodes.push(0x41);});
  rejectDepth('depth-no-standard-match','INJECTION_DEPTH_SEQUENCE',proof=>{proof.sequenceMatchesStandardKey=false;});
  rejectDepth('depth-wrong-binding-index','INJECTION_DEPTH_SEQUENCE',proof=>{proof.standardBindingIndex=99;});
});
test('depth key actions retain SelectAll digit Return order',()=>{
  rejectDepth('depth-arrow-path','INJECTION_DEPTH_ACTIONS',proof=>{proof.keyActions=['SelectAll','Up','Return'];});
  rejectDepth('depth-reordered-actions','INJECTION_DEPTH_ACTIONS',proof=>{proof.keyActions=['Digit1','SelectAll','Return'];});
});
test('depth operand envelope binds the actual row and selected entry',()=>{
  for(const [field,replacement] of [['step',231],['stepAtMs',0],['inputAtMs',0],['scope','other'],['generation',99],
    ['selectedEntryId',ENTRY_IDS[3]],['controlObjectName','other'],['beforeValue',2],['expectedValue',10]])
    rejectDepth(`depth-envelope-${field}`,'INJECTION_DEPTH_BOUND',proof=>{proof[field]=replacement;});
});
test('depth proof requires every ordered before and after phase',()=>{
  rejectDepth('depth-missing-before-digit','INJECTION_DEPTH_PHASES',proof=>{proof.snapshots.splice(4,1);});
  rejectDepth('depth-duplicate-phase','INJECTION_DEPTH_PHASES',proof=>{proof.snapshots[4].phase='after-select-all';});
  rejectDepth('depth-out-of-order-phase','INJECTION_DEPTH_PHASES',proof=>{[proof.snapshots[3],proof.snapshots[4]]=[proof.snapshots[4],proof.snapshots[3]];});
});
test('depth captures must precede their boundary assertion',()=>{
  rejectDepth('depth-late-capture','INJECTION_DEPTH_SNAPSHOT',proof=>{proof.snapshots[4].capturePoint='after-boundary-assertion';},'before-digit');
});
test('depth clocks cannot place captures after the row or terminal',()=>{
  rejectDepth('depth-capture-after-row','INJECTION_DEPTH_CLOCK',(proof,input)=>{
    const snapshot=proof.snapshots[7];snapshot.elapsedMs=input.elapsedMs+1;snapshot.nowMs=input.inputAtMs+snapshot.elapsedMs;
  },'after-commit');
  rejectDepth('depth-capture-after-terminal','INJECTION_DEPTH_CLOCK',(proof,input,value)=>{
    const snapshot=proof.snapshots[7];snapshot.nowMs=value.reports[0].worldbookInjection.observed.elapsedMs+1;
    snapshot.elapsedMs=snapshot.nowMs-input.inputAtMs;
  },'after-commit');
});
test('depth snapshot context cannot use another scope generation or phase clock',()=>{
  for(const [field,replacement] of [['scope','other'],['generation',99],['step',231],['stepAtMs',0],['inputAtMs',0],['controlObjectName','other'],['selectedEntryId',ENTRY_IDS[3]]])
    rejectDepth(`depth-snapshot-${field}`,'INJECTION_DEPTH_SNAPSHOT_BOUND',proof=>{proof.snapshots[4][field]=replacement;},'before-digit');
});
test('depth snapshots reject reversed clocks and future frames',()=>{
  rejectDepth('depth-time-reversal','INJECTION_DEPTH_CLOCK',proof=>{
    proof.snapshots[4].nowMs=proof.snapshots[3].nowMs-1;proof.snapshots[4].elapsedMs=proof.snapshots[3].elapsedMs-1;
  },'before-digit');
  rejectDepth('depth-clock-arithmetic','INJECTION_DEPTH_CLOCK',proof=>{proof.snapshots[4].elapsedMs++;},'before-digit');
  rejectDepth('depth-future-frame','INJECTION_DEPTH_CLOCK',(proof,input)=>{proof.snapshots[4].frame=input.frame+1;},'before-digit');
  rejectDepth('depth-frame-reversal','INJECTION_DEPTH_CLOCK',proof=>{proof.snapshots[4].frame=proof.snapshots[3].frame-1;},'before-digit');
});
test('depth captures bind actual target editable input and editor identities',()=>{
  for(const name of ['target','editableTextInput','editor'])
    rejectDepth(`depth-changed-${name}`,'INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4][name].token='b4';},'before-digit');
  rejectDepth('depth-same-target-editable','INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4].editableTextInput.token=proof.snapshots[4].target.token;},'before-digit');
  rejectDepth('depth-unbound-editable','INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4].editableMatchesBound=false;},'before-digit');
  rejectDepth('depth-not-textinput','INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4].editableTextInput.className='QQuickText';},'before-digit');
  rejectDepth('depth-missing-target','INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4].target={found:false,objectName:'',className:'',token:''};},'before-digit');
});
test('depth keyboard phases require focus in the bound editable input',()=>{
  rejectDepth('depth-focus-other-item','INJECTION_DEPTH_FOCUS',proof=>{proof.snapshots[4].focus.token='b4';},'before-digit');
  rejectDepth('depth-focus-outside-target','INJECTION_DEPTH_FOCUS',proof=>{proof.snapshots[4].focusInTarget=false;},'before-digit');
  rejectDepth('depth-focus-outside-editable','INJECTION_DEPTH_FOCUS',proof=>{proof.snapshots[4].focusInEditable=false;},'before-digit');
});
test('depth proof admits only bounded metadata without raw text fields',()=>{
  rejectDepth('depth-raw-envelope-text','INJECTION_DEPTH_EVIDENCE',proof=>{proof.text='0';});
  rejectDepth('depth-raw-snapshot-text','INJECTION_DEPTH_SNAPSHOT',proof=>{proof.snapshots[4].selectedText='0';},'before-digit');
  rejectDepth('depth-identity-name-bound','INJECTION_DEPTH_TARGET',proof=>{proof.snapshots[4].focus.objectName='x'.repeat(81);},'before-digit');
});
test('SelectAll must prove full real selection before the digit',()=>{
  for(const [index,phase] of [[3,'after-select-all'],[4,'before-digit']])
    rejectDepth(`depth-collapsed-selection-${index}`,'INJECTION_DEPTH_SELECTION',proof=>{
      const snapshot=proof.snapshots[index];snapshot.selectionStart=1;snapshot.selectedTextLength=0;snapshot.fullSelection=false;
    },phase);
  rejectDepth('depth-claimed-full-selection','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].fullSelection=false;},'before-digit');
});
test('depth selection rejects invalid bounds missing properties and cursor',()=>{
  rejectDepth('depth-invalid-selection-bounds','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].selectionEnd=2;},'before-digit');
  rejectDepth('depth-invalid-selection-length','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].selectedTextLength=0;},'before-digit');
  rejectDepth('depth-invalid-cursor','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].cursorPosition=2;},'before-digit');
  rejectDepth('depth-unread-properties','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].propertiesValid=false;},'before-digit');
  rejectDepth('depth-null-text-length','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[4].textLength=null;},'before-digit');
});
test('depth digit must replace rather than prepend to the original value',()=>{
  rejectDepth('depth-prepended-ten','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[5].textLength=2;proof.snapshots[5].editableValue=10;},'after-digit');
  rejectDepth('depth-wrong-numeric-read','INJECTION_DEPTH_REPLACEMENT',proof=>{proof.snapshots[5].editableValue=10;},'after-digit');
  rejectDepth('depth-not-numeric','INJECTION_DEPTH_SELECTION',proof=>{proof.snapshots[5].textNumeric=false;},'after-digit');
  rejectDepth('depth-digit-cursor-left','INJECTION_DEPTH_REPLACEMENT',proof=>{proof.snapshots[5].cursorPosition=0;},'after-digit');
});
test('depth commit binds actual control and editor numeric values',()=>{
  rejectDepth('depth-control-editor-mismatch','INJECTION_DEPTH_VALUES',proof=>{proof.snapshots[7].editorValue=0;},'after-commit');
  rejectDepth('depth-control-model-ten','INJECTION_DEPTH_VALUES',proof=>{proof.snapshots[7].editorValue=proof.snapshots[7].controlValue=10;},'after-commit');
  rejectDepth('depth-control-model-stale','INJECTION_DEPTH_VALUES',proof=>{proof.snapshots[7].editorValue=proof.snapshots[7].controlValue=0;},'after-commit');
  rejectDepth('depth-control-baseline-mismatch','INJECTION_DEPTH_VALUES',proof=>{proof.snapshots[0].editorValue=1;},'before-click');
});
test('depth per-phase dispatch counters prove one click and three actions',()=>{
  rejectDepth('depth-extra-mouse','INJECTION_DEPTH_COUNTS',proof=>{proof.mouseDispatchCount=2;});
  rejectDepth('depth-extra-key','INJECTION_DEPTH_COUNTS',proof=>{proof.keyDispatchCount=4;});
  rejectDepth('depth-digit-before-selectall','INJECTION_DEPTH_COUNTS',proof=>{proof.snapshots[2].keyDispatchCount=1;},'before-select-all');
  rejectDepth('depth-two-mouse-dispatches','INJECTION_DEPTH_COUNTS',proof=>{proof.snapshots[4].mouseDispatchCount=2;},'before-digit');
});
test('depth signal snapshots reject premature duplicate or absent modification',()=>{
  rejectDepth('depth-selection-emits-modified','INJECTION_DEPTH_COUNTS',proof=>{proof.snapshots[4].valueModifiedSignals=1;},'before-digit');
  rejectDepth('depth-duplicate-modified','INJECTION_DEPTH_COUNTS',proof=>{proof.snapshots[7].valueModifiedSignals=2;},'after-commit');
  rejectDepth('depth-absent-modified','INJECTION_DEPTH_COUNTS',proof=>{proof.snapshots[7].valueModifiedSignals=0;},'after-commit');
});
test('later zero and two replacement records carry independent evidence',()=>{
  rejectDepth('depth-zero-proof-missing','INJECTION_DEPTH_EVIDENCE',(_proof,input)=>{delete input.signals.depthInput;},undefined,231);
  rejectDepth('depth-two-proof-from-zero','INJECTION_DEPTH_BOUND',(proof,_input,value)=>{
    Object.assign(proof,clone(depthRow(value,231).signals.depthInput));
  },undefined,242);
});
const navigationRow=(value,step=213)=>value.reports[0].worldbookInjection.inputs.find(input=>input.step===step);
function rejectNavigation(id,reason,mutate,phase,step=213) {
  return reject(id,reason,value=>mutate(navigationRow(value,step).signals.navigation,navigationRow(value,step),value),
    {cycle:1,input:step===213?13:26,...(phase?{phase}:{})});
}
test('navigation proof requires original observations in both GUI stages',()=>{
  for(const step of [213,244])rejectNavigation(`navigation-missing-${step}`,'INJECTION_NAVIGATION_EVIDENCE',(_proof,input)=>{delete input.signals.navigation;},undefined,step);
  rejectNavigation('navigation-driver-visited-only','INJECTION_NAVIGATION_EVIDENCE',(_proof,input)=>{input.signals.navigation={visited:input.signals.visited,completed:true};});
});
test('navigation proof preserves one click nine keys and all twenty immediate phases',()=>{
  rejectNavigation('navigation-extra-key','INJECTION_NAVIGATION_COUNTS',proof=>{proof.keyDispatchCount=10;});
  rejectNavigation('navigation-key-order','INJECTION_NAVIGATION_ACTIONS',proof=>{proof.keyActions[2]='Backtab';});
  rejectNavigation('navigation-wrong-keycode','INJECTION_NAVIGATION_KEYS',proof=>{proof.keyDispatches[4].keyCode=0x01000001;});
  rejectNavigation('navigation-wrong-modifiers','INJECTION_NAVIGATION_KEYS',proof=>{proof.snapshots[11].modifiers=0;},'after-backtab-role');
  rejectNavigation('navigation-sample-missing','INJECTION_NAVIGATION_PHASES',proof=>{proof.snapshots.splice(7,1);});
  rejectNavigation('navigation-sample-added','INJECTION_NAVIGATION_PHASES',proof=>{proof.snapshots.push(clone(proof.snapshots.at(-1)));});
  rejectNavigation('navigation-phase-replaced','INJECTION_NAVIGATION_PHASES',proof=>{proof.snapshots[7]=clone(proof.snapshots[19]);});
});
test('navigation diagnostic failure cannot be replaced by a later success',()=>{
  rejectNavigation('navigation-incomplete','INJECTION_NAVIGATION_EVIDENCE',proof=>{proof.completed=false;});
  rejectNavigation('navigation-after-assertion-sample','INJECTION_NAVIGATION_SNAPSHOT',proof=>{proof.snapshots[7].capturePoint='after-boundary-assertion';},'after-tab-role');
  rejectNavigation('navigation-late-success-replacement','INJECTION_NAVIGATION_CLOCK',(proof,input)=>{
    const row=proof.snapshots[7];row.nowMs=input.inputAtMs+input.elapsedMs+1;row.elapsedMs=input.elapsedMs+1;
  },'after-tab-role');
});
test('navigation checks effective policy and rejects changed control policy',()=>{
  rejectNavigation('navigation-policy-unknown','INJECTION_NAVIGATION_POLICY',proof=>{proof.tabFocusBehavior=0;});
  rejectNavigation('navigation-policy-midflight','INJECTION_NAVIGATION_POLICY',proof=>{proof.snapshots[7].tabFocusBehavior=255;},'after-tab-role');
  rejectNavigation('navigation-role-no-tab-policy','INJECTION_NAVIGATION_CONTROLS',proof=>{proof.snapshots[7].controls.role.focusPolicy=0;},'after-tab-role');
});
test('navigation focus evidence binds leaf owner content and stable control identities',()=>{
  rejectNavigation('navigation-wrong-leaf','INJECTION_NAVIGATION_FOCUS',proof=>{proof.snapshots[7].focus.token='c1';},'after-tab-role');
  rejectNavigation('navigation-wrong-owner','INJECTION_NAVIGATION_OWNER',proof=>{proof.snapshots[7].owner.token='c1';},'after-tab-role');
  rejectNavigation('navigation-depth-wrong-content','INJECTION_NAVIGATION_FOCUS',proof=>{proof.snapshots[5].focus.token='c1';},'after-tab-depth');
  rejectNavigation('navigation-role-recreated','INJECTION_NAVIGATION_IDENTITY',proof=>{proof.snapshots[7].controls.role.token='c1';},'after-tab-role');
  rejectNavigation('navigation-content-replaced','INJECTION_NAVIGATION_IDENTITY',proof=>{proof.snapshots[7].controls.role.contentItem.token='c1';},'after-tab-role');
});
test('navigation before samples retain the immediately preceding real focus',()=>{
  rejectNavigation('navigation-before-focus-replaced','INJECTION_NAVIGATION_CONTINUITY',proof=>{proof.snapshots[8].focus.token='c1';},'before-tab-outside');
  rejectNavigation('navigation-before-owner-replaced','INJECTION_NAVIGATION_CONTINUITY',proof=>{proof.snapshots[8].owner.token='c1';},'before-tab-outside');
  rejectNavigation('navigation-outside-still-in-group','INJECTION_NAVIGATION_OUTSIDE',proof=>{proof.snapshots[9].groupContains=true;},'after-tab-outside');
  rejectNavigation('navigation-outside-policy-violation','INJECTION_NAVIGATION_OUTSIDE',proof=>{
    for(const name of ['focus','owner','expected']) {
      proof.snapshots[9][name].className='QQuickCheckBox';
      proof.snapshots[9][name].typeFlags={textInput:false,textEdit:false,comboBox:false,spinBox:false};
    }
  },'after-tab-outside');
});
test('navigation values and activation counters remain unchanged at every phase',()=>{
  rejectNavigation('navigation-value-changed','INJECTION_NAVIGATION_VALUES',proof=>{proof.snapshots[7].values.role='assistant';},'after-tab-role');
  rejectNavigation('navigation-selector-activated','INJECTION_NAVIGATION_COUNTS',proof=>{proof.snapshots[7].roleActivatedSignals=1;},'after-tab-role');
  rejectNavigation('navigation-early-key','INJECTION_NAVIGATION_COUNTS',proof=>{proof.snapshots[6].keyDispatchCount++;},'before-tab-role');
});
test('navigation bounded metadata rejects truncated identities raw text and invalid geometry',()=>{
  rejectNavigation('navigation-identity-truncated','INJECTION_NAVIGATION_DESCRIPTOR',proof=>{proof.snapshots[7].focus.objectName='x'.repeat(81);},'after-tab-role');
  rejectNavigation('navigation-raw-text','INJECTION_NAVIGATION_SNAPSHOT',proof=>{proof.snapshots[7].rawText='role';},'after-tab-role');
  rejectNavigation('navigation-zero-scene','INJECTION_NAVIGATION_GEOMETRY',proof=>{proof.snapshots[7].focus.geometry.sceneWidth=0;},'after-tab-role');
  rejectNavigation('navigation-clipped-as-full','INJECTION_NAVIGATION_GEOMETRY',proof=>{proof.snapshots[7].focus.geometry.clipWidth=0;},'after-tab-role');
});
test('navigation clocks frames and per-phase context remain in the original input boundary',()=>{
  rejectNavigation('navigation-clock-reversed','INJECTION_NAVIGATION_CLOCK',proof=>{
    const row=proof.snapshots[7];row.nowMs=proof.snapshots[6].nowMs-1;row.elapsedMs=row.nowMs-proof.inputAtMs;
  },'after-tab-role');
  rejectNavigation('navigation-frame-future','INJECTION_NAVIGATION_CLOCK',(proof,input)=>{proof.snapshots[7].frame=input.frame+1;},'after-tab-role');
  rejectNavigation('navigation-generation-other','INJECTION_NAVIGATION_SNAPSHOT_BOUND',proof=>{proof.snapshots[7].generation++;},'after-tab-role');
});

// R5 controlled inputs model direct Qt inherits booleans. These are fresh
// synthetic fixtures, never rewritten historical Qt evidence.
const navigationTypeFlags=kind=>({textInput:kind==='input',textEdit:kind==='edit',comboBox:kind==='combo',spinBox:kind==='spin'});
const fullNavigationDescriptors=proof=>proof.snapshots.flatMap(row=>[...Object.values(row.controls),row.focus,row.owner,row.expected]);
function renameNavigationIdentity(proof,token,className) {
  for(const descriptor of fullNavigationDescriptors(proof))for(const item of [descriptor,descriptor.contentItem,descriptor.scopedFocusItem])
    if(item.token===token)item.className=className;
}
function setNavigationType(proof,token,kind) {
  for(const descriptor of fullNavigationDescriptors(proof))if(descriptor.token===token)descriptor.typeFlags=navigationTypeFlags(kind);
}
function acceptNavigationMutation(mutate) {
  const pristine=fixture();assert.equal(verify(pristine).passed,true);
  const changed=clone(pristine);mutate(navigationRow(changed).signals.navigation);
  assert.equal(verify(changed).passed,true);
}
test('navigation semantic flags accept a controlled GlassField QML alias',()=>{
  acceptNavigationMutation(proof=>renameNavigationIdentity(proof,'b1','GlassField_QMLTYPE_731'));
});
test('navigation semantic flags accept a controlled anonymous derived TextArea',()=>{
  acceptNavigationMutation(proof=>{
    renameNavigationIdentity(proof,'b1','AnonymousArea_QML_737');setNavigationType(proof,'b1','edit');
  });
});
test('navigation semantic flags accept derived selectors spin boxes and opaque text leaves',()=>{
  acceptNavigationMutation(proof=>{
    renameNavigationIdentity(proof,'a1','PositionPicker_QMLTYPE_741');
    renameNavigationIdentity(proof,'a5','RolePicker_QMLTYPE_743');
    renameNavigationIdentity(proof,'a3','DepthStepper_QMLTYPE_749');
    renameNavigationIdentity(proof,'a4','AnonymousEditable_QML_751');
    renameNavigationIdentity(proof,'b3','BudgetStepper_QMLTYPE_757');
    renameNavigationIdentity(proof,'b2','AnonymousEditable_QML_761');
  });
});
test('navigation semantic flags reject missing observations on every descriptor role',()=>{
  for(const name of ['focus','owner','expected'])rejectNavigation(`navigation-flags-missing-${name}`,'INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    delete proof.snapshots[7][name].typeFlags;
  },'after-tab-role');
  rejectNavigation('navigation-flags-missing-control','INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    delete proof.snapshots[7].controls.depth.typeFlags;
  },'after-tab-role');
});
test('navigation semantic flags reject null numeric string array and incomplete objects',()=>{
  for(const [id,flags] of [['null',null],['number',1],['string','true'],['array',[]],['incomplete',{textInput:true}]])
    rejectNavigation(`navigation-flags-shape-${id}`,'INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{proof.snapshots[7].focus.typeFlags=clone(flags);},'after-tab-role');
  for(const [id,flag] of [['null',null],['number',1],['string','false']])
    rejectNavigation(`navigation-flag-not-boolean-${id}`,'INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{proof.snapshots[7].focus.typeFlags.comboBox=flag;},'after-tab-role');
});
test('navigation semantic flags reject conflicting unknown and absent-object types',()=>{
  rejectNavigation('navigation-flags-conflict','INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    proof.snapshots[7].focus.typeFlags.textEdit=true;
  },'after-tab-role');
  rejectNavigation('navigation-flags-extra','INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    proof.snapshots[7].focus.typeFlags.textField=true;
  },'after-tab-role');
  rejectNavigation('navigation-flags-absent-object','INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    proof.snapshots[0].focus={found:false,objectName:'',className:'',token:'',typeFlags:navigationTypeFlags('input'),
      visible:false,enabled:false,focusPolicy:null,activeFocusOnTab:false,isFocusScope:false,
      scopedFocusItem:{found:false,objectName:'',className:'',token:''},contentItem:{found:false,objectName:'',className:'',token:''},
      popupVisible:false,focusReason:null,geometry:{found:false,visible:false,fullyVisible:false}};
  },'before-click');
});
test('navigation semantic flags reject nontext controls whose diagnostic names contain text types',()=>{
  for(const className of ['DecorativeTextField_QMLTYPE_769','DecorativeTextArea_QMLTYPE_773','DecorativeTextInput_QML_777'])
    rejectNavigation(`navigation-name-spoof-${className}`,'INJECTION_NAVIGATION_OUTSIDE',proof=>{
      renameNavigationIdentity(proof,'b1',className);setNavigationType(proof,'b1','none');
    },'after-tab-outside');
});
test('navigation semantic flags reject selector and spin box name impersonation',()=>{
  for(const name of ['position','role','depth'])rejectNavigation(`navigation-control-type-spoof-${name}`,'INJECTION_NAVIGATION_CONTROLS',proof=>{
    proof.snapshots[0].controls[name].typeFlags=navigationTypeFlags('none');
  },'before-click');
});
test('navigation semantic flags bind the actual editable leaf after entering depth',()=>{
  rejectNavigation('navigation-depth-leaf-not-input','INJECTION_NAVIGATION_POLICY',proof=>{
    setNavigationType(proof,'a4','none');
  },'after-tab-depth');
});
test('navigation semantic flags cannot change for a live object token',()=>{
  rejectNavigation('navigation-object-type-changed','INJECTION_NAVIGATION_TYPE_BINDING',proof=>{
    proof.snapshots[7].focus.typeFlags=navigationTypeFlags('edit');
  },'after-tab-role');
});
test('navigation semantic flags require version two and reject old observations without inference',()=>{
  rejectNavigation('navigation-old-schema','INJECTION_NAVIGATION_EVIDENCE',proof=>{proof.schema='reverie.qt.worldbook-injection-navigation.v1';});
  rejectNavigation('navigation-old-record-no-semantic','INJECTION_NAVIGATION_TYPE_FLAGS',proof=>{
    for(const descriptor of fullNavigationDescriptors(proof))delete descriptor.typeFlags;
  },'before-click');
});
