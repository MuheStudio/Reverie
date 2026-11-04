'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertRejectedMutation}=require('./verdict-test-support.cjs');
const {REGEX_TEXTS,REGEX_REPLY,REGEX_BOOK_ID,A_MARKER,B_MARKER,RULES,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,
  RESTART_SAMPLES,regexModelMetadata,verifyWorldbookRegex}=require('./worldbook-regex-verdicts.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)), h=n=>n.toString(16).padStart(64,'0');
const A='p1_regex_a', B='p1_regex_b';
const geometry={found:true,visible:true,fullyVisible:true,sceneX:5,sceneY:5,sceneWidth:50,sceneHeight:20,clipX:0,clipY:0,clipWidth:100,clipHeight:100};
const layout=(scope,elapsedMs,stableSinceMs,frame)=>({ready:true,minimumStableMs:40,last:{ready:true,layoutStable:true,enabled:true,
  surfaceClosed:true,...clone(geometry),scope,elapsedMs,stableSinceMs,frameSerial:frame,stableFrameSerial:frame-1,pointX:30,pointY:15}});
const controls={29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',
  10:'worldbookUseRegex',11:'saveWorldbook',9:'worldbookEntrySelector',17:'worldbookComment',18:'worldbookRegexKeywords',
  19:'worldbookRegexKeywords',14:'memory-close',33:'nav-memory',34:'worldbookComment',35:'worldbookRegexKeywords',
  36:'nav-memory',37:'reloadWorldbook',39:'worldbookEntrySelector',21:'worldbookEntrySelector'};
function book(rules) {
  return {id:REGEX_BOOK_ID,name:'正则验收资料',scanDepth:1,tokenBudget:100,recursiveScanning:false,
    createdAt:'2026-10-25T00:00:00+00:00',updatedAt:'2026-10-25T00:00:00+00:00',
    entries:[0,1].map(i=>({id:i?B:A,comment:i?'正则 B':'正则 A',content:i?B_MARKER:A_MARKER,
      insertionOrder:i?40:30,priority:1000,enabled:true,alwaysActive:false,position:'before_char',depth:0,role:'system',
      scanDepth:null,tokenBudget:null,...clone(rules[i])}))};
}
function patternGeometry(selection=false) {
  return {fullyVisible:true,focusInTarget:true,textFormat:0,controlRect:{x:5,y:5,width:50,height:20},
    visibleRect:{x:5,y:5,width:50,height:20},viewportRect:{x:0,y:0,width:100,height:100},
    selectionRect:selection?{x:10,y:8,width:5,height:12}:{x:0,y:0,width:0,height:0},
    selectionStart:selection?9:12,selectionEnd:selection?10:12,cursorPosition:selection?10:12,
    hasSelection:selection,selectionFullyVisible:selection};
}
function diagnosticView(status,requestId,revision,bookIndex,entryIndex) {
  const text=status==='entry-error'?'正则表达式无效，本轮未使用此条目。':status==='unrun'?'本版本尚无运行诊断':'最近一次对话评估未报告此条目的问题。这不表示正则已验证有效：常驻条目不执行匹配，主模式未命中时不执行辅助模式。';
  return {status,requestId,revision,bookIndex,entryIndex,available:true,truncated:0,dirtyNote:'',text,
    codes:status==='entry-error'?['invalid_regex']:[],messages:status==='entry-error'?[text]:[]};
}
function fixture() {
  const served='builtin_default_persona',fingerprint=h(70),rest=h(50),otherBooks=2;
  const calls=[...['probe','chat','reading-fixture','reading-fixture','stop-fixture','combined-fixture'].map(kind=>({cycle:1,kind})),
    ...[1,2,3].map(stage=>({cycle:1,kind:'regex-fixture',stage,regexText:REGEX_TEXTS[stage-1],worldSettingSections:1,
      aMarkerCount:stage===1?0:1,bMarkerCount:stage===2?1:0,markerInHistory:false,worldSettingSha256:h(stage)})),{cycle:2,kind:'probe'}];
  const events=[{event:'bootstrap_started',cycle:1}],reports=[];let terminalIds;
  for(let cycle=1;cycle<=2;cycle++) {
    const restart=cycle===2,epoch=cycle*4+1,generation=cycle*10,scope=`${served}:${epoch}:${fingerprint}`;
    const observed={scope,runtimePersonaId:served,restHash:rest,elapsedMs:restart?4000:9000,baselineReadId:`baseline-read-${cycle}`,
      putCount:restart?0:4,startState:{dirty:false,activeId:'default',draftMatches:true,draftLength:restart?10:0,expectedDraftLength:restart?10:0}};
    const report={passed:true,error:'',mode:restart?'restart-readback':'change-and-effect',deadlineMs:restart?20000:45000,
      checks:(restart?RESTART_CHECKS:FIRST_CHECKS).map(name=>({name,passed:true})),observed,receipts:[],saves:[],chats:[],samples:[],inputs:[]};
    const diagnosticRaw=(revision,requestId='')=>({persona_id:served,revision,request_id:requestId,truncated:0,entries:requestId?[{
      persona_id:served,revision,request_id:requestId,book_id:REGEX_BOOK_ID,entry_id:B,book_index:otherBooks,entry_index:1,code:'invalid_regex'}]:[]});
    const receipt=(requestId,command,revision,value,request='')=>{
      const result={requestId,command,generation,scope,personaId:'default',runtimePersonaId:served,ok:true,exists:true,
        revision,archiveHash:h(revision),restHash:rest,book:clone(value),worldBookDiagnostics:diagnosticRaw(revision,request)};
      report.receipts.push(result);return result;
    };
    const dispatchScope={persona_id:served,persona_epoch:epoch,persona_fingerprint:fingerprint};
    if(!restart) {
      const ids=['message-0','message-1'];
      Object.assign(observed,{baselineRevision:20,baselineArchiveHash:h(20),baselineMessageIds:ids.slice(),otherBookCount:otherBooks,
        prepareWriteId:'prepare-write-1',prepareReadId:'prepare-read-1',preparedExpectedRevision:20,preparedRevision:21});
      receipt(observed.baselineReadId,'archive:get',20,{});
      receipt(observed.prepareWriteId,'archive:put',21,book(RULES[0]));receipt(observed.prepareReadId,'archive:get',21,book(RULES[0]));
      receipt('editor-reload-1','archive:get',21,book(RULES[0]));
      const writes=[{event:'regex_archive_put_dispatch',cycle:1,request_id:observed.prepareWriteId,expected_revision:20,...dispatchScope}];
      for(let n=0;n<3;n++) {
        const revision=22+n,writeId=`regex-write-${n+1}`,entryId=n===0?A:B;
        const save={stage:n+1,writeId,readId:`regex-read-${n+1}`,scope,generation,personaId:'default',expectedRevision:revision-1,revision,
          entryId,ruleGroup:clone(RULES[n+1][n===0?0:1]),archiveHash:h(revision),restHash:rest,book:book(RULES[n+1]),
          feedback:'已保存 · 下一轮聊天使用新 revision',binding:{armed:true,status:'matched',failureReason:'',requestId:writeId,scope,generation,baselineCount:n+1},
          readAtMs:[1950,3200,4950][n],feedbackInputAtMs:[2000,3250,5000][n],feedbackGeometry:clone(geometry),windowWidth:100,windowHeight:100,
          screenshot:`cycle-1.json.worldbook-regex-save-${n+1}.png`};
        report.saves.push(save);receipt(writeId,'archive:put',revision,book(RULES[n+1]));receipt(save.readId,'archive:get',revision,book(RULES[n+1]));
        writes.push({event:'regex_archive_put_dispatch',cycle:1,request_id:writeId,expected_revision:revision-1,...dispatchScope});
      }
      events.push(writes[0]);
      for(const stage of [1,2,3]) {
        if(stage===2)events.push(writes[1],writes[2]);if(stage===3)events.push(writes[3]);
        const requestId=`regex-chat-request-${stage}`,userId=`regex-user-${stage}`,assistantId=`regex-assistant-${stage}`,revision=[21,23,24][stage-1];
        const beforeIds=ids.slice();ids.push(userId,assistantId);
        report.chats.push({stage,requestId,scope,generation,personaId:'default',beforeIds,afterIds:ids.slice(),userId,assistantId,
          text:REGEX_TEXTS[stage-1],reply:REGEX_REPLY,revision,archiveHash:h(revision)});
        events.push({event:'regex_dispatch',cycle:1,stage,request_id:requestId,...dispatchScope},
          {event:'regex_timing',cycle:1,stage,start_delay_ms:0,delivery_delay_ms:100},
          {event:'regex_worker_spawn',cycle:1,worker_id:stage,pid:5000+stage,process_group:4000,bootstrap_pid:4100,monotonic_ns:stage*1000},
          {event:'regex_worker_exit',cycle:1,worker_id:stage,pid:5000+stage,bootstrap_pid:4100,returncode:-15,monotonic_ns:stage*1000+100});
      }
      terminalIds=ids.slice();
      Object.assign(observed,{terminalRevision:24,terminalArchiveHash:h(24),terminalMessageIds:ids.slice(),book:book(RULES[3]),
        diagnosticReadId:'post-chat-diagnostic-read'});
      receipt(observed.diagnosticReadId,'archive:get',24,book(RULES[3]),report.chats[2].requestId);
      report.samples=[0,1].map(i=>{
        const entryId=i===0?B:A,status=i===0?'entry-error':'clear',step=i===0?38:42,stepAtMs=i===0?6250:6500,inputAtMs=stepAtMs+50,
          sampledAtMs=inputAtMs+40,frame=i===0?200:240;
        const diagnostic=diagnosticView(status,report.chats[2].requestId,24,otherBooks,i===0?1:0);
        const sample={control:'worldbookRegexDiagnostics',step,entryId,value:status,ruleGroup:clone(RULES[3][i===0?1:0]),diagnostic,
          scope,generation,personaId:'default',revision:24,archiveHash:h(24),stepAtMs,inputAtMs,sampledAtMs,frame,
          layout:layout(scope,40,0,frame),geometry:clone(geometry),windowWidth:100,windowHeight:100};
        observed[i===0?'diagnosticsB':'diagnosticsA']={...clone(diagnostic),geometry:clone(sample.geometry),layout:clone(sample.layout),displayText:diagnostic.text};
        return sample;
      });
    } else {
      events.push({event:'bootstrap_started',cycle:2});
      Object.assign(observed,{restartReadId:observed.baselineReadId,baselineRevision:24,baselineArchiveHash:h(24),baselineMessageIds:terminalIds.slice(),
        finalReadId:'final-read-2',terminalRevision:24,terminalArchiveHash:h(24),terminalMessageIds:terminalIds.slice(),book:book(RULES[3]),
        restartScreenshot:'cycle-2.json.worldbook-regex-restart.png',restartScreenshotControl:'worldbookRegexDiagnostics',terminalDraftMatches:true});
      receipt(observed.baselineReadId,'archive:get',24,book(RULES[3]));receipt('editor-reload-2','archive:get',24,book(RULES[3]));
      receipt(observed.finalReadId,'archive:get',24,book(RULES[3]));
      report.samples=RESTART_SAMPLES.map(([step,entryId,control,value],i)=>{
        const offset=step===20?i:i-5,stepAtMs=step===20?500:1600,inputAtMs=stepAtMs+100,sampledAtMs=inputAtMs+40+offset*80,
          frame=(step===20?40:70)+offset*2;
        const diagnostic=control==='worldbookRegexDiagnostics'?diagnosticView('unrun','',24,otherBooks,1):{};
        return {control,step,entryId,value,ruleGroup:clone(RULES[3][entryId===A?0:1]),diagnostic,scope,generation,personaId:'default',
          revision:24,archiveHash:h(24),stepAtMs,inputAtMs,sampledAtMs,frame,
          layout:layout(scope,40+offset*80,offset*80,frame),geometry:clone(geometry),windowWidth:100,windowHeight:100};
      });
      const diagnostic=report.samples.at(-1).diagnostic;
      observed.diagnosticsB={...clone(diagnostic),geometry:clone(geometry),layout:clone(report.samples.at(-1).layout),displayText:diagnostic.text};
    }
    const entryOf={8:A,10:A,9:B,17:B,18:B,19:B,34:B,35:B,37:B,39:A,21:B};
    let saveOrdinal=0;
    report.inputs=INPUT_STEPS[cycle-1].map((step,index)=>{
      const frame=restart?[5,10,15,60,90][index]:step===39?220:index*5+5;
      const stepAtMs=restart?[100,200,300,1300,2400][index]:100+index*250;
      const row={step,control:controls[step],scope,generation,stepAtMs,inputAtMs:stepAtMs+50,elapsedMs:40,frame,
        selectedEntryId:entryOf[step]||A,layout:layout(scope,40,0,frame),windowWidth:100,windowHeight:100,
        beforeValue:null,afterValue:null,hit:{acceptorFound:true,hitResult:'target'}};
      if(step===11)row.selectedEntryId=saveOrdinal++===0?A:B;
      if(step===10) {
        row.beforeValue=false;row.afterValue=true;row.signals={kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:true};
      } else if(step===17||step===34) {
        const pattern=RULES[step===17?1:2][1].keywords[0];
        row.signals={kind:'pattern-tab-focus',mouseDispatchCount:1,keyDispatchCount:1,patternControl:'worldbookRegexKeywords',
          beforeText:pattern,afterText:pattern,geometry:patternGeometry(),focusInTarget:true,textFormat:0};
      } else if([18,19,35].includes(step)) {
        const state=step===35?2:1,before=RULES[state][1].keywords[0],after=RULES[step===18?1:step===19?2:3][1].keywords[0],selection=step===18;
        row.beforeValue=before;row.afterValue=after;delete row.hit;
        row.patternGeometry=patternGeometry(selection);
        row.signals={kind:'pattern-keyboard',action:({18:'select-quantifier',19:'replace-quantifier',35:'delete-close'})[step],mouseDispatchCount:0,
          keyDispatchCount:({18:22,19:5,35:17})[step],textChangedSignals:({18:0,19:3,35:1})[step],beforeText:before,afterText:after,
          immediateGeometry:patternGeometry(selection),performedFrame:frame-2,focusInTarget:true,textFormat:0,
          selectionStart:selection?9:12,selectionEnd:selection?10:12,selectedText:selection?'4':'',
          afterTabText:selection?null:after,afterBacktabText:selection?null:after,tabLeft:selection?null:true,backtabReturned:selection?null:true};
        row.screenshot=`cycle-1.json.worldbook-regex-${row.signals.action}.png`;
      } else if(step===30)row.signals={kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true};
      else if(step===8)row.signals={kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:otherBooks+1};
      else if([9,21,39].includes(step))row.signals={kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:step===39?1:2};
      else row.signals={kind:'button',mouseDispatchCount:1,clickedSignals:1};
      return row;
    });
    reports.push({worldbookRegex:report});
  }
  return {reports,calls,events};
}
const first=v=>v.reports[0].worldbookRegex, second=v=>v.reports[1].worldbookRegex;
const receipt=(report,id)=>report.receipts.find(x=>x.requestId===id);
const input=(v,step)=>first(v).inputs.find(x=>x.step===step);
const verify=v=>verifyWorldbookRegex(v.reports,v.calls,v.events);
const reject=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:fixture,verify,...row});};
// The first cycle can finish in the same tick as its last diagnostic sample.
// Preserve the original fixture's relative clocks and input sequence.
const diagnosticTerminalFixture=(gapMs=0)=>{
  const value=fixture(),report=first(value);
  report.observed.elapsedMs=report.samples.at(-1).sampledAtMs+gapMs;
  return value;
};
const rejectAtTerminal=rows=>{for(const row of rows)assertRejectedMutation({makeFixture:diagnosticTerminalFixture,verify,...row});};

test('accepts saved regex rules, visible keyboard edits, exact diagnostics and restart read-back',()=>{
  assert.deepEqual(verify(fixture()),{passed:true,checks:[10,4],http:3,preparationWrites:[1,0],saveWrites:[3,0],chats:[3,0]});
});
test('accepts the real Qt ordinary integer PlainText representation after JSON serialization',()=>{
  const value=JSON.parse(JSON.stringify(fixture()));
  assert.equal(input(value,19).signals.textFormat,0);
  assert.equal(input(value,19).signals.immediateGeometry.textFormat,0);
  assert.equal(input(value,19).patternGeometry.textFormat,0);
  assert.equal(verify(value).passed,true);
});
test('keeps the old real Qt PlainText enum-name report rejected by the strict GUI verifier',()=>reject([
  {id:'regex.old-real-qt-plaintext-string',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{
    const row=input(v,19);row.signals.textFormat='PlainText';row.signals.immediateGeometry.textFormat='PlainText';row.patternGeometry.textFormat='PlainText';
  }},
]));
test('rejects every nonnumeric or unsupported top-level pattern format without coercion',()=>reject([
  {id:'regex.format-string-zero',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat='0';}},
  {id:'regex.format-null',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat=null;}},
  {id:'regex.format-missing',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{delete input(v,19).signals.textFormat;}},
  {id:'regex.format-false',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat=false;}},
  {id:'regex.format-true',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat=true;}},
  {id:'regex.format-unknown',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat=91;}},
]));
test('rejects enum names and invalid immediate geometry formats at the shared production guard',()=>reject([
  {id:'regex.immediate-format-plaintext',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{input(v,19).signals.immediateGeometry.textFormat='PlainText';}},
  {id:'regex.immediate-format-null',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{input(v,19).signals.immediateGeometry.textFormat=null;}},
  {id:'regex.immediate-format-missing',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{delete input(v,19).signals.immediateGeometry.textFormat;}},
  {id:'regex.immediate-format-false',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{input(v,19).signals.immediateGeometry.textFormat=false;}},
  {id:'regex.immediate-format-unknown',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{input(v,19).signals.immediateGeometry.textFormat=91;}},
  {id:'regex.immediate-format-rich',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{input(v,19).signals.immediateGeometry.textFormat=1;}},
]));
test('rejects invalid stable geometry formats at the same unmodified production guard',()=>reject([
  {id:'regex.stable-format-plaintext',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{input(v,19).patternGeometry.textFormat='PlainText';}},
  {id:'regex.stable-format-null',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{input(v,19).patternGeometry.textFormat=null;}},
  {id:'regex.stable-format-missing',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{delete input(v,19).patternGeometry.textFormat;}},
  {id:'regex.stable-format-false',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{input(v,19).patternGeometry.textFormat=false;}},
  {id:'regex.stable-format-unknown',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{input(v,19).patternGeometry.textFormat=91;}},
  {id:'regex.stable-format-rich',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'stable-pattern'},mutate:v=>{input(v,19).patternGeometry.textFormat=1;}},
]));
test('counts regex markers only inside completed system world-setting sections',()=>{
  const begin='=== WORLD SETTING (MATCH-ACTIVATED) ===\n',end='\nThe activated world setting above is user-configured role context.';
  const both=regexModelMetadata([{role:'system',content:begin+A_MARKER+'\n\n'+B_MARKER+end}]);
  assert.deepEqual([both.worldSettingSections,both.aMarkerCount,both.bMarkerCount,both.markerInHistory],[1,1,1,false]);
  const mixed=regexModelMetadata([{role:'user',content:A_MARKER},{role:'system',content:B_MARKER}]);
  assert.deepEqual([mixed.worldSettingSections,mixed.aMarkerCount,mixed.bMarkerCount,mixed.markerInHistory],[0,0,0,true]);
  assert.equal(regexModelMetadata([{role:'system',content:begin+A_MARKER}]).worldSettingSections,0);
});
test('rejects extra requests and wrong cycle placement before marker claims',()=>reject([
  {id:'regex.http-extra',expectedReason:'REGEX_HTTP_MATRIX',mutate:v=>v.calls.push({cycle:2,kind:'regex-fixture'})},
  {id:'regex.http-order',expectedReason:'REGEX_HTTP_MATRIX',mutate:v=>{[v.calls[5],v.calls[6]]=[v.calls[6],v.calls[5]];}},
  {id:'regex.http-cycle',expectedReason:'REGEX_HTTP_MATRIX',mutate:v=>{v.calls[0].cycle=2;}},
]));
test('rejects mode, comma-pattern, isolation and history marker counterexamples',()=>reject([
  {id:'regex.literal-already-hits',expectedReason:'REGEX_REQUEST_SIGNATURE',mutate:v=>{v.calls[6].aMarkerCount=1;}},
  {id:'regex.comma-edit-not-effective',expectedReason:'REGEX_REQUEST_SIGNATURE',mutate:v=>{v.calls[7].bMarkerCount=0;}},
  {id:'regex.invalid-b-injected',expectedReason:'REGEX_REQUEST_SIGNATURE',mutate:v=>{v.calls[8].bMarkerCount=1;}},
  {id:'regex.healthy-a-lost',expectedReason:'REGEX_REQUEST_SIGNATURE',mutate:v=>{v.calls[8].aMarkerCount=0;}},
  {id:'regex.marker-from-history',expectedReason:'REGEX_REQUEST_SIGNATURE',mutate:v=>{v.calls[7].markerInHistory=true;}},
]));
test('rejects missing workers and unconfirmed cleanup',()=>reject([
  {id:'regex.worker-missing',expectedReason:'REGEX_WORKER_TOTAL',mutate:v=>{v.events=v.events.filter(e=>!(e.event==='regex_worker_spawn'&&e.worker_id===2));}},
  {id:'regex.worker-no-exit',expectedReason:'REGEX_WORKER_TOTAL',mutate:v=>{v.events=v.events.filter(e=>!(e.event==='regex_worker_exit'&&e.worker_id===2));}},
  {id:'regex.worker-unconfirmed',expectedReason:'REGEX_WORKER_TOTAL',mutate:v=>{v.events.push({event:'regex_worker_cleanup_unconfirmed'});}},
]));
test('rejects reused worker identity, foreign groups and impossible reap order',()=>reject([
  {id:'regex.worker-duplicate',expectedReason:'REGEX_WORKER_UNIQUE',mutate:v=>{v.events.filter(e=>e.event==='regex_worker_spawn')[1].worker_id=1;}},
  {id:'regex.worker-group',expectedReason:'REGEX_WORKER_SCOPE',mutate:v=>{v.events.find(e=>e.event==='regex_worker_spawn').process_group=9999;}},
  {id:'regex.worker-returncode',expectedReason:'REGEX_WORKER_REAP',expectedContext:{worker:1},mutate:v=>{v.events.find(e=>e.event==='regex_worker_exit').returncode=null;}},
  {id:'regex.worker-before-spawn',expectedReason:'REGEX_WORKER_REAP',expectedContext:{worker:1},mutate:v=>{v.events.find(e=>e.event==='regex_worker_exit').monotonic_ns=0;}},
]));
test('rejects missing dispatches, altered timing and restart writes',()=>reject([
  {id:'regex.dispatch-missing',expectedReason:'REGEX_DISPATCHES',mutate:v=>{v.events=v.events.filter(e=>!(e.event==='regex_dispatch'&&e.stage===2));}},
  {id:'regex.timing-altered',expectedReason:'REGEX_TIMING',mutate:v=>{v.events.find(e=>e.event==='regex_timing').delivery_delay_ms=1;}},
  {id:'regex.restart-write',expectedReason:'REGEX_WRITE_DISPATCH_TOTAL',mutate:v=>{v.events.push({event:'regex_archive_put_dispatch',cycle:2});}},
  {id:'regex.write-stale-revision',expectedReason:'REGEX_WRITE_DISPATCHES',expectedContext:{cycle:1},mutate:v=>{v.events.filter(e=>e.event==='regex_archive_put_dispatch')[2].expected_revision=20;}},
]));
test('rejects duplicate checks, missing start observations and changed deadlines',()=>reject([
  {id:'regex.check-duplicate',expectedReason:'REGEX_CHECK_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).checks[1].name=first(v).checks[0].name;}},
  {id:'regex.start-draft-unknown',expectedReason:'REGEX_START_STATE',expectedContext:{cycle:1},mutate:v=>{delete first(v).observed.startState.draftMatches;}},
  {id:'regex.restart-start-empty',expectedReason:'REGEX_START_STATE',expectedContext:{cycle:2},mutate:v=>{second(v).observed.startState.draftLength=0;}},
  {id:'regex.deadline-extended',expectedReason:'REGEX_DEADLINE',expectedContext:{cycle:1},mutate:v=>{first(v).deadlineMs=46000;}},
  {id:'regex.failed-report',expectedReason:'REGEX_REPORT_PASSED',expectedContext:{cycle:1},mutate:v=>{first(v).passed=false;}},
]));
test('rejects missing save acknowledgements or fresh reads and duplicated receipts',()=>reject([
  {id:'regex.ack-missing',expectedReason:'REGEX_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:put',role:'save-ack-1'},mutate:v=>{receipt(first(v),'regex-write-1').requestId='foreign-write';}},
  {id:'regex.read-missing',expectedReason:'REGEX_RECEIPT_PRESENT',expectedContext:{cycle:1,command:'archive:get',role:'save-read-2'},mutate:v=>{first(v).receipts=first(v).receipts.filter(x=>x.requestId!=='regex-read-2');}},
  {id:'regex.duplicate-receipt',expectedReason:'REGEX_RECEIPT_UNIQUE',expectedContext:{cycle:1},mutate:v=>{first(v).receipts.push(clone(first(v).receipts[0]));}},
  {id:'regex.foreign-generation',expectedReason:'REGEX_RECEIPT_GENERATION',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'editor-reload-1').generation++;}},
]));
test('rejects acknowledgement rules that coerce, split or alter saved arrays',()=>reject([
  {id:'regex.ack-bool-type',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:1,stage:1,source:'save-ack',entryIndex:0,field:'useRegex'},mutate:v=>{receipt(first(v),'regex-write-1').book.entries[0].useRegex='true';}},
  {id:'regex.ack-comma-split',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:1,stage:2,source:'save-ack',entryIndex:1,field:'keywords'},mutate:v=>{receipt(first(v),'regex-write-2').book.entries[1].keywords=['ID-(?:\\d{1','3})'];}},
  {id:'regex.ack-extra-auxiliary',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:1,stage:2,source:'save-read',entryIndex:1,field:'secondaryKeywords'},mutate:v=>{receipt(first(v),'regex-read-2').book.entries[1].secondaryKeywords=['extra'];}},
  {id:'regex.ack-case-changed',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:1,stage:3,source:'save-ack',entryIndex:1,field:'caseSensitive'},mutate:v=>{receipt(first(v),'regex-write-3').book.entries[1].caseSensitive=true;}},
]));
test('rejects reported save groups and revision bindings that differ from actual receipts',()=>reject([
  {id:'regex.save-group',expectedReason:'REGEX_SAVE_RULE_GROUP',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].ruleGroup.keywords=['lost'];}},
  {id:'regex.save-target',expectedReason:'REGEX_SAVE_VALUES',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).saves[2].entryId=A;}},
  {id:'regex.ack-revision',expectedReason:'REGEX_SAVE_ACK',expectedContext:{cycle:1,stage:1},mutate:v=>{receipt(first(v),'regex-write-1').revision++;}},
  {id:'regex.ack-rest-changed',expectedReason:'REGEX_RECEIPT_REST',expectedContext:{cycle:1,command:'archive:put',role:'save-ack-2'},mutate:v=>{receipt(first(v),'regex-write-2').restHash=h(88);}},
]));
test('rejects clipped feedback, unbound save requests and missing screenshots',()=>reject([
  {id:'regex.feedback-clipped',expectedReason:'REGEX_GEOMETRY_CONTAINMENT',expectedContext:{cycle:1,stage:1,section:'save-feedback'},mutate:v=>{first(v).saves[0].feedbackGeometry.sceneY=95;}},
  {id:'regex.save-binding',expectedReason:'REGEX_SAVE_BINDING',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).saves[1].binding.requestId='foreign-request';}},
  {id:'regex.save-image',expectedReason:'REGEX_SAVE_SCREENSHOT',expectedContext:{cycle:1,stage:3},mutate:v=>{first(v).saves[2].screenshot='unrelated.png';}},
]));
test('rejects absent or stale post-chat raw diagnostic envelopes',()=>reject([
  {id:'regex.diagnostic-missing',expectedReason:'REGEX_DIAGNOSTIC_ENVELOPE',expectedContext:{cycle:1},mutate:v=>{delete receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics;}},
  {id:'regex.diagnostic-old-request',expectedReason:'REGEX_DIAGNOSTIC_ENVELOPE',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.request_id='regex-chat-request-2';}},
  {id:'regex.diagnostic-old-revision',expectedReason:'REGEX_DIAGNOSTIC_ENVELOPE',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.revision=23;}},
  {id:'regex.diagnostic-persona',expectedReason:'REGEX_DIAGNOSTIC_ENVELOPE',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').runtimePersonaId='other-persona';}},
]));
test('rejects malformed, misplaced or unknown diagnostic records',()=>reject([
  {id:'regex.diagnostic-null-row',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries=[null];}},
  {id:'regex.diagnostic-wrong-entry',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries[0].entry_id=A;}},
  {id:'regex.diagnostic-wrong-index',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries[0].entry_index=0;}},
  {id:'regex.diagnostic-unknown-code',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries[0].code='unknown_error';}},
  {id:'regex.diagnostic-row-old-request',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:1},mutate:v=>{receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries[0].request_id='regex-chat-request-2';}},
]));
test('rejects diagnostic display claims that disagree with the current error',()=>reject([
  {id:'regex.diagnostic-ui-clear',expectedReason:'REGEX_DIAGNOSTIC_VIEW',expectedContext:{cycle:1,sampleIndex:0},mutate:v=>{first(v).samples[0].diagnostic.status='clear';}},
  {id:'regex.diagnostic-ui-codes',expectedReason:'REGEX_DIAGNOSTIC_VIEW_CODES',expectedContext:{cycle:1,sampleIndex:0},mutate:v=>{first(v).samples[0].diagnostic.codes=[];}},
  {id:'regex.diagnostic-ui-text',expectedReason:'REGEX_DIAGNOSTIC_TEXT',expectedContext:{cycle:1,sampleIndex:0},mutate:v=>{first(v).samples[0].diagnostic.text='模式有效';}},
  {id:'regex.diagnostic-display-target',expectedReason:'REGEX_DIAGNOSTIC_DISPLAY',expectedContext:{cycle:1,sampleIndex:0},mutate:v=>{first(v).observed.diagnosticsB.entryIndex=0;}},
  {id:'regex.diagnostic-stability-copied-from-b',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{first(v).samples[1].layout=clone(first(v).samples[0].layout);}},
]));
test('rejects acknowledgement-only completion without diagnostics and sampled controls',()=>reject([
  {id:'regex.only-acks-no-saves',expectedReason:'REGEX_SAVE_TOTAL',expectedContext:{cycle:1},mutate:v=>{first(v).saves=[];}},
  {id:'regex.only-acks-no-chat',expectedReason:'REGEX_CHAT_TOTAL',expectedContext:{cycle:1},mutate:v=>{first(v).chats=[];}},
  {id:'regex.only-acks-no-samples',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_SET',expectedContext:{cycle:1},mutate:v=>{first(v).samples=[];}},
  {id:'regex.reused-pre-chat-read',expectedReason:'REGEX_DIAGNOSTIC_FRESH_READ',expectedContext:{cycle:1},mutate:v=>{first(v).observed.diagnosticReadId='regex-read-3';}},
  {id:'regex.old-editor-read-cannot-be-redressed-as-diagnostic',expectedReason:'REGEX_DIAGNOSTIC_READ_ORDER',expectedContext:{cycle:1},mutate:v=>{const f=first(v),fresh=receipt(f,f.observed.diagnosticReadId),old=receipt(f,'editor-reload-1');Object.assign(old,clone(fresh),{requestId:'editor-reload-1'});f.observed.diagnosticReadId=old.requestId;}},
]));
test('rejects persisted-error claims when restart has no new evaluation',()=>reject([
  {id:'regex.restart-stale-diagnostic-request',expectedReason:'REGEX_DIAGNOSTIC_ENVELOPE',expectedContext:{cycle:2,source:'restart-baseline'},mutate:v=>{receipt(second(v),'baseline-read-2').worldBookDiagnostics.request_id='regex-chat-request-3';}},
  {id:'regex.restart-old-error',expectedReason:'REGEX_DIAGNOSTIC_RECORDS',expectedContext:{cycle:2,source:'restart-final'},mutate:v=>{receipt(second(v),'final-read-2').worldBookDiagnostics.entries=clone(receipt(first(v),'post-chat-diagnostic-read').worldBookDiagnostics.entries);}},
  {id:'regex.restart-ui-validity-claim',expectedReason:'REGEX_DIAGNOSTIC_VIEW',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics',section:'restart-diagnostic'},mutate:v=>{second(v).samples[10].diagnostic.status='clear';}},
]));
test('rejects restart configuration, history or write drift',()=>reject([
  {id:'regex.restart-mode-off',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:2,source:'restart-baseline',entryIndex:1,field:'useRegex'},mutate:v=>{receipt(second(v),'baseline-read-2').book.entries[1].useRegex=false;}},
  {id:'regex.restart-pattern-fixed',expectedReason:'REGEX_ENTRY_RULE',expectedContext:{cycle:2,source:'restart-baseline',entryIndex:1,field:'keywords'},mutate:v=>{receipt(second(v),'baseline-read-2').book.entries[1].keywords=clone(RULES[2][1].keywords);}},
  {id:'regex.restart-history',expectedReason:'REGEX_RESTART_HISTORY',expectedContext:{cycle:2},mutate:v=>{second(v).observed.baselineMessageIds.reverse();second(v).observed.terminalMessageIds.reverse();}},
  {id:'regex.restart-write-receipt',expectedReason:'REGEX_WRITE_RECEIPT_TOTAL',expectedContext:{cycle:2},mutate:v=>{second(v).receipts.push({...clone(second(v).receipts[0]),requestId:'unexpected-write',command:'archive:put'});}},
  {id:'regex.restart-draft-changed',expectedReason:'REGEX_RESTART_DRAFT',expectedContext:{cycle:2},mutate:v=>{second(v).observed.terminalDraftMatches=false;}},
]));
test('rejects missing, clipped or stale restart samples',()=>reject([
  {id:'regex.restart-samples-missing',expectedReason:'REGEX_RESTART_SAMPLE_SET',expectedContext:{cycle:2},mutate:v=>{second(v).samples.pop();}},
  {id:'regex.restart-sample-value',expectedReason:'REGEX_RESTART_SAMPLE_VALUE',expectedContext:{cycle:2,sampleIndex:1,control:'worldbookRegexKeywords'},mutate:v=>{second(v).samples[1].value='changed';}},
  {id:'regex.restart-sample-clipped',expectedReason:'REGEX_GEOMETRY_CONTAINMENT',expectedContext:{cycle:2,sampleIndex:5,control:'worldbookUseRegex',section:'restart-sample'},mutate:v=>{second(v).samples[5].geometry.sceneY=95;}},
  {id:'regex.restart-reused-stability',expectedReason:'REGEX_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:1,control:'worldbookRegexKeywords'},mutate:v=>{second(v).samples[1].layout.last.stableSinceMs=0;}},
]));
test('rejects changed real input order, scope, hit or readiness',()=>reject([
  {id:'regex.input-removed',expectedReason:'REGEX_INPUT_STEP_ORDER',expectedContext:{cycle:1},mutate:v=>{first(v).inputs.pop();}},
  {id:'regex.input-wrong-control',expectedReason:'REGEX_INPUT_CONTROL_ORDER',expectedContext:{cycle:1},mutate:v=>{input(v,17).control='worldbookKeys';}},
  {id:'regex.input-scope',expectedReason:'REGEX_INPUT_SCOPE',expectedContext:{cycle:1,step:29},mutate:v=>{first(v).inputs[0].scope='other';}},
  {id:'regex.input-hit',expectedReason:'REGEX_INPUT_HIT',expectedContext:{cycle:1,step:17},mutate:v=>{input(v,17).hit.hitResult='other';}},
  {id:'regex.input-unready',expectedReason:'REGEX_LAYOUT',expectedContext:{cycle:1,step:18,section:'input'},mutate:v=>{input(v,18).layout.last.ready=false;}},
]));
test('rejects selected-four evidence that is missing or visually clipped',()=>reject([
  {id:'regex.selection-wrong-text',expectedReason:'REGEX_PATTERN_SELECTED_FOUR',expectedContext:{cycle:1,step:18},mutate:v=>{input(v,18).signals.selectedText='1';}},
  {id:'regex.selection-wrong-offset',expectedReason:'REGEX_PATTERN_SELECTED_FOUR',expectedContext:{cycle:1,step:18},mutate:v=>{input(v,18).signals.selectionStart=8;}},
  {id:'regex.selection-clipped',expectedReason:'REGEX_PATTERN_SELECTION_VISIBLE',expectedContext:{cycle:1,step:18,section:'immediate-pattern'},mutate:v=>{input(v,18).signals.immediateGeometry.selectionRect.x=105;}},
  {id:'regex.selection-claimed-only',expectedReason:'REGEX_PATTERN_SELECTION_VISIBLE',expectedContext:{cycle:1,step:18,section:'stable-pattern'},mutate:v=>{input(v,18).patternGeometry.hasSelection=false;}},
]));
test('rejects rich text, altered key counts and Tab text insertion',()=>reject([
  {id:'regex.pattern-rich-text',expectedReason:'REGEX_PATTERN_FOCUS',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.textFormat=1;}},
  {id:'regex.pattern-key-count',expectedReason:'REGEX_PATTERN_KEYBOARD',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.keyDispatchCount=3;}},
  {id:'regex.pattern-tab-insert',expectedReason:'REGEX_PATTERN_TAB_PRESERVES_TEXT',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.afterTabText+='\t';}},
  {id:'regex.pattern-backtab-focus',expectedReason:'REGEX_PATTERN_TAB_PRESERVES_TEXT',expectedContext:{cycle:1,step:35},mutate:v=>{input(v,35).signals.backtabReturned=false;}},
]));
test('rejects later samples substituted for missing immediate geometry or fresh frames',()=>reject([
  {id:'regex.pattern-missing-immediate',expectedReason:'REGEX_PATTERN_GEOMETRY',expectedContext:{cycle:1,step:19,section:'immediate-pattern'},mutate:v=>{delete input(v,19).signals.immediateGeometry;}},
  {id:'regex.pattern-reused-frame',expectedReason:'REGEX_PATTERN_FRESH_FRAME',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).signals.performedFrame=input(v,19).frame;}},
  {id:'regex.pattern-stability-before-input',expectedReason:'REGEX_PATTERN_STABILITY_BINDING',expectedContext:{cycle:1,step:19},mutate:v=>{input(v,19).layout.last.stableFrameSerial=input(v,19).signals.performedFrame-1;}},
  {id:'regex.pattern-visible-boolean-only',expectedReason:'REGEX_PATTERN_CONTAINMENT',expectedContext:{cycle:1,step:35,section:'stable-pattern'},mutate:v=>{input(v,35).patternGeometry.controlRect.y=98;}},
  {id:'regex.pattern-visible-rect-cannot-be-viewport',expectedReason:'REGEX_PATTERN_VISIBLE_RECT',expectedContext:{cycle:1,step:35,section:'stable-pattern'},mutate:v=>{input(v,35).patternGeometry.visibleRect={x:0,y:0,width:100,height:100};}},
]));
test('rejects stale chat state, wrong dispatch and broken message pairs',()=>reject([
  {id:'regex.chat-before-second-save',expectedReason:'REGEX_CHAT_STATE',expectedContext:{cycle:1,stage:2},mutate:v=>{first(v).chats[1].revision=22;first(v).chats[1].archiveHash=h(22);}},
  {id:'regex.chat-dispatch-id',expectedReason:'REGEX_CHAT_DISPATCH_ID',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).chats[0].requestId='wrong-chat-request';}},
  {id:'regex.chat-message-pair',expectedReason:'REGEX_CHAT_PAIR',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).chats[0].userId='wrong-user';}},
  {id:'regex.chat-extra-message',expectedReason:'REGEX_CHAT_HISTORY_PREFIX',expectedContext:{cycle:1,stage:1},mutate:v=>{first(v).chats[0].afterIds.splice(2,0,'unexpected-message');}},
]));
test('rejects terminal state that is not the last saved archive and complete message suffix',()=>reject([
  {id:'regex.terminal-stale',expectedReason:'REGEX_TERMINAL_FINAL_SAVE',expectedContext:{cycle:1},mutate:v=>{first(v).observed.terminalRevision=23;first(v).observed.terminalArchiveHash=h(23);}},
  {id:'regex.terminal-history-missing',expectedReason:'REGEX_TERMINAL_HISTORY',expectedContext:{cycle:1},mutate:v=>{first(v).observed.terminalMessageIds.pop();}},
  {id:'regex.terminal-changed-restart',expectedReason:'REGEX_RESTART_UNCHANGED',expectedContext:{cycle:2},mutate:v=>{second(v).observed.terminalRevision=25;}},
  {id:'regex.restart-baseline-cannot-replace-final-read',expectedReason:'REGEX_RESTART_FINAL_READ_ORDER',expectedContext:{cycle:2},mutate:v=>{second(v).observed.finalReadId=second(v).observed.baselineReadId;}},
]));

test('accepts a first-cycle diagnostic sample in the terminal integer millisecond',()=>{
  const value=diagnosticTerminalFixture(),report=first(value);
  assert.equal(report.samples.at(-1).sampledAtMs,report.observed.elapsedMs);
  assert.equal(verify(value).passed,true);
});
test('accepts a first-cycle diagnostic sample one millisecond before the terminal snapshot',()=>{
  const value=diagnosticTerminalFixture(1),report=first(value);
  assert.equal(report.observed.elapsedMs-report.samples.at(-1).sampledAtMs,1);
  assert.equal(verify(value).passed,true);
});
test('accepts the formal 11919ms diagnostic boundary with consistently shifted fixture clocks',()=>{
  const value=fixture(),report=first(value),shiftMs=11919-report.samples.at(-1).sampledAtMs;
  // Move absolute first-cycle clocks together; layout and input elapsed times
  // remain relative durations, with every original stability interval intact.
  for(const row of report.inputs)for(const field of ['stepAtMs','inputAtMs'])row[field]+=shiftMs;
  for(const row of report.saves)for(const field of ['readAtMs','feedbackInputAtMs'])row[field]+=shiftMs;
  for(const row of report.samples)for(const field of ['stepAtMs','inputAtMs','sampledAtMs'])row[field]+=shiftMs;
  report.observed.elapsedMs=report.samples.at(-1).sampledAtMs;
  assert.equal(report.samples.at(-1).sampledAtMs,11919);
  assert.equal(report.observed.elapsedMs,11919);
  assert.equal(verify(value).passed,true);
});
test('rejects a future diagnostic sample and equal or future restart terminal boundaries',()=>{
  rejectAtTerminal([
    {id:'regex.diagnostic-sample-one-ms-future',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{first(v).observed.elapsedMs--; }},
  ]);
  reject([
    {id:'regex.restart-sample-terminal-equality',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const f=second(v);f.observed.elapsedMs=f.samples.at(-1).sampledAtMs;}},
    {id:'regex.restart-sample-one-ms-future',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const f=second(v);f.observed.elapsedMs=f.samples.at(-1).sampledAtMs-1;}},
  ]);
});
test('rejects diagnostic clock types and lower-bound violations at terminal equality',()=>rejectAtTerminal([
  {id:'regex.diagnostic-terminal-string',expectedReason:'REGEX_SEGMENT_ELAPSED',expectedContext:{cycle:1},mutate:v=>{first(v).observed.elapsedMs=String(first(v).observed.elapsedMs);}},
  {id:'regex.diagnostic-step-string',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.stepAtMs=String(s.stepAtMs);}},
  {id:'regex.diagnostic-step-missing',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{delete first(v).samples[1].stepAtMs;}},
  {id:'regex.diagnostic-step-negative',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{first(v).samples[1].stepAtMs=-1;}},
  {id:'regex.diagnostic-input-string',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.inputAtMs=String(s.inputAtMs);}},
  {id:'regex.diagnostic-input-before-step',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.inputAtMs=s.stepAtMs-1;}},
  {id:'regex.diagnostic-step-after-input',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.stepAtMs=s.inputAtMs+1;}},
  {id:'regex.diagnostic-sampled-string',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.sampledAtMs=String(s.sampledAtMs);}},
  {id:'regex.diagnostic-sampled-fraction',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{first(v).samples[1].sampledAtMs+=.5;first(v).observed.elapsedMs++;}},
  {id:'regex.diagnostic-sampled-missing',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{delete first(v).samples[1].sampledAtMs;}},
  {id:'regex.diagnostic-sampled-before-input',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.sampledAtMs=s.inputAtMs-1;}},
  {id:'regex.diagnostic-frame-string',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const s=first(v).samples[1];s.frame=String(s.frame);}},
]));
test('rejects restart clock types and lower-bound violations',()=>reject([
  {id:'regex.restart-terminal-string',expectedReason:'REGEX_SEGMENT_ELAPSED',expectedContext:{cycle:2},mutate:v=>{second(v).observed.elapsedMs=String(second(v).observed.elapsedMs);}},
  {id:'regex.restart-step-string',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.stepAtMs=String(s.stepAtMs);}},
  {id:'regex.restart-step-missing',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{delete second(v).samples[10].stepAtMs;}},
  {id:'regex.restart-step-negative',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{second(v).samples[10].stepAtMs=-1;}},
  {id:'regex.restart-input-string',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.inputAtMs=String(s.inputAtMs);}},
  {id:'regex.restart-input-before-step',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.inputAtMs=s.stepAtMs-1;}},
  {id:'regex.restart-step-after-input',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.stepAtMs=s.inputAtMs+1;}},
  {id:'regex.restart-sampled-string',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.sampledAtMs=String(s.sampledAtMs);}},
  {id:'regex.restart-sampled-fraction',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{second(v).samples[10].sampledAtMs+=.5;second(v).observed.elapsedMs++;}},
  {id:'regex.restart-sampled-missing',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics',section:'restart-sample-layout'},mutate:v=>{delete second(v).samples[10].sampledAtMs;}},
  {id:'regex.restart-sampled-before-input',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics',section:'restart-sample-layout'},mutate:v=>{const s=second(v).samples[10];s.sampledAtMs=s.inputAtMs-1;}},
  {id:'regex.restart-frame-string',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const s=second(v).samples[10];s.frame=String(s.frame);}},
]));
test('rejects the unchanged four-second sample deadline in both cycles',()=>{
  rejectAtTerminal([
    {id:'regex.diagnostic-sample-four-second-deadline',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_CLOCK',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{
      const f=first(v),s=f.samples[1];s.sampledAtMs=s.inputAtMs+4000;f.observed.elapsedMs=s.sampledAtMs;
      Object.assign(s.layout.last,{elapsedMs:4000,stableSinceMs:3960});
    }},
  ]);
  reject([
    {id:'regex.restart-sample-four-second-deadline',expectedReason:'REGEX_RESTART_SAMPLE_CLOCK',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{
      const f=second(v),s=f.samples[10];s.sampledAtMs=s.inputAtMs+4000;f.observed.elapsedMs=s.sampledAtMs+1;
      Object.assign(s.layout.last,{elapsedMs:4000,stableSinceMs:3960});
    }},
  ]);
});
test('rejects nonincreasing diagnostic time or frames and reused stability intervals',()=>rejectAtTerminal([
  {id:'regex.diagnostic-sample-time-not-increasing',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const samples=first(v).samples;samples[0].sampledAtMs=samples[1].sampledAtMs;}},
  {id:'regex.diagnostic-sample-frame-not-increasing',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{
    const samples=first(v).samples,s=samples[1];s.frame=samples[0].frame;Object.assign(s.layout.last,{frameSerial:s.frame,stableFrameSerial:s.frame-1});
  }},
  {id:'regex.diagnostic-stability-start-before-previous-sample',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{
    const samples=first(v).samples,s=samples[1];s.stepAtMs=s.inputAtMs=samples[0].sampledAtMs-1;s.layout.last.elapsedMs=s.sampledAtMs-s.inputAtMs;
  }},
  {id:'regex.diagnostic-stability-frame-before-previous-sample',expectedReason:'REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{const samples=first(v).samples;samples[1].layout.last.stableFrameSerial=samples[0].frame-1;}},
]));
test('rejects nonincreasing restart time or frames and reused stability intervals',()=>reject([
  {id:'regex.restart-sample-time-not-increasing',expectedReason:'REGEX_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{
    const samples=second(v).samples,s=samples[10];s.sampledAtMs=samples[9].sampledAtMs;Object.assign(s.layout.last,{elapsedMs:s.sampledAtMs-s.inputAtMs,stableSinceMs:s.sampledAtMs-s.inputAtMs-40});
  }},
  {id:'regex.restart-sample-frame-not-increasing',expectedReason:'REGEX_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{
    const samples=second(v).samples,s=samples[10];s.frame=samples[9].frame;Object.assign(s.layout.last,{frameSerial:s.frame,stableFrameSerial:s.frame-1});
  }},
  {id:'regex.restart-stability-start-before-previous-sample',expectedReason:'REGEX_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const samples=second(v).samples,s=samples[10];s.layout.last.stableSinceMs=samples[9].sampledAtMs-s.inputAtMs-1;}},
  {id:'regex.restart-stability-frame-before-previous-sample',expectedReason:'REGEX_RESTART_SAMPLE_FRESHNESS',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics'},mutate:v=>{const samples=second(v).samples;samples[10].layout.last.stableFrameSerial=samples[9].frame-1;}},
]));
test('rejects a 39ms stability interval in both cycles',()=>{
  rejectAtTerminal([
    {id:'regex.diagnostic-stability-under-forty-ms',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:1,sampleIndex:1},mutate:v=>{first(v).samples[1].layout.last.stableSinceMs=1;}},
  ]);
  reject([
    {id:'regex.restart-stability-under-forty-ms',expectedReason:'REGEX_STABILITY',expectedContext:{cycle:2,sampleIndex:10,control:'worldbookRegexDiagnostics',section:'restart-sample-layout'},mutate:v=>{const s=second(v).samples[10];s.layout.last.stableSinceMs=s.layout.last.elapsedMs-39;}},
  ]);
});
