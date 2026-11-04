'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {BOOK_SETTINGS_TEXTS,BOOK_SETTINGS_REPLY,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,EXPECTED_CONTEXT,bookSettingsModelMetadata,verifyWorldbookBookSettings}=require('./worldbook-book-settings-verdicts.cjs');
const clone=v=>JSON.parse(JSON.stringify(v)), h=n=>n.toString(16).padStart(64,'0');
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const SETTINGS=[[1,100,false],[3,100,true],[3,0,true]];
// A complete persona-row record for one switch, in the shape PersonaRowInputProbe reports.
function rowRecord({step,targetId,sourcePersonaId,scope,generation}) {
  const [livePersonaId,epochText,fingerprint]=scope.split(':'), epoch=Number(epochText);
  const control={found:true,bound:true,geometryValid:true,integerPointInsideClip:true,ready:true,enabled:true,visible:true,surfaceClosed:true,inputPointInsideClip:true,
    scope,fullyVisible:true,pointX:35,pointY:20,sceneX:10,sceneY:10,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100,
    scrolls:[{contentY:100,contentHeight:500,sceneX:0,sceneY:0,sceneWidth:100,sceneHeight:100}]};
  const whole={found:true,visible:true,fullyVisible:true,...Object.fromEntries(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].map(k=>[k,control[k]]))};
  const reveal={expired:false,geometryValid:true,scrollLimit:6,ancestorCount:1,scrollCount:0,elapsedMs:40,
    scrolls:[{index:0,beforeY:100,afterY:100,minimumY:0,maximumY:400,contentHeight:500,viewportHeight:100,topYBefore:10,bottomYBefore:30,requestedY:70,scrolled:false,fitsViewport:true,afterObserved:true}]};
  const observed={ready:true,root:'taskSurface',page:'characterTasks',targetId,sourcePersonaId,livePersonaId,scope,generation,
    listPersonaId:livePersonaId,listActivePersonaId:sourcePersonaId,personaEpoch:epoch,listPersonaEpoch:epoch,personaFingerprint:fingerprint,listPersonaFingerprint:fingerprint,liveMatches:true,
    taskSurfaceCount:1,characterTasksCount:1,rowCount:1,controlCount:1,targetProfileCount:1,sourceProfileCount:1,activeProfileCount:1,
    rowId:targetId,rowActive:false,rowIdKnown:true,rowActiveKnown:true,modelDataType:'QJSValue',normalizedModelDataType:'QVariantMap',
    identityMatches:true,rowInactive:true,scopeMatches:true,generationMatches:true,personaMatches:true,surfaceReady:true,effectiveOpacity:1,
    control,whole,hit:{acceptorFound:true,hitResult:'descendant'},reveal};
  const anchor={...clone(observed),elapsedMs:0,frameSerial:20,schedulingIntervalMs:null};anchor.reveal.elapsedMs=0;
  const final={...clone(observed),elapsedMs:40,frameSerial:21,schedulingIntervalMs:40,
    layout:{layoutStable:true,stableSinceMs:0,stableFrameSerial:20},stableAnchor:clone(anchor),
    dispatchElapsedMs:41,dispatchFrameSerial:21,dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,mouseElapsedMs:42,mouseFrameSerial:21,clickedSignals:1,signalObserverValid:true,status:'performed',failureReason:''};
  final.mouse={...clone(observed),elapsedMs:41,frameSerial:21,schedulingIntervalMs:40,layout:clone(final.layout)};
  return {step,targetId,sourcePersonaId,livePersonaId,control:'personaSwitch-'+targetId,root:'taskSurface',page:'characterTasks',
    scope,generation,stepAtMs:1000,deadlineMs:4000,pollIntervalMs:40,minimumStableMs:40,sampleLimit:6,polls:2,
    windowWidth:100,windowHeight:100,dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,clickedSignals:1,status:'performed',failureReason:'',terminalCount:1,
    samples:[anchor],terminal:final,sequence:{performed:true,expired:false,failed:false,busy:false,actionIndex:1,
      actions:[{name:'personaSwitch-'+targetId,index:0,attempted:true,performed:true,failed:false,actionElapsedMs:40}]}};
}
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100};
function book([scanDepth,tokenBudget,recursiveScanning]) {
  return {id:'p1_book_settings_book',name:'书级设置验收资料',scanDepth,tokenBudget,recursiveScanning,
    entries:[0,1].map(i=>({id:i?'p1_book_settings_recursion':'p1_book_settings_depth',content:i?'BOOK_RECURSION_ONLY':'BOOK_DEPTH_ONLY 回声',
      keywords:[i?'回声':'远灯'],insertionOrder:i?40:30,priority:0,enabled:true,alwaysActive:false,useRegex:false,scanDepth:null,tokenBudget:null}))};
}
function fixture() {
  const sunny='sunny-persona', moon='moon-persona', frost='frost-persona', fingerprint=h(70), rest=h(50);
  const events=[{event:'persona_seeded',cycle:1,profile_id:sunny}];
  const calls=[{kind:'probe',cycle:1},{kind:'priority-fixture',cycle:1,stage:1},{kind:'priority-fixture',cycle:1,stage:2},
    ...[1,2,3].map(stage=>({kind:'book-settings-fixture',cycle:1,stage,bookSettingsText:BOOK_SETTINGS_TEXTS[stage-1],
      worldSettingSections:stage===3?0:1,depthMarkerCount:stage===3?0:1,recursionMarkerCount:stage===2?1:0,markerInHistory:false,
      worldSettingSha256:digest(EXPECTED_CONTEXT[stage-1])})),
    {kind:'probe',cycle:2},{kind:'priority-fixture',cycle:2,stage:3}];
  const state=(personaId,revision,archiveHash,messageIds)=>({personaId,exists:true,revision,archiveHash,messageIds,charactersHash:h(22),avatarIds:['avatar-original'],activeAvatar:'avatar-original',avatarState:'idle'});
  const reports=[]; let frostIds=['frost-user-0','frost-assistant-0'], terminal;
  for(let cycle=1;cycle<=2;cycle++) {
    const verify=cycle===2, epoch=cycle*4+1, scope=`${frost}:${epoch}:${fingerprint}`, generation=cycle*10;
    const originalPersona=verify?'default':moon, originalScopeId=verify?'builtin-persona':moon;
    const originalScope=`${originalScopeId}:${epoch-1}:${h(71)}`, returnScope=`${originalScopeId}:${epoch+1}:${h(71)}`;
    const original=state(originalPersona,verify?20:6,h(90),['original-message']);
    const before=verify?clone(terminal):state(frost,4,h(4),frostIds.slice());
    const observed={originalBefore:original,originalAfter:clone(original),frostBefore:before,frostPersonaId:frost,originalScope,returnScope,frostScope:scope,
      originalReadId:`original-read-${cycle}`,baselineReadId:`baseline-read-${cycle}`,returnReadId:`return-read-${cycle}`,elapsedMs:9000,putCount:verify?0:3,
      canonicalBaselineRestHash:rest};
    const report={passed:true,error:'',mode:verify?'restart-readback':'change-and-effect',deadlineMs:verify?20000:40000,
      checks:(verify?RESTART_CHECKS:FIRST_CHECKS).map(name=>({name,passed:true})),observed,receipts:[],saves:[],chats:[],inputs:[]};
    const receipt=(requestId,command,revision,archiveHash,value,personaId=frost,receiptScope=scope)=>{
      const r={requestId,command,generation:receiptScope===originalScope?generation-1:receiptScope===returnScope?generation+1:generation,scope:receiptScope,personaId,ok:true,exists:true,revision,archiveHash,restHash:rest,book:value};
      report.receipts.push(r);return r;
    };
    receipt(observed.originalReadId,'archive:get',original.revision,original.archiveHash,{},originalPersona,originalScope);
    receipt(observed.baselineReadId,'archive:get',before.revision,before.archiveHash,verify?book(SETTINGS[2]):{});
    const states=[];
    if(!verify) {
      Object.assign(observed,{prepareWriteId:'prepare-write-1',prepareReadId:'prepare-read-1',preparedExpectedRevision:4,preparedRevision:5});
      receipt(observed.prepareWriteId,'archive:put',5,h(5),book(SETTINGS[0]));receipt(observed.prepareReadId,'archive:get',5,h(5),book(SETTINGS[0]));
      events.push({event:'book_settings_archive_put_dispatch',cycle:1,request_id:observed.prepareWriteId,persona_id:frost,persona_epoch:epoch,persona_fingerprint:fingerprint,expected_revision:4});
      states.push(5);
      for(let n=0;n<2;n++) {
        const revision=6+n, [scanDepth,tokenBudget,recursiveScanning]=SETTINGS[n+1];
        const save={stage:n+1,scanDepth,tokenBudget,recursiveScanning,expectedRevision:revision-1,revision,writeId:`book-write-${n+1}`,readId:`book-read-${n+1}`,scope,generation,personaId:frost,
          binding:{armed:true,status:'matched',failureReason:'',scope,generation,requestId:`book-write-${n+1}`,baselineCount:n+1},readAtMs:1000+n*1000,feedbackInputAtMs:1100+n*1000,
          archiveHash:h(revision),restHash:rest,book:book(SETTINGS[n+1]),feedback:'已保存 · 下一轮聊天使用新 revision',feedbackGeometry:clone(geometry),windowWidth:100,windowHeight:100,
          screenshot:`cycle-1.json.worldbook-book-settings-save-${n+1}.png`};
        events.push({event:'book_settings_archive_put_dispatch',cycle:1,request_id:save.writeId,persona_id:frost,persona_epoch:epoch,persona_fingerprint:fingerprint,expected_revision:save.expectedRevision});
        report.saves.push(save);receipt(save.writeId,'archive:put',revision,h(revision),book(SETTINGS[n+1]));receipt(save.readId,'archive:get',revision,h(revision),book(SETTINGS[n+1]));
        states.push(revision);
      }
      for(const stage of [1,2,3]) {
        const requestId=`book-chat-request-${stage}`, userId=`book-user-${stage}`, assistantId=`book-assistant-${stage}`;
        const beforeIds=frostIds.slice(); frostIds.push(userId,assistantId);
        report.chats.push({stage,requestId,scope,generation,personaId:frost,beforeIds,afterIds:frostIds.slice(),userId,assistantId,
          text:BOOK_SETTINGS_TEXTS[stage-1],reply:BOOK_SETTINGS_REPLY,revision:states[stage-1],archiveHash:h(states[stage-1])});
        events.push({event:'book_settings_timing',cycle:1,stage,persona_id:frost,persona_epoch:epoch,persona_fingerprint:fingerprint,start_delay_ms:0,delivery_delay_ms:100},
          {event:'book_settings_dispatch',cycle:1,stage,request_id:requestId,persona_id:frost,persona_epoch:epoch,persona_fingerprint:fingerprint});
      }
      terminal=state(frost,7,h(7),frostIds.slice());
      observed.frostTerminal=clone(terminal); observed.frostBaselineMessageIds=before.messageIds.slice();
    } else {
      observed.frostTerminal=clone(before);
      observed.restartControls={scanDepth:3,tokenBudget:0,recursiveScanning:true,editorScanDepth:3,editorTokenBudget:0,editorRecursiveScanning:true,
        scanGeometry:clone(geometry),readAtMs:500,inputAtMs:600,windowWidth:100,windowHeight:100,screenshot:'cycle-2.json.worldbook-book-settings-restart.png',
        samplingPolicy:'sequential-whole-within-one-input-deadline',screenshotControl:'worldbookRecursiveScanning',
        samples:['worldbookScanDepth','worldbookBookTokenBudget','worldbookRecursiveScanning'].map((control,i)=>({
          control,step:19,value:SETTINGS[2][i],editorValue:SETTINGS[2][i],readId:observed.baselineReadId,scope,generation,personaId:frost,
          revision:before.revision,archiveHash:before.archiveHash,stepAtMs:500,inputAtMs:600,sampledAtMs:640+i*80,frame:50+i*2,
          windowWidth:100,windowHeight:100,geometry:clone(geometry),
          layout:{ready:true,minimumStableMs:40,last:{ready:true,layoutStable:true,enabled:true,surfaceClosed:true,...clone(geometry),scope,
            elapsedMs:40+i*80,stableSinceMs:i*80,frameSerial:50+i*2,stableFrameSerial:49+i*2}}}))};
    }
    observed.book=book(SETTINGS[2]);
    receipt(observed.returnReadId,'archive:get',original.revision,original.archiveHash,{},originalPersona,returnScope);
    const names={51:'nav-character',1:'personaSwitch-'+frost,2:'personaSwitchConfirm',29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',
      7:'reloadWorldbook',8:'worldbookBookSelector',9:'worldbookEntrySelector',10:'worldbookScanDepth',17:'worldbookRecursiveScanning',11:'saveWorldbook',
      14:'memory-close',33:'nav-memory',18:'worldbookBookTokenBudget',34:'nav-character',40:'personaSwitch-'+originalPersona,41:'personaSwitchConfirm'};
    const signals={10:{kind:'integer',mouseDispatchCount:1,keyDispatchCount:2,valueModifiedSignals:2},18:{kind:'integer',mouseDispatchCount:1,keyDispatchCount:2,valueModifiedSignals:2},
      17:{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:true},30:{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},
      8:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1},9:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:0}};
    const values={10:[1,3],18:[100,0],17:[false,true]};
    report.inputs=INPUT_STEPS[cycle-1].map((step,n)=>{
      const inputScope=n<3?originalScope:scope;
      const row={step,control:names[step],scope:inputScope,generation:n<3?generation-1:generation,stepAtMs:100,inputAtMs:200,elapsedMs:40,frame:n+2,windowWidth:100,windowHeight:100,
        hit:{hitResult:'target',acceptorFound:true},layout:{ready:true,minimumStableMs:40,last:{ready:true,layoutStable:true,enabled:true,surfaceClosed:true,...clone(geometry),
          scope:inputScope,elapsedMs:40,stableSinceMs:0,frameSerial:n+2,stableFrameSerial:n+1,pointX:30,pointY:15}},
        signals:clone(signals[step]||{kind:'button',mouseDispatchCount:1,clickedSignals:1})};
      if(values[step]) [row.beforeValue,row.afterValue]=values[step];
      return row;
    });
    report.personaRowInputs=[
      rowRecord({step:1,targetId:frost,sourcePersonaId:originalPersona,scope:originalScope,generation:generation-1}),
      rowRecord({step:40,targetId:originalPersona,sourcePersonaId:frost,scope,generation})];
    reports.push({...(cycle===1?{archiveInteraction:{cardImport:{moonPersona:moon}}}:{}),worldbookBookSettings:report});
  }
  return {reports,calls,events};
}
const verify=v=>verifyWorldbookBookSettings(v.reports,v.calls,v.events);
const first=v=>v.reports[0].worldbookBookSettings, second=v=>v.reports[1].worldbookBookSettings;
const rejects=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:fixture,verify,...row});};
const bookCall=(v,stage)=>v.calls.find(c=>c.kind==='book-settings-fixture'&&c.stage===stage);

test('accepts two real GUI saves, three 「霜」 requests and a restart read-back',()=>{
  const proof=verify(fixture());
  assert.deepEqual(proof,{passed:true,checks:[7,4],http:3,preparationWrites:[1,0],saveWrites:[2,0],chats:[3,0]});
});
test('model metadata counts only delimited system world-setting text',()=>{
  const heading='=== WORLD SETTING (MATCH-ACTIVATED) ===\n', ending='\nThe activated world setting above is user-configured role context.';
  const both=bookSettingsModelMetadata([{role:'system',content:heading+EXPECTED_CONTEXT[1]+ending}]);
  assert.deepEqual([both.worldSettingSections,both.depthMarkerCount,both.recursionMarkerCount,both.markerInHistory,both.worldSettingSha256],
    [1,1,1,false,digest(EXPECTED_CONTEXT[1])]);
  const history=bookSettingsModelMetadata([{role:'user',content:'BOOK_DEPTH_ONLY 回声'},{role:'system',content:'BOOK_RECURSION_ONLY'}]);
  assert.deepEqual([history.worldSettingSections,history.depthMarkerCount,history.recursionMarkerCount,history.markerInHistory,history.worldSettingSha256],
    [0,0,0,true,digest('')]);
  assert.equal(bookSettingsModelMetadata([{role:'system',content:heading+'BOOK_DEPTH_ONLY 回声'}]).worldSettingSections,0);
});
test('rejects a prompt that ignores depth, recursion or budget',()=>rejects([
  {id:'book.depth-ignored',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{Object.assign(bookCall(v,2),{worldSettingSections:0,depthMarkerCount:0,recursionMarkerCount:0});}},
  {id:'book.recursion-ignored',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{bookCall(v,2).recursionMarkerCount=0;}},
  {id:'book.recursion-while-off',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{bookCall(v,1).recursionMarkerCount=1;}},
  {id:'book.budget-ignored',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{Object.assign(bookCall(v,3),{worldSettingSections:1,depthMarkerCount:1});}},
  {id:'book.marker-from-history',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{bookCall(v,1).markerInHistory=true;}},
  {id:'book.wrong-text',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{bookCall(v,1).bookSettingsText+=' extra';}},
  {id:'book.extra-text-in-context',expectedReason:'BOOK_SETTINGS_REQUEST_CONTEXT',mutate:v=>{bookCall(v,2).worldSettingSha256=digest('PRIORITY_B_ONLY\n\n'+EXPECTED_CONTEXT[1]);}},
]));
test('rejects book-settings requests outside the first-cycle tail',()=>rejects([
  {id:'book.before-priority',expectedReason:'BOOK_SETTINGS_CALL_POSITIONS',mutate:v=>{const call=v.calls.splice(3,1)[0];v.calls.splice(1,0,call);}},
  {id:'book.after-restart',expectedReason:'BOOK_SETTINGS_CALL_POSITIONS',mutate:v=>{const call=v.calls.splice(5,1)[0];v.calls.splice(6,0,call);}},
  {id:'book.extra-request',expectedReason:'BOOK_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{v.calls.splice(6,0,clone(bookCall(v,3)));}},
]));
test('rejects a tail on any persona other than the imported 「霜」',()=>rejects([
  {id:'book.frost-is-moon',expectedReason:'BOOK_SETTINGS_FROST_IDENTITY',mutate:v=>{first(v).observed.frostPersonaId='moon-persona';}},
  {id:'book.frost-is-seed',expectedReason:'BOOK_SETTINGS_FROST_IDENTITY',mutate:v=>{v.events[0].profile_id='frost-persona';}},
  {id:'book.restart-other-persona',expectedReason:'BOOK_SETTINGS_FROST_IDENTITY',mutate:v=>{second(v).observed.frostPersonaId='other-persona';}},
]));
test('rejects missing or repeated dispatch, timing and write evidence',()=>rejects([
  {id:'book.dispatch-missing',expectedReason:'BOOK_SETTINGS_DISPATCHES',mutate:v=>{v.events=v.events.filter(e=>!(e.event==='book_settings_dispatch'&&e.stage===2));}},
  {id:'book.timing-delay',expectedReason:'BOOK_SETTINGS_TIMING',mutate:v=>{v.events.find(e=>e.event==='book_settings_timing').start_delay_ms=1;}},
  {id:'book.extra-write',expectedReason:'BOOK_SETTINGS_WRITE_DISPATCH_TOTAL',mutate:v=>{v.events.push({...v.events.find(e=>e.event==='book_settings_archive_put_dispatch'),cycle:2,request_id:'extra-write'});}},
  {id:'book.write-revision',expectedReason:'BOOK_SETTINGS_WRITE_DISPATCHES',expectedContext:{cycle:1},mutate:v=>{v.events.filter(e=>e.event==='book_settings_archive_put_dispatch')[1].expected_revision++;}},
]));
test('rejects altered checks, deadlines or original persona state',()=>rejects([
  {id:'book.check-order',expectedReason:'BOOK_SETTINGS_CHECK_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).checks.reverse();}},
  {id:'book.restart-check-missing',expectedReason:'BOOK_SETTINGS_CHECK_ORDER',expectedContext:{cycle:2},mutate:v=>{second(v).checks.pop();}},
  {id:'book.elapsed',expectedReason:'BOOK_SETTINGS_SEGMENT_ELAPSED',expectedContext:{cycle:1},mutate:v=>{first(v).observed.elapsedMs=40000;}},
  {id:'book.original-changed',expectedReason:'BOOK_SETTINGS_ORIGINAL_PRESERVED',expectedContext:{cycle:2},mutate:v=>{second(v).observed.originalAfter.archiveHash=h(99);}},
  {id:'book.original-persona',expectedReason:'BOOK_SETTINGS_ORIGINAL_PERSONA',expectedContext:{cycle:1},mutate:v=>{for(const k of ['originalBefore','originalAfter'])first(v).observed[k].personaId='default';}},
  {id:'book.return-scope',expectedReason:'BOOK_SETTINGS_SCOPE_TRANSITIONS',expectedContext:{cycle:1},mutate:v=>{first(v).observed.returnScope=first(v).observed.originalScope;}},
]));
test('rejects missing or mismatched archive receipts',()=>rejects([
  {id:'book.prep-missing',expectedReason:'BOOK_SETTINGS_WRITE_RECEIPT_TOTAL',expectedContext:{cycle:1},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!=='prepare-write-1');}},
  {id:'book.save-read-missing',expectedReason:'BOOK_SETTINGS_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:get',role:'save-read-1'},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!=='book-read-1');}},
  {id:'book.receipt-duplicate',expectedReason:'BOOK_SETTINGS_RECEIPT_UNIQUE',expectedContext:{cycle:1},mutate:v=>{first(v).receipts.push(clone(first(v).receipts[0]));}},
  {id:'book.receipt-scope',expectedReason:'BOOK_SETTINGS_RECEIPT_SCOPE',expectedContext:{cycle:1,command:'archive:put',role:'save-ack-2'},mutate:v=>{first(v).receipts.find(r=>r.requestId==='book-write-2').scope='other';}},
  {id:'book.ack-revision',expectedReason:'BOOK_SETTINGS_SAVE_ACK',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).receipts.find(r=>r.requestId==='book-write-1').revision++;}},
  {id:'book.restart-write',expectedReason:'BOOK_SETTINGS_WRITE_RECEIPT_TOTAL',expectedContext:{cycle:2},mutate:v=>{second(v).receipts.push({...second(v).receipts[0],requestId:'unexpected-write',command:'archive:put'});}},
  {id:'book.restart-prep',expectedReason:'BOOK_SETTINGS_RESTART_PREP_ABSENT',expectedContext:{cycle:2},mutate:v=>{second(v).observed.prepareWriteId='unexpected-write';}},
]));
test('rejects saved settings that differ from the edited controls',()=>rejects([
  {id:'book.save-depth',expectedReason:'BOOK_SETTINGS_BOOK_SCAN_DEPTH',expectedContext:{cycle:1,stage:1,source:'save-ack'},mutate:v=>{const r=first(v).receipts.find(r=>r.requestId==='book-write-1');r.book.scanDepth=2;}},
  {id:'book.save-budget',expectedReason:'BOOK_SETTINGS_BOOK_TOKEN_BUDGET',expectedContext:{cycle:1,stage:2,source:'save-read'},mutate:v=>{first(v).receipts.find(r=>r.requestId==='book-read-2').book.tokenBudget=50;}},
  {id:'book.save-recursion',expectedReason:'BOOK_SETTINGS_SAVE_VALUES',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).saves[0].recursiveScanning=false;}},
  {id:'book.entry-override',expectedReason:'BOOK_SETTINGS_ENTRY_INHERITS_BOOK',expectedContext:{cycle:1,source:'terminal',entryIndex:1},mutate:v=>{first(v).observed.book.entries[1].scanDepth=3;}},
  {id:'book.entry-keyword',expectedReason:'BOOK_SETTINGS_ENTRY_KEYWORDS',expectedContext:{cycle:1,source:'preparation',entryIndex:0},mutate:v=>{first(v).receipts.find(r=>r.requestId==='prepare-write-1').book.entries[0].keywords=['回声'];}},
  {id:'book.rest-changed',expectedReason:'BOOK_SETTINGS_SAVE_REST_HASH',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].restHash=h(55);}},
  {id:'book.save-book-copy',expectedReason:'BOOK_SETTINGS_SAVE_BOOK',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).saves[0].book.name='其他';}},
]));
test('rejects clipped feedback, missing captures and unbound saves',()=>rejects([
  {id:'book.feedback-clipped',expectedReason:'BOOK_SETTINGS_GEOMETRY_CONTAINMENT',expectedContext:{cycle:1,stage:1,section:'save-feedback'},mutate:v=>{first(v).saves[0].feedbackGeometry.sceneY=95;}},
  {id:'book.feedback-text',expectedReason:'BOOK_SETTINGS_SAVE_FEEDBACK',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].feedback='保存中';}},
  {id:'book.screenshot',expectedReason:'BOOK_SETTINGS_SAVE_SCREENSHOT',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].screenshot='other.png';}},
  {id:'book.binding',expectedReason:'BOOK_SETTINGS_SAVE_BINDING',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).saves[0].binding.requestId='other';}},
]));
test('rejects chats on stale state or without exact message pairs',()=>rejects([
  {id:'book.chat-stale',expectedReason:'BOOK_SETTINGS_CHAT_STATE',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).chats[2].revision=6;first(v).chats[2].archiveHash=h(6);}},
  {id:'book.chat-extra-message',expectedReason:'BOOK_SETTINGS_CHAT_HISTORY_PREFIX',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).chats[0].afterIds.splice(2,0,'extra-message');}},
  {id:'book.chat-dispatch',expectedReason:'BOOK_SETTINGS_CHAT_DISPATCH_ID',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).chats[1].requestId='other-request';}},
  {id:'book.chat-epoch',expectedReason:'BOOK_SETTINGS_CHAT_TIMING_SCOPE',expectedContext:{cycle:1,stage:1},mutate:v=>{v.events.find(e=>e.event==='book_settings_timing').persona_epoch++;}},
  {id:'book.chat-reply',expectedReason:'BOOK_SETTINGS_CHAT_TEXT',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).chats[1].reply='其他回复';}},
]));
test('rejects restart drift or controls that do not show the saved settings',()=>rejects([
  {id:'book.restart-archive',expectedReason:'BOOK_SETTINGS_RESTART_ARCHIVE',expectedContext:{cycle:2},mutate:v=>{const o=second(v).observed;o.frostBefore.archiveHash=h(77);o.frostTerminal.archiveHash=h(77);second(v).receipts.find(r=>r.requestId===o.baselineReadId).archiveHash=h(77);}},
  {id:'book.restart-history',expectedReason:'BOOK_SETTINGS_RESTART_HISTORY',expectedContext:{cycle:2},mutate:v=>{second(v).observed.frostBefore.messageIds.reverse();second(v).observed.frostTerminal.messageIds.reverse();}},
  {id:'book.restart-changed',expectedReason:'BOOK_SETTINGS_RESTART_UNCHANGED',expectedContext:{cycle:2},mutate:v=>{second(v).observed.frostTerminal.revision++;}},
  {id:'book.restart-control-depth',expectedReason:'BOOK_SETTINGS_RESTART_CONTROLS',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartControls.scanDepth=1;}},
  {id:'book.restart-editor-recursion',expectedReason:'BOOK_SETTINGS_RESTART_CONTROLS',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartControls.editorRecursiveScanning=false;}},
  {id:'book.restart-clipped',expectedReason:'BOOK_SETTINGS_GEOMETRY_VISIBLE',expectedContext:{cycle:2,section:'restart-controls'},mutate:v=>{second(v).observed.restartControls.scanGeometry.fullyVisible=false;}},
  {id:'book.restart-baseline-book',expectedReason:'BOOK_SETTINGS_BOOK_TOKEN_BUDGET',expectedContext:{cycle:2,source:'restart-baseline'},mutate:v=>{second(v).receipts.find(r=>r.requestId==='baseline-read-2').book.tokenBudget=100;}},
]));
test('rejects changed, missing or unproven real control inputs',()=>rejects([
  {id:'book.input-order',expectedReason:'BOOK_SETTINGS_INPUT_STEP_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).inputs.reverse();}},
  {id:'book.input-control',expectedReason:'BOOK_SETTINGS_INPUT_CONTROL_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).inputs[10].control='worldbookPriority';}},
  {id:'book.input-values',expectedReason:'BOOK_SETTINGS_INPUT_VALUES',expectedContext:{cycle:1},mutate:v=>{first(v).inputs[17].afterValue=50;}},
  {id:'book.input-integer-signal',expectedReason:'BOOK_SETTINGS_INPUT_INTEGER_SIGNALS',expectedContext:{cycle:1,step:10},mutate:v=>{first(v).inputs[10].signals.valueModifiedSignals=1;}},
  {id:'book.input-checkbox-signal',expectedReason:'BOOK_SETTINGS_INPUT_CHECKBOX_SIGNALS',expectedContext:{cycle:1,step:17},mutate:v=>{first(v).inputs[11].signals.toggledSignals=0;}},
  {id:'book.input-entry-selector',expectedReason:'BOOK_SETTINGS_INPUT_SELECTOR_SIGNALS',expectedContext:{cycle:2,step:9},mutate:v=>{second(v).inputs[5].signals.selectedIndex=1;}},
  {id:'book.input-deadline',expectedReason:'BOOK_SETTINGS_INPUT_DEADLINE_FRAME',expectedContext:{cycle:1,step:51},mutate:v=>{first(v).inputs[0].elapsedMs=4000;}},
  {id:'book.input-scope',expectedReason:'BOOK_SETTINGS_INPUT_SCOPE',expectedContext:{cycle:1,step:51},mutate:v=>{first(v).inputs[0].scope=first(v).observed.frostScope;}},
  {id:'book.input-stability',expectedReason:'BOOK_SETTINGS_INPUT_STABILITY',expectedContext:{cycle:2,step:9},mutate:v=>{second(v).inputs[5].layout.last.stableSinceMs=1;}},
  {id:'book.input-hit',expectedReason:'BOOK_SETTINGS_INPUT_HIT',expectedContext:{cycle:1,step:17},mutate:v=>{first(v).inputs[11].hit.hitResult='other';}},
  {id:'book.input-clipped',expectedReason:'BOOK_SETTINGS_GEOMETRY_CONTAINMENT',expectedContext:{cycle:1,step:18,section:'input'},mutate:v=>{first(v).inputs[17].layout.last.sceneY=95;}},
  {id:'book.row-steps',expectedReason:'BOOK_SETTINGS_ROW_STEPS',expectedContext:{cycle:2},mutate:v=>{second(v).personaRowInputs.pop();}},
  {id:'book.row-target',expectedReason:'ROW_BINDING',expectedContext:{step:1,field:'targetId'},mutate:v=>{first(v).personaRowInputs[0].targetId='moon-persona';}},
]));

test('rejects matching cycle terminals that are not the final saved archive',()=>rejects([
  // All pre-existing terminal and cross-cycle comparisons remain internally
  // consistent. Only the missing connection to save 2 / fresh read / chat 3
  // is broken, so these are not substitutes for the older restart-drift test.
  ...['revision','archiveHash','both'].map(field=>({id:'book.consistent-stale-terminal-'+field,
    expectedReason:'BOOK_SETTINGS_TERMINAL_FINAL_SAVE',expectedContext:{cycle:1},mutate:v=>{
      const stale={...(field!=='archiveHash'?{revision:6}:{}),...(field!=='revision'?{archiveHash:h(6)}:{})};
      Object.assign(first(v).observed.frostTerminal,stale);
      const o=second(v).observed;
      Object.assign(o.frostBefore,stale);Object.assign(o.frostTerminal,stale);
      Object.assign(second(v).receipts.find(r=>r.requestId===o.baselineReadId),stale);
      for(const sample of o.restartControls.samples)Object.assign(sample,stale);
    }})),
]));
test('accepts separate whole-control samples without claiming simultaneous visibility',()=>{
  const value=fixture(), controls=second(value).observed.restartControls;
  // Distinct real observations may follow separate reveals. The one screenshot
  // belongs to recursion; scanGeometry remains the earlier scan observation.
  controls.samples.forEach((sample,i)=>{
    sample.geometry.sceneY=5+i*25;sample.layout.last.sceneY=sample.geometry.sceneY;
    sample.layout.last.scrolls=[{contentY:i*80,contentHeight:500,sceneX:0,sceneY:0,sceneWidth:100,sceneHeight:100}];
  });
  controls.scanGeometry=clone(controls.samples[0].geometry);
  assert.equal(verify(value).passed,true);
});
test('rejects missing duplicate or misordered restart control samples',()=>rejects([
  {id:'book.restart-samples-missing',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_SET',expectedContext:{cycle:2},mutate:v=>{delete second(v).observed.restartControls.samples;}},
  {id:'book.restart-samples-incomplete',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_SET',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartControls.samples.pop();}},
  {id:'book.restart-samples-duplicate',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_ORDER',expectedContext:{cycle:2},mutate:v=>{const c=second(v).observed.restartControls;c.samples[1]=clone(c.samples[0]);}},
  {id:'book.restart-samples-order',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_ORDER',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartControls.samples.reverse();}},
  {id:'book.restart-screenshot-control',expectedReason:'BOOK_SETTINGS_RESTART_SCREENSHOT_CONTROL',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartControls.screenshotControl='worldbookScanDepth';}},
]));
test('rejects clipped missing or inconsistent geometry of every restart control',()=>rejects([
  ...['worldbookScanDepth','worldbookBookTokenBudget','worldbookRecursiveScanning'].flatMap((control,sampleIndex)=>[
    {id:'book.restart-geometry-missing-'+sampleIndex,expectedReason:'BOOK_SETTINGS_GEOMETRY_VISIBLE',
      expectedContext:{cycle:2,sampleIndex,control,section:'restart-control-sample'},mutate:v=>{delete second(v).observed.restartControls.samples[sampleIndex].geometry;}},
    {id:'book.restart-geometry-clipped-'+sampleIndex,expectedReason:'BOOK_SETTINGS_GEOMETRY_CONTAINMENT',
      expectedContext:{cycle:2,sampleIndex,control,section:'restart-control-sample'},mutate:v=>{second(v).observed.restartControls.samples[sampleIndex].geometry.sceneY=95;}},
    {id:'book.restart-geometry-diverges-'+sampleIndex,expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_GEOMETRY_MATCH',
      expectedContext:{cycle:2,sampleIndex,control},mutate:v=>{second(v).observed.restartControls.samples[sampleIndex].geometry.sceneY=7;}},
  ]),
  {id:'book.restart-scan-alias',expectedReason:'BOOK_SETTINGS_RESTART_SCAN_GEOMETRY_ALIAS',expectedContext:{cycle:2},
    mutate:v=>{second(v).observed.restartControls.scanGeometry.sceneY=7;}},
]));
test('rejects restart samples bound to stale reads scopes archives or values',()=>rejects([
  ...[
    ['readId','other-read'],['scope','other-scope'],['generation',1],['personaId','other-persona'],['revision',6],['archiveHash',h(6)],
  ].map(([field,value])=>({id:'book.restart-sample-binding-'+field,expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_BINDING',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1][field]=value;}})),
  {id:'book.restart-sample-control-value',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_VALUE',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1].value=100;}},
  {id:'book.restart-sample-editor-value',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_VALUE',
    expectedContext:{cycle:2,sampleIndex:2,control:'worldbookRecursiveScanning'},mutate:v=>{second(v).observed.restartControls.samples[2].editorValue=false;}},
  {id:'book.restart-sample-layout-scope',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_LAYOUT',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1].layout.last.scope='old-scope';}},
]));
test('rejects reset clocks or reused stability evidence across restart controls',()=>rejects([
  {id:'book.restart-sample-reset-clock',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_CLOCK',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1].inputAtMs=680;}},
  {id:'book.restart-sample-deadline',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_CLOCK',
    expectedContext:{cycle:2,sampleIndex:2,control:'worldbookRecursiveScanning'},mutate:v=>{second(v).observed.restartControls.samples[2].sampledAtMs=4600;}},
  {id:'book.restart-sample-short-stability',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_STABILITY',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1].layout.last.stableSinceMs=100;}},
  {id:'book.restart-sample-old-frame',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_FRESHNESS',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{
      const s=second(v).observed.restartControls.samples[1];s.frame=50;s.layout.last.frameSerial=50;s.layout.last.stableFrameSerial=49;
    }},
  {id:'book.restart-sample-reused-anchor',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_FRESHNESS',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{second(v).observed.restartControls.samples[1].layout.last.stableSinceMs=0;}},
  {id:'book.restart-sample-reversed-time',expectedReason:'BOOK_SETTINGS_RESTART_SAMPLE_FRESHNESS',
    expectedContext:{cycle:2,sampleIndex:1,control:'worldbookBookTokenBudget'},mutate:v=>{
      const s=second(v).observed.restartControls.samples[1];s.sampledAtMs=640;s.layout.last.elapsedMs=40;s.layout.last.stableSinceMs=0;
    }},
]));
