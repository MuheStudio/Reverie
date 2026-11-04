'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {verdictReason}=require('./verdict-test-support.cjs');
// The entry-level scan depth and budget tail of the isolated --p1-worldbook-entry
// mode. It follows the unchanged ordinary check on the default persona and owns
// three requests of the first cycle only.
const ENTRY_SETTINGS_TEXTS = Object.freeze(['条目记录一：远灯与预算灯', '条目记录二：预算灯', '条目记录三：请再核对']);
const ENTRY_SETTINGS_REPLY = '条目设置效果已核对';
const ENTRY_SETTINGS_BOOK_ID = 'p1_entry_settings_book';
const ENTRY_A = 'p1_entry_settings_depth', ENTRY_B = 'p1_entry_settings_budget';
const DEPTH_MARKER = 'ENTRY_DEPTH_A_16', BUDGET_MARKER = 'ENTRY_BUDGET_B_' + 'X'.repeat(86);
// [A scanDepth, A tokenBudget, B scanDepth, B tokenBudget]; null follows the
// book. Prepared, then after each GUI save.
const SETTINGS = Object.freeze([[null,null,null,null],[5,null,null,null],[5,null,null,50],[null,null,null,50]]);
const SAVED_ENTRIES = Object.freeze([ENTRY_A, ENTRY_B, ENTRY_A]);
// The [A, B] markers each chat must carry, and the saved state it reads.
const EXPECTED_MARKERS = Object.freeze([[1,1],[1,0],[0,0]]);
const CHAT_STATES = Object.freeze([0,2,3]);
const INPUT_STEPS = Object.freeze([[29,30,31,16,7,8,10,17,11,9,18,19,11,14,30,31,33,34,35,11,14,30,31],[16,7,8,21,14]]);
const CONTROLS = Object.freeze({29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',
  10:'worldbookEntryScanDepthInherit',17:'worldbookEntryScanDepth',11:'saveWorldbook',9:'worldbookEntrySelector',18:'worldbookEntryTokenBudgetInherit',
  19:'worldbookEntryTokenBudget',14:'memory-close',33:'nav-memory',34:'worldbookEntrySelector',35:'worldbookEntryScanDepthInherit',21:'worldbookEntrySelector'});
const FIRST_CHECKS = Object.freeze(['entry-settings-default-baseline-read',
  'entry-settings-fixture-prepared-book-depth-one-budget-hundred-entries-follow-book', 'entry-settings-first-chat-both-entries-follow-book',
  'entry-settings-a-depth-five-saved-and-read-back', 'entry-settings-b-budget-fifty-saved-and-read-back',
  'entry-settings-second-chat-a-depth-five-b-budget-fifty', 'entry-settings-a-follows-book-again-saved-and-read-back',
  'entry-settings-third-chat-after-a-follows-book-again', 'entry-settings-terminal-three-saves-six-messages-rest-unchanged']);
const RESTART_CHECKS = Object.freeze(['entry-settings-restart-archive-and-messages-read-back',
  'entry-settings-restart-entry-a-follows-book-for-both', 'entry-settings-restart-entry-b-budget-fifty-and-depth-follows-book',
  'entry-settings-restart-zero-writes-and-zero-chats']);
// [step, entry, control, shown value, entry follows the book] per restart sample.
const RESTART_SAMPLES = Object.freeze([[20,ENTRY_A,'worldbookEntryScanDepthInherit',true,true],[20,ENTRY_A,'worldbookEntryTokenBudgetInherit',true,true],
  [22,ENTRY_B,'worldbookEntryScanDepthInherit',true,true],[22,ENTRY_B,'worldbookEntryTokenBudget',50,false]]);
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function entrySettingsModelMetadata(messages) {
  assert(Array.isArray(messages),verdictReason('ENTRY_SETTINGS_MODEL_MESSAGES',{},'Entry settings model messages missing'));
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
  return { worldSettingSections: sections.length, depthMarkerCount: context.split(DEPTH_MARKER).length-1,
    budgetMarkerCount: context.split(BUDGET_MARKER).length-1,
    markerInHistory: messages.some(m=>m.role!=='system' && /ENTRY_(DEPTH|BUDGET)_/.test(String(m.content || ''))),
    worldSettingSha256: digest(context) };
}
function wholeGeometry(g, width, height, diagnostic = {}) {
  assert(g?.found===true && g.visible===true && g.fullyVisible===true,verdictReason('ENTRY_SETTINGS_GEOMETRY_VISIBLE',diagnostic,''));
  assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(k=>Number.isFinite(g[k])),verdictReason('ENTRY_SETTINGS_GEOMETRY_NUMERIC',diagnostic,''));
  assert(g.sceneWidth>1 && g.sceneHeight>1 && g.clipWidth>0 && g.clipHeight>0 && Number.isFinite(width) && Number.isFinite(height) && width>0 && height>0,verdictReason('ENTRY_SETTINGS_GEOMETRY_SIZE',diagnostic,''));
  assert(g.clipX>=-.5 && g.clipY>=-.5 && g.clipX+g.clipWidth<=width+.5 && g.clipY+g.clipHeight<=height+.5,verdictReason('ENTRY_SETTINGS_GEOMETRY_WINDOW',diagnostic,''));
  assert(g.sceneX+.5>=g.clipX && g.sceneY+.5>=g.clipY && g.sceneX+g.sceneWidth-.5<=g.clipX+g.clipWidth && g.sceneY+g.sceneHeight-.5<=g.clipY+g.clipHeight,verdictReason('ENTRY_SETTINGS_GEOMETRY_CONTAINMENT',diagnostic,'Clipped geometry'));
}
function entryBook(book, settings, diagnostic = {}) {
  assert.equal(book?.id,ENTRY_SETTINGS_BOOK_ID,verdictReason('ENTRY_SETTINGS_BOOK_ID',diagnostic,'')); assert.equal(book.name,'条目设置验收资料',verdictReason('ENTRY_SETTINGS_BOOK_NAME',diagnostic,''));
  assert(book.scanDepth===1 && book.tokenBudget===100 && book.recursiveScanning===false,verdictReason('ENTRY_SETTINGS_BOOK_SETTINGS',diagnostic,'The book settings must stay depth 1, budget 100, recursion off'));
  assert.equal(book.entries?.length,2,verdictReason('ENTRY_SETTINGS_BOOK_ENTRY_COUNT',diagnostic,''));
  for (const [i,entry] of book.entries.entries()) {
    const context={...diagnostic,entryIndex:i};
    assert.equal(entry.id,i?ENTRY_B:ENTRY_A,verdictReason('ENTRY_SETTINGS_ENTRY_ID',context,''));
    assert.equal(entry.content,i?BUDGET_MARKER:DEPTH_MARKER,verdictReason('ENTRY_SETTINGS_ENTRY_CONTENT',context,''));
    assert.deepEqual(entry.keywords,[i?'预算灯':'远灯'],verdictReason('ENTRY_SETTINGS_ENTRY_KEYWORDS',context,''));
    assert(entry.insertionOrder===(i?40:30) && entry.priority===1000,verdictReason('ENTRY_SETTINGS_ENTRY_ORDER',context,'Both entries are allocated before every other book'));
    assert(entry.enabled===true && entry.alwaysActive===false && entry.useRegex===false,verdictReason('ENTRY_SETTINGS_ENTRY_SWITCHES',context,''));
    // An explicit null is a stored field, not a missing one.
    assert(Object.hasOwn(entry,'scanDepth') && Object.hasOwn(entry,'tokenBudget') &&
      entry.scanDepth===settings[i*2] && entry.tokenBudget===settings[i*2+1],verdictReason('ENTRY_SETTINGS_ENTRY_VALUES',context,''));
  }
}
function uniqueIds(ids, diagnostic = {}) {
  assert(Array.isArray(ids) && ids.every(ident),verdictReason('ENTRY_SETTINGS_MESSAGE_IDS',diagnostic,'Message identities missing'));
  assert.equal(new Set(ids).size,ids.length,verdictReason('ENTRY_SETTINGS_MESSAGE_IDS_UNIQUE',diagnostic,''));
}
function scopeParts(value, diagnostic) {
  const parts=typeof value==='string'?value.split(':'):[];
  assert(parts.length===3 && ident(parts[0]) && /^\d+$/.test(parts[1]) && sha(parts[2]),verdictReason('ENTRY_SETTINGS_SCOPE_SHAPE',diagnostic,''));
  return {personaId:parts[0],epoch:Number(parts[1]),fingerprint:parts[2]};
}
function layoutEvidence(layout, scope, width, height, elapsedMs, frame, diagnostic) {
  const current=layout?.last;
  assert(layout?.ready===true && layout.minimumStableMs===40 && current?.ready===true && current.layoutStable===true && current.enabled===true &&
    current.surfaceClosed===true && current.scope===scope && current.fullyVisible===true,verdictReason('ENTRY_SETTINGS_LAYOUT',diagnostic,''));
  wholeGeometry(current,width,height,diagnostic);
  assert(integer(current.elapsedMs) && integer(current.stableSinceMs) && current.elapsedMs-current.stableSinceMs>=40 && current.elapsedMs<=elapsedMs &&
    integer(current.frameSerial) && integer(current.stableFrameSerial) && current.frameSerial>current.stableFrameSerial && current.frameSerial<=frame,
    verdictReason('ENTRY_SETTINGS_STABILITY',diagnostic,''));
  return current;
}
// allCalls is the complete ordered model-call list of the run; every call
// carries its cycle in this mode.
function verifyWorldbookEntrySettings(reports, allCalls, events) {
  assert(Array.isArray(allCalls) && Array.isArray(events),verdictReason('ENTRY_SETTINGS_INPUTS',{},''));
  const calls=allCalls.filter(c=>c.kind==='entry-settings-fixture');
  assert.deepEqual(calls.map(c=>[c.cycle,c.stage,c.entrySettingsText,c.depthMarkerCount,c.budgetMarkerCount,c.markerInHistory]),
    [0,1,2].map(n=>[1,n+1,ENTRY_SETTINGS_TEXTS[n],...EXPECTED_MARKERS[n],false]),
    verdictReason('ENTRY_SETTINGS_REQUEST_SIGNATURE',{},'Entry depth, budget or inheritance did not reach the actual prompt as registered'));
  // The three requests are the last of the first cycle and precede every
  // second-cycle request.
  const positions=allCalls.map((c,i)=>c.kind==='entry-settings-fixture'?i:null).filter(i=>i!==null);
  const firstCycle=allCalls.map((c,i)=>c.cycle===1?i:null).filter(i=>i!==null), firstRestart=allCalls.findIndex(c=>c.cycle===2);
  assert(allCalls.every(c=>c.cycle===1||c.cycle===2) && JSON.stringify(positions)===JSON.stringify(firstCycle.slice(-3)) && firstRestart>positions[2],
    verdictReason('ENTRY_SETTINGS_CALL_POSITIONS',{},'Entry settings requests are not the first-cycle tail'));
  assert(Array.isArray(reports) && reports.length===2,verdictReason('ENTRY_SETTINGS_REPORT_COUNT',{},''));
  const [first,restart]=reports.map(r=>r?.worldbookEntrySettings);
  // The default persona is "default" to the window and receipts; its scope
  // and the backend events name the persona the runtime actually serves.
  const servedPersona=scopeParts(first?.observed?.scope,{cycle:1}).personaId;
  assert.deepEqual(events.filter(e=>e.event==='bootstrap_started').map(e=>e.cycle),[1,2],verdictReason('ENTRY_SETTINGS_BOOTSTRAPS',{},''));
  const dispatches=events.filter(e=>e.event==='entry_settings_dispatch'), timing=events.filter(e=>e.event==='entry_settings_timing');
  const writes=events.filter(e=>e.event==='entry_settings_archive_put_dispatch');
  assert.deepEqual(dispatches.map(e=>[e.cycle,e.stage,e.persona_id]),[1,2,3].map(stage=>[1,stage,servedPersona]),verdictReason('ENTRY_SETTINGS_DISPATCHES',{},''));
  assert.deepEqual(timing.map(e=>[e.cycle,e.stage,e.start_delay_ms,e.delivery_delay_ms]),[1,2,3].map(stage=>[1,stage,0,100]),verdictReason('ENTRY_SETTINGS_TIMING',{},''));
  assert(writes.length===4 && writes.every(e=>e.cycle===1),verdictReason('ENTRY_SETTINGS_WRITE_DISPATCH_TOTAL',{},'Fixture-book writes were missing, repeated or made after the restart'));
  for(const [index,report] of [first,restart].entries()) {
    const verify=index===1, cycle=index+1, o=report?.observed;
    assert.equal(report?.passed,true,verdictReason('ENTRY_SETTINGS_REPORT_PASSED',{cycle},'')); assert.equal(report.error,'',verdictReason('ENTRY_SETTINGS_REPORT_ERROR',{cycle},''));
    assert.equal(report.mode,verify?'restart-readback':'change-and-effect',verdictReason('ENTRY_SETTINGS_REPORT_MODE',{cycle},''));
    assert.equal(report.deadlineMs,verify?20000:45000,verdictReason('ENTRY_SETTINGS_DEADLINE',{cycle},'')); assert(integer(o?.elapsedMs) && o.elapsedMs<report.deadlineMs,verdictReason('ENTRY_SETTINGS_SEGMENT_ELAPSED',{cycle},''));
    assert.deepEqual(report.checks.map(c=>c.name),verify?RESTART_CHECKS:FIRST_CHECKS,verdictReason('ENTRY_SETTINGS_CHECK_ORDER',{cycle},''));
    assert(report.checks.every(c=>c.passed===true),verdictReason('ENTRY_SETTINGS_CHECKS_PASSED',{cycle},''));
    assert.equal(scopeParts(o.scope,{cycle}).personaId,servedPersona,verdictReason('ENTRY_SETTINGS_SERVED_PERSONA',{cycle},'Both cycles must serve the same default persona'));
    assert.equal(report.receipts.length,new Set(report.receipts.map(r=>r.requestId)).size,verdictReason('ENTRY_SETTINGS_RECEIPT_UNIQUE',{cycle},'Repeated receipt'));
    assert(report.receipts.every(r=>ident(r.requestId) && integer(r.generation) && typeof r.scope==='string' && r.scope.length>0 && sha(r.archiveHash) && sha(r.restHash)),
      verdictReason('ENTRY_SETTINGS_RECEIPT_SHAPE',{cycle},''));
    const receipt=(id,command,role) => {
      const found=report.receipts.filter(r=>r.requestId===id);
      assert(ident(id) && found.length===1,verdictReason('ENTRY_SETTINGS_RECEIPT_PRESENT',{cycle,command,role},'Missing actual receipt'));
      const r=found[0];
      assert(r.command===command && r.ok===true && r.personaId==='default' && r.exists===true,verdictReason('ENTRY_SETTINGS_RECEIPT_IDENTITY',{cycle,command,role},''));
      assert.equal(r.scope,o.scope,verdictReason('ENTRY_SETTINGS_RECEIPT_SCOPE',{cycle,command,role},''));
      assert.equal(r.restHash,o.restHash,verdictReason('ENTRY_SETTINGS_RECEIPT_REST',{cycle,command,role},'Untouched archive fields changed'));
      return r;
    };
    const baseline=receipt(o.baselineReadId,'archive:get','baseline-read');
    assert(baseline.revision===o.baselineRevision && baseline.archiveHash===o.baselineArchiveHash && sha(o.restHash),verdictReason('ENTRY_SETTINGS_BASELINE_ARCHIVE',{cycle},''));
    uniqueIds(o.baselineMessageIds,{cycle,ids:'baseline'});
    const generation=baseline.generation;
    assert(report.receipts.every(r=>r.generation===generation),verdictReason('ENTRY_SETTINGS_RECEIPT_GENERATION',{cycle},''));
    const puts=report.receipts.filter(r=>r.command==='archive:put');
    assert.equal(puts.length,verify?0:4,verdictReason('ENTRY_SETTINGS_WRITE_RECEIPT_TOTAL',{cycle},'')); assert.equal(o.putCount,puts.length,verdictReason('ENTRY_SETTINGS_PUT_COUNT',{cycle},''));
    assert.equal(report.saves.length,verify?0:3,verdictReason('ENTRY_SETTINGS_SAVE_TOTAL',{cycle},'')); assert.equal(report.chats.length,verify?0:3,verdictReason('ENTRY_SETTINGS_CHAT_TOTAL',{cycle},''));
    const states=[];
    if(!verify) {
      assert.deepEqual(baseline.book,{},verdictReason('ENTRY_SETTINGS_BASELINE_HAS_FIXTURE',{cycle},''));
      assert(integer(o.otherBookCount),verdictReason('ENTRY_SETTINGS_OTHER_BOOKS',{cycle},''));
      assert.equal(o.preparedExpectedRevision,o.baselineRevision,verdictReason('ENTRY_SETTINGS_PREPARED_EXPECTED_REVISION',{cycle},''));
      const prep=receipt(o.prepareWriteId,'archive:put','prepare-write'), read=receipt(o.prepareReadId,'archive:get','prepare-read');
      assert(prep.revision===o.baselineRevision+1 && prep.revision===o.preparedRevision && read.revision===prep.revision && read.archiveHash===prep.archiveHash,
        verdictReason('ENTRY_SETTINGS_PREPARATION_REVISION',{cycle},''));
      entryBook(prep.book,SETTINGS[0],{cycle,source:'preparation'}); entryBook(read.book,SETTINGS[0],{cycle,source:'preparation-read'});
      states.push({revision:read.revision,archiveHash:read.archiveHash});
      for(const [n,save] of report.saves.entries()) {
        const stage=n+1, context={cycle,stage}, expected=SETTINGS[stage];
        assert(save.stage===stage && save.entryId===SAVED_ENTRIES[n] && JSON.stringify(save.settings)===JSON.stringify(expected),verdictReason('ENTRY_SETTINGS_SAVE_VALUES',context,''));
        assert(save.expectedRevision===prep.revision+n && save.revision===save.expectedRevision+1,verdictReason('ENTRY_SETTINGS_SAVE_REVISION',context,''));
        assert(save.scope===o.scope && save.personaId==='default' && save.generation===generation,verdictReason('ENTRY_SETTINGS_SAVE_IDENTITY',context,''));
        const ack=receipt(save.writeId,'archive:put','save-ack-'+stage), fresh=receipt(save.readId,'archive:get','save-read-'+stage);
        assert(save.readId!==save.writeId,verdictReason('ENTRY_SETTINGS_SAVE_RECEIPTS',context,''));
        assert(ack.revision===save.revision && fresh.revision===save.revision && ack.archiveHash===save.archiveHash && fresh.archiveHash===save.archiveHash,verdictReason('ENTRY_SETTINGS_SAVE_ACK',context,''));
        assert.equal(save.restHash,o.restHash,verdictReason('ENTRY_SETTINGS_SAVE_REST_HASH',context,'Untouched archive fields changed'));
        entryBook(ack.book,expected,{...context,source:'save-ack'}); entryBook(fresh.book,expected,{...context,source:'save-read'});
        assert.deepEqual(save.book,ack.book,verdictReason('ENTRY_SETTINGS_SAVE_BOOK',context,''));
        const b=save.binding;
        assert(b?.armed===true && b.status==='matched' && b.failureReason==='' && b.requestId===save.writeId && b.scope===o.scope && b.generation===generation && integer(b.baselineCount),verdictReason('ENTRY_SETTINGS_SAVE_BINDING',context,''));
        assert(integer(save.readAtMs) && integer(save.feedbackInputAtMs) && save.feedbackInputAtMs>=save.readAtMs && save.feedbackInputAtMs-save.readAtMs<10000,verdictReason('ENTRY_SETTINGS_FEEDBACK_CLOCK',context,''));
        assert(typeof save.feedback==='string' && save.feedback.includes('已保存'),verdictReason('ENTRY_SETTINGS_SAVE_FEEDBACK',context,''));
        wholeGeometry(save.feedbackGeometry,save.windowWidth,save.windowHeight,{...context,section:'save-feedback'});
        assert(typeof save.screenshot==='string' && save.screenshot.endsWith(`.worldbook-entry-settings-save-${stage}.png`),verdictReason('ENTRY_SETTINGS_SAVE_SCREENSHOT',context,''));
        states.push({revision:save.revision,archiveHash:save.archiveHash});
      }
      assert.deepEqual(puts.map(p=>p.requestId),[o.prepareWriteId,...report.saves.map(s=>s.writeId)],verdictReason('ENTRY_SETTINGS_PUT_ORDER',{cycle},''));
      assert.deepEqual(writes.map(d=>[d.request_id,d.persona_id,d.expected_revision]),puts.map((p,n)=>[p.requestId,servedPersona,o.baselineRevision+n]),verdictReason('ENTRY_SETTINGS_WRITE_DISPATCHES',{cycle},''));
      assert(writes.every(d=>`${d.persona_id}:${d.persona_epoch}:${d.persona_fingerprint}`===o.scope),verdictReason('ENTRY_SETTINGS_WRITE_DISPATCH_SCOPE',{cycle},''));
      entryBook(o.book,SETTINGS[3],{cycle,source:'terminal'});
    } else {
      assert(o.prepareWriteId===undefined && o.prepareReadId===undefined && o.preparedRevision===undefined,verdictReason('ENTRY_SETTINGS_RESTART_PREP_ABSENT',{cycle},''));
      entryBook(baseline.book,SETTINGS[3],{cycle,source:'restart-baseline'});
      const terminal=first.observed;
      assert(o.restartReadId===o.baselineReadId && baseline.archiveHash===terminal.terminalArchiveHash && baseline.revision===terminal.terminalRevision &&
        o.restHash===terminal.restHash,verdictReason('ENTRY_SETTINGS_RESTART_ARCHIVE',{cycle},'Restart did not read the first-cycle terminal archive'));
      assert.deepEqual(o.baselineMessageIds,terminal.terminalMessageIds,verdictReason('ENTRY_SETTINGS_RESTART_HISTORY',{cycle},'Restart did not preserve the complete message history'));
      const finalRead=receipt(o.finalReadId,'archive:get','final-read');
      assert(finalRead.archiveHash===baseline.archiveHash && finalRead.revision===baseline.revision && o.terminalArchiveHash===baseline.archiveHash &&
        o.terminalRevision===baseline.revision && JSON.stringify(o.terminalMessageIds)===JSON.stringify(o.baselineMessageIds),
        verdictReason('ENTRY_SETTINGS_RESTART_UNCHANGED',{cycle},''));
      entryBook(finalRead.book,SETTINGS[3],{cycle,source:'restart-final'});
      assert(typeof o.restartScreenshot==='string' && o.restartScreenshot.endsWith('.worldbook-entry-settings-restart.png') &&
        o.restartScreenshotControl==='worldbookEntryTokenBudget',verdictReason('ENTRY_SETTINGS_RESTART_SCREENSHOT',{cycle},''));
      // Separate whole-item observations; a step's samples share one input clock.
      assert(Array.isArray(report.samples) && report.samples.length===RESTART_SAMPLES.length,verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_SET',{cycle},''));
      assert.deepEqual(report.samples.map(s=>[s?.step,s?.entryId,s?.control]),RESTART_SAMPLES.map(([step,entry,control])=>[step,entry,control]),
        verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_ORDER',{cycle},''));
      let previous;
      for(const [sampleIndex,sample] of report.samples.entries()) {
        const [step,,control,value,inherited]=RESTART_SAMPLES[sampleIndex], context={cycle,sampleIndex,control};
        assert(sample.scope===o.scope && sample.generation===generation && sample.personaId==='default' && sample.revision===baseline.revision &&
          sample.archiveHash===baseline.archiveHash,verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_BINDING',context,''));
        assert(sample.value===value && sample.inherited===inherited,verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_VALUE',context,'The real control did not show the saved entry setting'));
        wholeGeometry(sample.geometry,sample.windowWidth,sample.windowHeight,{...context,section:'restart-sample'});
        const current=layoutEvidence(sample.layout,sample.scope,sample.windowWidth,sample.windowHeight,sample.sampledAtMs-sample.inputAtMs,sample.frame,{...context,section:'restart-sample-layout'});
        assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(key=>Math.abs(current[key]-sample.geometry[key])<=.5),
          verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_GEOMETRY_MATCH',context,''));
        const sameStep=previous?.step===step;
        assert(integer(sample.stepAtMs) && integer(sample.inputAtMs) && sample.inputAtMs>=sample.stepAtMs && integer(sample.sampledAtMs) &&
          sample.sampledAtMs>=sample.inputAtMs && sample.sampledAtMs-sample.inputAtMs<4000 && sample.sampledAtMs<o.elapsedMs && integer(sample.frame) && sample.frame>0 &&
          (!sameStep || (sample.stepAtMs===previous.stepAtMs && sample.inputAtMs===previous.inputAtMs)),
          verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_CLOCK',context,'A step\'s samples share its original input clock'));
        assert(!previous || (sample.sampledAtMs>previous.sampledAtMs && sample.frame>previous.frame &&
          sample.inputAtMs+current.stableSinceMs>=previous.sampledAtMs && current.stableFrameSerial>=previous.frame),
          verdictReason('ENTRY_SETTINGS_RESTART_SAMPLE_FRESHNESS',context,'Each target must acquire a fresh stability interval'));
        previous=sample;
      }
    }
    let before=o.baselineMessageIds;
    for(const [n,chat] of report.chats.entries()) {
      const stage=n+1, context={cycle,stage};
      assert(chat.stage===stage && chat.personaId==='default' && chat.scope===o.scope && chat.generation===generation,verdictReason('ENTRY_SETTINGS_CHAT_IDENTITY',context,''));
      assert(chat.text===ENTRY_SETTINGS_TEXTS[n] && chat.reply===ENTRY_SETTINGS_REPLY,verdictReason('ENTRY_SETTINGS_CHAT_TEXT',context,''));
      uniqueIds(chat.afterIds,context); assert.deepEqual(chat.beforeIds,before,verdictReason('ENTRY_SETTINGS_CHAT_BEFORE',context,''));
      assert.deepEqual(chat.afterIds.slice(0,-2),before,verdictReason('ENTRY_SETTINGS_CHAT_HISTORY_PREFIX',context,'Each chat adds exactly one message pair'));
      assert.deepEqual(chat.afterIds.slice(-2),[chat.userId,chat.assistantId],verdictReason('ENTRY_SETTINGS_CHAT_PAIR',context,''));
      const dispatch=dispatches[n];
      assert(ident(chat.requestId) && chat.requestId===dispatch.request_id,verdictReason('ENTRY_SETTINGS_CHAT_DISPATCH_ID',context,''));
      assert.equal(chat.scope,`${dispatch.persona_id}:${dispatch.persona_epoch}:${dispatch.persona_fingerprint}`,verdictReason('ENTRY_SETTINGS_CHAT_DISPATCH_SCOPE',context,''));
      const state=states[CHAT_STATES[n]];
      assert(chat.revision===state.revision && chat.archiveHash===state.archiveHash,verdictReason('ENTRY_SETTINGS_CHAT_STATE',context,'A chat did not read the preceding saved archive'));
      before=chat.afterIds;
    }
    if(!verify) {
      assert.deepEqual(o.terminalMessageIds,before,verdictReason('ENTRY_SETTINGS_TERMINAL_HISTORY',{cycle},''));
      assert.equal(o.terminalMessageIds.length,o.baselineMessageIds.length+6,verdictReason('ENTRY_SETTINGS_TERMINAL_MESSAGE_COUNT',{cycle},''));
      const finalSave=report.saves[2], finalRead=report.receipts.find(r=>r.requestId===finalSave.readId), finalChat=report.chats[2];
      assert([finalSave,finalRead,finalChat].every(value=>o.terminalRevision===value.revision && o.terminalArchiveHash===value.archiveHash),
        verdictReason('ENTRY_SETTINGS_TERMINAL_FINAL_SAVE',{cycle},'First-cycle terminal must be the final saved and freshly read archive used by the third chat'));
    }
    assert.deepEqual(report.inputs.map(i=>i.step),INPUT_STEPS[index],verdictReason('ENTRY_SETTINGS_INPUT_STEP_ORDER',{cycle},'Real control input order changed'));
    assert.deepEqual(report.inputs.map(i=>i.control),INPUT_STEPS[index].map(step=>CONTROLS[step]),verdictReason('ENTRY_SETTINGS_INPUT_CONTROL_ORDER',{cycle},'Real control identity changed'));
    const values=name=>JSON.stringify(report.inputs.filter(i=>i.control===name).map(i=>[i.beforeValue,i.afterValue]));
    assert(values('worldbookEntryScanDepthInherit')===JSON.stringify(verify?[]:[[true,false],[false,true]]) &&
      values('worldbookEntryScanDepth')===JSON.stringify(verify?[]:[[1,5]]) &&
      values('worldbookEntryTokenBudgetInherit')===JSON.stringify(verify?[]:[[true,false]]) &&
      values('worldbookEntryTokenBudget')===JSON.stringify(verify?[]:[[100,50]]),verdictReason('ENTRY_SETTINGS_INPUT_VALUES',{cycle},''));
    const entryOf={8:ENTRY_A,10:ENTRY_A,17:ENTRY_A,9:ENTRY_B,18:ENTRY_B,19:ENTRY_B,34:ENTRY_A,35:ENTRY_A,21:ENTRY_B};
    for(const input of report.inputs) {
      const context={cycle,step:input.step};
      assert(input.scope===o.scope && input.generation===generation,verdictReason('ENTRY_SETTINGS_INPUT_SCOPE',context,''));
      assert(integer(input.elapsedMs) && input.elapsedMs<4000 && Number.isInteger(input.frame) && input.frame>0,verdictReason('ENTRY_SETTINGS_INPUT_DEADLINE_FRAME',context,''));
      if(entryOf[input.step]) assert.equal(input.selectedEntryId,entryOf[input.step],verdictReason('ENTRY_SETTINGS_INPUT_ENTRY',context,'An entry control acted on the wrong entry'));
      const current=layoutEvidence(input.layout,input.scope,input.windowWidth,input.windowHeight,input.elapsedMs,input.frame,{...context,section:'input'});
      assert(input.hit?.acceptorFound===true && ['target','descendant'].includes(input.hit.hitResult),verdictReason('ENTRY_SETTINGS_INPUT_HIT',context,''));
      assert(Number.isFinite(current.pointX) && Number.isFinite(current.pointY) && current.pointX>=current.sceneX && current.pointX<=current.sceneX+current.sceneWidth &&
        current.pointY>=current.sceneY && current.pointY<=current.sceneY+current.sceneHeight && current.pointX>=current.clipX && current.pointX<=current.clipX+current.clipWidth &&
        current.pointY>=current.clipY && current.pointY<=current.clipY+current.clipHeight,verdictReason('ENTRY_SETTINGS_INPUT_POINT',context,''));
      const signal=input.signals;
      if(input.control==='worldbookEntryScanDepth') assert.deepEqual(signal,{kind:'integer',mouseDispatchCount:1,keyDispatchCount:4,valueModifiedSignals:4},verdictReason('ENTRY_SETTINGS_INPUT_INTEGER_SIGNALS',context,''));
      else if(input.control==='worldbookEntryTokenBudget') assert.deepEqual(signal,{kind:'integer',mouseDispatchCount:1,keyDispatchCount:1,valueModifiedSignals:1},verdictReason('ENTRY_SETTINGS_INPUT_INTEGER_SIGNALS',context,''));
      else if(input.control.endsWith('Inherit')) assert.deepEqual(signal,{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:input.step===35},verdictReason('ENTRY_SETTINGS_INPUT_CHECKBOX_SIGNALS',context,''));
      else if(input.control==='chatComposer') assert.deepEqual(signal,{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},verdictReason('ENTRY_SETTINGS_INPUT_TEXT_SIGNALS',context,''));
      else if(input.control==='worldbookBookSelector') assert(signal?.kind==='selector' && signal.mouseDispatchCount===1 && signal.activatedSignals===1 &&
        Number.isInteger(signal.selectedIndex) && signal.selectedIndex===Number(o.otherBookCount ?? first.observed.otherBookCount)+1,verdictReason('ENTRY_SETTINGS_INPUT_SELECTOR_SIGNALS',context,'The fixture book is the last book'));
      else if(input.control==='worldbookEntrySelector') assert.deepEqual(signal,{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:input.step===34?1:2},verdictReason('ENTRY_SETTINGS_INPUT_SELECTOR_SIGNALS',context,''));
      else assert.deepEqual(signal,{kind:'button',mouseDispatchCount:1,clickedSignals:1},verdictReason('ENTRY_SETTINGS_INPUT_BUTTON_SIGNALS',context,''));
    }
  }
  return {passed:true,checks:[9,4],http:3,preparationWrites:[1,0],saveWrites:[3,0],chats:[3,0]};
}
module.exports={ENTRY_SETTINGS_TEXTS,ENTRY_SETTINGS_REPLY,ENTRY_SETTINGS_BOOK_ID,DEPTH_MARKER,BUDGET_MARKER,SETTINGS,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,
  RESTART_SAMPLES,entrySettingsModelMetadata,verifyWorldbookEntrySettings};
