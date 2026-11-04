'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {ENTRY_SETTINGS_TEXTS,ENTRY_SETTINGS_REPLY,ENTRY_SETTINGS_BOOK_ID,DEPTH_MARKER,BUDGET_MARKER,SETTINGS,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,
  RESTART_SAMPLES,entrySettingsModelMetadata,verifyWorldbookEntrySettings}=require('./worldbook-entry-settings-verdicts.cjs');
const clone=v=>JSON.parse(JSON.stringify(v)), h=n=>n.toString(16).padStart(64,'0');
const ENTRY_A='p1_entry_settings_depth', ENTRY_B='p1_entry_settings_budget';
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100};
function book(settings) {
  return {id:ENTRY_SETTINGS_BOOK_ID,name:'条目设置验收资料',scanDepth:1,tokenBudget:100,recursiveScanning:false,
    entries:[0,1].map(i=>({id:i?ENTRY_B:ENTRY_A,content:i?BUDGET_MARKER:DEPTH_MARKER,keywords:[i?'预算灯':'远灯'],insertionOrder:i?40:30,priority:1000,
      enabled:true,alwaysActive:false,useRegex:false,scanDepth:settings[i*2],tokenBudget:settings[i*2+1]}))};
}
const layout=(scope,elapsedMs,stableSinceMs,frame)=>({ready:true,minimumStableMs:40,last:{ready:true,layoutStable:true,enabled:true,surfaceClosed:true,
  ...clone(geometry),scope,elapsedMs,stableSinceMs,frameSerial:frame,stableFrameSerial:frame-1,pointX:30,pointY:15}});
const CONTROL={29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',
  10:'worldbookEntryScanDepthInherit',17:'worldbookEntryScanDepth',11:'saveWorldbook',9:'worldbookEntrySelector',18:'worldbookEntryTokenBudgetInherit',
  19:'worldbookEntryTokenBudget',14:'memory-close',33:'nav-memory',34:'worldbookEntrySelector',35:'worldbookEntryScanDepthInherit',21:'worldbookEntrySelector'};
function fixture() {
  const served='builtin_default_persona', fingerprint=h(70), rest=h(50), otherBooks=2;
  const calls=[...['probe','chat','reading-fixture','reading-fixture','stop-fixture','combined-fixture'].map(kind=>({kind,cycle:1})),
    ...[1,2,3].map(stage=>({kind:'entry-settings-fixture',cycle:1,stage,entrySettingsText:ENTRY_SETTINGS_TEXTS[stage-1],
      worldSettingSections:stage<3?1:0,depthMarkerCount:stage<3?1:0,budgetMarkerCount:stage===1?1:0,markerInHistory:false,worldSettingSha256:h(stage)})),
    {kind:'probe',cycle:2}];
  const events=[{event:'bootstrap_started',cycle:1},{event:'bootstrap_started',cycle:2}];
  const reports=[]; let terminalIds;
  for(let cycle=1;cycle<=2;cycle++) {
    const verify=cycle===2, epoch=cycle*4+1, scope=`${served}:${epoch}:${fingerprint}`, generation=cycle*10;
    const observed={scope,restHash:rest,elapsedMs:9000,baselineReadId:`baseline-read-${cycle}`,putCount:verify?0:4};
    const report={passed:true,error:'',mode:verify?'restart-readback':'change-and-effect',deadlineMs:verify?20000:45000,
      checks:(verify?RESTART_CHECKS:FIRST_CHECKS).map(name=>({name,passed:true})),observed,receipts:[],saves:[],chats:[],inputs:[],samples:[]};
    const receipt=(requestId,command,revision,value)=>{
      const r={requestId,command,generation,scope,personaId:'default',ok:true,exists:true,revision,archiveHash:h(revision),restHash:rest,book:value};
      report.receipts.push(r); return r;
    };
    const dispatchScope={persona_id:served,persona_epoch:epoch,persona_fingerprint:fingerprint};
    if(!verify) {
      const ids=['message-0','message-1'];
      Object.assign(observed,{baselineRevision:20,baselineArchiveHash:h(20),baselineMessageIds:ids.slice(),otherBookCount:otherBooks,
        prepareWriteId:'prepare-write-1',prepareReadId:'prepare-read-1',preparedExpectedRevision:20,preparedRevision:21});
      receipt(observed.baselineReadId,'archive:get',20,{});
      receipt(observed.prepareWriteId,'archive:put',21,book(SETTINGS[0])); receipt(observed.prepareReadId,'archive:get',21,book(SETTINGS[0]));
      // The editor's own reload is an ordinary extra receipt of the same scope.
      receipt('editor-reload-1','archive:get',21,book(SETTINGS[0]));
      events.push({event:'entry_settings_archive_put_dispatch',cycle:1,request_id:observed.prepareWriteId,expected_revision:20,...dispatchScope});
      const states=[21];
      for(let n=0;n<3;n++) {
        const revision=22+n, writeId=`entry-write-${n+1}`;
        const save={stage:n+1,writeId,readId:`entry-read-${n+1}`,scope,generation,personaId:'default',expectedRevision:revision-1,revision,
          entryId:[ENTRY_A,ENTRY_B,ENTRY_A][n],settings:clone(SETTINGS[n+1]),archiveHash:h(revision),restHash:rest,book:book(SETTINGS[n+1]),
          feedback:'已保存 · 下一轮聊天使用新 revision',binding:{armed:true,status:'matched',failureReason:'',scope,generation,requestId:writeId,baselineCount:n+1},
          readAtMs:1000+n*1000,feedbackInputAtMs:1100+n*1000,feedbackGeometry:clone(geometry),windowWidth:100,windowHeight:100,
          screenshot:`cycle-1.json.worldbook-entry-settings-save-${n+1}.png`};
        report.saves.push(save); receipt(writeId,'archive:put',revision,book(SETTINGS[n+1])); receipt(save.readId,'archive:get',revision,book(SETTINGS[n+1]));
        events.push({event:'entry_settings_archive_put_dispatch',cycle:1,request_id:writeId,expected_revision:revision-1,...dispatchScope});
        states.push(revision);
      }
      for(const stage of [1,2,3]) {
        const requestId=`entry-chat-request-${stage}`, userId=`entry-user-${stage}`, assistantId=`entry-assistant-${stage}`, state=states[[0,2,3][stage-1]];
        const beforeIds=ids.slice(); ids.push(userId,assistantId);
        report.chats.push({stage,requestId,scope,generation,personaId:'default',beforeIds,afterIds:ids.slice(),userId,assistantId,
          text:ENTRY_SETTINGS_TEXTS[stage-1],reply:ENTRY_SETTINGS_REPLY,revision:state,archiveHash:h(state)});
        events.push({event:'entry_settings_timing',cycle:1,stage,start_delay_ms:0,delivery_delay_ms:100},
          {event:'entry_settings_dispatch',cycle:1,stage,request_id:requestId,...dispatchScope});
      }
      terminalIds=ids.slice();
      Object.assign(observed,{terminalRevision:24,terminalArchiveHash:h(24),terminalMessageIds:ids.slice(),book:book(SETTINGS[3])});
    } else {
      Object.assign(observed,{restartReadId:observed.baselineReadId,baselineRevision:24,baselineArchiveHash:h(24),baselineMessageIds:terminalIds.slice(),
        finalReadId:'final-read-2',terminalRevision:24,terminalArchiveHash:h(24),terminalMessageIds:terminalIds.slice(),
        restartScreenshot:'cycle-2.json.worldbook-entry-settings-restart.png',restartScreenshotControl:'worldbookEntryTokenBudget'});
      receipt(observed.baselineReadId,'archive:get',24,book(SETTINGS[3])); receipt('editor-reload-2','archive:get',24,book(SETTINGS[3]));
      receipt(observed.finalReadId,'archive:get',24,book(SETTINGS[3]));
      report.samples=RESTART_SAMPLES.map(([step,entryId,control,value,inherited],i)=>{
        const second=i%2===1, stepAtMs=step===20?500:1500, inputAtMs=stepAtMs+100, sampledAtMs=inputAtMs+(second?120:40), frame=(step===20?50:60)+(second?2:0);
        return {control,step,entryId,value,inherited,scope,generation,personaId:'default',revision:24,archiveHash:h(24),stepAtMs,inputAtMs,sampledAtMs,frame,
          layout:layout(scope,second?120:40,second?80:0,frame),geometry:clone(geometry),windowWidth:100,windowHeight:100};
      });
    }
    const signals={17:{kind:'integer',mouseDispatchCount:1,keyDispatchCount:4,valueModifiedSignals:4},19:{kind:'integer',mouseDispatchCount:1,keyDispatchCount:1,valueModifiedSignals:1},
      10:{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:false},18:{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:false},
      35:{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:true},30:{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},
      8:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:otherBooks+1},9:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:2},
      34:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1},21:{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:2}};
    const values={10:[true,false],17:[1,5],18:[true,false],19:[100,50],35:[false,true]};
    const entries={8:ENTRY_A,10:ENTRY_A,17:ENTRY_A,9:ENTRY_B,18:ENTRY_B,19:ENTRY_B,34:ENTRY_A,35:ENTRY_A,21:ENTRY_B};
    report.inputs=INPUT_STEPS[cycle-1].map((step,n)=>{
      const row={step,control:CONTROL[step],scope,generation,stepAtMs:100,inputAtMs:200,elapsedMs:40,frame:n+2,windowWidth:100,windowHeight:100,
        selectedEntryId:entries[step]||ENTRY_A,hit:{hitResult:'target',acceptorFound:true},layout:layout(scope,40,0,n+2),
        signals:clone(signals[step]||{kind:'button',mouseDispatchCount:1,clickedSignals:1})};
      if(values[step]) [row.beforeValue,row.afterValue]=values[step];
      return row;
    });
    reports.push({worldbookEntrySettings:report});
  }
  return {reports,calls,events};
}
const verify=v=>verifyWorldbookEntrySettings(v.reports,v.calls,v.events);
const first=v=>v.reports[0].worldbookEntrySettings, second=v=>v.reports[1].worldbookEntrySettings;
const rejects=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:fixture,verify,...row});};
const entryCall=(v,stage)=>v.calls.find(c=>c.kind==='entry-settings-fixture'&&c.stage===stage);
const receiptOf=(report,id)=>report.receipts.find(r=>r.requestId===id);

test('accepts three real saves, three default-persona requests and a restart read-back',()=>{
  assert.deepEqual(verify(fixture()),{passed:true,checks:[9,4],http:3,preparationWrites:[1,0],saveWrites:[3,0],chats:[3,0]});
});
test('model metadata counts only the fixture markers inside delimited system world-setting text',()=>{
  const heading='=== WORLD SETTING (MATCH-ACTIVATED) ===\n', ending='\nThe activated world setting above is user-configured role context.';
  const both=entrySettingsModelMetadata([{role:'system',content:heading+DEPTH_MARKER+'\n\n'+BUDGET_MARKER+ending}]);
  assert.deepEqual([both.worldSettingSections,both.depthMarkerCount,both.budgetMarkerCount,both.markerInHistory],[1,1,1,false]);
  // Another book of the default archive may share the section.
  const other=entrySettingsModelMetadata([{role:'system',content:heading+'我们的观星暗号是青绿色的流星。\n\n'+DEPTH_MARKER+ending}]);
  assert.deepEqual([other.worldSettingSections,other.depthMarkerCount,other.budgetMarkerCount,other.markerInHistory],[1,1,0,false]);
  const history=entrySettingsModelMetadata([{role:'user',content:DEPTH_MARKER},{role:'system',content:BUDGET_MARKER}]);
  assert.deepEqual([history.worldSettingSections,history.depthMarkerCount,history.budgetMarkerCount,history.markerInHistory],[0,0,0,true]);
  assert.equal(entrySettingsModelMetadata([{role:'system',content:heading+DEPTH_MARKER}]).worldSettingSections,0);
  assert.equal(BUDGET_MARKER.length,101); assert.equal(DEPTH_MARKER.length,16);
});
test('rejects a prompt that ignores entry depth, entry budget or the return to the book',()=>rejects([
  {id:'entry.first-chat-missing-b',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,1).budgetMarkerCount=0;}},
  {id:'entry.depth-ignored',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,2).depthMarkerCount=0;}},
  {id:'entry.budget-ignored',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,2).budgetMarkerCount=1;}},
  {id:'entry.inheritance-ignored',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,3).depthMarkerCount=1;}},
  {id:'entry.marker-from-history',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,1).markerInHistory=true;}},
  {id:'entry.wrong-text',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{entryCall(v,1).entrySettingsText+=' extra';}},
  {id:'entry.extra-request',expectedReason:'ENTRY_SETTINGS_REQUEST_SIGNATURE',mutate:v=>{v.calls.splice(9,0,clone(entryCall(v,3)));}},
]));
test('rejects entry-settings requests outside the first-cycle tail',()=>rejects([
  {id:'entry.before-ordinary',expectedReason:'ENTRY_SETTINGS_CALL_POSITIONS',mutate:v=>{const call=v.calls.splice(6,1)[0];v.calls.splice(1,0,call);}},
  {id:'entry.after-restart',expectedReason:'ENTRY_SETTINGS_CALL_POSITIONS',mutate:v=>{const call=v.calls.splice(8,1)[0];v.calls.splice(9,0,call);}},
  {id:'entry.call-without-cycle',expectedReason:'ENTRY_SETTINGS_CALL_POSITIONS',mutate:v=>{delete v.calls[0].cycle;}},
]));
test('rejects missing, repeated or foreign dispatch, timing and write evidence',()=>rejects([
  {id:'entry.bootstrap-repeated',expectedReason:'ENTRY_SETTINGS_BOOTSTRAPS',mutate:v=>{v.events.push({event:'bootstrap_started',cycle:2});}},
  {id:'entry.dispatch-missing',expectedReason:'ENTRY_SETTINGS_DISPATCHES',mutate:v=>{v.events=v.events.filter(e=>!(e.event==='entry_settings_dispatch'&&e.stage===2));}},
  {id:'entry.dispatch-persona',expectedReason:'ENTRY_SETTINGS_DISPATCHES',mutate:v=>{v.events.find(e=>e.event==='entry_settings_dispatch').persona_id='other_persona';}},
  {id:'entry.timing-delay',expectedReason:'ENTRY_SETTINGS_TIMING',mutate:v=>{v.events.find(e=>e.event==='entry_settings_timing').start_delay_ms=1;}},
  {id:'entry.restart-write',expectedReason:'ENTRY_SETTINGS_WRITE_DISPATCH_TOTAL',mutate:v=>{v.events.push({...v.events.find(e=>e.event==='entry_settings_archive_put_dispatch'),cycle:2,request_id:'extra-write'});}},
  {id:'entry.write-revision',expectedReason:'ENTRY_SETTINGS_WRITE_DISPATCHES',expectedContext:{cycle:1},mutate:v=>{v.events.filter(e=>e.event==='entry_settings_archive_put_dispatch')[1].expected_revision++;}},
]));
test('rejects altered checks, deadlines or another served persona',()=>rejects([
  {id:'entry.check-order',expectedReason:'ENTRY_SETTINGS_CHECK_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).checks.reverse();}},
  {id:'entry.restart-check-missing',expectedReason:'ENTRY_SETTINGS_CHECK_ORDER',expectedContext:{cycle:2},mutate:v=>{second(v).checks.pop();}},
  {id:'entry.elapsed',expectedReason:'ENTRY_SETTINGS_SEGMENT_ELAPSED',expectedContext:{cycle:1},mutate:v=>{first(v).observed.elapsedMs=45000;}},
  {id:'entry.deadline',expectedReason:'ENTRY_SETTINGS_DEADLINE',expectedContext:{cycle:1},mutate:v=>{first(v).deadlineMs=40000;}},
  {id:'entry.restart-persona',expectedReason:'ENTRY_SETTINGS_SERVED_PERSONA',expectedContext:{cycle:2},mutate:v=>{second(v).observed.scope=`other_persona:9:${h(70)}`;}},
]));
test('rejects missing or mismatched archive receipts',()=>rejects([
  {id:'entry.prep-missing',expectedReason:'ENTRY_SETTINGS_WRITE_RECEIPT_TOTAL',expectedContext:{cycle:1},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!=='prepare-write-1');}},
  {id:'entry.save-read-missing',expectedReason:'ENTRY_SETTINGS_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:get',role:'save-read-1'},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!=='entry-read-1');}},
  {id:'entry.receipt-duplicate',expectedReason:'ENTRY_SETTINGS_RECEIPT_UNIQUE',expectedContext:{cycle:1},mutate:v=>{first(v).receipts.push(clone(first(v).receipts[0]));}},
  {id:'entry.receipt-generation',expectedReason:'ENTRY_SETTINGS_RECEIPT_GENERATION',expectedContext:{cycle:1},mutate:v=>{receiptOf(first(v),'editor-reload-1').generation=99;}},
  {id:'entry.receipt-rest',expectedReason:'ENTRY_SETTINGS_RECEIPT_REST',expectedContext:{cycle:1,command:'archive:put',role:'save-ack-2'},mutate:v=>{receiptOf(first(v),'entry-write-2').restHash=h(55);}},
  {id:'entry.ack-revision',expectedReason:'ENTRY_SETTINGS_SAVE_ACK',expectedContext:{cycle:1,stage:1},mutate:v=>{receiptOf(first(v),'entry-write-1').revision++;}},
  {id:'entry.restart-write-receipt',expectedReason:'ENTRY_SETTINGS_WRITE_RECEIPT_TOTAL',expectedContext:{cycle:2},mutate:v=>{second(v).receipts.push({...second(v).receipts[0],requestId:'unexpected-write',command:'archive:put'});}},
  {id:'entry.restart-prep',expectedReason:'ENTRY_SETTINGS_RESTART_PREP_ABSENT',expectedContext:{cycle:2},mutate:v=>{second(v).observed.prepareWriteId='unexpected-write';}},
]));
test('rejects saved entry settings that differ from the edited controls',()=>rejects([
  {id:'entry.ack-a-depth',expectedReason:'ENTRY_SETTINGS_ENTRY_VALUES',expectedContext:{cycle:1,stage:1,source:'save-ack',entryIndex:0},mutate:v=>{receiptOf(first(v),'entry-write-1').book.entries[0].scanDepth=4;}},
  {id:'entry.read-b-budget-null',expectedReason:'ENTRY_SETTINGS_ENTRY_VALUES',expectedContext:{cycle:1,stage:2,source:'save-read',entryIndex:1},mutate:v=>{receiptOf(first(v),'entry-read-2').book.entries[1].tokenBudget=null;}},
  {id:'entry.read-null-became-missing',expectedReason:'ENTRY_SETTINGS_ENTRY_VALUES',expectedContext:{cycle:1,stage:3,source:'save-read',entryIndex:0},mutate:v=>{delete receiptOf(first(v),'entry-read-3').book.entries[0].scanDepth;}},
  {id:'entry.read-null-became-zero',expectedReason:'ENTRY_SETTINGS_ENTRY_VALUES',expectedContext:{cycle:1,stage:3,source:'save-ack',entryIndex:0},mutate:v=>{receiptOf(first(v),'entry-write-3').book.entries[0].scanDepth=0;}},
  {id:'entry.save-settings',expectedReason:'ENTRY_SETTINGS_SAVE_VALUES',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].settings[3]=100;}},
  {id:'entry.save-entry',expectedReason:'ENTRY_SETTINGS_SAVE_VALUES',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).saves[2].entryId=ENTRY_B;}},
  {id:'entry.book-settings',expectedReason:'ENTRY_SETTINGS_BOOK_SETTINGS',expectedContext:{cycle:1,source:'preparation'},mutate:v=>{receiptOf(first(v),'prepare-write-1').book.scanDepth=2;}},
  {id:'entry.priority-lowered',expectedReason:'ENTRY_SETTINGS_ENTRY_ORDER',expectedContext:{cycle:1,source:'terminal',entryIndex:1},mutate:v=>{first(v).observed.book.entries[1].priority=0;}},
  {id:'entry.save-book-copy',expectedReason:'ENTRY_SETTINGS_SAVE_BOOK',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).saves[0].book.name='其他';}},
  {id:'entry.save-rest',expectedReason:'ENTRY_SETTINGS_SAVE_REST_HASH',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].restHash=h(55);}},
]));
test('rejects clipped feedback, missing captures and unbound saves',()=>rejects([
  {id:'entry.feedback-clipped',expectedReason:'ENTRY_SETTINGS_GEOMETRY_CONTAINMENT',expectedContext:{cycle:1,stage:1,section:'save-feedback'},mutate:v=>{first(v).saves[0].feedbackGeometry.sceneY=95;}},
  {id:'entry.feedback-text',expectedReason:'ENTRY_SETTINGS_SAVE_FEEDBACK',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].feedback='保存中';}},
  {id:'entry.screenshot',expectedReason:'ENTRY_SETTINGS_SAVE_SCREENSHOT',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).saves[2].screenshot='other.png';}},
  {id:'entry.binding',expectedReason:'ENTRY_SETTINGS_SAVE_BINDING',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).saves[0].binding.requestId='other';}},
]));
test('rejects chats on stale state, without exact message pairs or foreign dispatch',()=>rejects([
  {id:'entry.chat-two-before-budget-save',expectedReason:'ENTRY_SETTINGS_CHAT_STATE',expectedContext:{cycle:1,stage:2},mutate:v=>{Object.assign(first(v).chats[1],{revision:22,archiveHash:h(22)});}},
  {id:'entry.chat-three-before-inherit-save',expectedReason:'ENTRY_SETTINGS_CHAT_STATE',expectedContext:{cycle:1,stage:3},mutate:v=>{Object.assign(first(v).chats[2],{revision:23,archiveHash:h(23)});}},
  {id:'entry.chat-extra-message',expectedReason:'ENTRY_SETTINGS_CHAT_HISTORY_PREFIX',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).chats[0].afterIds.splice(2,0,'extra-message');}},
  {id:'entry.chat-dispatch',expectedReason:'ENTRY_SETTINGS_CHAT_DISPATCH_ID',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).chats[1].requestId='other-request';}},
  {id:'entry.chat-dispatch-epoch',expectedReason:'ENTRY_SETTINGS_CHAT_DISPATCH_SCOPE',expectedContext:{cycle:1,stage:1},mutate:v=>{v.events.find(e=>e.event==='entry_settings_dispatch').persona_epoch++;}},
  {id:'entry.chat-reply',expectedReason:'ENTRY_SETTINGS_CHAT_TEXT',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).chats[2].reply='其他回复';}},
  {id:'entry.terminal-stale',expectedReason:'ENTRY_SETTINGS_TERMINAL_FINAL_SAVE',expectedContext:{cycle:1},mutate:v=>{Object.assign(first(v).observed,{terminalRevision:23,terminalArchiveHash:h(23)});}},
  {id:'entry.terminal-history',expectedReason:'ENTRY_SETTINGS_TERMINAL_HISTORY',expectedContext:{cycle:1},mutate:v=>{first(v).observed.terminalMessageIds.pop();}},
]));
test('rejects restart drift or a read-back other than the saved entries',()=>rejects([
  {id:'entry.restart-archive',expectedReason:'ENTRY_SETTINGS_RESTART_ARCHIVE',expectedContext:{cycle:2},mutate:v=>{const o=second(v).observed;o.baselineArchiveHash=h(77);receiptOf(second(v),o.baselineReadId).archiveHash=h(77);}},
  {id:'entry.restart-history',expectedReason:'ENTRY_SETTINGS_RESTART_HISTORY',expectedContext:{cycle:2},mutate:v=>{const o=second(v).observed;o.baselineMessageIds.reverse();o.terminalMessageIds.reverse();}},
  {id:'entry.restart-changed',expectedReason:'ENTRY_SETTINGS_RESTART_UNCHANGED',expectedContext:{cycle:2},mutate:v=>{second(v).observed.terminalRevision++;}},
  {id:'entry.restart-baseline-budget',expectedReason:'ENTRY_SETTINGS_ENTRY_VALUES',expectedContext:{cycle:2,source:'restart-baseline',entryIndex:1},mutate:v=>{receiptOf(second(v),'baseline-read-2').book.entries[1].tokenBudget=null;}},
  {id:'entry.restart-screenshot',expectedReason:'ENTRY_SETTINGS_RESTART_SCREENSHOT',expectedContext:{cycle:2},mutate:v=>{second(v).observed.restartScreenshotControl='worldbookEntryScanDepthInherit';}},
]));
test('rejects missing, misordered, stale or reused restart control samples',()=>rejects([
  {id:'entry.samples-missing',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_SET',expectedContext:{cycle:2},mutate:v=>{second(v).samples=[];}},
  {id:'entry.samples-order',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_ORDER',expectedContext:{cycle:2},mutate:v=>{second(v).samples.reverse();}},
  {id:'entry.sample-budget-value',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_VALUE',expectedContext:{cycle:2,sampleIndex:3,control:'worldbookEntryTokenBudget'},mutate:v=>{second(v).samples[3].value=100;}},
  {id:'entry.sample-inherited',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_VALUE',expectedContext:{cycle:2,sampleIndex:0,control:'worldbookEntryScanDepthInherit'},mutate:v=>{second(v).samples[0].inherited=false;}},
  {id:'entry.sample-binding',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_BINDING',expectedContext:{cycle:2,sampleIndex:1,control:'worldbookEntryTokenBudgetInherit'},mutate:v=>{second(v).samples[1].revision=23;}},
  {id:'entry.sample-clipped',expectedReason:'ENTRY_SETTINGS_GEOMETRY_CONTAINMENT',expectedContext:{cycle:2,sampleIndex:2,control:'worldbookEntryScanDepthInherit',section:'restart-sample'},mutate:v=>{second(v).samples[2].geometry.sceneY=95;}},
  {id:'entry.sample-reset-clock',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:1,control:'worldbookEntryTokenBudgetInherit'},mutate:v=>{
    const s=second(v).samples[1];s.inputAtMs=680;s.layout.last.elapsedMs=40;s.layout.last.stableSinceMs=0;}},
  {id:'entry.sample-reused-stability',expectedReason:'ENTRY_SETTINGS_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:1,control:'worldbookEntryTokenBudgetInherit'},mutate:v=>{second(v).samples[1].layout.last.stableSinceMs=0;}},
]));
test('rejects changed, missing or unproven real control inputs',()=>rejects([
  {id:'entry.input-order',expectedReason:'ENTRY_SETTINGS_INPUT_STEP_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).inputs.reverse();}},
  {id:'entry.input-control',expectedReason:'ENTRY_SETTINGS_INPUT_CONTROL_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).inputs[6].control='worldbookScanDepth';}},
  {id:'entry.input-values',expectedReason:'ENTRY_SETTINGS_INPUT_VALUES',expectedContext:{cycle:1},mutate:v=>{first(v).inputs[7].afterValue=4;}},
  {id:'entry.input-entry',expectedReason:'ENTRY_SETTINGS_INPUT_ENTRY',expectedContext:{cycle:1,step:18},mutate:v=>{first(v).inputs[10].selectedEntryId=ENTRY_A;}},
  {id:'entry.input-integer-signal',expectedReason:'ENTRY_SETTINGS_INPUT_INTEGER_SIGNALS',expectedContext:{cycle:1,step:17},mutate:v=>{first(v).inputs[7].signals.keyDispatchCount=2;}},
  {id:'entry.input-checkbox-signal',expectedReason:'ENTRY_SETTINGS_INPUT_CHECKBOX_SIGNALS',expectedContext:{cycle:1,step:35},mutate:v=>{first(v).inputs[18].signals.checked=false;}},
  {id:'entry.input-book-selector',expectedReason:'ENTRY_SETTINGS_INPUT_SELECTOR_SIGNALS',expectedContext:{cycle:1,step:8},mutate:v=>{first(v).inputs[5].signals.selectedIndex=1;}},
  {id:'entry.input-restart-entry-selector',expectedReason:'ENTRY_SETTINGS_INPUT_SELECTOR_SIGNALS',expectedContext:{cycle:2,step:21},mutate:v=>{second(v).inputs[3].signals.selectedIndex=1;}},
  {id:'entry.input-scope',expectedReason:'ENTRY_SETTINGS_INPUT_SCOPE',expectedContext:{cycle:1,step:29},mutate:v=>{first(v).inputs[0].scope='other';}},
  {id:'entry.input-deadline',expectedReason:'ENTRY_SETTINGS_INPUT_DEADLINE_FRAME',expectedContext:{cycle:1,step:29},mutate:v=>{first(v).inputs[0].elapsedMs=4000;}},
  {id:'entry.input-stability',expectedReason:'ENTRY_SETTINGS_STABILITY',expectedContext:{cycle:2,step:21,section:'input'},mutate:v=>{second(v).inputs[3].layout.last.stableSinceMs=1;}},
  {id:'entry.input-hit',expectedReason:'ENTRY_SETTINGS_INPUT_HIT',expectedContext:{cycle:1,step:17},mutate:v=>{first(v).inputs[7].hit.hitResult='other';}},
  {id:'entry.input-clipped',expectedReason:'ENTRY_SETTINGS_GEOMETRY_CONTAINMENT',expectedContext:{cycle:1,step:19,section:'input'},mutate:v=>{first(v).inputs[11].layout.last.sceneY=95;}},
]));
