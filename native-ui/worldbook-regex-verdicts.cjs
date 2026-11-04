'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {verdictReason}=require('./verdict-test-support.cjs');
// The regex editing tail of the isolated --p1-worldbook-regex
// mode. It follows the unchanged ordinary check on the default persona and owns
// three requests of the first cycle only.
const REGEX_TEXTS=Object.freeze(["正则记录一：ID-12", "正则记录二：ID-12", "正则记录三：ID-12"]);
const REGEX_REPLY='正则设置效果已核对';
const REGEX_BOOK_ID='p1_regex_book', ENTRY_A='p1_regex_a', ENTRY_B='p1_regex_b';
const A_MARKER='REGEX_A_ONLY', B_MARKER='REGEX_B_ONLY';
const RULES=Object.freeze([[{"useRegex": false, "keywords": ["ID-\\d\\d"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}, {"useRegex": true, "keywords": ["ID-(?:\\d{4})"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}], [{"useRegex": true, "keywords": ["ID-\\d\\d"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}, {"useRegex": true, "keywords": ["ID-(?:\\d{4})"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}], [{"useRegex": true, "keywords": ["ID-\\d\\d"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}, {"useRegex": true, "keywords": ["ID-(?:\\d{1,3})"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}], [{"useRegex": true, "keywords": ["ID-\\d\\d"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}, {"useRegex": true, "keywords": ["ID-(?:\\d{1,3}"], "secondaryKeywords": [], "selectiveLogic": "and_any", "caseSensitive": false}]]);
const SAVED_ENTRIES=Object.freeze([ENTRY_A,ENTRY_B,ENTRY_B]);
const EXPECTED_MARKERS=Object.freeze([[0,0],[1,1],[1,0]]);
const CHAT_STATES=Object.freeze([0,2,3]);
const FIRST_CHECKS=Object.freeze(["regex-default-baseline-read", "regex-fixture-prepared", "regex-first-chat-no-test-markers", "regex-a-enabled-saved-and-read-back", "regex-b-comma-pattern-saved-and-read-back", "regex-second-chat-both-markers", "regex-b-invalid-pattern-saved-and-read-back", "regex-third-chat-invalid-b-isolated", "regex-diagnostics-bound-to-third-chat", "regex-terminal-three-saves-six-messages-rest-unchanged"]);
const RESTART_CHECKS=Object.freeze(["regex-restart-archive-and-messages-read-back", "regex-restart-entry-a-rules", "regex-restart-entry-b-rules-and-no-diagnostic", "regex-restart-zero-writes-and-zero-chats"]);
// Real control sequence is frozen with the C++ driver.
const INPUT_STEPS=Object.freeze([[29,30,31,16,7,8,10,11,9,17,18,19,11,14,30,31,33,34,35,11,14,30,31,36,37,39],[16,7,8,21,14]]);
const CONTROLS=Object.freeze({29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',10:'worldbookUseRegex',11:'saveWorldbook',9:'worldbookEntrySelector',17:'worldbookComment',18:'worldbookRegexKeywords',19:'worldbookRegexKeywords',14:'memory-close',33:'nav-memory',34:'worldbookComment',35:'worldbookRegexKeywords',36:'nav-memory',37:'reloadWorldbook',39:'worldbookEntrySelector',21:'worldbookEntrySelector'});
const RESTART_SAMPLES=Object.freeze([[20, "p1_regex_a", "worldbookUseRegex", true], [20, "p1_regex_a", "worldbookRegexKeywords", "ID-\\d\\d"], [20, "p1_regex_a", "worldbookRegexSecondaryKeywords", ""], [20, "p1_regex_a", "worldbookSelectiveLogic", 0], [20, "p1_regex_a", "worldbookCaseSensitive", false], [22, "p1_regex_b", "worldbookUseRegex", true], [22, "p1_regex_b", "worldbookRegexKeywords", "ID-(?:\\d{1,3}"], [22, "p1_regex_b", "worldbookRegexSecondaryKeywords", ""], [22, "p1_regex_b", "worldbookSelectiveLogic", 0], [22, "p1_regex_b", "worldbookCaseSensitive", false], [22, "p1_regex_b", "worldbookRegexDiagnostics", "unrun"]]);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function regexModelMetadata(messages) {
  assert(Array.isArray(messages),verdictReason('REGEX_MODEL_MESSAGES',{},'Regex model messages missing'));
  const heading = '=== WORLD SETTING (MATCH-ACTIVATED) ===\n';
  const ending = '\nThe activated world setting above is user-configured role context.';
  const sections = [];
  for (const message of messages.filter(m=>m.role==='system')) {
    const text = String(message.content || ''); let from=0;
    while (true) {
      const at=text.indexOf(heading,from); if(at<0)break;
      const end=text.indexOf(ending,at+heading.length); if(end<0)break;
      sections.push(text.slice(at+heading.length,end)); from=end+ending.length;
    }
  }
  // Other books of the default archive may also be injected; only the two
  // fixture markers are counted, never a whole-section hash.
  const context=sections.join('\n');
  return { worldSettingSections: sections.length, aMarkerCount: context.split(A_MARKER).length-1,
    bMarkerCount: context.split(B_MARKER).length-1,
    markerInHistory: messages.some(m=>m.role!=='system' && /REGEX_[AB]_ONLY/.test(String(m.content || ''))),
    worldSettingSha256: digest(context) };
}
function wholeGeometry(g, width, height, diagnostic = {}) {
  assert(g?.found===true && g.visible===true && g.fullyVisible===true,verdictReason('REGEX_GEOMETRY_VISIBLE',diagnostic,''));
  assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(k=>Number.isFinite(g[k])),verdictReason('REGEX_GEOMETRY_NUMERIC',diagnostic,''));
  assert(g.sceneWidth>1 && g.sceneHeight>1 && g.clipWidth>0 && g.clipHeight>0 && Number.isFinite(width) && Number.isFinite(height) && width>0 && height>0,verdictReason('REGEX_GEOMETRY_SIZE',diagnostic,''));
  assert(g.clipX>=-.5 && g.clipY>=-.5 && g.clipX+g.clipWidth<=width+.5 && g.clipY+g.clipHeight<=height+.5,verdictReason('REGEX_GEOMETRY_WINDOW',diagnostic,''));
  assert(g.sceneX+.5>=g.clipX && g.sceneY+.5>=g.clipY && g.sceneX+g.sceneWidth-.5<=g.clipX+g.clipWidth && g.sceneY+g.sceneHeight-.5<=g.clipY+g.clipHeight,verdictReason('REGEX_GEOMETRY_CONTAINMENT',diagnostic,'Clipped geometry'));
}
function entryBook(book, rules, diagnostic = {}) {
  assert.equal(book?.id,REGEX_BOOK_ID,verdictReason('REGEX_BOOK_ID',diagnostic,''));
  assert.equal(book.name,'正则验收资料',verdictReason('REGEX_BOOK_NAME',diagnostic,''));
  assert(book.scanDepth===1 && book.tokenBudget===100 && book.recursiveScanning===false,verdictReason('REGEX_BOOK_RULES',diagnostic,''));
  assert.equal(book.entries?.length,2,verdictReason('REGEX_BOOK_ENTRY_COUNT',diagnostic,''));
  for(const [i,entry] of book.entries.entries()) {
    const context={...diagnostic,entryIndex:i};
    assert.equal(entry?.id,i?ENTRY_B:ENTRY_A,verdictReason('REGEX_ENTRY_ID',context,''));
    assert.equal(entry.content,i?B_MARKER:A_MARKER,verdictReason('REGEX_ENTRY_CONTENT',context,''));
    assert(entry.insertionOrder===(i?40:30)&&entry.priority===1000,verdictReason('REGEX_ENTRY_ORDER',context,''));
    assert(entry.enabled===true&&entry.alwaysActive===false,verdictReason('REGEX_ENTRY_SWITCHES',context,''));
    assert(Object.hasOwn(entry,'scanDepth')&&Object.hasOwn(entry,'tokenBudget')&&entry.scanDepth===null&&entry.tokenBudget===null,verdictReason('REGEX_ENTRY_BUDGET',context,''));
    for(const [key,value] of Object.entries(rules[i])) assert.deepEqual(entry[key],value,verdictReason('REGEX_ENTRY_RULE',{...context,field:key},''));
  }
}
function patternGeometry(g,width,height,selection,context) {
  const rect=(value,positive=true)=>value && ['x','y','width','height'].every(k=>Number.isFinite(value[k])) &&
    (positive?value.width>0&&value.height>0:value.width>=0&&value.height>=0);
  const contains=(outer,inner)=>inner.x+.5>=outer.x&&inner.y+.5>=outer.y&&inner.x+inner.width-.5<=outer.x+outer.width&&inner.y+inner.height-.5<=outer.y+outer.height;
  assert(g&&g.fullyVisible===true&&g.focusInTarget===true&&g.textFormat===0&&rect(g.controlRect)&&rect(g.visibleRect)&&rect(g.viewportRect),verdictReason('REGEX_PATTERN_GEOMETRY',context,''));
  assert(Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0&&contains({x:0,y:0,width,height},g.visibleRect)&&contains(g.visibleRect,g.controlRect)&&contains(g.viewportRect,g.visibleRect),verdictReason('REGEX_PATTERN_CONTAINMENT',context,''));
  assert(['x','y','width','height'].every(k=>Math.abs(g.visibleRect[k]-g.controlRect[k])<=.5),verdictReason('REGEX_PATTERN_VISIBLE_RECT',context,''));
  assert(integer(g.selectionStart)&&integer(g.selectionEnd)&&g.selectionEnd>=g.selectionStart&&integer(g.cursorPosition),verdictReason('REGEX_PATTERN_SELECTION_SHAPE',context,''));
  if(selection) assert(g.hasSelection===true&&g.selectionFullyVisible===true&&g.selectionStart===9&&g.selectionEnd===10&&rect(g.selectionRect)&&contains(g.visibleRect,g.selectionRect),verdictReason('REGEX_PATTERN_SELECTION_VISIBLE',context,''));
}
function verifyWorkers(events) {
  const spawns=events.filter(e=>e.event==='regex_worker_spawn'), exits=events.filter(e=>e.event==='regex_worker_exit');
  assert(events.every(e=>e.event!=='regex_worker_cleanup_unconfirmed')&&spawns.length===3&&exits.length===3,verdictReason('REGEX_WORKER_TOTAL',{},''));
  const keys=e=>`${e.cycle}:${e.bootstrap_pid}:${e.worker_id}`;
  assert(new Set(spawns.map(keys)).size===3&&new Set(exits.map(keys)).size===3,verdictReason('REGEX_WORKER_UNIQUE',{},''));
  assert(new Set(spawns.map(e=>e.bootstrap_pid)).size===1&&new Set(spawns.map(e=>e.process_group)).size===1,verdictReason('REGEX_WORKER_SCOPE',{},''));
  let previous=-1;
  for(const [index,start] of spawns.entries()) {
    const end=exits.find(e=>keys(e)===keys(start)),context={worker:index+1};
    assert(start.cycle===1&&start.worker_id===index+1&&integer(start.pid)&&start.pid>0&&integer(start.process_group)&&start.process_group>0&&integer(start.bootstrap_pid)&&start.bootstrap_pid>0&&integer(start.monotonic_ns),verdictReason('REGEX_WORKER_IDENTITY',context,''));
    assert(end&&end.pid===start.pid&&Number.isSafeInteger(end.returncode)&&integer(end.monotonic_ns)&&end.monotonic_ns>=start.monotonic_ns&&start.monotonic_ns>previous,verdictReason('REGEX_WORKER_REAP',context,''));
    previous=end.monotonic_ns;
  }
}
function diagnosticRaw(receipt, persona, revision, request, bookIndex, codes, context) {
  const d=receipt?.worldBookDiagnostics;
  assert(receipt.runtimePersonaId===persona && d && d.persona_id===persona && d.revision===revision && d.request_id===request && d.truncated===0 && Array.isArray(d.entries),verdictReason('REGEX_DIAGNOSTIC_ENVELOPE',context,''));
  assert(d.entries.every(object),verdictReason('REGEX_DIAGNOSTIC_RECORDS',context,''));
  assert.deepEqual(d.entries.map(v=>[v.persona_id,v.revision,v.request_id,v.book_id,v.entry_id,v.book_index,v.entry_index,v.code]),
    codes.map(code=>[persona,revision,request,REGEX_BOOK_ID,ENTRY_B,bookIndex,1,code]),verdictReason('REGEX_DIAGNOSTIC_RECORDS',context,''));
}
function diagnosticView(value,status,request,revision,context) {
  assert(value && value.status===status && value.available===true && value.requestId===request && value.revision===revision && value.truncated===0,verdictReason('REGEX_DIAGNOSTIC_VIEW',context,''));
  assert.deepEqual(value.codes,status==='entry-error'?['invalid_regex']:[],verdictReason('REGEX_DIAGNOSTIC_VIEW_CODES',context,''));
  const expectedText=status==='entry-error'?'正则表达式无效，本轮未使用此条目。':status==='unrun'?'本版本尚无运行诊断':'最近一次对话评估未报告此条目的问题。这不表示正则已验证有效：常驻条目不执行匹配，主模式未命中时不执行辅助模式。';
  assert(value.text===expectedText,verdictReason('REGEX_DIAGNOSTIC_TEXT',context,''));
  assert.deepEqual(value.messages,status==='entry-error'?[expectedText]:[],verdictReason('REGEX_DIAGNOSTIC_MESSAGES',context,''));
}
function uniqueIds(ids, diagnostic = {}) {
  assert(Array.isArray(ids) && ids.every(ident),verdictReason('REGEX_MESSAGE_IDS',diagnostic,'Message identities missing'));
  assert.equal(new Set(ids).size,ids.length,verdictReason('REGEX_MESSAGE_IDS_UNIQUE',diagnostic,''));
}
function scopeParts(value, diagnostic) {
  const parts=typeof value==='string'?value.split(':'):[];
  assert(parts.length===3 && ident(parts[0]) && /^\d+$/.test(parts[1]) && sha(parts[2]),verdictReason('REGEX_SCOPE_SHAPE',diagnostic,''));
  return {personaId:parts[0],epoch:Number(parts[1]),fingerprint:parts[2]};
}
function layoutEvidence(layout, scope, width, height, elapsedMs, frame, diagnostic) {
  const current=layout?.last;
  assert(layout?.ready===true && layout.minimumStableMs===40 && current?.ready===true && current.layoutStable===true && current.enabled===true &&
    current.surfaceClosed===true && current.scope===scope && current.fullyVisible===true,verdictReason('REGEX_LAYOUT',diagnostic,''));
  wholeGeometry(current,width,height,diagnostic);
  assert(integer(current.elapsedMs) && integer(current.stableSinceMs) && current.elapsedMs-current.stableSinceMs>=40 && current.elapsedMs<=elapsedMs &&
    integer(current.frameSerial) && integer(current.stableFrameSerial) && current.frameSerial>current.stableFrameSerial && current.frameSerial<=frame,
    verdictReason('REGEX_STABILITY',diagnostic,''));
  return current;
}
// allCalls is the complete ordered model-call list of the run; every call
// carries its cycle in this mode.
function verifyWorldbookRegex(reports, allCalls, events) {
  assert(Array.isArray(allCalls) && Array.isArray(events) && allCalls.every(object) && events.every(object),verdictReason('REGEX_INPUTS',{},''));
  verifyWorkers(events);
  assert(allCalls.length===10 && JSON.stringify(allCalls.map(c=>[c.cycle,c.kind]))===JSON.stringify([[1,'probe'],[1,'chat'],[1,'reading-fixture'],[1,'reading-fixture'],[1,'stop-fixture'],[1,'combined-fixture'],[1,'regex-fixture'],[1,'regex-fixture'],[1,'regex-fixture'],[2,'probe']]),verdictReason('REGEX_HTTP_MATRIX',{},''));
  const calls=allCalls.filter(c=>c.kind==='regex-fixture');
  assert.deepEqual(calls.map(c=>[c.cycle,c.stage,c.regexText,c.aMarkerCount,c.bMarkerCount,c.markerInHistory]),
    [0,1,2].map(n=>[1,n+1,REGEX_TEXTS[n],...EXPECTED_MARKERS[n],false]),
    verdictReason('REGEX_REQUEST_SIGNATURE',{},'Regex mode, comma preservation or invalid-pattern isolation did not reach the actual prompt as registered'));
  // The three requests are the last of the first cycle and precede every
  // second-cycle request.
  const positions=allCalls.map((c,i)=>c.kind==='regex-fixture'?i:null).filter(i=>i!==null);
  const firstCycle=allCalls.map((c,i)=>c.cycle===1?i:null).filter(i=>i!==null), firstRestart=allCalls.findIndex(c=>c.cycle===2);
  assert(allCalls.every(c=>c.cycle===1||c.cycle===2) && JSON.stringify(positions)===JSON.stringify(firstCycle.slice(-3)) && firstRestart>positions[2],
    verdictReason('REGEX_CALL_POSITIONS',{},'Regex requests are not the first-cycle tail'));
  assert(Array.isArray(reports) && reports.length===2,verdictReason('REGEX_REPORT_COUNT',{},''));
  const [first,restart]=reports.map(r=>r?.worldbookRegex);
  // The default persona is "default" to the window and receipts; its scope
  // and the backend events name the persona the runtime actually serves.
  const servedPersona=scopeParts(first?.observed?.scope,{cycle:1}).personaId;
  assert.deepEqual(events.filter(e=>e.event==='bootstrap_started').map(e=>e.cycle),[1,2],verdictReason('REGEX_BOOTSTRAPS',{},''));
  const dispatches=events.filter(e=>e.event==='regex_dispatch'), timing=events.filter(e=>e.event==='regex_timing');
  const writes=events.filter(e=>e.event==='regex_archive_put_dispatch');
  assert.deepEqual(dispatches.map(e=>[e.cycle,e.stage,e.persona_id]),[1,2,3].map(stage=>[1,stage,servedPersona]),verdictReason('REGEX_DISPATCHES',{},''));
  assert.deepEqual(timing.map(e=>[e.cycle,e.stage,e.start_delay_ms,e.delivery_delay_ms]),[1,2,3].map(stage=>[1,stage,0,100]),verdictReason('REGEX_TIMING',{},''));
  assert(writes.length===4 && writes.every(e=>e.cycle===1),verdictReason('REGEX_WRITE_DISPATCH_TOTAL',{},'Fixture-book writes were missing, repeated or made after the restart'));
  for(const [index,report] of [first,restart].entries()) {
    const verify=index===1, cycle=index+1, o=report?.observed;
    assert(o?.startState?.dirty===false&&o.startState.activeId==='default'&&o.startState.draftMatches===true&&o.startState.draftLength===(verify?10:0)&&o.startState.expectedDraftLength===(verify?10:0),verdictReason('REGEX_START_STATE',{cycle},''));
    if(verify) assert(o.terminalDraftMatches===true,verdictReason('REGEX_RESTART_DRAFT',{cycle},''));
    assert.equal(report?.passed,true,verdictReason('REGEX_REPORT_PASSED',{cycle},'')); assert.equal(report.error,'',verdictReason('REGEX_REPORT_ERROR',{cycle},''));
    assert(['checks','receipts','saves','chats','inputs','samples'].every(k=>Array.isArray(report[k])),verdictReason('REGEX_REPORT_ARRAYS',{cycle},''));
    assert(report.checks.every(object),verdictReason('REGEX_CHECK_ORDER',{cycle},''));
    assert(report.receipts.every(object),verdictReason('REGEX_RECEIPT_SHAPE',{cycle},''));
    assert(report.inputs.every(object),verdictReason('REGEX_INPUT_STEP_ORDER',{cycle},''));
    assert.equal(report.mode,verify?'restart-readback':'change-and-effect',verdictReason('REGEX_REPORT_MODE',{cycle},''));
    assert.equal(report.deadlineMs,verify?20000:45000,verdictReason('REGEX_DEADLINE',{cycle},'')); assert(integer(o?.elapsedMs) && o.elapsedMs<report.deadlineMs,verdictReason('REGEX_SEGMENT_ELAPSED',{cycle},''));
    assert.deepEqual(report.checks.map(c=>c.name),verify?RESTART_CHECKS:FIRST_CHECKS,verdictReason('REGEX_CHECK_ORDER',{cycle},''));
    assert(report.checks.every(c=>c.passed===true),verdictReason('REGEX_CHECKS_PASSED',{cycle},''));
    assert.equal(scopeParts(o.scope,{cycle}).personaId,servedPersona,verdictReason('REGEX_SERVED_PERSONA',{cycle},'Both cycles must serve the same default persona'));
    assert.equal(report.receipts.length,new Set(report.receipts.map(r=>r.requestId)).size,verdictReason('REGEX_RECEIPT_UNIQUE',{cycle},'Repeated receipt'));
    assert(report.receipts.every(r=>ident(r.requestId) && integer(r.generation) && typeof r.scope==='string' && r.scope.length>0 && sha(r.archiveHash) && sha(r.restHash)),
      verdictReason('REGEX_RECEIPT_SHAPE',{cycle},''));
    const receipt=(id,command,role) => {
      const found=report.receipts.filter(r=>r.requestId===id);
      assert(ident(id) && found.length===1,verdictReason('REGEX_RECEIPT_PRESENT',{cycle,command,role},'Missing actual receipt'));
      const r=found[0];
      assert(r.command===command && r.ok===true && r.personaId==='default' && r.exists===true,verdictReason('REGEX_RECEIPT_IDENTITY',{cycle,command,role},''));
      assert.equal(r.scope,o.scope,verdictReason('REGEX_RECEIPT_SCOPE',{cycle,command,role},''));
      assert.equal(r.restHash,o.restHash,verdictReason('REGEX_RECEIPT_REST',{cycle,command,role},'Untouched archive fields changed'));
      return r;
    };
    const baseline=receipt(o.baselineReadId,'archive:get','baseline-read');
    assert(baseline.revision===o.baselineRevision && baseline.archiveHash===o.baselineArchiveHash && sha(o.restHash),verdictReason('REGEX_BASELINE_ARCHIVE',{cycle},''));
    uniqueIds(o.baselineMessageIds,{cycle,ids:'baseline'});
    const generation=baseline.generation;
    assert(report.receipts.every(r=>r.generation===generation),verdictReason('REGEX_RECEIPT_GENERATION',{cycle},''));
    const puts=report.receipts.filter(r=>r.command==='archive:put');
    assert.equal(puts.length,verify?0:4,verdictReason('REGEX_WRITE_RECEIPT_TOTAL',{cycle},'')); assert.equal(o.putCount,puts.length,verdictReason('REGEX_PUT_COUNT',{cycle},''));
    assert.equal(report.saves.length,verify?0:3,verdictReason('REGEX_SAVE_TOTAL',{cycle},'')); assert.equal(report.chats.length,verify?0:3,verdictReason('REGEX_CHAT_TOTAL',{cycle},''));
    const states=[];
    if(!verify) {
      assert.deepEqual(baseline.book,{},verdictReason('REGEX_BASELINE_HAS_FIXTURE',{cycle},''));
      assert(integer(o.otherBookCount),verdictReason('REGEX_OTHER_BOOKS',{cycle},''));
      assert.equal(o.preparedExpectedRevision,o.baselineRevision,verdictReason('REGEX_PREPARED_EXPECTED_REVISION',{cycle},''));
      const prep=receipt(o.prepareWriteId,'archive:put','prepare-write'), read=receipt(o.prepareReadId,'archive:get','prepare-read');
      assert(prep.revision===o.baselineRevision+1 && prep.revision===o.preparedRevision && read.revision===prep.revision && read.archiveHash===prep.archiveHash,
        verdictReason('REGEX_PREPARATION_REVISION',{cycle},''));
      entryBook(prep.book,RULES[0],{cycle,source:'preparation'}); entryBook(read.book,RULES[0],{cycle,source:'preparation-read'});
      states.push({revision:read.revision,archiveHash:read.archiveHash});
      for(const [n,save] of report.saves.entries()) {
        const stage=n+1, context={cycle,stage}, expected=RULES[stage];
        assert(object(save) && save.stage===stage && save.entryId===SAVED_ENTRIES[n],verdictReason('REGEX_SAVE_VALUES',context,''));
        assert.deepEqual(save.ruleGroup,expected[n===0?0:1],verdictReason('REGEX_SAVE_RULE_GROUP',context,''));
        assert(save.expectedRevision===prep.revision+n && save.revision===save.expectedRevision+1,verdictReason('REGEX_SAVE_REVISION',context,''));
        assert(save.scope===o.scope && save.personaId==='default' && save.generation===generation,verdictReason('REGEX_SAVE_IDENTITY',context,''));
        const ack=receipt(save.writeId,'archive:put','save-ack-'+stage), fresh=receipt(save.readId,'archive:get','save-read-'+stage);
        assert(save.readId!==save.writeId,verdictReason('REGEX_SAVE_RECEIPTS',context,''));
        assert(ack.revision===save.revision && fresh.revision===save.revision && ack.archiveHash===save.archiveHash && fresh.archiveHash===save.archiveHash,verdictReason('REGEX_SAVE_ACK',context,''));
        assert.equal(save.restHash,o.restHash,verdictReason('REGEX_SAVE_REST_HASH',context,'Untouched archive fields changed'));
        entryBook(ack.book,expected,{...context,source:'save-ack'}); entryBook(fresh.book,expected,{...context,source:'save-read'});
        assert.deepEqual(save.book,ack.book,verdictReason('REGEX_SAVE_BOOK',context,''));
        const b=save.binding;
        assert(b?.armed===true && b.status==='matched' && b.failureReason==='' && b.requestId===save.writeId && b.scope===o.scope && b.generation===generation && integer(b.baselineCount),verdictReason('REGEX_SAVE_BINDING',context,''));
        assert(integer(save.readAtMs) && integer(save.feedbackInputAtMs) && save.feedbackInputAtMs>=save.readAtMs && save.feedbackInputAtMs-save.readAtMs<10000,verdictReason('REGEX_FEEDBACK_CLOCK',context,''));
        assert(typeof save.feedback==='string' && save.feedback.includes('已保存'),verdictReason('REGEX_SAVE_FEEDBACK',context,''));
        wholeGeometry(save.feedbackGeometry,save.windowWidth,save.windowHeight,{...context,section:'save-feedback'});
        assert(typeof save.screenshot==='string' && save.screenshot.endsWith(`.worldbook-regex-save-${stage}.png`),verdictReason('REGEX_SAVE_SCREENSHOT',context,''));
        states.push({revision:save.revision,archiveHash:save.archiveHash});
      }
      assert.deepEqual(puts.map(p=>p.requestId),[o.prepareWriteId,...report.saves.map(s=>s.writeId)],verdictReason('REGEX_PUT_ORDER',{cycle},''));
      assert.deepEqual(writes.map(d=>[d.request_id,d.persona_id,d.expected_revision]),puts.map((p,n)=>[p.requestId,servedPersona,o.baselineRevision+n]),verdictReason('REGEX_WRITE_DISPATCHES',{cycle},''));
      assert(writes.every(d=>`${d.persona_id}:${d.persona_epoch}:${d.persona_fingerprint}`===o.scope),verdictReason('REGEX_WRITE_DISPATCH_SCOPE',{cycle},''));
      entryBook(o.book,RULES[3],{cycle,source:'terminal'});
      const diag=receipt(o.diagnosticReadId,'archive:get','post-chat-diagnostics');
      assert(diag.requestId!==report.saves[2].readId && diag.revision===report.saves[2].revision && diag.archiveHash===report.saves[2].archiveHash,verdictReason('REGEX_DIAGNOSTIC_FRESH_READ',{cycle},''));
      assert(report.receipts.at(-1).requestId===o.diagnosticReadId&&report.receipts.findIndex(r=>r.requestId===o.diagnosticReadId)>report.receipts.findIndex(r=>r.requestId===report.saves[2].readId),verdictReason('REGEX_DIAGNOSTIC_READ_ORDER',{cycle},''));
      entryBook(diag.book,RULES[3],{cycle,source:'diagnostic-read'});
      diagnosticRaw(diag,servedPersona,diag.revision,report.chats[2].requestId,o.otherBookCount,['invalid_regex'],{cycle});
      assert.deepEqual(report.samples.map(v=>[v?.step,v?.entryId,v?.control,v?.value]),[[38,ENTRY_B,'worldbookRegexDiagnostics','entry-error'],[42,ENTRY_A,'worldbookRegexDiagnostics','clear']],verdictReason('REGEX_DIAGNOSTIC_SAMPLE_SET',{cycle},''));
      let previousSample;
      for(const [sampleIndex,sample] of report.samples.entries()) {
        const context={cycle,sampleIndex},status=sampleIndex===0?'entry-error':'clear';
        assert(sample.scope===o.scope&&sample.generation===generation&&sample.personaId==='default'&&sample.revision===diag.revision&&sample.archiveHash===diag.archiveHash,verdictReason('REGEX_DIAGNOSTIC_SAMPLE_BINDING',context,''));
        assert.deepEqual(sample.ruleGroup,RULES[3][sampleIndex===0?1:0],verdictReason('REGEX_DIAGNOSTIC_SAMPLE_RULE',context,''));
        diagnosticView(sample.diagnostic,status,report.chats[2].requestId,diag.revision,context);
        const displayed=o[sampleIndex===0?'diagnosticsB':'diagnosticsA'];
        diagnosticView(displayed,status,report.chats[2].requestId,diag.revision,context);
        assert(displayed.bookIndex===o.otherBookCount&&displayed.entryIndex===(sampleIndex===0?1:0)&&typeof displayed.displayText==='string'&&displayed.displayText.includes(displayed.text),verdictReason('REGEX_DIAGNOSTIC_DISPLAY',context,''));
        assert.deepEqual(displayed.geometry,sample.geometry,verdictReason('REGEX_DIAGNOSTIC_DISPLAY_GEOMETRY',context,''));
        wholeGeometry(sample.geometry,sample.windowWidth,sample.windowHeight,context);
        const liveLayout=layoutEvidence(sample.layout,sample.scope,sample.windowWidth,sample.windowHeight,sample.sampledAtMs-sample.inputAtMs,sample.frame,context);
        assert(!previousSample||(liveLayout.stableFrameSerial>=previousSample.frame&&sample.inputAtMs+liveLayout.stableSinceMs>=previousSample.sampledAtMs),verdictReason('REGEX_DIAGNOSTIC_SAMPLE_FRESHNESS',context,''));
        // The last diagnostic sample and finish can share one tick, so their
        // integer-millisecond snapshots may be equal; future samples still fail.
        assert(integer(sample.stepAtMs)&&integer(sample.inputAtMs)&&sample.inputAtMs>=sample.stepAtMs&&integer(sample.sampledAtMs)&&sample.sampledAtMs>=sample.inputAtMs&&sample.sampledAtMs-sample.inputAtMs<4000&&sample.sampledAtMs<=o.elapsedMs&&integer(sample.frame)&&sample.frame>0&&(!previousSample||sample.frame>previousSample.frame&&sample.sampledAtMs>previousSample.sampledAtMs),verdictReason('REGEX_DIAGNOSTIC_SAMPLE_CLOCK',context,''));
        previousSample=sample;
      }

    } else {
      assert(o.prepareWriteId===undefined && o.prepareReadId===undefined && o.preparedRevision===undefined,verdictReason('REGEX_RESTART_PREP_ABSENT',{cycle},''));
      entryBook(baseline.book,RULES[3],{cycle,source:'restart-baseline'});
      const terminal=first.observed;
      assert(o.restartReadId===o.baselineReadId && baseline.archiveHash===terminal.terminalArchiveHash && baseline.revision===terminal.terminalRevision &&
        o.restHash===terminal.restHash,verdictReason('REGEX_RESTART_ARCHIVE',{cycle},'Restart did not read the first-cycle terminal archive'));
      assert.deepEqual(o.baselineMessageIds,terminal.terminalMessageIds,verdictReason('REGEX_RESTART_HISTORY',{cycle},'Restart did not preserve the complete message history'));
      const finalRead=receipt(o.finalReadId,'archive:get','final-read');
      assert(o.finalReadId!==o.baselineReadId&&report.receipts.at(-1).requestId===o.finalReadId&&report.receipts.findIndex(r=>r.requestId===o.finalReadId)>report.receipts.findIndex(r=>r.requestId===o.baselineReadId),verdictReason('REGEX_RESTART_FINAL_READ_ORDER',{cycle},''));
      assert(finalRead.archiveHash===baseline.archiveHash && finalRead.revision===baseline.revision && o.terminalArchiveHash===baseline.archiveHash &&
        o.terminalRevision===baseline.revision && JSON.stringify(o.terminalMessageIds)===JSON.stringify(o.baselineMessageIds),
        verdictReason('REGEX_RESTART_UNCHANGED',{cycle},''));
      entryBook(finalRead.book,RULES[3],{cycle,source:'restart-final'});
      diagnosticRaw(baseline,servedPersona,baseline.revision,'',Number(first.observed.otherBookCount),[],{cycle,source:'restart-baseline'});
      diagnosticRaw(finalRead,servedPersona,baseline.revision,'',Number(first.observed.otherBookCount),[],{cycle,source:'restart-final'});
      assert(typeof o.restartScreenshot==='string' && o.restartScreenshot.endsWith('.worldbook-regex-restart.png') &&
        o.restartScreenshotControl==='worldbookRegexDiagnostics',verdictReason('REGEX_RESTART_SCREENSHOT',{cycle},''));
      // Separate whole-item observations; a step's samples share one input clock.
      assert(Array.isArray(report.samples) && report.samples.length===RESTART_SAMPLES.length,verdictReason('REGEX_RESTART_SAMPLE_SET',{cycle},''));
      assert.deepEqual(report.samples.map(s=>[s?.step,s?.entryId,s?.control]),RESTART_SAMPLES.map(([step,entry,control])=>[step,entry,control]),
        verdictReason('REGEX_RESTART_SAMPLE_ORDER',{cycle},''));
      let previous;
      for(const [sampleIndex,sample] of report.samples.entries()) {
        const [step,entryId,control,value]=RESTART_SAMPLES[sampleIndex], context={cycle,sampleIndex,control};
        assert(sample.scope===o.scope && sample.generation===generation && sample.personaId==='default' && sample.revision===baseline.revision &&
          sample.archiveHash===baseline.archiveHash,verdictReason('REGEX_RESTART_SAMPLE_BINDING',context,''));
        assert.deepEqual(sample.value,value,verdictReason('REGEX_RESTART_SAMPLE_VALUE',context,'The real control must show the saved rules'));
        assert.deepEqual(sample.ruleGroup,RULES[3][entryId===ENTRY_A?0:1],verdictReason('REGEX_RESTART_SAMPLE_RULE',context,''));
        if(control==='worldbookRegexDiagnostics') diagnosticView(sample.diagnostic,'unrun','',baseline.revision,{...context,section:'restart-diagnostic'});
        wholeGeometry(sample.geometry,sample.windowWidth,sample.windowHeight,{...context,section:'restart-sample'});
        const current=layoutEvidence(sample.layout,sample.scope,sample.windowWidth,sample.windowHeight,sample.sampledAtMs-sample.inputAtMs,sample.frame,{...context,section:'restart-sample-layout'});
        assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(key=>Math.abs(current[key]-sample.geometry[key])<=.5),
          verdictReason('REGEX_RESTART_SAMPLE_GEOMETRY_MATCH',context,''));
        const sameStep=previous?.step===step;
        assert(integer(sample.stepAtMs) && integer(sample.inputAtMs) && sample.inputAtMs>=sample.stepAtMs && integer(sample.sampledAtMs) &&
          sample.sampledAtMs>=sample.inputAtMs && sample.sampledAtMs-sample.inputAtMs<4000 && sample.sampledAtMs<o.elapsedMs && integer(sample.frame) && sample.frame>0 &&
          (!sameStep || (sample.stepAtMs===previous.stepAtMs && sample.inputAtMs===previous.inputAtMs)),
          verdictReason('REGEX_RESTART_SAMPLE_CLOCK',context,'A step\'s samples share its original input clock'));
        assert(!previous || (sample.sampledAtMs>previous.sampledAtMs && sample.frame>previous.frame &&
          sample.inputAtMs+current.stableSinceMs>=previous.sampledAtMs && current.stableFrameSerial>=previous.frame),
          verdictReason('REGEX_RESTART_SAMPLE_FRESHNESS',context,'Each target must acquire a fresh stability interval'));
        previous=sample;
      }
    }
    let before=o.baselineMessageIds;
    for(const [n,chat] of report.chats.entries()) {
      const stage=n+1, context={cycle,stage};
      assert(object(chat) && chat.stage===stage && chat.personaId==='default' && chat.scope===o.scope && chat.generation===generation,verdictReason('REGEX_CHAT_IDENTITY',context,''));
      assert(chat.text===REGEX_TEXTS[n] && chat.reply===REGEX_REPLY,verdictReason('REGEX_CHAT_TEXT',context,''));
      uniqueIds(chat.afterIds,context); assert.deepEqual(chat.beforeIds,before,verdictReason('REGEX_CHAT_BEFORE',context,''));
      assert.deepEqual(chat.afterIds.slice(0,-2),before,verdictReason('REGEX_CHAT_HISTORY_PREFIX',context,'Each chat adds exactly one message pair'));
      assert.deepEqual(chat.afterIds.slice(-2),[chat.userId,chat.assistantId],verdictReason('REGEX_CHAT_PAIR',context,''));
      const dispatch=dispatches[n];
      assert(ident(chat.requestId) && chat.requestId===dispatch.request_id,verdictReason('REGEX_CHAT_DISPATCH_ID',context,''));
      assert.equal(chat.scope,`${dispatch.persona_id}:${dispatch.persona_epoch}:${dispatch.persona_fingerprint}`,verdictReason('REGEX_CHAT_DISPATCH_SCOPE',context,''));
      const state=states[CHAT_STATES[n]];
      assert(chat.revision===state.revision && chat.archiveHash===state.archiveHash,verdictReason('REGEX_CHAT_STATE',context,'A chat did not read the preceding saved archive'));
      before=chat.afterIds;
    }
    if(!verify) {
      assert.deepEqual(o.terminalMessageIds,before,verdictReason('REGEX_TERMINAL_HISTORY',{cycle},''));
      assert.equal(o.terminalMessageIds.length,o.baselineMessageIds.length+6,verdictReason('REGEX_TERMINAL_MESSAGE_COUNT',{cycle},''));
      const finalSave=report.saves[2], finalRead=report.receipts.find(r=>r.requestId===o.diagnosticReadId), finalChat=report.chats[2];
      assert([finalSave,finalRead,finalChat].every(value=>o.terminalRevision===value.revision && o.terminalArchiveHash===value.archiveHash),
        verdictReason('REGEX_TERMINAL_FINAL_SAVE',{cycle},'First-cycle terminal must be the final saved and freshly read archive used by the third chat'));
    }
    assert.deepEqual(report.inputs.map(i=>i.step),INPUT_STEPS[index],verdictReason('REGEX_INPUT_STEP_ORDER',{cycle},'Real control input order changed'));
    assert.deepEqual(report.inputs.map(i=>i.control),INPUT_STEPS[index].map(step=>CONTROLS[step]),verdictReason('REGEX_INPUT_CONTROL_ORDER',{cycle},'Real control identity changed'));
    assert.deepEqual(report.inputs.filter(i=>i.control==='worldbookUseRegex').map(i=>[i.beforeValue,i.afterValue]),verify?[]:[[false,true]],verdictReason('REGEX_INPUT_VALUES',{cycle},''));
    const entryOf={8:ENTRY_A,10:ENTRY_A,9:ENTRY_B,17:ENTRY_B,18:ENTRY_B,19:ENTRY_B,34:ENTRY_B,35:ENTRY_B,37:ENTRY_B,39:ENTRY_A,21:ENTRY_B};
    for(const input of report.inputs) {
      const context={cycle,step:input.step};
      assert(input.scope===o.scope && input.generation===generation,verdictReason('REGEX_INPUT_SCOPE',context,''));
      assert(integer(input.elapsedMs) && input.elapsedMs<4000 && Number.isInteger(input.frame) && input.frame>0,verdictReason('REGEX_INPUT_DEADLINE_FRAME',context,''));
      if(entryOf[input.step]) assert.equal(input.selectedEntryId,entryOf[input.step],verdictReason('REGEX_INPUT_ENTRY',context,'An entry control acted on the wrong entry'));
      const current=layoutEvidence(input.layout,input.scope,input.windowWidth,input.windowHeight,input.elapsedMs,input.frame,{...context,section:'input'});
      if(![18,19,35].includes(input.step)) assert(input.hit?.acceptorFound===true && ['target','descendant'].includes(input.hit.hitResult),verdictReason('REGEX_INPUT_HIT',context,''));
      assert(Number.isFinite(current.pointX) && Number.isFinite(current.pointY) && current.pointX>=current.sceneX && current.pointX<=current.sceneX+current.sceneWidth &&
        current.pointY>=current.sceneY && current.pointY<=current.sceneY+current.sceneHeight && current.pointX>=current.clipX && current.pointX<=current.clipX+current.clipWidth &&
        current.pointY>=current.clipY && current.pointY<=current.clipY+current.clipHeight,verdictReason('REGEX_INPUT_POINT',context,''));
      const signal=input.signals;
      if(input.control==='worldbookUseRegex') assert.deepEqual(signal,{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:true},verdictReason('REGEX_INPUT_CHECKBOX_SIGNALS',context,''));
      else if([17,34].includes(input.step)) {
        const expected=RULES[input.step===17?1:2][1].keywords[0];
        assert(signal?.kind==='pattern-tab-focus'&&signal.mouseDispatchCount===1&&signal.keyDispatchCount===1&&signal.beforeText===expected&&signal.afterText===expected&&signal.patternControl==='worldbookRegexKeywords',verdictReason('REGEX_PATTERN_TAB',context,''));
        assert(signal.focusInTarget===true&&signal.textFormat===0,verdictReason('REGEX_PATTERN_FOCUS',context,''));
        patternGeometry(signal.geometry,input.windowWidth,input.windowHeight,false,{...context,section:'tab-pattern'});
      } else if([18,19,35].includes(input.step)) {
        const expected={18:[22,0,RULES[1][1].keywords[0],RULES[1][1].keywords[0]],19:[5,3,RULES[1][1].keywords[0],RULES[2][1].keywords[0]],35:[17,1,RULES[2][1].keywords[0],RULES[3][1].keywords[0]]}[input.step];
        assert(signal?.kind==='pattern-keyboard'&&signal.action===({18:'select-quantifier',19:'replace-quantifier',35:'delete-close'}[input.step])&&signal.mouseDispatchCount===0&&signal.keyDispatchCount===expected[0]&&signal.textChangedSignals===expected[1]&&signal.beforeText===expected[2]&&signal.afterText===expected[3],verdictReason('REGEX_PATTERN_KEYBOARD',context,''));
        assert(integer(signal.performedFrame)&&signal.performedFrame<input.frame,verdictReason('REGEX_PATTERN_FRESH_FRAME',context,''));
        assert(signal.focusInTarget===true&&signal.textFormat===0&&input.beforeValue===expected[2]&&input.afterValue===expected[3],verdictReason('REGEX_PATTERN_FOCUS',context,''));
        patternGeometry(signal.immediateGeometry,input.windowWidth,input.windowHeight,input.step===18,{...context,section:'immediate-pattern'});
        patternGeometry(input.patternGeometry,input.windowWidth,input.windowHeight,input.step===18,{...context,section:'stable-pattern'});
        const pr=input.patternGeometry.controlRect;
        assert(Math.abs(pr.x-current.sceneX)<=.5&&Math.abs(pr.y-current.sceneY)<=.5&&Math.abs(pr.width-current.sceneWidth)<=.5&&Math.abs(pr.height-current.sceneHeight)<=.5&&current.stableFrameSerial>=signal.performedFrame,verdictReason('REGEX_PATTERN_STABILITY_BINDING',context,''));
        if(input.step===18) assert(signal.selectionStart===9&&signal.selectionEnd===10&&signal.selectedText==='4'&&signal.afterTabText===null&&signal.afterBacktabText===null&&signal.tabLeft===null&&signal.backtabReturned===null,verdictReason('REGEX_PATTERN_SELECTED_FOUR',context,''));
        else assert(signal.afterTabText===expected[3]&&signal.afterBacktabText===expected[3]&&signal.tabLeft===true&&signal.backtabReturned===true,verdictReason('REGEX_PATTERN_TAB_PRESERVES_TEXT',context,''));
        assert(typeof input.screenshot==='string'&&input.screenshot.endsWith('.worldbook-regex-'+({18:'select-quantifier',19:'replace-quantifier',35:'delete-close'}[input.step])+'.png'),verdictReason('REGEX_PATTERN_SCREENSHOT',context,''));
      }
      else if(input.control==='chatComposer') assert.deepEqual(signal,{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},verdictReason('REGEX_INPUT_TEXT_SIGNALS',context,''));
      else if(input.control==='worldbookBookSelector') assert(signal?.kind==='selector' && signal.mouseDispatchCount===1 && signal.activatedSignals===1 &&
        Number.isInteger(signal.selectedIndex) && signal.selectedIndex===Number(o.otherBookCount ?? first.observed.otherBookCount)+1,verdictReason('REGEX_INPUT_SELECTOR_SIGNALS',context,'The fixture book is the last book'));
      else if(input.control==='worldbookEntrySelector') assert.deepEqual(signal,{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:input.step===39?1:2},verdictReason('REGEX_INPUT_SELECTOR_SIGNALS',context,''));
      else assert.deepEqual(signal,{kind:'button',mouseDispatchCount:1,clickedSignals:1},verdictReason('REGEX_INPUT_BUTTON_SIGNALS',context,''));
    }
  }
  return {passed:true,checks:[10,4],http:3,preparationWrites:[1,0],saveWrites:[3,0],chats:[3,0]};
}
module.exports={REGEX_TEXTS,REGEX_REPLY,REGEX_BOOK_ID,A_MARKER,B_MARKER,RULES,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,
  RESTART_SAMPLES,regexModelMetadata,patternGeometry,verifyWorldbookRegex};
