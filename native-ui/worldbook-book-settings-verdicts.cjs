'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {verdictReason}=require('./verdict-test-support.cjs');
const {verifyPersonaRowInputRecord}=require('./worldbook-priority-verdicts.cjs');
// The book-level scan depth, budget and recursion tail on 「霜」. It follows the
// signed-off priority tail and owns three requests of the first cycle only.
const BOOK_SETTINGS_TEXTS = Object.freeze(['书级记录一：远灯亮起', '书级记录二：请继续核对', '书级记录三：远灯再亮']);
const BOOK_SETTINGS_REPLY = '书级设置效果已核对';
const DEPTH_MARKER = 'BOOK_DEPTH_ONLY 回声', RECURSION_MARKER = 'BOOK_RECURSION_ONLY';
// Prepared, after the first GUI save and after the second.
const SETTINGS = Object.freeze([[1,100,false],[3,100,true],[3,0,true]]);
const INPUT_STEPS = Object.freeze([[51,1,2,29,30,31,16,7,8,9,10,17,11,14,30,31,33,18,11,14,30,31,34,40,41],[51,1,2,16,7,9,14,34,40,41]]);
const FIRST_CHECKS = Object.freeze(['book-settings-original-persona-captured-and-frost-baseline-read',
  'book-settings-fixture-prepared-depth-one-budget-hundred-recursion-off', 'book-settings-first-chat-depth-one-without-recursion',
  'book-settings-depth-three-recursion-on-saved-read-back-and-second-chat', 'book-settings-budget-zero-saved-read-back-and-third-chat',
  'book-settings-frost-terminal-only-two-edits-and-six-messages', 'book-settings-return-moon-archive-messages-switches-preserved']);
const RESTART_CHECKS = Object.freeze(['book-settings-restart-frost-archive-and-message-identities', 'book-settings-restart-controls-read-back',
  'book-settings-restart-default-archive-messages-switches-avatar-preserved', 'book-settings-restart-zero-preparation-zero-save-writes-and-zero-chats']);
// The world-setting text each chat must carry, in insertion order.
const EXPECTED_CONTEXT = Object.freeze([DEPTH_MARKER, DEPTH_MARKER + '\n\n' + RECURSION_MARKER, '']);
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function bookSettingsModelMetadata(messages) {
  assert(Array.isArray(messages),verdictReason('BOOK_SETTINGS_MODEL_MESSAGES',{},'Book settings model messages missing'));
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
  const context=sections.join('\n');
  return { worldSettingSections: sections.length, depthMarkerCount: context.split('BOOK_DEPTH_ONLY').length-1,
    recursionMarkerCount: context.split(RECURSION_MARKER).length-1,
    markerInHistory: messages.some(m=>m.role!=='system' && /BOOK_(DEPTH|RECURSION)_ONLY/.test(String(m.content || ''))),
    worldSettingSha256: digest(context) };
}
function wholeGeometry(g, width, height, diagnostic = {}) {
  assert(g?.found===true && g.visible===true && g.fullyVisible===true,verdictReason('BOOK_SETTINGS_GEOMETRY_VISIBLE',diagnostic,''));
  assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(k=>Number.isFinite(g[k])),verdictReason('BOOK_SETTINGS_GEOMETRY_NUMERIC',diagnostic,''));
  assert(g.sceneWidth>1 && g.sceneHeight>1 && g.clipWidth>0 && g.clipHeight>0 && Number.isFinite(width) && Number.isFinite(height) && width>0 && height>0,verdictReason('BOOK_SETTINGS_GEOMETRY_SIZE',diagnostic,''));
  assert(g.clipX>=-.5 && g.clipY>=-.5 && g.clipX+g.clipWidth<=width+.5 && g.clipY+g.clipHeight<=height+.5,verdictReason('BOOK_SETTINGS_GEOMETRY_WINDOW',diagnostic,''));
  assert(g.sceneX+.5>=g.clipX && g.sceneY+.5>=g.clipY && g.sceneX+g.sceneWidth-.5<=g.clipX+g.clipWidth && g.sceneY+g.sceneHeight-.5<=g.clipY+g.clipHeight,verdictReason('BOOK_SETTINGS_GEOMETRY_CONTAINMENT',diagnostic,'Clipped geometry'));
}
function settingsBook(book, [depth,budget,recursive], diagnostic = {}) {
  assert.equal(book?.id,'p1_book_settings_book',verdictReason('BOOK_SETTINGS_BOOK_ID',diagnostic,'')); assert.equal(book.name,'书级设置验收资料',verdictReason('BOOK_SETTINGS_BOOK_NAME',diagnostic,''));
  assert.equal(book.scanDepth,depth,verdictReason('BOOK_SETTINGS_BOOK_SCAN_DEPTH',diagnostic,'')); assert.equal(book.tokenBudget,budget,verdictReason('BOOK_SETTINGS_BOOK_TOKEN_BUDGET',diagnostic,''));
  assert.equal(book.recursiveScanning,recursive,verdictReason('BOOK_SETTINGS_BOOK_RECURSION',diagnostic,'')); assert.equal(book.entries?.length,2,verdictReason('BOOK_SETTINGS_BOOK_ENTRY_COUNT',diagnostic,''));
  for (const [i,entry] of book.entries.entries()) {
    const context={...diagnostic,entryIndex:i};
    assert.equal(entry.id,i?'p1_book_settings_recursion':'p1_book_settings_depth',verdictReason('BOOK_SETTINGS_ENTRY_ID',context,''));
    assert.equal(entry.content,i?RECURSION_MARKER:DEPTH_MARKER,verdictReason('BOOK_SETTINGS_ENTRY_CONTENT',context,''));
    assert.deepEqual(entry.keywords,[i?'回声':'远灯'],verdictReason('BOOK_SETTINGS_ENTRY_KEYWORDS',context,''));
    assert.equal(entry.insertionOrder,i?40:30,verdictReason('BOOK_SETTINGS_ENTRY_ORDER',context,'')); assert.equal(entry.priority,0,verdictReason('BOOK_SETTINGS_ENTRY_PRIORITY',context,''));
    assert(entry.enabled===true && entry.alwaysActive===false && entry.useRegex===false,verdictReason('BOOK_SETTINGS_ENTRY_SWITCHES',context,''));
    assert(entry.scanDepth===null && entry.tokenBudget===null,verdictReason('BOOK_SETTINGS_ENTRY_INHERITS_BOOK',context,'Entry overrides would hide the book settings'));
  }
}
function uniqueIds(ids, diagnostic = {}) {
  assert(Array.isArray(ids) && ids.every(ident),verdictReason('BOOK_SETTINGS_MESSAGE_IDS',diagnostic,'Message identities missing'));
  assert.equal(new Set(ids).size,ids.length,verdictReason('BOOK_SETTINGS_MESSAGE_IDS_UNIQUE',diagnostic,''));
}
function snapshot(value, diagnostic = {}) {
  assert(ident(value?.personaId) && integer(value.revision) && sha(value.archiveHash) && sha(value.charactersHash) && typeof value.exists==='boolean',verdictReason('BOOK_SETTINGS_SNAPSHOT_SHAPE',diagnostic,''));
  uniqueIds(value.messageIds,diagnostic);
  assert(Array.isArray(value.avatarIds) && new Set(value.avatarIds).size===value.avatarIds.length && typeof value.activeAvatar==='string' && value.activeAvatar.length>0,verdictReason('BOOK_SETTINGS_SNAPSHOT_AVATAR',diagnostic,''));
}
function rowScope(value, diagnostic) {
  const parts=typeof value==='string'?value.split(':'):[];
  assert(parts.length===3 && ident(parts[0]) && /^\d+$/.test(parts[1]) && sha(parts[2]),verdictReason('BOOK_SETTINGS_SCOPE_SHAPE',diagnostic,''));
  return {personaId:parts[0],epoch:Number(parts[1]),fingerprint:parts[2]};
}
// allCalls is the complete ordered model-call list of the persona run.
function verifyWorldbookBookSettings(reports, allCalls, events) {
  assert(Array.isArray(allCalls),verdictReason('BOOK_SETTINGS_MODEL_CALLS',{},''));
  const calls=allCalls.filter(c=>c.kind==='book-settings-fixture');
  assert.deepEqual(calls.map(c=>[c.cycle,c.stage,c.bookSettingsText,c.worldSettingSections,c.depthMarkerCount,c.recursionMarkerCount,c.markerInHistory]),
    [[1,1,BOOK_SETTINGS_TEXTS[0],1,1,0,false],[1,2,BOOK_SETTINGS_TEXTS[1],1,1,1,false],[1,3,BOOK_SETTINGS_TEXTS[2],0,0,0,false]],
    verdictReason('BOOK_SETTINGS_REQUEST_SIGNATURE',{},'Depth, recursion or budget did not reach the actual prompt as registered'));
  assert.deepEqual(calls.map(c=>c.worldSettingSha256),EXPECTED_CONTEXT.map(digest),verdictReason('BOOK_SETTINGS_REQUEST_CONTEXT',{},''));
  // The three requests directly follow the first-cycle priority requests and
  // precede every second-cycle request.
  const positions=allCalls.map((c,i)=>c.kind==='book-settings-fixture'?i:null).filter(i=>i!==null);
  const lastPriority=allCalls.map((c,i)=>c.kind==='priority-fixture'&&c.cycle===1?i:-1).reduce((a,b)=>Math.max(a,b),-1);
  const firstRestart=allCalls.findIndex(c=>c.cycle===2);
  assert(lastPriority>=0 && firstRestart>lastPriority && positions.length===3 && positions.every((p,n)=>p===lastPriority+1+n) && positions[2]<firstRestart,
    verdictReason('BOOK_SETTINGS_CALL_POSITIONS',{},'Book settings requests are not the first-cycle tail'));
  assert(Array.isArray(reports) && reports.length===2,verdictReason('BOOK_SETTINGS_REPORT_COUNT',{},''));
  const [first,restart]=reports.map(r=>r?.worldbookBookSettings);
  const frost=first?.observed?.frostPersonaId, moon=reports[0]?.archiveInteraction?.cardImport?.moonPersona;
  const seeded=events.filter(e=>e.event==='persona_seeded');
  assert(ident(frost) && ident(moon) && seeded.length===1 && ![moon,'default',seeded[0].profile_id].includes(frost) && restart?.observed?.frostPersonaId===frost,
    verdictReason('BOOK_SETTINGS_FROST_IDENTITY',{},'The tail did not run on the imported flagged persona'));
  const dispatches=events.filter(e=>e.event==='book_settings_dispatch'), timing=events.filter(e=>e.event==='book_settings_timing');
  const writes=events.filter(e=>e.event==='book_settings_archive_put_dispatch');
  assert.deepEqual(dispatches.map(e=>[e.cycle,e.stage,e.persona_id]),[1,2,3].map(stage=>[1,stage,frost]),verdictReason('BOOK_SETTINGS_DISPATCHES',{},''));
  assert.deepEqual(timing.map(e=>[e.cycle,e.stage,e.persona_id,e.start_delay_ms,e.delivery_delay_ms]),[1,2,3].map(stage=>[1,stage,frost,0,100]),verdictReason('BOOK_SETTINGS_TIMING',{},''));
  assert.equal(writes.length,3,verdictReason('BOOK_SETTINGS_WRITE_DISPATCH_TOTAL',{},'「霜」 archive writes were missing or repeated'));
  for(const [index,report] of [first,restart].entries()) {
    const verify=index===1, cycle=index+1, o=report?.observed;
    assert.equal(report?.passed,true,verdictReason('BOOK_SETTINGS_REPORT_PASSED',{cycle},'')); assert.equal(report.error,'',verdictReason('BOOK_SETTINGS_REPORT_ERROR',{cycle},''));
    assert.equal(report.mode,verify?'restart-readback':'change-and-effect',verdictReason('BOOK_SETTINGS_REPORT_MODE',{cycle},''));
    assert.equal(report.deadlineMs,verify?20000:40000,verdictReason('BOOK_SETTINGS_DEADLINE',{cycle},'')); assert(integer(o?.elapsedMs) && o.elapsedMs<report.deadlineMs,verdictReason('BOOK_SETTINGS_SEGMENT_ELAPSED',{cycle},''));
    assert.deepEqual(report.checks.map(c=>c.name),verify?RESTART_CHECKS:FIRST_CHECKS,verdictReason('BOOK_SETTINGS_CHECK_ORDER',{cycle},''));
    assert(report.checks.every(c=>c.passed===true),verdictReason('BOOK_SETTINGS_CHECKS_PASSED',{cycle},''));
    snapshot(o.originalBefore,{cycle,snapshot:'original-before'}); snapshot(o.originalAfter,{cycle,snapshot:'original-after'});
    snapshot(o.frostBefore,{cycle,snapshot:'frost-before'}); snapshot(o.frostTerminal,{cycle,snapshot:'frost-terminal'});
    assert.deepEqual(o.originalAfter,o.originalBefore,verdictReason('BOOK_SETTINGS_ORIGINAL_PRESERVED',{cycle},'Return changed original persona persistent state'));
    assert.equal(o.originalBefore.personaId,verify?'default':moon,verdictReason('BOOK_SETTINGS_ORIGINAL_PERSONA',{cycle},''));
    assert(o.frostBefore.personaId===frost && o.frostTerminal.personaId===frost,verdictReason('BOOK_SETTINGS_FROST_SNAPSHOTS',{cycle},''));
    const originalScope=rowScope(o.originalScope,{cycle,scope:'original'}), frostScope=rowScope(o.frostScope,{cycle,scope:'frost'}), returnScope=rowScope(o.returnScope,{cycle,scope:'return'});
    assert(frostScope.personaId===frost && o.originalScope!==o.returnScope && o.frostScope!==o.originalScope && o.frostScope!==o.returnScope &&
      originalScope.personaId===returnScope.personaId,verdictReason('BOOK_SETTINGS_SCOPE_TRANSITIONS',{cycle},''));
    assert.equal(report.receipts.length,new Set(report.receipts.map(r=>r.requestId)).size,verdictReason('BOOK_SETTINGS_RECEIPT_UNIQUE',{cycle},'Repeated receipt'));
    assert(report.receipts.every(r=>ident(r.requestId) && integer(r.generation) && typeof r.scope==='string' && r.scope.length>0 && sha(r.archiveHash)),verdictReason('BOOK_SETTINGS_RECEIPT_SHAPE',{cycle},''));
    const receipt=(id,command,scope,personaId,role) => {
      const found=report.receipts.filter(r=>r.requestId===id);
      assert(ident(id) && found.length===1,verdictReason('BOOK_SETTINGS_RECEIPT_PRESENT',{cycle,command,role},'Missing actual receipt'));
      const r=found[0];
      assert(r.command===command && r.ok===true && r.personaId===personaId,verdictReason('BOOK_SETTINGS_RECEIPT_IDENTITY',{cycle,command,role},''));
      assert.equal(r.scope,scope,verdictReason('BOOK_SETTINGS_RECEIPT_SCOPE',{cycle,command,role},'')); return r;
    };
    const originalRead=receipt(o.originalReadId,'archive:get',o.originalScope,o.originalBefore.personaId,'original-read');
    const returned=receipt(o.returnReadId,'archive:get',o.returnScope,o.originalBefore.personaId,'return-read');
    for(const [role,read] of [['original-read',originalRead],['return-read',returned]])
      assert(read.archiveHash===o.originalBefore.archiveHash && read.revision===o.originalBefore.revision,verdictReason('BOOK_SETTINGS_ORIGINAL_READ',{cycle,role},''));
    const baseline=receipt(o.baselineReadId,'archive:get',o.frostScope,frost,'baseline-read');
    assert(baseline.archiveHash===o.frostBefore.archiveHash && baseline.revision===o.frostBefore.revision && baseline.exists===true && o.frostBefore.exists===true,verdictReason('BOOK_SETTINGS_BASELINE_ARCHIVE',{cycle},''));
    assert(sha(o.canonicalBaselineRestHash) && baseline.restHash===o.canonicalBaselineRestHash,verdictReason('BOOK_SETTINGS_BASELINE_REST',{cycle},''));
    const puts=report.receipts.filter(r=>r.command==='archive:put');
    assert.equal(puts.length,verify?0:3,verdictReason('BOOK_SETTINGS_WRITE_RECEIPT_TOTAL',{cycle},'')); assert.equal(o.putCount,puts.length,verdictReason('BOOK_SETTINGS_PUT_COUNT',{cycle},''));
    assert.equal(report.saves.length,verify?0:2,verdictReason('BOOK_SETTINGS_SAVE_TOTAL',{cycle},'')); assert.equal(report.chats.length,verify?0:3,verdictReason('BOOK_SETTINGS_CHAT_TOTAL',{cycle},''));
    const states=[];
    if(!verify) {
      assert.deepEqual(baseline.book,{},verdictReason('BOOK_SETTINGS_BASELINE_HAS_FIXTURE',{cycle},''));
      assert.equal(o.preparedExpectedRevision,o.frostBefore.revision,verdictReason('BOOK_SETTINGS_PREPARED_EXPECTED_REVISION',{cycle},''));
      const prep=receipt(o.prepareWriteId,'archive:put',o.frostScope,frost,'prepare-write'), read=receipt(o.prepareReadId,'archive:get',o.frostScope,frost,'prepare-read');
      assert(prep.revision===o.frostBefore.revision+1 && prep.revision===o.preparedRevision && read.revision===prep.revision && read.archiveHash===prep.archiveHash,verdictReason('BOOK_SETTINGS_PREPARATION_REVISION',{cycle},''));
      assert(prep.restHash===o.canonicalBaselineRestHash && read.restHash===o.canonicalBaselineRestHash,verdictReason('BOOK_SETTINGS_PREPARATION_REST',{cycle},''));
      assert(prep.generation===baseline.generation && read.generation===baseline.generation,verdictReason('BOOK_SETTINGS_PREPARATION_GENERATION',{cycle},''));
      settingsBook(prep.book,SETTINGS[0],{cycle,source:'preparation'}); settingsBook(read.book,SETTINGS[0],{cycle,source:'preparation-read'});
      states.push({revision:read.revision,archiveHash:read.archiveHash});
      for(const [n,save] of report.saves.entries()) {
        const stage=n+1, context={cycle,stage}, expected=SETTINGS[stage];
        assert(save.stage===stage && save.scanDepth===expected[0] && save.tokenBudget===expected[1] && save.recursiveScanning===expected[2],verdictReason('BOOK_SETTINGS_SAVE_VALUES',context,''));
        assert(save.expectedRevision===prep.revision+n && save.revision===save.expectedRevision+1,verdictReason('BOOK_SETTINGS_SAVE_REVISION',context,''));
        assert(save.scope===o.frostScope && save.personaId===frost && save.generation===baseline.generation,verdictReason('BOOK_SETTINGS_SAVE_IDENTITY',context,''));
        const ack=receipt(save.writeId,'archive:put',o.frostScope,frost,'save-ack-'+stage), fresh=receipt(save.readId,'archive:get',o.frostScope,frost,'save-read-'+stage);
        assert(save.readId!==save.writeId && ack.generation===save.generation && fresh.generation===save.generation,verdictReason('BOOK_SETTINGS_SAVE_RECEIPTS',context,''));
        assert(ack.revision===save.revision && fresh.revision===save.revision && ack.archiveHash===save.archiveHash && fresh.archiveHash===save.archiveHash,verdictReason('BOOK_SETTINGS_SAVE_ACK',context,''));
        assert(save.restHash===o.canonicalBaselineRestHash && fresh.restHash===o.canonicalBaselineRestHash,verdictReason('BOOK_SETTINGS_SAVE_REST_HASH',context,'Untouched archive fields changed'));
        settingsBook(ack.book,expected,{...context,source:'save-ack'}); settingsBook(fresh.book,expected,{...context,source:'save-read'});
        assert.deepEqual(save.book,ack.book,verdictReason('BOOK_SETTINGS_SAVE_BOOK',context,''));
        const b=save.binding;
        assert(b?.armed===true && b.status==='matched' && b.failureReason==='' && b.requestId===save.writeId && b.scope===o.frostScope && b.generation===baseline.generation && integer(b.baselineCount),verdictReason('BOOK_SETTINGS_SAVE_BINDING',context,''));
        assert(integer(save.readAtMs) && integer(save.feedbackInputAtMs) && save.feedbackInputAtMs>=save.readAtMs && save.feedbackInputAtMs-save.readAtMs<10000,verdictReason('BOOK_SETTINGS_FEEDBACK_CLOCK',context,''));
        assert(typeof save.feedback==='string' && save.feedback.includes('已保存'),verdictReason('BOOK_SETTINGS_SAVE_FEEDBACK',context,''));
        wholeGeometry(save.feedbackGeometry,save.windowWidth,save.windowHeight,{...context,section:'save-feedback'});
        assert(typeof save.screenshot==='string' && save.screenshot.endsWith(`.worldbook-book-settings-save-${stage}.png`),verdictReason('BOOK_SETTINGS_SAVE_SCREENSHOT',context,''));
        states.push({revision:save.revision,archiveHash:save.archiveHash});
      }
      assert.deepEqual(puts.map(p=>p.requestId),[o.prepareWriteId,...report.saves.map(s=>s.writeId)],verdictReason('BOOK_SETTINGS_PUT_ORDER',{cycle},''));
      assert.deepEqual(writes.map(d=>[d.cycle,d.request_id,d.persona_id,d.expected_revision]),puts.map((p,n)=>[1,p.requestId,frost,o.frostBefore.revision+n]),verdictReason('BOOK_SETTINGS_WRITE_DISPATCHES',{cycle},''));
      assert(writes.every(d=>`${d.persona_id}:${d.persona_epoch}:${d.persona_fingerprint}`===o.frostScope),verdictReason('BOOK_SETTINGS_WRITE_DISPATCH_SCOPE',{cycle},''));
      settingsBook(o.book,SETTINGS[2],{cycle,source:'terminal'});
      assert.deepEqual(o.frostBaselineMessageIds,o.frostBefore.messageIds,verdictReason('BOOK_SETTINGS_BASELINE_MESSAGES',{cycle},''));
    } else {
      assert(o.prepareWriteId===undefined && o.prepareReadId===undefined && o.preparedRevision===undefined,verdictReason('BOOK_SETTINGS_RESTART_PREP_ABSENT',{cycle},''));
      settingsBook(baseline.book,SETTINGS[2],{cycle,source:'restart-baseline'}); settingsBook(o.book,SETTINGS[2],{cycle,source:'restart-observed'});
      const terminal=first.observed.frostTerminal;
      assert(o.frostBefore.archiveHash===terminal.archiveHash && o.frostBefore.revision===terminal.revision,verdictReason('BOOK_SETTINGS_RESTART_ARCHIVE',{cycle},''));
      assert.deepEqual(o.frostBefore.messageIds,terminal.messageIds,verdictReason('BOOK_SETTINGS_RESTART_HISTORY',{cycle},'Restart did not preserve the complete 「霜」 history'));
      assert(o.frostTerminal.archiveHash===o.frostBefore.archiveHash && o.frostTerminal.revision===o.frostBefore.revision &&
        o.frostTerminal.charactersHash===o.frostBefore.charactersHash && JSON.stringify(o.frostTerminal.messageIds)===JSON.stringify(o.frostBefore.messageIds),
        verdictReason('BOOK_SETTINGS_RESTART_UNCHANGED',{cycle},''));
      const controls=o.restartControls;
      assert(controls?.scanDepth===3 && controls.tokenBudget===0 && controls.recursiveScanning===true && controls.editorScanDepth===3 &&
        controls.editorTokenBudget===0 && controls.editorRecursiveScanning===true,verdictReason('BOOK_SETTINGS_RESTART_CONTROLS',{cycle},'Restart did not show the saved settings in the real controls'));
      wholeGeometry(controls.scanGeometry,controls.windowWidth,controls.windowHeight,{cycle,section:'restart-controls'});
      assert(integer(controls.readAtMs) && integer(controls.inputAtMs) && controls.inputAtMs>=controls.readAtMs && controls.inputAtMs-controls.readAtMs<10000,verdictReason('BOOK_SETTINGS_RESTART_CLOCK',{cycle},''));
      assert(typeof controls.screenshot==='string' && controls.screenshot.endsWith('.worldbook-book-settings-restart.png'),verdictReason('BOOK_SETTINGS_RESTART_SCREENSHOT',{cycle},''));
      // Separate whole-item observations within the one existing input clock,
      // not a claim that the final screenshot shows all three controls at once.
      const names=['worldbookScanDepth','worldbookBookTokenBudget','worldbookRecursiveScanning'];
      assert(controls.samplingPolicy==='sequential-whole-within-one-input-deadline' && Array.isArray(controls.samples) && controls.samples.length===3,
        verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_SET',{cycle},'Three individually qualified control observations are required'));
      assert.deepEqual(controls.samples.map(sample=>sample?.control),names,verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_ORDER',{cycle},''));
      assert.equal(controls.screenshotControl,names[2],verdictReason('BOOK_SETTINGS_RESTART_SCREENSHOT_CONTROL',{cycle},'The single screenshot follows the final control sample'));
      let previousSample;
      for(const [sampleIndex,sample] of controls.samples.entries()) {
        const context={cycle,sampleIndex,control:names[sampleIndex]}, current=sample.layout?.last;
        assert(sample.step===19 && sample.readId===o.baselineReadId && sample.scope===o.frostScope && sample.generation===baseline.generation && sample.personaId===frost &&
          sample.revision===baseline.revision && sample.archiveHash===baseline.archiveHash,verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_BINDING',context,''));
        assert(sample.value===SETTINGS[2][sampleIndex] && sample.editorValue===SETTINGS[2][sampleIndex],verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_VALUE',context,''));
        assert(sample.windowWidth===controls.windowWidth && sample.windowHeight===controls.windowHeight,verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_WINDOW',context,''));
        wholeGeometry(sample.geometry,sample.windowWidth,sample.windowHeight,{...context,section:'restart-control-sample'});
        assert(sample.layout?.ready===true && sample.layout.minimumStableMs===40 && current?.ready===true && current.layoutStable===true && current.enabled===true &&
          current.surfaceClosed===true && current.scope===sample.scope && current.fullyVisible===true,verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_LAYOUT',context,''));
        wholeGeometry(current,sample.windowWidth,sample.windowHeight,{...context,section:'restart-control-layout'});
        assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(key=>Math.abs(current[key]-sample.geometry[key])<=.5),
          verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_GEOMETRY_MATCH',context,'Whole-item geometry must match the qualified stable target'));
        assert(sample.stepAtMs===controls.readAtMs && sample.inputAtMs===controls.inputAtMs && integer(sample.sampledAtMs) &&
          sample.sampledAtMs>=controls.inputAtMs && sample.sampledAtMs-controls.inputAtMs<4000 && sample.sampledAtMs<o.elapsedMs &&
          integer(sample.frame) && sample.frame>0,verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_CLOCK',context,'All observations share the original input clock'));
        assert(integer(current.elapsedMs) && integer(current.stableSinceMs) && current.elapsedMs-current.stableSinceMs>=40 &&
          current.elapsedMs<=sample.sampledAtMs-controls.inputAtMs && integer(current.frameSerial) && integer(current.stableFrameSerial) &&
          current.frameSerial>current.stableFrameSerial && current.frameSerial<=sample.frame,
          verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_STABILITY',context,''));
        assert(!previousSample || (sample.sampledAtMs>previousSample.sampledAtMs && sample.frame>previousSample.frame &&
          current.stableSinceMs>=previousSample.sampledAtMs-controls.inputAtMs && current.stableFrameSerial>=previousSample.frame),
          verdictReason('BOOK_SETTINGS_RESTART_SAMPLE_FRESHNESS',context,'Each target must acquire a fresh stability interval'));
        previousSample=sample;
      }
      assert.deepEqual(controls.scanGeometry,controls.samples[0].geometry,verdictReason('BOOK_SETTINGS_RESTART_SCAN_GEOMETRY_ALIAS',{cycle},'Legacy scanGeometry describes the first scan-depth sample'));
    }
    let before=o.frostBefore.messageIds;
    for(const [n,chat] of report.chats.entries()) {
      const stage=n+1, context={cycle,stage};
      assert(chat.stage===stage && chat.personaId===frost && chat.scope===o.frostScope && chat.generation===baseline.generation,verdictReason('BOOK_SETTINGS_CHAT_IDENTITY',context,''));
      assert(chat.text===BOOK_SETTINGS_TEXTS[n] && chat.reply===BOOK_SETTINGS_REPLY,verdictReason('BOOK_SETTINGS_CHAT_TEXT',context,''));
      uniqueIds(chat.afterIds,context); assert.deepEqual(chat.beforeIds,before,verdictReason('BOOK_SETTINGS_CHAT_BEFORE',context,''));
      assert.deepEqual(chat.afterIds.slice(0,-2),before,verdictReason('BOOK_SETTINGS_CHAT_HISTORY_PREFIX',context,''));
      assert.deepEqual(chat.afterIds.slice(-2),[chat.userId,chat.assistantId],verdictReason('BOOK_SETTINGS_CHAT_PAIR',context,''));
      const dispatch=dispatches[n], clock=timing[n];
      assert(ident(chat.requestId) && chat.requestId===dispatch.request_id,verdictReason('BOOK_SETTINGS_CHAT_DISPATCH_ID',context,''));
      assert(chat.scope===`${dispatch.persona_id}:${dispatch.persona_epoch}:${dispatch.persona_fingerprint}` && dispatch.persona_epoch===clock.persona_epoch &&
        dispatch.persona_fingerprint===clock.persona_fingerprint,verdictReason('BOOK_SETTINGS_CHAT_TIMING_SCOPE',context,''));
      // Each chat runs on the state the preceding save (or preparation) read back.
      assert(chat.revision===states[n].revision && chat.archiveHash===states[n].archiveHash,verdictReason('BOOK_SETTINGS_CHAT_STATE',context,''));
      before=chat.afterIds;
    }
    if(!verify) {
      assert.deepEqual(o.frostTerminal.messageIds,before,verdictReason('BOOK_SETTINGS_TERMINAL_HISTORY',{cycle},''));
      const finalSave=report.saves[1], finalRead=report.receipts.find(r=>r.requestId===finalSave.readId), finalChat=report.chats[2];
      assert([finalSave,finalRead,finalChat].every(value=>o.frostTerminal.revision===value.revision && o.frostTerminal.archiveHash===value.archiveHash),
        verdictReason('BOOK_SETTINGS_TERMINAL_FINAL_SAVE',{cycle},'First-cycle terminal must be the final saved and freshly read archive used by the third chat'));
    }
    assert.deepEqual(report.inputs.map(i=>i.step),INPUT_STEPS[index],verdictReason('BOOK_SETTINGS_INPUT_STEP_ORDER',{cycle},'Real control input order changed'));
    const controls={51:'nav-character',1:'personaSwitch-'+frost,2:'personaSwitchConfirm',29:'nav-chat',30:'chatComposer',31:'sendChat',16:'nav-memory',
      7:'reloadWorldbook',8:'worldbookBookSelector',9:'worldbookEntrySelector',10:'worldbookScanDepth',17:'worldbookRecursiveScanning',11:'saveWorldbook',
      14:'memory-close',33:'nav-memory',18:'worldbookBookTokenBudget',34:'nav-character',40:'personaSwitch-'+o.originalBefore.personaId,41:'personaSwitchConfirm'};
    assert.deepEqual(report.inputs.map(i=>i.control),INPUT_STEPS[index].map(step=>controls[step]),verdictReason('BOOK_SETTINGS_INPUT_CONTROL_ORDER',{cycle},'Real control identity changed'));
    const values=name=>report.inputs.filter(i=>i.control===name).map(i=>[i.beforeValue,i.afterValue]);
    assert(JSON.stringify(values('worldbookScanDepth'))===JSON.stringify(verify?[]:[[1,3]]) && JSON.stringify(values('worldbookBookTokenBudget'))===JSON.stringify(verify?[]:[[100,0]]) &&
      JSON.stringify(values('worldbookRecursiveScanning'))===JSON.stringify(verify?[]:[[false,true]]),verdictReason('BOOK_SETTINGS_INPUT_VALUES',{cycle},''));
    assert.deepEqual(report.personaRowInputs?.map(r=>r.step),[1,40],verdictReason('BOOK_SETTINGS_ROW_STEPS',{cycle},''));
    for(const [n,row] of report.personaRowInputs.entries()) {
      const sourceScope=n?o.frostScope:o.originalScope;
      verifyPersonaRowInputRecord(row,{step:n?40:1,targetId:n?o.originalBefore.personaId:frost,sourcePersonaId:n?frost:o.originalBefore.personaId,
        livePersonaId:rowScope(sourceScope,{cycle,step:row.step}).personaId,scope:sourceScope,generation:n?baseline.generation:originalRead.generation,
        root:'taskSurface',page:'characterTasks'});
      const input=report.inputs.find(value=>value.step===row.step);
      assert(input && input.scope===row.scope && input.generation===row.generation && input.signals?.mouseDispatchCount===row.mouseDispatchCount &&
        input.signals?.clickedSignals===row.clickedSignals,verdictReason('BOOK_SETTINGS_ROW_INPUT',{cycle,step:row.step},''));
    }
    for(const [ordinal,input] of report.inputs.entries()) {
      const context={cycle,step:input.step};
      assert.equal(input.scope,ordinal<3?o.originalScope:o.frostScope,verdictReason('BOOK_SETTINGS_INPUT_SCOPE',context,''));
      assert.equal(input.generation,ordinal<3?originalRead.generation:baseline.generation,verdictReason('BOOK_SETTINGS_INPUT_GENERATION',context,''));
      assert(integer(input.elapsedMs) && input.elapsedMs<4000 && Number.isInteger(input.frame) && input.frame>0,verdictReason('BOOK_SETTINGS_INPUT_DEADLINE_FRAME',context,''));
      const layout=input.layout, current=layout?.last;
      assert(layout?.ready===true && layout.minimumStableMs===40 && current?.ready===true && current.layoutStable===true && current.enabled===true && current.surfaceClosed===true &&
        current.scope===input.scope && current.fullyVisible===true,verdictReason('BOOK_SETTINGS_INPUT_LAYOUT',context,''));
      wholeGeometry(current,input.windowWidth,input.windowHeight,{...context,section:'input'});
      assert(current.elapsedMs-current.stableSinceMs>=40 && current.elapsedMs<=input.elapsedMs && current.frameSerial>current.stableFrameSerial && current.frameSerial<=input.frame,verdictReason('BOOK_SETTINGS_INPUT_STABILITY',context,''));
      assert(input.hit?.acceptorFound===true && ['target','descendant'].includes(input.hit.hitResult),verdictReason('BOOK_SETTINGS_INPUT_HIT',context,''));
      assert(Number.isFinite(current.pointX) && Number.isFinite(current.pointY) && current.pointX>=current.sceneX && current.pointX<=current.sceneX+current.sceneWidth &&
        current.pointY>=current.sceneY && current.pointY<=current.sceneY+current.sceneHeight && current.pointX>=current.clipX && current.pointX<=current.clipX+current.clipWidth &&
        current.pointY>=current.clipY && current.pointY<=current.clipY+current.clipHeight,verdictReason('BOOK_SETTINGS_INPUT_POINT',context,''));
      const signal=input.signals;
      if(['worldbookScanDepth','worldbookBookTokenBudget'].includes(input.control)) assert.deepEqual(signal,{kind:'integer',mouseDispatchCount:1,keyDispatchCount:2,valueModifiedSignals:2},verdictReason('BOOK_SETTINGS_INPUT_INTEGER_SIGNALS',context,''));
      else if(input.control==='worldbookRecursiveScanning') assert.deepEqual(signal,{kind:'checkbox',mouseDispatchCount:1,toggledSignals:1,checked:true},verdictReason('BOOK_SETTINGS_INPUT_CHECKBOX_SIGNALS',context,''));
      else if(input.control==='chatComposer') assert.deepEqual(signal,{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},verdictReason('BOOK_SETTINGS_INPUT_TEXT_SIGNALS',context,''));
      else if(input.control==='worldbookBookSelector') assert.deepEqual(signal,{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1},verdictReason('BOOK_SETTINGS_INPUT_SELECTOR_SIGNALS',context,''));
      else if(input.control==='worldbookEntrySelector') assert.deepEqual(signal,{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:0},verdictReason('BOOK_SETTINGS_INPUT_SELECTOR_SIGNALS',context,''));
      else assert.deepEqual(signal,{kind:'button',mouseDispatchCount:1,clickedSignals:1},verdictReason('BOOK_SETTINGS_INPUT_BUTTON_SIGNALS',context,''));
    }
  }
  return {passed:true,checks:[7,4],http:3,preparationWrites:[1,0],saveWrites:[2,0],chats:[3,0]};
}
module.exports={BOOK_SETTINGS_TEXTS,BOOK_SETTINGS_REPLY,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,EXPECTED_CONTEXT,bookSettingsModelMetadata,verifyWorldbookBookSettings};
