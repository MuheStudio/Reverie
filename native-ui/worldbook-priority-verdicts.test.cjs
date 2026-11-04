'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {verdictReason,rejectionIdentity,assertRejectedMutation}=require('./verdict-test-support.cjs');
const {PRIORITY_TEXTS,PRIORITY_REPLY,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,LEGACY_SEQUENCE,priorityModelMetadata,verifyWorldbookPriority,PERSONA_ROW_INPUT_CONTRACT,verifyPersonaRowInputs,verifyPersonaRowInputRecord,verifyAuthorControlReadiness}=require('./worldbook-priority-verdicts.cjs');
const clone=v=>JSON.parse(JSON.stringify(v)), h=n=>n.toString(16).padStart(64,'0');
const canonEmpty=crypto.createHash('sha256').update('{"activeCharacterIds":[],"characters":[],"worldBooks":[]}').digest('hex');
const absent=crypto.createHash('sha256').update('{}').digest('hex');
const absentRest=crypto.createHash('sha256').update('{"worldBooks":[]}').digest('hex');
function fixture(){
  const sunny='sunny-persona', moon='moon-persona', events=[{event:'persona_seeded',cycle:1,profile_id:sunny}];
  const old=LEGACY_SEQUENCE.map(([kind,cycle,stage])=>({kind,cycle,...(stage?{stage}:{})}));
  const additions=[1,2,3].map(stage=>({kind:'priority-fixture',cycle:stage===3?2:1,stage,priorityText:PRIORITY_TEXTS[stage-1],worldSettingSections:1,firstMarkerCount:stage===1?1:0,secondMarkerCount:stage===1?0:1,markerInHistory:false,worldSettingSha256:crypto.createHash('sha256').update(stage===1?'PRIORITY_A_ONLY':'PRIORITY_B_ONLY').digest('hex')}));
  const modelCalls=[...old.slice(0,18),...additions.slice(0,2),...old.slice(18),additions[2]];
  const book=priority=>({id:'p1_priority_book',tokenBudget:8,scanDepth:1,recursiveScanning:false,
    entries:[0,1].map(i=>({id:i?'p1_priority_b':'p1_priority_a',content:i?'PRIORITY_B_ONLY':'PRIORITY_A_ONLY',priority:i?1:priority,insertionOrder:i?20:10,enabled:true,alwaysActive:true,useRegex:false,tokenBudget:null}))});
  const state=(personaId,revision,archiveHash,messageIds)=>({personaId,exists:revision>0,revision,archiveHash,messageIds,charactersHash:h(22),avatarIds:['avatar-original'],activeAvatar:'avatar-original',avatarState:'idle'});
  const reports=[]; let sunnyIds=['sunny-welcome'];
  for(let cycle=1;cycle<=2;cycle++){
    const verify=cycle===2, sunnyEpoch=cycle*2+1, scope=`${sunny}:${sunnyEpoch}:${h(70)}`, generation=cycle*10;
    const originalPersona=verify?'default':moon, originalScope=`${originalPersona==='default'?'builtin-persona':originalPersona}:${cycle*2}:${h(71)}`, returnScope=`${originalPersona==='default'?'builtin-persona':originalPersona}:${cycle*2+2}:${h(71)}`;
    const original=state(originalPersona,verify?20:4,h(90),['original-message']);
    const before=state(sunny,verify?3:0,verify?h(3):absent,sunnyIds.slice());
    const observed={originalBefore:original,originalAfter:clone(original),sunnyBefore:before,sunnyPersonaId:sunny,originalScope,returnScope,sunnyScope:scope,
      originalReadId:`original-read-${cycle}`,baselineReadId:`baseline-read-${cycle}`,returnReadId:`return-read-${cycle}`,elapsedMs:5000,putCount:verify?0:3,canonicalBaselineRestHash:canonEmpty};
    const report={passed:true,error:'',mode:verify?'restart-readback':'change-and-effect',deadlineMs:verify?20000:30000,
      checks:(verify?RESTART_CHECKS:FIRST_CHECKS).map(name=>({name,passed:true})),observed,receipts:[],saves:[],chats:[],inputs:[]};
    const receipt=(requestId,command,revision,archiveHash,value,personaId=sunny,receiptScope=scope)=>{
      const r={requestId,command,generation:receiptScope===originalScope?generation-1:receiptScope===returnScope?generation+1:generation,scope:receiptScope,personaId,ok:true,exists:revision>0,revision,archiveHash,restHash:revision>0?canonEmpty:absentRest,book:value};report.receipts.push(r);return r;
    };
    receipt(observed.originalReadId,'archive:get',original.revision,original.archiveHash,{},originalPersona,originalScope);
    receipt(observed.baselineReadId,'archive:get',before.revision,before.archiveHash,verify?book(0):{});
    if(!verify){
      observed.prepareWriteId='prepare-write-1';observed.prepareReadId='prepare-read-1';observed.preparedExpectedRevision=0;observed.preparedRevision=1;
      events.push({event:'priority_archive_put_dispatch',cycle:1,request_id:observed.prepareWriteId,persona_id:sunny,persona_epoch:sunnyEpoch,persona_fingerprint:h(70),expected_revision:0});
      receipt(observed.prepareWriteId,'archive:put',1,h(1),book(0));receipt(observed.prepareReadId,'archive:get',1,h(1),book(0));
      for(let n=0;n<2;n++){
        const priority=n?0:2, revision=n+2;
        const save={stage:n+1,priority,expectedRevision:revision-1,revision,writeId:`priority-write-${n+1}`,readId:`priority-read-${n+1}`,scope,generation,personaId:sunny,
          binding:{armed:true,status:'matched',failureReason:'',scope,generation,requestId:`priority-write-${n+1}`,baselineCount:n+1},readAtMs:1000+n*1000,feedbackInputAtMs:1100+n*1000,
          archiveHash:h(revision),restHash:canonEmpty,book:book(priority),feedback:'已保存 · 下一轮聊天使用新 revision',feedbackGeometry:{found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100},windowWidth:100,windowHeight:100,screenshot:`cycle-1.json.worldbook-priority-save-${n+1}.png`};
        events.push({event:'priority_archive_put_dispatch',cycle:1,request_id:save.writeId,persona_id:sunny,persona_epoch:sunnyEpoch,persona_fingerprint:h(70),expected_revision:save.expectedRevision});
        report.saves.push(save);receipt(save.writeId,'archive:put',revision,h(revision),book(priority));receipt(save.readId,'archive:get',revision,h(revision),book(priority));
        report.inputs.push({control:'worldbookPriority',beforeValue:n?2:0,afterValue:priority,elapsedMs:40,frame:n+1},{control:'saveWorldbook',elapsedMs:40,frame:n+2});
      }
    }else report.inputs.push({control:'nav-character',elapsedMs:40,frame:1});
    for(const stage of (verify?[3]:[1,2])){
      const requestId=`priority-chat-request-${stage}`, userId=`priority-user-${stage}`,assistantId=`priority-assistant-${stage}`;
      const beforeIds=sunnyIds.slice();sunnyIds.push(userId,assistantId);
      report.chats.push({stage,requestId,scope,generation,personaId:sunny,beforeIds,afterIds:sunnyIds.slice(),userId,assistantId,text:PRIORITY_TEXTS[stage-1],reply:PRIORITY_REPLY,revision:verify?3:stage+1,archiveHash:h(verify?3:stage+1)});
      events.push({event:'priority_dispatch',cycle,stage,request_id:requestId,persona_id:sunny,persona_epoch:sunnyEpoch,persona_fingerprint:h(70)},
        {event:'priority_timing',cycle,stage,persona_id:sunny,persona_epoch:sunnyEpoch,persona_fingerprint:h(70),start_delay_ms:0,delivery_delay_ms:100});
    }
    observed.sunnyTerminal=state(sunny,3,h(3),sunnyIds.slice());observed.book=book(0);
    receipt(observed.returnReadId,'archive:get',original.revision,original.archiveHash,{},originalPersona,returnScope);
    let edits=0;
    report.inputs=INPUT_STEPS[cycle-1].map((step,n)=>{
      const names={51:'nav-character',1:'personaSwitch-'+sunny,2:'personaSwitchConfirm',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',9:'worldbookEntrySelector',10:'worldbookPriority',11:'saveWorldbook',14:'memory-close',30:'chatComposer',31:'sendChat',33:'nav-memory',34:'nav-character',40:'personaSwitch-'+originalPersona,41:'personaSwitchConfirm',29:'nav-chat'};
      const row={step,control:names[step],scope:n<3?originalScope:scope,generation:n<3?generation-1:generation,stepAtMs:100,inputAtMs:200,elapsedMs:40,frame:n+2,windowWidth:100,windowHeight:100,hit:{hitResult:'target',acceptorFound:true},layout:{ready:true,minimumStableMs:40,last:{ready:true,layoutStable:true,enabled:true,surfaceClosed:true,found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100,scope:n<3?originalScope:scope,elapsedMs:40,stableSinceMs:0,frameSerial:n+2,stableFrameSerial:n+1,pointX:30,pointY:15}},signals:step===10?{kind:'integer',mouseDispatchCount:1,keyDispatchCount:2,valueModifiedSignals:2}:step===30?{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true}:[8,9].includes(step)?{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1}:{kind:'button',mouseDispatchCount:1,clickedSignals:1}};if(step===10){row.beforeValue=edits?2:0;row.afterValue=edits?0:2;edits++;}return row;
    });
    report.personaRowInputs=[
      rowRecordFixture({step:1,targetId:sunny,sourcePersonaId:originalPersona,livePersonaId:originalScope.split(':')[0],scope:originalScope,generation:generation-1,root:'taskSurface',page:'characterTasks'}),
      rowRecordFixture({step:40,targetId:originalPersona,sourcePersonaId:sunny,livePersonaId:sunny,scope,generation,root:'taskSurface',page:'characterTasks'})];
    reports.push({archiveInteraction:{cardImport:{moonPersona:moon}},worldbookPriority:report});
  }
  return {reports,modelCalls,events,requests:25};
}
const verify=v=>verifyWorldbookPriority(v.reports,v.modelCalls,v.events,v.requests);
const first=v=>v.reports[0].worldbookPriority, second=v=>v.reports[1].worldbookPriority;
const rejects=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:fixture,verify,...row});};
test('accepts two real GUI saves, three Sunny requests and original 22-request subset',()=>{
  const proof=verify(fixture());assert.deepEqual(proof.checks,[6,4]);assert.equal(proof.http,25);assert.equal(proof.legacyModelCalls.length,22);
});
test('extracts markers solely from delimited system WORLD SETTING',()=>{
  const result=priorityModelMetadata([{role:'system',content:'=== WORLD SETTING (MATCH-ACTIVATED) ===\nPRIORITY_A_ONLY\nThe activated world setting above is user-configured role context.'}]);
  assert.equal(result.firstMarkerCount,1);assert.equal(result.secondMarkerCount,0);assert.equal(result.worldSettingSections,1);assert.equal(result.markerInHistory,false);
});
test('user or assistant history cannot supply the world-setting marker',()=>{
  for(const role of ['user','assistant']){const result=priorityModelMetadata([{role,content:'PRIORITY_A_ONLY'}]);assert.equal(result.firstMarkerCount,0);assert.equal(result.markerInHistory,true);}
});
test('unterminated or ordinary system text cannot supply an injection section',()=>{
  for(const content of ['PRIORITY_A_ONLY','=== WORLD SETTING (MATCH-ACTIVATED) ===\nPRIORITY_A_ONLY'])assert.equal(priorityModelMetadata([{role:'system',content}]).worldSettingSections,0);
});
test('rejects an extra HTTP even if all expected calls are present',()=>rejects([{id:"wb.priority_http_total.1",expectedReason:"PRIORITY_HTTP_TOTAL",expectedContext:{},mutate:v=>{v.requests++;}}]));
test('rejects a missing old request replaced by an extra priority request',()=>rejects([{id:"wb.priority_legacy_sequence.2",expectedReason:"PRIORITY_LEGACY_SEQUENCE",expectedContext:{},mutate:v=>{v.modelCalls[1]=clone(v.modelCalls[18]);}}]));
test('rejects reordered legacy requests',()=>rejects([{id:"wb.priority_legacy_sequence.3",expectedReason:"PRIORITY_LEGACY_SEQUENCE",expectedContext:{},mutate:v=>{[v.modelCalls[0],v.modelCalls[1]]=[v.modelCalls[1],v.modelCalls[0]];}}]));
test('rejects priority requests before the old cycle has finished',()=>rejects([{id:"wb.priority_call_positions.4",expectedReason:"PRIORITY_CALL_POSITIONS",expectedContext:{},mutate:v=>{[v.modelCalls[17],v.modelCalls[18]]=[v.modelCalls[18],v.modelCalls[17]];}}]));
test('rejects wrong cycle or fixed text',()=>{rejects([{id:"wb.priority_request_signature.5",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[18].cycle=2;}}]);rejects([{id:"wb.priority_request_signature.6",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[18].priorityText+=' extra';}}]);});
test('rejects a marker copied from user history',()=>rejects([{id:"wb.priority_request_signature.7",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[18].markerInHistory=true;}}]));
test('rejects both budget candidates or the wrong candidate',()=>{rejects([{id:"wb.priority_request_signature.8",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[18].secondMarkerCount=1;}}]);rejects([{id:"wb.priority_request_signature.9",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[19].firstMarkerCount=1;}}]);});
test('rejects duplicate world-setting blocks',()=>rejects([{id:"wb.priority_request_signature.10",expectedReason:"PRIORITY_REQUEST_SIGNATURE",expectedContext:{},mutate:v=>{v.modelCalls[18].worldSettingSections=2;}}]));
test('rejects missing actual preparation write',()=>rejects([{id:"wb.priority_write_receipt_total.11",expectedReason:"PRIORITY_WRITE_RECEIPT_TOTAL",expectedContext:{"cycle":1},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!==first(v).observed.prepareWriteId);}},{id:'priority.preparation.receipt-missing-count-kept',expectedReason:'PRIORITY_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:put',role:'prepare-write'},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).observed.prepareWriteId).requestId='orphan-preparation-write';}}]));
test('rejects missing actual GUI save ACK',()=>rejects([{id:"wb.priority_write_receipt_total.12",expectedReason:"PRIORITY_WRITE_RECEIPT_TOTAL",expectedContext:{"cycle":1},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!==first(v).saves[0].writeId);}},{id:'priority.save.ack-missing-count-kept',expectedReason:'PRIORITY_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:put',role:'save-ack-1'},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).saves[0].writeId).requestId='orphan-save-write';}}]));
test('rejects ACK alone without the fresh read',()=>rejects([{id:"wb.priority_receipt_present.13",expectedReason:"PRIORITY_RECEIPT_PRESENT",expectedContext:{"cycle":1,"command":"archive:get","role":"save-read-1"},mutate:v=>{first(v).receipts=first(v).receipts.filter(r=>r.requestId!==first(v).saves[0].readId);}}]));
test('rejects save or read revision mismatch',()=>{rejects([{id:"wb.priority_ack_revision.14",expectedReason:"PRIORITY_ACK_REVISION",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).saves[0].writeId).revision++;}}]);rejects([{id:"wb.priority_save_revision.15",expectedReason:"PRIORITY_SAVE_REVISION",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).saves[0].revision++;}}]);});
test('rejects wrong receipt scope or generation',()=>{rejects([{id:"wb.priority_receipt_scope.16",expectedReason:"PRIORITY_RECEIPT_SCOPE",expectedContext:{"cycle":1,"command":"archive:get","role":"save-read-1"},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).saves[0].readId).scope='other';}}]);rejects([{id:"wb.priority_read_generation.17",expectedReason:"PRIORITY_READ_GENERATION",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).saves[0].readId).generation++;}}]);});
test('rejects duplicated receipt identity',()=>rejects([{id:"wb.priority_receipt_unique.18",expectedReason:"PRIORITY_RECEIPT_UNIQUE",expectedContext:{"cycle":1},mutate:v=>{first(v).receipts.push(clone(first(v).receipts[0]));}}]));
test('rejects success booleans without exact ordered check identities',()=>{rejects([{id:"wb.priority_check_order.19",expectedReason:"PRIORITY_CHECK_ORDER",expectedContext:{"cycle":1},mutate:v=>{first(v).checks[1]=clone(first(v).checks[0]);}}]);rejects([{id:"wb.priority_check_order.20",expectedReason:"PRIORITY_CHECK_ORDER",expectedContext:{"cycle":2},mutate:v=>{second(v).checks.pop();}}]);});
test('rejects a tail at its independent deadline',()=>{rejects([{id:"wb.priority_segment_elapsed.21",expectedReason:"PRIORITY_SEGMENT_ELAPSED",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.elapsedMs=30000;}}]);rejects([{id:"wb.priority_segment_elapsed.22",expectedReason:"PRIORITY_SEGMENT_ELAPSED",expectedContext:{"cycle":2},mutate:v=>{second(v).observed.elapsedMs=20000;}}]);});
test('rejects changed original archive, messages or switches',()=>{rejects([{id:"wb.priority_original_preserved.23",expectedReason:"PRIORITY_ORIGINAL_PRESERVED",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.originalAfter.archiveHash=h(99);}}]);rejects([{id:"wb.priority_original_preserved.24",expectedReason:"PRIORITY_ORIGINAL_PRESERVED",expectedContext:{"cycle":2},mutate:v=>{second(v).observed.originalAfter.messageIds.push('unexpected-id');}}]);rejects([{id:"wb.priority_original_preserved.25",expectedReason:"PRIORITY_ORIGINAL_PRESERVED",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.originalAfter.charactersHash=h(99);}}]);});
test('rejects missing original or return authoritative read',()=>{rejects([{id:"wb.priority_receipt_present.26",expectedReason:"PRIORITY_RECEIPT_PRESENT",expectedContext:{"cycle":1,"command":"archive:get","role":"original-read"},mutate:v=>{first(v).observed.originalReadId='not-observed';}}]);rejects([{id:"wb.priority_receipt_present.27",expectedReason:"PRIORITY_RECEIPT_PRESENT",expectedContext:{"cycle":1,"command":"archive:get","role":"return-read"},mutate:v=>{first(v).observed.returnReadId='not-observed';}}]);});
test('rejects original persona or Sunny scope mix-up',()=>{rejects([{id:"wb.priority_original_preserved.28",expectedReason:"PRIORITY_ORIGINAL_PRESERVED",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.originalBefore.personaId='default';}},{id:'priority.original.consistent-wrong-persona',expectedReason:'PRIORITY_ORIGINAL_PERSONA',expectedContext:{cycle:1},mutate:v=>{first(v).observed.originalBefore.personaId='default';first(v).observed.originalAfter.personaId='default';}}]);rejects([{id:"wb.priority_chat_persona.29",expectedReason:"PRIORITY_CHAT_PERSONA",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).chats[0].personaId='default';}}]);});
test('rejects restart writes and preparation',()=>{rejects([{id:"wb.priority_restart_prep_absent.30",expectedReason:"PRIORITY_RESTART_PREP_ABSENT",expectedContext:{"cycle":2},mutate:v=>{second(v).observed.prepareWriteId='unexpected-write';}}]);rejects([{id:"wb.priority_write_receipt_total.31",expectedReason:"PRIORITY_WRITE_RECEIPT_TOTAL",expectedContext:{"cycle":2},mutate:v=>{second(v).receipts.push({...second(v).receipts[0],requestId:'unexpected-write',command:'archive:put'});}}]);});
test('rejects restart archive or complete Sunny history drift',()=>{rejects([{id:"wb.priority_baseline_archive_hash.32",expectedReason:"PRIORITY_BASELINE_ARCHIVE_HASH",expectedContext:{"cycle":2},mutate:v=>{second(v).observed.sunnyBefore.archiveHash=h(77);}},{id:'priority.restart.consistent-wrong-archive',expectedReason:'PRIORITY_RESTART_ARCHIVE_HASH',expectedContext:{cycle:2},mutate:v=>{const report=second(v);report.observed.sunnyBefore.archiveHash=h(77);report.receipts.find(r=>r.requestId===report.observed.baselineReadId).archiveHash=h(77);}}]);rejects([{id:"wb.priority_restart_history.33",expectedReason:"PRIORITY_RESTART_HISTORY",expectedContext:{"cycle":2},mutate:v=>{second(v).observed.sunnyBefore.messageIds.reverse();}}]);});
test('rejects altered budget, insertion order or unbounded entry budget',()=>{rejects([{id:"wb.priority_save_book.34",expectedReason:"PRIORITY_SAVE_BOOK",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).saves[0].book.tokenBudget=16;}},{id:'priority.book.consistent-over-budget',expectedReason:'PRIORITY_BOOK_BUDGET',expectedContext:{cycle:1,stage:1,source:'save-ack'},mutate:v=>{const report=first(v),save=report.saves[0];save.book.tokenBudget=16;for(const receipt of report.receipts)if([save.writeId,save.readId].includes(receipt.requestId))receipt.book.tokenBudget=16;}}]);rejects([{id:"wb.priority_entry_order.35",expectedReason:"PRIORITY_ENTRY_ORDER",expectedContext:{"cycle":1,"stage":1,"source":"save-ack","entryIndex":0},mutate:v=>{first(v).receipts.find(r=>r.requestId===first(v).saves[0].writeId).book.entries[0].insertionOrder=20;}}]);rejects([{id:"wb.priority_entry_token_budget.36",expectedReason:"PRIORITY_ENTRY_TOKEN_BUDGET",expectedContext:{"cycle":1,"source":"terminal","entryIndex":0},mutate:v=>{first(v).observed.book.entries[0].tokenBudget=8;}}]);});
test('rejects changes to untouched archive fields',()=>rejects([{id:"wb.priority_save_rest_hash.37",expectedReason:"PRIORITY_SAVE_REST_HASH",expectedContext:{"cycle":1,"stage":2},mutate:v=>{first(v).saves[1].restHash=h(55);}}]));
test('rejects a chat without the exact bound user and assistant IDs',()=>{rejects([{id:"wb.priority_chat_history_prefix.38",expectedReason:"PRIORITY_CHAT_HISTORY_PREFIX",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).chats[0].afterIds.push('extra-message');}}]);rejects([{id:"wb.priority_chat_dispatch_id.39",expectedReason:"PRIORITY_CHAT_DISPATCH_ID",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).chats[0].requestId='other-request';}}]);});
test('rejects timing override outside the Sunny epoch',()=>rejects([{id:"wb.priority_chat_timing_epoch.40",expectedReason:"PRIORITY_CHAT_TIMING_EPOCH",expectedContext:{"cycle":1,"stage":1},mutate:v=>{v.events.find(e=>e.event==='priority_timing').persona_epoch++;}}]));
test('rejects an unchanged epoch on return',()=>rejects([{id:"wb.priority_scope_transitions.41",expectedReason:"PRIORITY_SCOPE_TRANSITIONS",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.returnScope=first(v).observed.originalScope;}}]));
test('rejects clipped first save feedback',()=>rejects([{id:"wb.geometry_visible.42",expectedReason:"GEOMETRY_VISIBLE",expectedContext:{"cycle":1,"stage":1,"section":"save-feedback"},mutate:v=>{first(v).saves[0].feedbackGeometry.fullyVisible=false;}}]));
test('rejects input beyond the original four-second limit',()=>rejects([{id:"wb.priority_input_deadline_frame.43",expectedReason:"PRIORITY_INPUT_DEADLINE_FRAME",expectedContext:{"cycle":1},mutate:v=>{first(v).inputs[0].elapsedMs=4000;}}]));

test('rejects zero-write claims when a Sunny write was actually dispatched',()=>rejects([{id:"wb.priority_write_dispatch_total.44",expectedReason:"PRIORITY_WRITE_DISPATCH_TOTAL",expectedContext:{},mutate:v=>{v.events.push({...v.events.find(e=>e.event==='priority_archive_put_dispatch'),cycle:2,request_id:'extra-write'});}}]));
test('rejects clipped geometry even when its success boolean claims visibility',()=>rejects([{id:"wb.geometry_containment.45",expectedReason:"GEOMETRY_CONTAINMENT",expectedContext:{"cycle":1,"stage":1,"section":"save-feedback"},mutate:v=>{first(v).saves[0].feedbackGeometry.sceneY=95;}}]));
test('rejects a changed control order or missing real priority edit',()=>{rejects([{id:"wb.priority_input_control_order.46",expectedReason:"PRIORITY_INPUT_CONTROL_ORDER",expectedContext:{"cycle":1},mutate:v=>{first(v).inputs[7].control='worldbookInsertionOrder';}}]);rejects([{id:"wb.priority_input_step_order.47",expectedReason:"PRIORITY_INPUT_STEP_ORDER",expectedContext:{"cycle":1},mutate:v=>{first(v).inputs.reverse();}}]);});
test('rejects arbitrary defaulting of a missing archive baseline',()=>rejects([{id:"wb.priority_empty_canonical_rest.48",expectedReason:"PRIORITY_EMPTY_CANONICAL_REST",expectedContext:{"cycle":1},mutate:v=>{first(v).observed.canonicalBaselineRestHash=h(67);}}]));

test('rejects missing clicked or valueModified evidence despite success claims',()=>{rejects([{id:"wb.priority_input_mouse_dispatch.49",expectedReason:"PRIORITY_INPUT_MOUSE_DISPATCH",expectedContext:{"cycle":1,"step":51},mutate:v=>{delete first(v).inputs[0].signals;}}]);rejects([{id:"wb.priority_input_integer_signals.50",expectedReason:"PRIORITY_INPUT_INTEGER_SIGNALS",expectedContext:{"cycle":1,"step":10},mutate:v=>{first(v).inputs.find(i=>i.control==='worldbookPriority').signals.valueModifiedSignals=0;}}]);});
test('rejects unstable clipped or intercepted actual inputs',()=>{rejects([{id:"wb.priority_input_stability.51",expectedReason:"PRIORITY_INPUT_STABILITY",expectedContext:{"cycle":1,"step":51},mutate:v=>{first(v).inputs[0].layout.last.stableSinceMs=1;}}]);rejects([{id:"wb.geometry_containment.52",expectedReason:"GEOMETRY_CONTAINMENT",expectedContext:{"cycle":1,"step":51,"section":"priority-input"},mutate:v=>{first(v).inputs[0].layout.last.sceneY=95;}}]);rejects([{id:"wb.priority_input_hit.53",expectedReason:"PRIORITY_INPUT_HIT",expectedContext:{"cycle":1,"step":51},mutate:v=>{first(v).inputs[0].hit.hitResult='other';}}]);rejects([{id:"wb.priority_input_scope.54",expectedReason:"PRIORITY_INPUT_SCOPE",expectedContext:{"cycle":1,"step":51},mutate:v=>{first(v).inputs[0].scope=first(v).observed.sunnyScope;}}]);});


// Row-acquisition fixtures are independent of the existing 38 priority cases.
// No existing priority acceptance fixture or assertion is weakened by these.
function personaRowFixture() {
  const sunny='sunny-persona', moon='moon-persona', frost='frost-persona';
  const defaultScopeId='builtin-persona';
  const scopes=[[`${defaultScopeId}:1:${h(1)}`,`${sunny}:2:${h(2)}`,`${frost}:5:${h(3)}`,`${defaultScopeId}:6:${h(1)}`],
    [`${moon}:1:${h(4)}`,`${defaultScopeId}:2:${h(1)}`,`${moon}:3:${h(4)}`]];
  const profiles=[{id:'default',name:'默认人格'},{id:sunny,name:'测试人格·晴'},{id:moon,name:'测试人格·月'},{id:frost,name:'测试人格·霜'}];
  const sources=[['default',sunny,frost,'default'],[moon,'default',moon]],targets=[[sunny,'default','default',moon],['default',moon,'default']];
  const names=[['before-first-synthetic-input','scope-cleared-first-to-seeded',null,null],
    ['before-first-synthetic-input','scope-cleared-restart-to-default','scope-cleared-restart-to-moon']];
  const reports=PERSONA_ROW_INPUT_CONTRACT.steps.map((steps,cycle)=>{
    const rows=steps.map((step,index)=>{
      const scope=scopes[cycle][index], generation=Number(scope.split(':')[1]), livePersonaId=scope.split(':')[0], fingerprint=scope.split(':')[2];
      const control={found:true,bound:true,geometryValid:true,integerPointInsideClip:true,ready:true,enabled:true,visible:true,surfaceClosed:true,inputPointInsideClip:true,
        scope,fullyVisible:true,pointX:35,pointY:20,sceneX:10,sceneY:10,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100,
        scrolls:[{contentY:100,contentHeight:500,sceneX:0,sceneY:0,sceneWidth:100,sceneHeight:100}]};
      const whole={found:true,visible:true,fullyVisible:true,...Object.fromEntries(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].map(k=>[k,control[k]]))};
      const reveal={expired:false,geometryValid:true,scrollLimit:6,ancestorCount:1,scrollCount:0,elapsedMs:40,
        scrolls:[{index:0,beforeY:100,afterY:100,minimumY:0,maximumY:400,contentHeight:500,viewportHeight:100,topYBefore:10,bottomYBefore:30,requestedY:70,scrolled:false,fitsViewport:true,afterObserved:true}]};
      const observed={ready:true,root:'taskSurface',page:'characterTasks',targetId:targets[cycle][index],sourcePersonaId:sources[cycle][index],livePersonaId,scope,generation,
        listPersonaId:livePersonaId,listActivePersonaId:sources[cycle][index],personaEpoch:Number(scope.split(':')[1]),listPersonaEpoch:Number(scope.split(':')[1]),personaFingerprint:fingerprint,listPersonaFingerprint:fingerprint,liveMatches:true,
        taskSurfaceCount:1,characterTasksCount:1,rowCount:1,controlCount:1,targetProfileCount:1,sourceProfileCount:1,activeProfileCount:1,
        rowId:targets[cycle][index],rowActive:false,rowIdKnown:true,rowActiveKnown:true,modelDataType:'QJSValue',normalizedModelDataType:'QVariantMap',
        identityMatches:true,rowInactive:true,scopeMatches:true,generationMatches:true,personaMatches:true,surfaceReady:true,effectiveOpacity:1,
        control,whole,hit:{acceptorFound:true,hitResult:'descendant'},reveal};
      const anchor={...clone(observed),elapsedMs:0,frameSerial:20,schedulingIntervalMs:null};anchor.reveal.elapsedMs=0;
      const final={...clone(observed),elapsedMs:40,frameSerial:21,schedulingIntervalMs:40,
        layout:{layoutStable:true,stableSinceMs:0,stableFrameSerial:20},stableAnchor:clone(anchor),
        dispatchElapsedMs:41,dispatchFrameSerial:21,dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,mouseElapsedMs:42,mouseFrameSerial:21,clickedSignals:1,signalObserverValid:true,status:'performed',failureReason:''};
      final.mouse={...clone(observed),elapsedMs:41,frameSerial:21,schedulingIntervalMs:40,layout:clone(final.layout)};
      return {step,targetId:targets[cycle][index],sourcePersonaId:sources[cycle][index],livePersonaId,control:'personaSwitch-'+targets[cycle][index],root:'taskSurface',page:'characterTasks',
        scope,generation,stepAtMs:index*1000,deadlineMs:4000,pollIntervalMs:40,minimumStableMs:40,sampleLimit:6,polls:2,
        windowWidth:100,windowHeight:100,dispatchCount:1,dispatchAttemptCount:1,mouseDispatchCount:1,clickedSignals:1,status:'performed',failureReason:'',terminalCount:1,
        samples:[anchor],terminal:final,sequence:{performed:true,expired:false,failed:false,busy:false,actionIndex:1,
          actions:[{name:'personaSwitch-'+targets[cycle][index],index:0,attempted:true,performed:true,failed:false,actionElapsedMs:40}]}};
    });
    const segment={personaRowInputs:rows};
    if(cycle===0)segment.cardImport={moonPersona:moon};
    return {startupPersona:{activeId:cycle?moon:'default'},personas:{profiles:clone(profiles)},
      draftAssertions:names[cycle].flatMap((stage,i)=>stage?[{stage,scopeKey:scopes[cycle][i]}]:[]),
      [cycle?'personaRestart':'archiveInteraction']:segment};
  });
  return {reports,events:[{event:'persona_seeded',cycle:1,profile_id:sunny},
    {event:'bootstrap',cycle:1,active_id:'default',profile_ids:['default',sunny]},
    {event:'bootstrap',cycle:2,active_id:moon,profile_ids:profiles.map(p=>p.id)}]};
}
const rowFirst=v=>v.reports[0].archiveInteraction.personaRowInputs[0];
const rowVerify=v=>verifyPersonaRowInputs(v.reports,v.events);
const rowRejects=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:personaRowFixture,verify:rowVerify,...row});};
test('persona rows accept seven ordered scoped inputs with independent numeric evidence',()=>{
  const proof=rowVerify(personaRowFixture());assert.equal(proof.passed,true);assert.deepEqual(proof.dispatches,[4,3]);assert.deepEqual(proof.contract,PERSONA_ROW_INPUT_CONTRACT);
});
test('persona rows reject missing repeated or reordered input steps',()=>{
  rowRejects([{id:"wb.row_step_order.55",expectedReason:"ROW_STEP_ORDER",expectedContext:{"cycle":1},mutate:v=>v.reports[0].archiveInteraction.personaRowInputs.pop()}]);
  rowRejects([{id:"wb.row_step_order.56",expectedReason:"ROW_STEP_ORDER",expectedContext:{"cycle":2},mutate:v=>v.reports[1].personaRestart.personaRowInputs[1]=clone(v.reports[1].personaRestart.personaRowInputs[0])}]);
  rowRejects([{id:"wb.row_step_order.57",expectedReason:"ROW_STEP_ORDER",expectedContext:{"cycle":1},mutate:v=>v.reports[0].archiveInteraction.personaRowInputs.reverse()}]);
});
test('persona rows reject wrong root page or target despite ready booleans',()=>{
  rowRejects([{id:"wb.row_root.58",expectedReason:"ROW_ROOT",expectedContext:{"cycle":1,"step":401},mutate:v=>{rowFirst(v).root='otherSurface';}}]);rowRejects([{id:"wb.row_trace_identity.59",expectedReason:"ROW_TRACE_IDENTITY",expectedContext:{"step":401,"trace":"terminal","field":"page"},mutate:v=>{rowFirst(v).terminal.page='memoryTasks';}}]);
  rowRejects([{id:"wb.row_target.60",expectedReason:"ROW_TARGET",expectedContext:{"cycle":1,"step":401},mutate:v=>{rowFirst(v).targetId='moon-persona';}}]);rowRejects([{id:"wb.row_control.61",expectedReason:"ROW_CONTROL",expectedContext:{"cycle":1,"step":401},mutate:v=>{rowFirst(v).control='personaSwitch-default';}}]);
});
test('persona rows reject seed import profile or startup identity substitutions',()=>{
  rowRejects([{id:"wb.row_seeded_id.62",expectedReason:"ROW_SEEDED_ID",expectedContext:{},mutate:v=>{v.events[0].profile_id='other-seed';}}]);
  rowRejects([{id:"wb.row_moon_id.63",expectedReason:"ROW_MOON_ID",expectedContext:{},mutate:v=>{v.reports[0].archiveInteraction.cardImport.moonPersona='frost-persona';}}]);
  rowRejects([{id:"wb.row_startup_profile_ids.64",expectedReason:"ROW_STARTUP_PROFILE_IDS",expectedContext:{},mutate:v=>{v.reports[1].startupPersona.activeId='default';}}]);
  rowRejects([{id:"wb.row_profiles_restart.65",expectedReason:"ROW_PROFILES_RESTART",expectedContext:{},mutate:v=>{v.reports[0].personas.profiles[3].id='other-frost';}}]);
});
test('persona rows reject old scope epoch source identity or generation',()=>{
  rowRejects([{id:"wb.row_scope_anchor.66",expectedReason:"ROW_SCOPE_ANCHOR",expectedContext:{"cycle":1,"step":401},mutate:v=>{rowFirst(v).scope='builtin-persona:0:'+h(1);}}]);
  rowRejects([{id:"wb.row_source.67",expectedReason:"ROW_SOURCE",expectedContext:{"cycle":1,"step":401},mutate:v=>{rowFirst(v).sourcePersonaId='frost-persona';}}]);
  rowRejects([{id:"wb.row_trace_identity.68",expectedReason:"ROW_TRACE_IDENTITY",expectedContext:{"step":401,"trace":"terminal","field":"generation"},mutate:v=>{rowFirst(v).terminal.generation++;}}]);
  rowRejects([{id:"wb.row_scope_advances.69",expectedReason:"ROW_SCOPE_ADVANCES",expectedContext:{"cycle":1,"step":422},mutate:v=>{v.reports[0].archiveInteraction.personaRowInputs[3].scope=rowFirst(v).scope;}}]);
});
test('persona rows reject hidden duplicate target and incomplete profile membership',()=>{
  rowRejects([{id:"wb.row_target_unique.70",expectedReason:"ROW_TARGET_UNIQUE",expectedContext:{"step":401,"field":"controlCount"},mutate:v=>{rowFirst(v).terminal.controlCount=2;}}]);rowRejects([{id:"wb.row_target_unique.71",expectedReason:"ROW_TARGET_UNIQUE",expectedContext:{"step":401,"field":"rowCount"},mutate:v=>{rowFirst(v).terminal.rowCount=0;}}]);
  rowRejects([{id:"wb.row_target_unique.72",expectedReason:"ROW_TARGET_UNIQUE",expectedContext:{"step":401,"field":"targetProfileCount"},mutate:v=>{rowFirst(v).terminal.targetProfileCount=0;}}]);rowRejects([{id:"wb.row_target_unique.73",expectedReason:"ROW_TARGET_UNIQUE",expectedContext:{"step":401,"field":"activeProfileCount"},mutate:v=>{rowFirst(v).terminal.activeProfileCount=2;}}]);
  rowRejects([{id:"wb.row_eligible.74",expectedReason:"ROW_ELIGIBLE",expectedContext:{"step":401,"field":"rowInactive"},mutate:v=>{rowFirst(v).terminal.rowInactive=false;}}]);rowRejects([{id:"wb.row_model_id.75",expectedReason:"ROW_MODEL_ID",expectedContext:{"step":401,"trace":"terminal"},mutate:v=>{rowFirst(v).terminal.rowId='other-id';}}]);
  rowRejects([{id:"wb.row_target_active.76",expectedReason:"ROW_TARGET_ACTIVE",expectedContext:{"step":401,"trace":"terminal"},mutate:v=>{rowFirst(v).terminal.rowActive=true;}}]);rowRejects([{id:"wb.row_model_data_type.77",expectedReason:"ROW_MODEL_DATA_TYPE",expectedContext:{"step":401,"trace":"terminal"},mutate:v=>{rowFirst(v).terminal.modelDataType='QString';}}]);
});
test('persona rows reject unknown trace values instead of defaulting to zero',()=>{
  rowRejects([{id:"wb.row_trace_count.78",expectedReason:"ROW_TRACE_COUNT",expectedContext:{"step":401,"trace":"terminal","field":"sourceProfileCount"},mutate:v=>{delete rowFirst(v).terminal.sourceProfileCount;}}]);rowRejects([{id:"wb.row_opacity.79",expectedReason:"ROW_OPACITY",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.effectiveOpacity=null;}}]);
  rowRejects([{id:"wb.row_trace_boolean.80",expectedReason:"ROW_TRACE_BOOLEAN",expectedContext:{"step":401,"trace":"sample","sampleIndex":0,"field":"generationMatches"},mutate:v=>{rowFirst(v).samples[0].generationMatches=null;}}]);rowRejects([{id:"wb.row_scheduling_interval.81",expectedReason:"ROW_SCHEDULING_INTERVAL",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.schedulingIntervalMs=null;}}]);
  rowRejects([{id:"wb.row_reveal_numeric.82",expectedReason:"ROW_REVEAL_NUMERIC",expectedContext:{"step":401,"scrollIndex":0,"field":"afterY"},mutate:v=>{rowFirst(v).terminal.reveal.scrolls[0].afterY=null;}}]);
});
test('persona rows reject missing duplicate or overbounded terminal and sample records',()=>{
  rowRejects([{id:"wb.row_terminal_shape.83",expectedReason:"ROW_TERMINAL_SHAPE",expectedContext:{"step":401},mutate:v=>{delete rowFirst(v).terminal;}}]);rowRejects([{id:"wb.row_terminal_count.84",expectedReason:"ROW_TERMINAL_COUNT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminalCount=2;}}]);
  rowRejects([{id:"wb.row_samples.85",expectedReason:"ROW_SAMPLES",expectedContext:{"step":401},mutate:v=>{rowFirst(v).samples=[];}}]);rowRejects([{id:"wb.row_samples.86",expectedReason:"ROW_SAMPLES",expectedContext:{"step":401},mutate:v=>{rowFirst(v).samples=Array(7).fill(rowFirst(v).samples[0]);}}]);
});
test('persona rows reject expired dispatch and renewed four second budgets',()=>{
  rowRejects([{id:"wb.row_dispatch_elapsed.87",expectedReason:"ROW_DISPATCH_ELAPSED",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.dispatchElapsedMs=4000;}}]);rowRejects([{id:"wb.row_deadline.88",expectedReason:"ROW_DEADLINE",expectedContext:{"step":401},mutate:v=>{rowFirst(v).deadlineMs=4001;}}]);
  rowRejects([{id:"wb.row_terminal_elapsed.89",expectedReason:"ROW_TERMINAL_ELAPSED",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.elapsedMs=4000;}}]);rowRejects([{id:"wb.row_reveal_elapsed.90",expectedReason:"ROW_REVEAL_ELAPSED",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.reveal.elapsedMs=4000;}}]);
});
test('persona rows reject insufficient stability absent new frame and changed anchor',()=>{
  rowRejects([{id:"wb.row_stability.91",expectedReason:"ROW_STABILITY",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.layout.stableSinceMs=1;}}]);
  rowRejects([{id:"wb.row_stability.92",expectedReason:"ROW_STABILITY",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.layout.stableFrameSerial=21;}}]);
  rowRejects([{id:"wb.row_trace_shape.93",expectedReason:"ROW_TRACE_SHAPE",expectedContext:{"step":401,"trace":"anchor"},mutate:v=>{delete rowFirst(v).terminal.stableAnchor;}}]);
  rowRejects([{id:"wb.row_anchor_geometry.94",expectedReason:"ROW_ANCHOR_GEOMETRY",expectedContext:{"step":401,"field":"sceneY"},mutate:v=>{rowFirst(v).terminal.stableAnchor.control.sceneY+=1;}}]);
  rowRejects([{id:"wb.row_anchor_scroll.95",expectedReason:"ROW_ANCHOR_SCROLL",expectedContext:{"step":401,"scrollIndex":0,"field":"contentHeight"},mutate:v=>{rowFirst(v).terminal.stableAnchor.control.scrolls[0].contentHeight++;}}]);
});
test('persona rows reject clipping bad integer point or intercepted hits',()=>{
  rowRejects([{id:"wb.geometry_containment.96",expectedReason:"GEOMETRY_CONTAINMENT",expectedContext:{"step":401,"section":"row-terminal"},mutate:v=>{rowFirst(v).terminal.whole.sceneY=95;}}]);rowRejects([{id:"wb.row_integer_point.97",expectedReason:"ROW_INTEGER_POINT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.control.pointX=35.5;}}]);
  rowRejects([{id:"wb.row_point_in_item.98",expectedReason:"ROW_POINT_IN_ITEM",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.control.pointY=0;}}]);rowRejects([{id:"wb.row_hit.99",expectedReason:"ROW_HIT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.hit.hitResult='other';}}]);
  rowRejects([{id:"wb.row_hit.100",expectedReason:"ROW_HIT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.hit.acceptorFound=false;}}]);
});
test('persona rows reject disabled hidden transparent and unready surfaces',()=>{
  rowRejects([{id:"wb.row_control_ready.101",expectedReason:"ROW_CONTROL_READY",expectedContext:{"step":401,"field":"enabled"},mutate:v=>{rowFirst(v).terminal.control.enabled=false;}}]);rowRejects([{id:"wb.row_control_ready.102",expectedReason:"ROW_CONTROL_READY",expectedContext:{"step":401,"field":"visible"},mutate:v=>{rowFirst(v).terminal.control.visible=false;}}]);
  rowRejects([{id:"wb.row_opacity.103",expectedReason:"ROW_OPACITY",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.effectiveOpacity=.01;}}]);rowRejects([{id:"wb.row_eligible.104",expectedReason:"ROW_ELIGIBLE",expectedContext:{"step":401,"field":"surfaceReady"},mutate:v=>{rowFirst(v).terminal.surfaceReady=false;}}]);
});
test('persona rows reject missing clicked signal or more than one actual dispatch',()=>{
  rowRejects([{id:"wb.row_signal_observer.105",expectedReason:"ROW_SIGNAL_OBSERVER",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.signalObserverValid=false;}}]);rowRejects([{id:"wb.row_clicked_signals.106",expectedReason:"ROW_CLICKED_SIGNALS",expectedContext:{"step":401},mutate:v=>{rowFirst(v).clickedSignals=null;}}]);
  rowRejects([{id:"wb.row_terminal_clicked_signals.107",expectedReason:"ROW_TERMINAL_CLICKED_SIGNALS",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.clickedSignals=0;}}]);rowRejects([{id:"wb.row_dispatch_count.108",expectedReason:"ROW_DISPATCH_COUNT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).dispatchCount=2;}}]);
  rowRejects([{id:"wb.row_terminal_dispatch_count.109",expectedReason:"ROW_TERMINAL_DISPATCH_COUNT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal.dispatchCount=2;}}]);
});
test('persona rows reject reentry postclick exception and fabricated sequence completion',()=>{
  rowRejects([{id:"wb.row_sequence_state.110",expectedReason:"ROW_SEQUENCE_STATE",expectedContext:{"step":401},mutate:v=>{rowFirst(v).sequence.busy=true;}}]);rowRejects([{id:"wb.row_sequence_state.111",expectedReason:"ROW_SEQUENCE_STATE",expectedContext:{"step":401},mutate:v=>{rowFirst(v).sequence.failed=true;}}]);
  rowRejects([{id:"wb.row_sequence_action.112",expectedReason:"ROW_SEQUENCE_ACTION",expectedContext:{"step":401},mutate:v=>{rowFirst(v).sequence.actions[0].attempted=false;}}]);rowRejects([{id:"wb.row_sequence_count.113",expectedReason:"ROW_SEQUENCE_COUNT",expectedContext:{"step":401},mutate:v=>{rowFirst(v).sequence.actions.push(clone(rowFirst(v).sequence.actions[0]));}}]);
  rowRejects([{id:"wb.row_status.114",expectedReason:"ROW_STATUS",expectedContext:{"step":401},mutate:v=>{rowFirst(v).status='failed';rowFirst(v).failureReason='dispatch-exception';}}]);
});
test('persona rows reject escaped scroll bounds and unsolicited visible row scrolling',()=>{
  rowRejects([{id:"wb.row_reveal_bounds.115",expectedReason:"ROW_REVEAL_BOUNDS",expectedContext:{"step":401,"scrollIndex":0},mutate:v=>{rowFirst(v).terminal.reveal.scrolls[0].afterY=401;}}]);
  rowRejects([{id:"wb.row_reveal_write_evidence.116",expectedReason:"ROW_REVEAL_WRITE_EVIDENCE",expectedContext:{"step":401,"scrollIndex":0},mutate:v=>{rowFirst(v).terminal.reveal.scrolls[0].scrolled=true;}},{id:'row.reveal.visible-scroll-with-complete-write-evidence',expectedReason:'ROW_REVEAL_VISIBLE_NO_SCROLL',expectedContext:{step:401,scrollIndex:0},mutate:v=>{const reveal=rowFirst(v).terminal.reveal;reveal.scrollCount=1;Object.assign(reveal.scrolls[0],{scrolled:true,appliedY:100,elapsedMs:40});}}]);
  rowRejects([{id:"wb.row_reveal_after_observed.117",expectedReason:"ROW_REVEAL_AFTER_OBSERVED",expectedContext:{"step":401,"scrollIndex":0},mutate:v=>{rowFirst(v).terminal.reveal.scrolls[0].afterObserved=false;}}]);
});
test('persona rows reject success booleans without numeric acquisition proof',()=>{
  rowRejects([{id:"wb.row_terminal_elapsed.118",expectedReason:"ROW_TERMINAL_ELAPSED",expectedContext:{"step":401},mutate:v=>{rowFirst(v).terminal={ready:true,passed:true,status:'performed'};}}]);
  rowRejects([{id:"wb.row_samples.119",expectedReason:"ROW_SAMPLES",expectedContext:{"step":401},mutate:v=>{delete rowFirst(v).samples;}}]);rowRejects([{id:"wb.row_sequence_state.120",expectedReason:"ROW_SEQUENCE_STATE",expectedContext:{"step":401},mutate:v=>{delete rowFirst(v).sequence;}}]);
});
test('persona rows retain separate successful proof without changing priority contract',()=>{
  assert.equal(verify(fixture()).http,25);assert.deepEqual(rowVerify(personaRowFixture()).steps,[[401,405,418,422],[506,510,518]]);
});

function rowRecordFixture(expected) {
  const row=clone(personaRowFixture().reports[0].archiveInteraction.personaRowInputs[0]);
  const values={step:expected.step,targetId:expected.targetId,sourcePersonaId:expected.sourcePersonaId,
    livePersonaId:expected.livePersonaId,listPersonaId:expected.livePersonaId,listActivePersonaId:expected.sourcePersonaId,
    scope:expected.scope,generation:expected.generation,personaEpoch:Number(expected.scope.split(':')[1]),
    listPersonaEpoch:Number(expected.scope.split(':')[1]),personaFingerprint:expected.scope.split(':')[2],
    listPersonaFingerprint:expected.scope.split(':')[2],rowId:expected.targetId};
  function visit(value) {
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=='object')return;
    for(const key of Object.keys(value)) {
      if(Object.hasOwn(values,key))value[key]=values[key];
      else if((key==='control'||key==='name')&&typeof value[key]==='string'&&value[key].startsWith('personaSwitch-'))value[key]='personaSwitch-'+expected.targetId;
      else visit(value[key]);
    }
  }
  visit(row);return row;
}
function authorFixture() {
  const value=personaRowFixture(),firstPriorityScope='moon-persona:7:'+h(4);
  value.reports[0].worldbookPriority={observed:{originalScope:firstPriorityScope,originalReadId:'author-original-read'},
    receipts:[{requestId:'author-original-read',command:'archive:get',ok:true,scope:firstPriorityScope,generation:7}]};
  for(const [cycle,steps]of [[425],[502,513,514]].entries()) {
    const rows=steps.map(step=>{
      const scope=cycle?(step===502?'moon-persona:1:':'moon-persona:3:')+h(4):firstPriorityScope;
      const generation=cycle?(step===502?1:3):7,feedback=step===514;
      const control=feedback?'authorPromptFeedback':'authorPromptSwitch-post_history';
      const layout=name=>({control:name,objectName:name,scope,ready:true,layoutStable:true,found:true,bound:true,enabled:true,visible:true,fullyVisible:true,
        surfaceClosed:true,integerPointInsideClip:true,sceneX:10,sceneY:name.includes('system')?10:40,sceneWidth:50,sceneHeight:20,
        clipX:0,clipY:0,clipWidth:100,clipHeight:100,pointX:35,pointY:name.includes('system')?20:50,
        elapsedMs:40,frameSerial:2,stableSinceMs:0,stableFrameSerial:1});
      const first=layout(feedback?control:'authorPromptSwitch-system'),second=layout(control);
      const terminal={step,scope,generation,root:'taskSurface',page:'characterTasks',windowWidth:100,windowHeight:100,elapsedMs:40,frameSerial:2,
        first,second,firstAnchor:{...first,elapsedMs:0,frameSerial:1,ready:false,layoutStable:false},
        secondAnchor:{...second,elapsedMs:0,frameSerial:1,ready:false,layoutStable:false},
        firstReveal:{geometryValid:true,expired:false,elapsedMs:0},secondReveal:feedback?{}:{geometryValid:true,expired:false,elapsedMs:0},
        performed:true,mouseDispatchCount:step===513?1:0,clickedSignals:step===513?1:null,toggledSignals:step===513?1:null};
      if(step===513)Object.assign(terminal,{mouseElapsedMs:41,mouseFrameSerial:2,hit:{acceptorFound:true,hitResult:'target'}});
      return {step,control,scope,generation,stepAtMs:1000,deadlineMs:4000,sampleLimit:6,terminalCount:1,
        samples:[{step,scope,generation,elapsedMs:0,frameSerial:1}],terminal};
    });
    (cycle?value.reports[1].personaRestart:value.reports[0].archiveInteraction).authorControlReadiness=rows;
  }
  value.reports[0].archiveInteraction.authorWriteReceipts=[];
  const changed=value.reports[1].personaRestart.authorControlReadiness[1],feedback=value.reports[1].personaRestart.authorControlReadiness[2];
  const binding={armed:true,status:'matched',failureReason:'',scope:changed.scope,generation:changed.generation,requestId:'author-disable-write',baselineCount:0};
  changed.terminal.writeBinding=binding;changed.terminal.pendingFeedbackRequestId=binding.requestId;
  const ack={requestId:binding.requestId,command:'archive:put',scope:changed.scope,generation:changed.generation,ok:true,revision:6,cardMatches:1,cardId:'moon-persona',systemEnabled:false,postHistoryEnabled:false};
  value.reports[1].personaRestart.authorWriteReceipts=[ack];value.reports[1].personaRestart.personaRestart={switchRevision:5,disabledRevision:6};
  feedback.terminal.writeReadback=clone(ack);
  return value;
}
const authorRejects=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:authorFixture,verify:v=>verifyAuthorControlReadiness(v.reports),...row});};
test('priority rejects jointly stale save ACK read and record generations',()=>rejects([{id:"wb.priority_save_baseline_generation.121",expectedReason:"PRIORITY_SAVE_BASELINE_GENERATION",expectedContext:{"cycle":1,"stage":1},mutate:v=>{
  const report=first(v),save=report.saves[0];save.generation--;
  for(const receipt of report.receipts)if([save.writeId,save.readId].includes(receipt.requestId))receipt.generation--;
}}]));
test('priority rejects jointly stale preparation write and preparation read generations',()=>rejects([{id:"wb.priority_prep_baseline_generation.122",expectedReason:"PRIORITY_PREP_BASELINE_GENERATION",expectedContext:{"cycle":1},mutate:v=>{
  const report=first(v);for(const receipt of report.receipts)if([report.observed.prepareWriteId,report.observed.prepareReadId].includes(receipt.requestId))receipt.generation--;
}}]));
test('priority rejects unbound save identity or restarted feedback input clock',()=>{
  rejects([{id:"wb.priority_save_request_binding.123",expectedReason:"PRIORITY_SAVE_REQUEST_BINDING",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).saves[0].binding.requestId='old-save-request';}}]);
  rejects([{id:"wb.priority_feedback_input_clock.124",expectedReason:"PRIORITY_FEEDBACK_INPUT_CLOCK",expectedContext:{"cycle":1,"stage":1},mutate:v=>{first(v).saves[0].feedbackInputAtMs=first(v).saves[0].readAtMs+10000;}}]);
  rejects([{id:"wb.priority_selector_clock.125",expectedReason:"PRIORITY_SELECTOR_CLOCK",expectedContext:{"cycle":1},mutate:v=>{first(v).inputs.find(i=>i.step===8).inputAtMs=first(v).inputs.find(i=>i.step===8).stepAtMs-1;}}]);
});
test('priority tail requires both real scoped persona row records',()=>{
  rejects([{id:"wb.priority_tail_row_steps.126",expectedReason:"PRIORITY_TAIL_ROW_STEPS",expectedContext:{"cycle":1},mutate:v=>{first(v).personaRowInputs.pop();}}]);rejects([{id:"wb.row_mouse_dispatch_count.127",expectedReason:"ROW_MOUSE_DISPATCH_COUNT",expectedContext:{"step":1},mutate:v=>{second(v).personaRowInputs[0].mouseDispatchCount=0;}}]);
});
test('persona row record consumes independent default live identity and actual mouse evidence',()=>{
  const expected={step:401,targetId:'sunny-persona',sourcePersonaId:'default',livePersonaId:'builtin-persona',scope:'builtin-persona:1:'+h(1),generation:1,root:'taskSurface',page:'characterTasks'};
  const record=rowRecordFixture(expected);assert.equal(verifyPersonaRowInputRecord(record,expected).passed,true);
  const rows=[
    {id:'row.mouse.dispatch-missing',expectedReason:'ROW_MOUSE_DISPATCH_COUNT',expectedContext:{step:401},mutate:r=>{r.mouseDispatchCount=0;}},
    {id:'row.mouse.terminal-dispatch-repeated',expectedReason:'ROW_TERMINAL_MOUSE_DISPATCH_COUNT',expectedContext:{step:401},mutate:r=>{r.terminal.mouseDispatchCount=2;}},
    {id:'row.mouse.point-moved',expectedReason:'ROW_MOUSE_POINT_X',expectedContext:{step:401},mutate:r=>{r.terminal.mouse.control.pointX++;}},
    {id:'row.mouse.list-active-wrong',expectedReason:'ROW_LIVE_LIST_ACTIVE',expectedContext:{step:401,trace:'mouse'},mutate:r=>{r.terminal.mouse.listActivePersonaId='wrong-source';}},
    {id:'row.live.list-epoch-wrong',expectedReason:'ROW_LIVE_LIST_EPOCH',expectedContext:{step:401,trace:'terminal'},mutate:r=>{r.terminal.listPersonaEpoch++;}},
    {id:'row.live.get-fingerprint-wrong',expectedReason:'ROW_LIVE_GET_FINGERPRINT',expectedContext:{step:401,trace:'terminal'},mutate:r=>{r.terminal.personaFingerprint=h(7);}},
    {id:'row.mouse.at-deadline',expectedReason:'ROW_MOUSE_ELAPSED',expectedContext:{step:401},mutate:r=>{r.terminal.mouseElapsedMs=4000;}},
    {id:'row.mouse.intercepted',expectedReason:'ROW_MOUSE_HIT',expectedContext:{step:401},mutate:r=>{r.terminal.mouse.hit.hitResult='other';}}
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(expected),verify:r=>verifyPersonaRowInputRecord(r,expected),...row});
});
test('author control proof binds the original and restart read scopes',()=>assert.equal(verifyAuthorControlReadiness(authorFixture().reports).passed,true));
test('author control proof rejects wrong identity duplicate step or missing dual control',()=>{
  authorRejects([{id:"wb.author_scope.128",expectedReason:"AUTHOR_SCOPE",expectedContext:{"step":425},mutate:v=>{v.reports[0].archiveInteraction.authorControlReadiness[0].scope='old-scope';}}]);
  authorRejects([{id:"wb.author_step_order.129",expectedReason:"AUTHOR_STEP_ORDER",expectedContext:{"cycle":2},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].step=502;}}]);
  authorRejects([{id:"wb.author_control_name.130",expectedReason:"AUTHOR_CONTROL_NAME",expectedContext:{"step":425,"part":"first"},mutate:v=>{v.reports[0].archiveInteraction.authorControlReadiness[0].terminal.first.objectName='authorPromptSwitch-post_history';}}]);
});
test('author control proof rejects clipping stale frame or an extended original deadline',()=>{
  authorRejects([{id:"wb.geometry_containment.131",expectedReason:"GEOMETRY_CONTAINMENT",expectedContext:{"step":425,"part":"first","section":"author-control"},mutate:v=>{v.reports[0].archiveInteraction.authorControlReadiness[0].terminal.first.sceneY=95;}}]);
  authorRejects([{id:"wb.author_new_frame.132",expectedReason:"AUTHOR_NEW_FRAME",expectedContext:{"step":502,"part":"second"},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[0].terminal.second.frameSerial=1;}}]);
  authorRejects([{id:"wb.author_mouse_elapsed.133",expectedReason:"AUTHOR_MOUSE_ELAPSED",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.mouseElapsedMs=4000;}}]);
});
test('author control proof rejects extra mouse input or missing signal',()=>{
  authorRejects([{id:"wb.author_mouse_count.134",expectedReason:"AUTHOR_MOUSE_COUNT",expectedContext:{"step":425},mutate:v=>{v.reports[0].archiveInteraction.authorControlReadiness[0].terminal.mouseDispatchCount=1;}}]);
  authorRejects([{id:"wb.author_clicked_signals.135",expectedReason:"AUTHOR_CLICKED_SIGNALS",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.clickedSignals=null;}}]);
});

const {verifyNativeEvidence,verifyNativeEvidenceRecord}=require('./native-evidence-consume.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const pairedExpected={step:401,targetId:'sunny-persona',sourcePersonaId:'default',livePersonaId:'builtin-persona',
  scope:'builtin-persona:1:'+h(1),generation:1,root:'taskSurface',page:'characterTasks'};
function pairedFiles() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-evidence-unit-'));
  const evidence=path.join(directory,'records');fs.mkdirSync(evidence);
  const cases=Array.from({length:4},(_,n)=>({caseId:`case-${n}`,filename:`case-${n}.json`,kind:'persona-row',expected:pairedExpected}));
  const contract={schema:'reverie.native-input-evidence.contract.v1',maxRecordBytes:131072,cases};
  const contractPath=path.join(directory,'contract.json');const rawContract=Buffer.from(JSON.stringify(contract));fs.writeFileSync(contractPath,rawContract);
  const manifest={schema:'reverie.native-input-evidence.manifest.v1',contractSha256:crypto.createHash('sha256').update(rawContract).digest('hex'),cases:[]};
  for(const entry of cases) {
    const raw=Buffer.from(JSON.stringify({schema:'reverie.native-input-evidence.v1',caseId:entry.caseId,record:rowRecordFixture(pairedExpected)}));
    fs.writeFileSync(path.join(evidence,entry.filename),raw);
    manifest.cases.push({caseId:entry.caseId,filename:entry.filename,kind:entry.kind,sha256:crypto.createHash('sha256').update(raw).digest('hex'),bytes:raw.length});
  }
  fs.writeFileSync(path.join(evidence,'manifest.json'),JSON.stringify(manifest));
  return {directory,evidence,contractPath,manifest};
}
test('native evidence consumer binds original bytes and independent fixed case expectations',()=>{
  const v=pairedFiles();try {
    const proof=verifyNativeEvidence(v.evidence,v.contractPath);assert.equal(proof.passed,true);assert.equal(proof.caseIds.length,4);
    assert.equal(Object.keys(proof.recordsSha256).length,4);
  }finally{fs.rmSync(v.directory,{recursive:true,force:true});}
});
test('native evidence consumer rejects changed bytes missing records and unexpected files',()=>{
  const rows=[
    {id:'native.files.length-changed',expectedReason:'NATIVE_EVIDENCE_RECORD_BYTES',expectedContext:{caseId:'case-0',file:'case-0.json'},mutate:v=>fs.appendFileSync(path.join(v.evidence,'case-0.json'),' ')},
    {id:'native.files.missing',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},mutate:v=>fs.unlinkSync(path.join(v.evidence,'case-0.json'))},
    {id:'native.files.extra',expectedReason:'NATIVE_EVIDENCE_DIRECTORY_FILES',expectedContext:{field:'files'},mutate:v=>fs.writeFileSync(path.join(v.evidence,'extra.json'),'{}')},
    {id:'native.files.same-length-hash-changed',expectedReason:'NATIVE_EVIDENCE_RECORD_HASH',expectedContext:{caseId:'case-0',file:'case-0.json'},mutate:v=>{
      const file=path.join(v.evidence,'case-0.json'),before=fs.readFileSync(file,'utf8');
      const after=before.replace('"case-0"','"case-x"');assert.notEqual(after,before);assert.equal(Buffer.byteLength(after),Buffer.byteLength(before));fs.writeFileSync(file,after);
    }}
  ];
  for(const row of rows)assertRejectedMutation({kind:'files',makeFixture:pairedFiles,verify:v=>verifyNativeEvidence(v.evidence,v.contractPath),dispose:v=>fs.rmSync(v.directory,{recursive:true,force:true}),...row});
});
test('native evidence consumer rejects repeated cases stale contracts and symlink substitution',()=>{
  const rows=[
    {id:'native.manifest.case-repeated',expectedReason:'NATIVE_EVIDENCE_MANIFEST_CASE_IDS',expectedContext:{field:'cases'},mutate:v=>{v.manifest.cases[1]=clone(v.manifest.cases[0]);fs.writeFileSync(path.join(v.evidence,'manifest.json'),JSON.stringify(v.manifest));}},
    {id:'native.contract.bytes-changed',expectedReason:'NATIVE_EVIDENCE_CONTRACT_HASH',expectedContext:{field:'contractSha256'},mutate:v=>fs.appendFileSync(v.contractPath,' ')},
    {id:'native.files.symlink',expectedReason:'NATIVE_EVIDENCE_FILE_KIND',expectedContext:{file:'case-0.json'},mutate:v=>{fs.unlinkSync(path.join(v.evidence,'case-0.json'));fs.symlinkSync(path.join(v.evidence,'case-1.json'),path.join(v.evidence,'case-0.json'));}}
  ];
  for(const row of rows)assertRejectedMutation({kind:'files',makeFixture:pairedFiles,verify:v=>verifyNativeEvidence(v.evidence,v.contractPath),dispose:v=>fs.rmSync(v.directory,{recursive:true,force:true}),...row});
});
test('native evidence record does not accept its own substituted expected identity',()=>{
  const rows=[{id:'native.record.target-substituted',expectedReason:'ROW_BINDING',expectedContext:{step:401,field:'targetId'},
    mutate:v=>{v.wrapper.record=rowRecordFixture({...pairedExpected,targetId:'other-target'});}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>({entry:{caseId:'fixed-case',kind:'persona-row',expected:clone(pairedExpected)},
    wrapper:{schema:'reverie.native-input-evidence.v1',caseId:'fixed-case',record:rowRecordFixture(pairedExpected)}}),
    verify:v=>verifyNativeEvidenceRecord(v.wrapper,v.entry),...row});
});

function pairedHeaderFixture() {
  const scope='builtin-persona:1:'+h(1),readId='receipt_header_001';
  const text='待确认 · 第1批 · 本批100条';
  const geometry={found:true,visible:true,fullyVisible:true,sceneX:10,sceneY:10,sceneWidth:360,sceneHeight:20,clipX:0,clipY:0,clipWidth:591,clipHeight:650};
  const record={schema:'reverie.candidate-header.v1',objectName:'memoryCandidatePageInfo',rootObjectName:'memoryTasks',objectCount:1,
    outsideScroll:true,page:'memory',tabIndex:0,live:true,busy:false,pageNumber:1,count:100,readRequestId:readId,scope,generation:1,frameSerial:2,
    textLength:text.length,textSha256:crypto.createHash('sha256').update(text).digest('hex'),textMatches:true,
    className:'QQuickText',inheritsQuickText:true,textFormat:0,textFormatValid:true,textFormatProperty:{exists:true,readable:true,enumProperty:true,readSucceeded:true,enumType:true,conversionSucceeded:true,memberValid:true},
    childInputObjects:{childScanComplete:true,childrenInspected:0,mouseAreaChildren:0,pointerHandlerChildren:0},
    activeFocus:false,activeFocusOnTab:false,acceptedMouseButtons:0,contentWidth:250,contentHeight:18,geometry,windowWidth:591,windowHeight:650,
    scrollFound:true,contentYBefore:0,contentYAfter:0};
  const anchor={...clone(record),frameSerial:1,elapsedMs:0},terminal={...clone(record),elapsedMs:40};
  record.settling={minimumStableMs:40,deadlineMs:10000,elapsedMs:40,stableSinceMs:0,frameSerial:2,stableFrameSerial:1,polls:2,sampleLimit:6,
    samples:[clone(anchor),clone(terminal)],anchor,terminal,companionAnchor:{},companionTerminal:{},terminalCount:1,ready:true,expired:false,failed:false};
  const rowIds=Array.from({length:100},(_,index)=>'mc_'+(index+1).toString(16).padStart(32,'0'));
  const entry={caseId:'fixed-header',kind:'candidate-header',expected:{rootObjectName:'memoryTasks',page:'memory',tabIndex:0,pageNumber:1,count:100,visible:true,
    scope,generation:1,readCommand:'memory:candidates:list',rowIds,acquisitionDeadlineMs:10000}};
  const wrapper={schema:'reverie.native-input-evidence.v1',caseId:'fixed-header',record,
    read:{command:'memory:candidates:list',envelope:{protocol_version:4,request_id:readId,command:'memory:candidates:list',persona:{persona_id:'builtin-persona',epoch:1,fingerprint:h(1)}},
      receipt:{type:'memory:candidates:result',request_id:readId,payload:{ok:true,status:'pending',persona_id:'builtin-persona',persona_epoch:1,persona_fingerprint:h(1),candidates:rowIds.map(id=>({id,status:'pending'})),has_more:false,next_cursor:null}}}};
  return {entry,wrapper};
}
test('native header evidence consumes original request response and registered page fields',()=>{
  const {entry,wrapper}=pairedHeaderFixture();assert.equal(verifyNativeEvidenceRecord(wrapper,entry).acquisitionPassed,true);
});
test('native header evidence rejects joint record IDs without an independent matching response',()=>{
  const rows=[
    {id:'native.header.self-reported-old-id',expectedReason:'CB_HEADER_08',expectedContext:{field:'readRequestId'},mutate:v=>{v.wrapper.record.readRequestId='old_header_request';v.wrapper.record.settling.anchor.readRequestId='old_header_request';v.wrapper.record.settling.terminal.readRequestId='old_header_request';}},
    {id:'native.header.response-old-id',expectedReason:'NATIVE_EVIDENCE_RESPONSE_ID',expectedContext:{caseId:'fixed-header',field:'request_id'},mutate:v=>{v.wrapper.read.receipt.request_id='old_header_request';}},
    {id:'native.header.response-id-order',expectedReason:'NATIVE_EVIDENCE_CANDIDATE_IDS',expectedContext:{caseId:'fixed-header',field:'candidates.id'},mutate:v=>{v.wrapper.read.receipt.payload.candidates.reverse();}},
    {id:'native.header.request-epoch',expectedReason:'NATIVE_EVIDENCE_REQUEST_SCOPE',expectedContext:{caseId:'fixed-header',field:'persona'},mutate:v=>{v.wrapper.read.envelope.persona.epoch++;}},
    {id:'native.header.registered-page',expectedReason:'NATIVE_EVIDENCE_HEADER_PAGE',expectedContext:{caseId:'fixed-header',field:'page'},mutate:v=>{v.entry.expected.page='settings';}}
  ];
  for(const row of rows)assertRejectedMutation({makeFixture:pairedHeaderFixture,verify:v=>verifyNativeEvidenceRecord(v.wrapper,v.entry),...row});
});

test('author switch accepts its canonical toggle with zero or one clicked signal',()=>{
  for(const clicked of [0,1]){const v=authorFixture();v.reports[1].personaRestart.authorControlReadiness[1].terminal.clickedSignals=clicked;assert.equal(verifyAuthorControlReadiness(v.reports).toggledSignals,1);}
});
test('author switch rejects missing repeated toggle or an old write despite matching click counts',()=>{
  authorRejects([{id:"wb.author_toggled_signals.136",expectedReason:"AUTHOR_TOGGLED_SIGNALS",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.toggledSignals=0;}}]);
  authorRejects([{id:"wb.author_toggled_signals.137",expectedReason:"AUTHOR_TOGGLED_SIGNALS",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.toggledSignals=2;}}]);
  authorRejects([{id:"wb.author_clicked_signals.138",expectedReason:"AUTHOR_CLICKED_SIGNALS",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.clickedSignals=2;}}]);
  authorRejects([{id:"wb.author_pending_write_id.139",expectedReason:"AUTHOR_PENDING_WRITE_ID",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[1].terminal.pendingFeedbackRequestId='old-author-write';}}]);
  authorRejects([{id:"wb.author_ack_readback.140",expectedReason:"AUTHOR_ACK_READBACK",expectedContext:{"step":514},mutate:v=>{v.reports[1].personaRestart.authorControlReadiness[2].terminal.writeReadback.requestId='old-author-write';}}]);
  authorRejects([{id:"wb.author_ack_post_history_off.141",expectedReason:"AUTHOR_ACK_POST_HISTORY_OFF",expectedContext:{"step":513},mutate:v=>{v.reports[1].personaRestart.authorWriteReceipts[0].postHistoryEnabled=true;}}]);
});

test('persona mouse readiness rejects missing while nested control remains ready',()=>{
  const rows=[{id:"row.mouse.ready.missing",expectedReason:'ROW_MOUSE_READY',expectedContext:{step:401,field:'mouse.ready'},mutate:r=>{delete r.terminal.mouse.ready;assert.equal(r.terminal.mouse.control.ready,true);}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(pairedExpected),verify:r=>verifyPersonaRowInputRecord(r,pairedExpected),...row});
});

test('persona mouse readiness rejects false while nested control remains ready',()=>{
  const rows=[{id:"row.mouse.ready.false",expectedReason:'ROW_MOUSE_READY',expectedContext:{step:401,field:'mouse.ready'},mutate:r=>{r.terminal.mouse.ready=false;assert.equal(r.terminal.mouse.control.ready,true);}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(pairedExpected),verify:r=>verifyPersonaRowInputRecord(r,pairedExpected),...row});
});

test('persona mouse readiness rejects null while nested control remains ready',()=>{
  const rows=[{id:"row.mouse.ready.null",expectedReason:'ROW_MOUSE_READY',expectedContext:{step:401,field:'mouse.ready'},mutate:r=>{r.terminal.mouse.ready=null;assert.equal(r.terminal.mouse.control.ready,true);}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(pairedExpected),verify:r=>verifyPersonaRowInputRecord(r,pairedExpected),...row});
});

test('persona mouse readiness rejects numeric one while nested control remains ready',()=>{
  const rows=[{id:"row.mouse.ready.numeric-one",expectedReason:'ROW_MOUSE_READY',expectedContext:{step:401,field:'mouse.ready'},mutate:r=>{r.terminal.mouse.ready=1;assert.equal(r.terminal.mouse.control.ready,true);}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(pairedExpected),verify:r=>verifyPersonaRowInputRecord(r,pairedExpected),...row});
});

test('persona mouse readiness rejects string true while nested control remains ready',()=>{
  const rows=[{id:"row.mouse.ready.string-true",expectedReason:'ROW_MOUSE_READY',expectedContext:{step:401,field:'mouse.ready'},mutate:r=>{r.terminal.mouse.ready='true';assert.equal(r.terminal.mouse.control.ready,true);}}];
  for(const row of rows)assertRejectedMutation({makeFixture:()=>rowRecordFixture(pairedExpected),verify:r=>verifyPersonaRowInputRecord(r,pairedExpected),...row});
});

// Harness self-checks are the only direct throws checks in this file. Each
// checks an exact helper failure identity or the original mutation exception.
const helperFailure=(reason,mutation)=>error=>{assert.deepEqual(rejectionIdentity(error),{reason,context:{mutation}});return true;};
test('negative mutation guard refuses an invalid pristine baseline',()=>{
  let mutated=false;
  assert.throws(()=>assertRejectedMutation({id:'self.baseline',makeFixture:()=>({ready:false}),
    verify:v=>assert.equal(v.ready,true,verdictReason('SELF_READY',{},'ready required')),
    mutate:v=>{mutated=true;v.ready=false;},expectedReason:'SELF_READY',expectedContext:{}}),helperFailure('NEGATIVE_BASELINE_INVALID','self.baseline'));
  assert.equal(mutated,false);
});
test('negative mutation guard refuses the wrong rejection identity',()=>{
  assert.throws(()=>assertRejectedMutation({id:'self.reason',makeFixture:()=>({ready:true}),
    verify:v=>assert.equal(v.ready,true,verdictReason('SELF_ACTUAL',{},'ready required')),
    mutate:v=>{v.ready=false;},expectedReason:'SELF_OTHER',expectedContext:{}}),helperFailure('NEGATIVE_REJECTION_MISMATCH','self.reason'));
  const failures=[
    {id:'self.unlabelled-assertion',reject:()=>assert.fail('unlabelled assertion')},
    {id:'self.type-error',reject:()=>{throw new TypeError(verdictReason('SELF_ACTUAL',{step:401,field:'mouse.ready'}));}},
    {id:'self.syntax-error',reject:()=>{throw new SyntaxError('deliberate parse error');}},
    {id:'self.io-error',reject:()=>{throw Object.assign(new Error('deliberate missing file'),{code:'ENOENT'});}},
    {id:'self.context-missing',reject:()=>assert.fail(verdictReason('SELF_ACTUAL',{step:401}))},
    {id:'self.context-wrong',reject:()=>assert.fail(verdictReason('SELF_ACTUAL',{step:405,field:'mouse.ready'}))},
    {id:'self.context-extra',reject:()=>assert.fail(verdictReason('SELF_ACTUAL',{step:401,field:'mouse.ready',extra:'unexpected'}))}
  ];
  for(const row of failures)assert.throws(()=>assertRejectedMutation({id:row.id,makeFixture:()=>({ready:true}),
    verify:v=>{if(!v.ready)row.reject();},mutate:v=>{v.ready=false;},
    expectedReason:'SELF_ACTUAL',expectedContext:{step:401,field:'mouse.ready'}}),helperFailure('NEGATIVE_REJECTION_MISMATCH',row.id));
});
test('negative mutation guard propagates the mutation exception unchanged',()=>{
  const sentinel=new TypeError('deliberate mutation exception');let reads=0;
  assert.throws(()=>assertRejectedMutation({id:'self.mutator',makeFixture:()=>({ready:true}),
    verify:v=>{reads++;assert.equal(v.ready,true,verdictReason('SELF_READY',{},'ready required'));},
    mutate:()=>{throw sentinel;},expectedReason:'SELF_READY',expectedContext:{}}),error=>error===sentinel);
  assert.equal(reads,2);
  const asyncCases=[
    {phase:'factory',overrides:{makeFixture:()=>Promise.resolve({ready:true})}},
    {phase:'mutator',overrides:{mutate:v=>{v.ready=false;return Promise.resolve();}}},
    {phase:'disposer',overrides:{dispose:()=>Promise.resolve()}}
  ];
  for(const row of asyncCases)assert.throws(()=>assertRejectedMutation({id:'self.async.'+row.phase,
    makeFixture:()=>({ready:true}),verify:v=>assert.equal(v.ready,true,verdictReason('SELF_READY',{},'ready required')),
    mutate:v=>{v.ready=false;},expectedReason:'SELF_READY',expectedContext:{},...row.overrides}),
    error=>error instanceof TypeError && error.message==='Negative fixtures require a synchronous '+row.phase);
});
test('negative mutation guard refuses an unchanged accepted fixture',()=>{
  assert.throws(()=>assertRejectedMutation({id:'self.noop',makeFixture:()=>({ready:true}),
    verify:v=>assert.equal(v.ready,true,verdictReason('SELF_READY',{},'ready required')),
    mutate:()=>{},expectedReason:'SELF_READY',expectedContext:{}}),helperFailure('NEGATIVE_NOT_REJECTED','self.noop'));
});
