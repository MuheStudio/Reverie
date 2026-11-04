'use strict';
const assert = require('node:assert/strict');
const {verdictReason}=require('./verdict-test-support.cjs');
const crypto = require('node:crypto');
const PRIORITY_TEXTS = Object.freeze(['优先级记录一：请核对第一条', '优先级记录二：请核对第二条', '优先级记录三：重启后请核对']);
const PRIORITY_REPLY = '优先级效果已核对';
const INPUT_STEPS = Object.freeze([[51,1,2,16,7,8,9,10,11,14,30,31,33,10,11,14,30,31,34,40,41],[51,1,2,29,30,31,34,40,41]]);
const FIRST_CHECKS = Object.freeze(['priority-original-persona-captured-and-sunny-baseline-read',
  'priority-fixture-prepared-once-with-budget-eight', 'priority-a-two-saved-read-back-and-first-chat',
  'priority-a-zero-saved-read-back-and-second-chat', 'priority-sunny-terminal-only-two-edits-and-four-messages',
  'priority-return-moon-archive-messages-switches-preserved']);
const RESTART_CHECKS = Object.freeze(['priority-restart-sunny-archive-and-message-identities',
  'priority-restart-third-chat-only-b-and-one-message-pair',
  'priority-restart-default-archive-messages-switches-avatar-preserved', 'priority-restart-zero-preparation-and-zero-save-writes']);
// This is the full observed order of the signed-off 22-request persona contract,
// with its fixed stages retained. The three new tail calls are not substituted
// for an old call and cannot hide an unexpected extra request.
const LEGACY_SEQUENCE = Object.freeze([
  ['probe',1,0],['chat',1,0],['reading-fixture',1,0],['reading-fixture',1,0],['stop-fixture',1,0],['combined-fixture',1,0],
  ...[1,2,3,4].map(n=>['worldbook-fixture',1,n]), ...[1,2,3,4].map(n=>['literal-rule-fixture',1,n]),
  ...[1,2,3,4].map(()=>['author-prompt-fixture',1,0]), ['probe',2,0],['author-prompt-fixture',2,0],
  ['literal-rule-fixture',2,5],['author-prompt-fixture',2,0]]);
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function priorityModelMetadata(messages) {
  assert(Array.isArray(messages),verdictReason('WB_MODEL_ARRAY_ISARRAY_MESSAGES',{},'Priority model messages missing'));
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
  return { worldSettingSections: sections.length, firstMarkerCount: context.split('PRIORITY_A_ONLY').length-1,
    secondMarkerCount: context.split('PRIORITY_B_ONLY').length-1,
    markerInHistory: messages.some(m=>m.role!=='system' && /PRIORITY_[AB]_ONLY/.test(String(m.content || ''))),
    worldSettingSha256: crypto.createHash('sha256').update(context).digest('hex') };
}
function canonicalHash(value) {
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
function wholeGeometry(g, width, height, diagnostic = {}) {
  assert(g?.found===true && g.visible===true && g.fullyVisible===true,verdictReason('GEOMETRY_VISIBLE',diagnostic,''));
  assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'].every(k=>Number.isFinite(g[k])),verdictReason('WB_GEOMETRY_SCENEX_SCENEY_SCENEWIDTH_SCENEHEIGHT_CLIPX_CLIPY_CLIPWIDTH_CLIPHEIGHT_EVERY_K',diagnostic,''));
  assert(g.sceneWidth>1 && g.sceneHeight>1 && g.clipWidth>0 && g.clipHeight>0,verdictReason('WB_GEOMETRY_G_SCENEWIDTH_1_G_SCENEHEIGHT_1_G_CLIPWIDTH_0_G_CLIPHEIGHT_0',diagnostic,''));
  assert(Number.isFinite(width) && Number.isFinite(height) && width>0 && height>0,verdictReason('WB_GEOMETRY_NUMBER_ISFINITE_WIDTH_NUMBER_ISFINITE_HEIGHT_WIDTH_0_HEIGHT_0',diagnostic,''));
  assert(g.clipX>=-.5 && g.clipY>=-.5 && g.clipX+g.clipWidth<=width+.5 && g.clipY+g.clipHeight<=height+.5,verdictReason('WB_GEOMETRY_G_CLIPX_5_G_CLIPY_5_G_CLIPX_G_CLIPWIDTH_WIDTH_5_G_CLIPY_G_CLIPHEIGHT_HEIGHT_5',diagnostic,''));
  assert(g.sceneX+.5>=g.clipX && g.sceneY+.5>=g.clipY && g.sceneX+g.sceneWidth-.5<=g.clipX+g.clipWidth && g.sceneY+g.sceneHeight-.5<=g.clipY+g.clipHeight,verdictReason('GEOMETRY_CONTAINMENT',diagnostic,'Clipped save feedback'));
}
function priorityBook(book, value, diagnostic = {}) {
  assert.equal(book?.id,'p1_priority_book',verdictReason('WB_BOOK_BOOK_ID_P1_PRIORITY_BOOK',diagnostic,'')); assert.equal(book.tokenBudget,8,verdictReason('PRIORITY_BOOK_BUDGET',diagnostic,''));
  assert.equal(book.recursiveScanning,false,verdictReason('WB_BOOK_BOOK_RECURSIVESCANNING_FALSE',diagnostic,'')); assert.equal(book.scanDepth,1,verdictReason('WB_BOOK_BOOK_SCANDEPTH_1',diagnostic,''));
  assert.equal(book.entries?.length,2,verdictReason('WB_BOOK_BOOK_ENTRIES_LENGTH_2',diagnostic,''));
  for (const [i,entry] of book.entries.entries()) {
    assert.equal(entry.id,i?'p1_priority_b':'p1_priority_a',verdictReason('WB_BOOK_ENTRY_ID_I_P1_PRIORITY_B_P1_PRIORITY_A',{...diagnostic,entryIndex:i},''));
    assert.equal(entry.content,i?'PRIORITY_B_ONLY':'PRIORITY_A_ONLY',verdictReason('WB_BOOK_ENTRY_CONTENT_I_PRIORITY_B_ONLY_PRIORITY_A_ONLY',{...diagnostic,entryIndex:i},''));
    assert.equal(entry.priority,i?1:value,verdictReason('WB_BOOK_ENTRY_PRIORITY_I_1_VALUE',{...diagnostic,entryIndex:i},'')); assert.equal(entry.insertionOrder,i?20:10,verdictReason('PRIORITY_ENTRY_ORDER',{...diagnostic,entryIndex:i},''));
    assert.equal(entry.enabled,true,verdictReason('WB_BOOK_ENTRY_ENABLED_TRUE',{...diagnostic,entryIndex:i},'')); assert.equal(entry.alwaysActive,true,verdictReason('WB_BOOK_ENTRY_ALWAYSACTIVE_TRUE',{...diagnostic,entryIndex:i},'')); assert.equal(entry.useRegex,false,verdictReason('WB_BOOK_ENTRY_USEREGEX_FALSE',{...diagnostic,entryIndex:i},''));
    assert.equal(entry.tokenBudget,null,verdictReason('PRIORITY_ENTRY_TOKEN_BUDGET',{...diagnostic,entryIndex:i},''));
  }
}
function uniqueIds(ids, diagnostic = {}) { assert(Array.isArray(ids) && ids.every(ident),verdictReason('WB_IDS_ARRAY_ISARRAY_IDS_IDS_EVERY_IDENT',diagnostic,'Message identities missing')); assert.equal(new Set(ids).size,ids.length,verdictReason('WB_IDS_NEW_SET_IDS_SIZE_IDS_LENGTH',diagnostic,'')); }
function snapshot(value, diagnostic = {}) {
  assert(ident(value?.personaId) && Number.isInteger(value.revision) && value.revision>=0 && sha(value.archiveHash) && sha(value.charactersHash),verdictReason('WB_SNAPSHOT_IDENT_VALUE_PERSONAID_NUMBER_ISINTEGER_VALUE_REVISION_VALUE_REVISION_0_SHA_VAL',diagnostic,''));
  assert.equal(typeof value.exists,'boolean',verdictReason('WB_SNAPSHOT_TYPEOF_VALUE_EXISTS_BOOLEAN',diagnostic,'')); uniqueIds(value.messageIds,diagnostic); assert(Array.isArray(value.avatarIds),verdictReason('WB_SNAPSHOT_ARRAY_ISARRAY_VALUE_AVATARIDS',diagnostic,'')); assert.equal(new Set(value.avatarIds).size,value.avatarIds.length,verdictReason('WB_SNAPSHOT_NEW_SET_VALUE_AVATARIDS_SIZE_VALUE_AVATARIDS_LENGTH',diagnostic,''));
  assert(typeof value.activeAvatar==='string' && value.activeAvatar.length>0,verdictReason('WB_SNAPSHOT_TYPEOF_VALUE_ACTIVEAVATAR_STRING_VALUE_ACTIVEAVATAR_LENGTH_0',diagnostic,''));
}
function verifyWorldbookPriority(reports, modelCalls, events, requests) {
  assert.equal(requests,25,verdictReason('PRIORITY_HTTP_TOTAL',{},'Persona HTTP count must be exactly 25')); assert.equal(modelCalls.length,25,verdictReason('WB_PRIORITY_MODELCALLS_LENGTH_25',{},''));
  const legacy=modelCalls.filter(c=>c.kind!=='priority-fixture');
  assert.deepEqual(legacy.map(c=>[c.kind,c.cycle,c.stage||0]),LEGACY_SEQUENCE,verdictReason('PRIORITY_LEGACY_SEQUENCE',{},'Original 22 requests are not a complete ordered subset'));
  const additions=modelCalls.filter(c=>c.kind==='priority-fixture');
  assert.deepEqual(modelCalls.map((c,i)=>c.kind==='priority-fixture'?i:null).filter(i=>i!==null),[18,19,24],verdictReason('PRIORITY_CALL_POSITIONS',{},'Priority calls not after the complete old cycle'));
  assert.deepEqual(additions.map(c=>[c.cycle,c.stage,c.priorityText,c.worldSettingSections,c.firstMarkerCount,c.secondMarkerCount,c.markerInHistory]),[[1,1,PRIORITY_TEXTS[0],1,1,0,false],[1,2,PRIORITY_TEXTS[1],1,0,1,false],[2,3,PRIORITY_TEXTS[2],1,0,1,false]],verdictReason('PRIORITY_REQUEST_SIGNATURE',{},''));
  assert.deepEqual(additions.map(c=>c.worldSettingSha256),['PRIORITY_A_ONLY','PRIORITY_B_ONLY','PRIORITY_B_ONLY'].map(text=>crypto.createHash('sha256').update(text).digest('hex')),verdictReason('WB_PRIORITY_ADDITIONS_MAP_C_C_WORLDSETTINGSHA256_PRIORITY_A_ONLY_PRIORITY_B_ONLY_PRIORITY',{},''));
  assert.equal(reports.length,2,verdictReason('WB_PRIORITY_REPORTS_LENGTH_2',{},''));
  const [first,restart]=reports.map(r=>r.worldbookPriority);
  const seeded=events.filter(e=>e.event==='persona_seeded'); assert.equal(seeded.length,1,verdictReason('WB_PRIORITY_SEEDED_LENGTH_1',{},'')); const sunny=seeded[0].profile_id; assert(ident(sunny),verdictReason('WB_PRIORITY_IDENT_SUNNY',{},''));
  const dispatches=events.filter(e=>e.event==='priority_dispatch'), timing=events.filter(e=>e.event==='priority_timing');
  const writeDispatches=events.filter(e=>e.event==='priority_archive_put_dispatch');
  assert.equal(writeDispatches.length,3,verdictReason('PRIORITY_WRITE_DISPATCH_TOTAL',{},'Sunny archive writes were missing or repeated'));
  assert.deepEqual(dispatches.map(e=>[e.cycle,e.stage,e.persona_id]),[[1,1,sunny],[1,2,sunny],[2,3,sunny]],verdictReason('WB_PRIORITY_DISPATCHES_MAP_E_E_CYCLE_E_STAGE_E_PERSONA_ID_1_1_SUNNY_1_2_SUNNY_2_3_SUNNY',{},''));
  assert.deepEqual(timing.map(e=>[e.cycle,e.stage,e.persona_id,e.start_delay_ms,e.delivery_delay_ms]),[[1,1,sunny,0,100],[1,2,sunny,0,100],[2,3,sunny,0,100]],verdictReason('WB_PRIORITY_TIMING_MAP_E_E_CYCLE_E_STAGE_E_PERSONA_ID_E_START_DELAY_MS_E_DELIVERY_DELAY_MS',{},''));
  for(const [index,report] of [first,restart].entries()) {
    const verify=index===1, o=report?.observed;
    assert.equal(report?.passed,true,verdictReason('WB_PRIORITY_REPORT_PASSED_TRUE',{cycle:index+1},'')); assert.equal(report.error,'',verdictReason('WB_PRIORITY_REPORT_ERROR',{cycle:index+1},'')); assert.equal(report.mode,verify?'restart-readback':'change-and-effect',verdictReason('WB_PRIORITY_REPORT_MODE_VERIFY_RESTART_READBACK_CHANGE_AND_EFFECT',{cycle:index+1},''));
    assert.equal(report.deadlineMs,verify?20000:30000,verdictReason('WB_PRIORITY_REPORT_DEADLINEMS_VERIFY_20000_30000',{cycle:index+1},'')); assert(o.elapsedMs>=0 && o.elapsedMs<report.deadlineMs,verdictReason('PRIORITY_SEGMENT_ELAPSED',{cycle:index+1},''));
    assert.deepEqual(report.checks.map(c=>c.name),verify?RESTART_CHECKS:FIRST_CHECKS,verdictReason('PRIORITY_CHECK_ORDER',{cycle:index+1},'')); assert(report.checks.every(c=>c.passed===true),verdictReason('WB_PRIORITY_REPORT_CHECKS_EVERY_C_C_PASSED_TRUE',{cycle:index+1},''));
    assert.equal(new Set(report.checks.map(c=>c.name)).size,report.checks.length,verdictReason('WB_PRIORITY_NEW_SET_REPORT_CHECKS_MAP_C_C_NAME_SIZE_REPORT_CHECKS_LENGTH',{cycle:index+1},''));
    assert.equal(o.sunnyPersonaId,sunny,verdictReason('WB_PRIORITY_O_SUNNYPERSONAID_SUNNY',{cycle:index+1},'')); snapshot(o.originalBefore,{cycle:index+1,snapshot:"original-before"}); snapshot(o.originalAfter,{cycle:index+1,snapshot:"original-after"}); snapshot(o.sunnyBefore,{cycle:index+1,snapshot:"sunny-before"}); snapshot(o.sunnyTerminal,{cycle:index+1,snapshot:"sunny-terminal"});
    assert.deepEqual(o.originalAfter,o.originalBefore,verdictReason('PRIORITY_ORIGINAL_PRESERVED',{cycle:index+1},'Return changed original persona persistent state'));
    assert.equal(o.sunnyBefore.personaId,sunny,verdictReason('WB_PRIORITY_O_SUNNYBEFORE_PERSONAID_SUNNY',{cycle:index+1},'')); assert.equal(o.sunnyTerminal.personaId,sunny,verdictReason('WB_PRIORITY_O_SUNNYTERMINAL_PERSONAID_SUNNY',{cycle:index+1},''));
    assert.equal(o.originalBefore.personaId,index?'default':reports[0].archiveInteraction.cardImport.moonPersona,verdictReason('PRIORITY_ORIGINAL_PERSONA',{cycle:index+1},''));
    assert(typeof o.originalScope==='string' && typeof o.returnScope==='string' && o.originalScope!==o.returnScope && o.sunnyScope!==o.originalScope && o.sunnyScope!==o.returnScope,verdictReason('PRIORITY_SCOPE_TRANSITIONS',{cycle:index+1},''));
    assert.equal(report.receipts.length,new Set(report.receipts.map(r=>r.requestId)).size,verdictReason('PRIORITY_RECEIPT_UNIQUE',{cycle:index+1},'Repeated receipt'));
    assert(report.receipts.every(r=>ident(r.requestId) && Number.isInteger(r.generation) && r.generation>=0 && typeof r.scope==='string' && r.scope.length>0 && sha(r.archiveHash)),verdictReason('WB_PRIORITY_REPORT_RECEIPTS_EVERY_R_IDENT_R_REQUESTID_NUMBER_ISINTEGER_R_GENERATION_R_GENE',{cycle:index+1},''));
    const receipt=(id,command,scope,personaId,role) => {
      assert(ident(id),verdictReason('WB_PRIORITY_IDENT_ID',{cycle:index+1,command,role},'')); const found=report.receipts.filter(r=>r.requestId===id); assert.equal(found.length,1,verdictReason('PRIORITY_RECEIPT_PRESENT',{cycle:index+1,command,role},'Missing actual receipt'));
      const r=found[0]; assert.equal(r.command,command,verdictReason('WB_PRIORITY_R_COMMAND_COMMAND',{cycle:index+1,command,role},'')); assert.equal(r.ok,true,verdictReason('WB_PRIORITY_R_OK_TRUE',{cycle:index+1,command,role},'')); assert.equal(r.scope,scope,verdictReason('PRIORITY_RECEIPT_SCOPE',{cycle:index+1,command,role},'')); assert.equal(r.personaId,personaId,verdictReason('WB_PRIORITY_R_PERSONAID_PERSONAID',{cycle:index+1,command,role},'')); return r;
    };
    const originalRead=receipt(o.originalReadId,'archive:get',o.originalScope,o.originalBefore.personaId,'original-read');
    assert.equal(originalRead.archiveHash,o.originalBefore.archiveHash,verdictReason('WB_PRIORITY_ORIGINALREAD_ARCHIVEHASH_O_ORIGINALBEFORE_ARCHIVEHASH',{cycle:index+1},'')); assert.equal(originalRead.revision,o.originalBefore.revision,verdictReason('WB_PRIORITY_ORIGINALREAD_REVISION_O_ORIGINALBEFORE_REVISION',{cycle:index+1},''));
    const returned=receipt(o.returnReadId,'archive:get',o.returnScope,o.originalBefore.personaId,'return-read');
    assert.equal(returned.archiveHash,o.originalBefore.archiveHash,verdictReason('WB_PRIORITY_RETURNED_ARCHIVEHASH_O_ORIGINALBEFORE_ARCHIVEHASH',{cycle:index+1},'')); assert.equal(returned.revision,o.originalBefore.revision,verdictReason('WB_PRIORITY_RETURNED_REVISION_O_ORIGINALBEFORE_REVISION',{cycle:index+1},''));
    const baseline=receipt(o.baselineReadId,'archive:get',o.sunnyScope,sunny,'baseline-read');
    assert.equal(baseline.archiveHash,o.sunnyBefore.archiveHash,verdictReason('PRIORITY_BASELINE_ARCHIVE_HASH',{cycle:index+1},'')); assert.equal(baseline.revision,o.sunnyBefore.revision,verdictReason('WB_PRIORITY_BASELINE_REVISION_O_SUNNYBEFORE_REVISION',{cycle:index+1},'')); assert.equal(baseline.exists,o.sunnyBefore.exists,verdictReason('WB_PRIORITY_BASELINE_EXISTS_O_SUNNYBEFORE_EXISTS',{cycle:index+1},''));
    const baselineRest=o.canonicalBaselineRestHash; assert(sha(baselineRest),verdictReason('WB_PRIORITY_SHA_BASELINEREST',{cycle:index+1},''));
    if(baseline.exists===false) {
      assert.equal(baseline.revision,0,verdictReason('WB_PRIORITY_BASELINE_REVISION_0',{cycle:index+1},'')); assert.deepEqual(baseline.book,{},verdictReason('WB_PRIORITY_BASELINE_BOOK',{cycle:index+1},'')); assert.equal(baseline.archiveHash,canonicalHash({}),verdictReason('WB_PRIORITY_BASELINE_ARCHIVEHASH_CANONICALHASH',{cycle:index+1},''));
      assert.equal(baseline.restHash,canonicalHash({worldBooks:[]}),verdictReason('WB_PRIORITY_BASELINE_RESTHASH_CANONICALHASH_WORLDBOOKS',{cycle:index+1},''));
      assert.equal(baselineRest,canonicalHash({characters:[],activeCharacterIds:[],worldBooks:[]}),verdictReason('PRIORITY_EMPTY_CANONICAL_REST',{cycle:index+1},''));
    } else assert.equal(baselineRest,baseline.restHash,verdictReason('WB_PRIORITY_BASELINEREST_BASELINE_RESTHASH',{cycle:index+1},''));
    const puts=report.receipts.filter(r=>r.command==='archive:put'); assert.equal(puts.length,verify?0:3,verdictReason('PRIORITY_WRITE_RECEIPT_TOTAL',{cycle:index+1},'')); assert.equal(o.putCount,puts.length,verdictReason('WB_PRIORITY_O_PUTCOUNT_PUTS_LENGTH',{cycle:index+1},''));
    assert.equal(report.saves.length,verify?0:2,verdictReason('WB_PRIORITY_REPORT_SAVES_LENGTH_VERIFY_0_2',{cycle:index+1},'')); assert.equal(report.chats.length,verify?1:2,verdictReason('WB_PRIORITY_REPORT_CHATS_LENGTH_VERIFY_1_2',{cycle:index+1},''));
    if(!verify) {
      assert.deepEqual(baseline.book,{},verdictReason('WB_PRIORITY_BASELINE_BOOK_2',{cycle:index+1},'')); assert.equal(o.preparedExpectedRevision,o.sunnyBefore.revision,verdictReason('WB_PRIORITY_O_PREPAREDEXPECTEDREVISION_O_SUNNYBEFORE_REVISION',{cycle:index+1},''));
      const prep=receipt(o.prepareWriteId,'archive:put',o.sunnyScope,sunny,'prepare-write'), read=receipt(o.prepareReadId,'archive:get',o.sunnyScope,sunny,'prepare-read');
      assert.equal(prep.revision,o.sunnyBefore.revision+1,verdictReason('WB_PRIORITY_PREP_REVISION_O_SUNNYBEFORE_REVISION_1',{cycle:index+1},'')); assert.equal(prep.revision,o.preparedRevision,verdictReason('WB_PRIORITY_PREP_REVISION_O_PREPAREDREVISION',{cycle:index+1},''));
      priorityBook(prep.book,0,{cycle:index+1,source:"preparation"}); assert.equal(read.revision,prep.revision,verdictReason('WB_PRIORITY_READ_REVISION_PREP_REVISION',{cycle:index+1},'')); assert.equal(read.archiveHash,prep.archiveHash,verdictReason('WB_PRIORITY_READ_ARCHIVEHASH_PREP_ARCHIVEHASH',{cycle:index+1},'')); assert.equal(read.restHash,baselineRest,verdictReason('WB_PRIORITY_READ_RESTHASH_BASELINEREST',{cycle:index+1},''));
      assert.equal(prep.generation,baseline.generation,verdictReason('PRIORITY_PREP_BASELINE_GENERATION',{cycle:index+1},'')); assert.equal(read.generation,baseline.generation,verdictReason('WB_PRIORITY_READ_GENERATION_BASELINE_GENERATION',{cycle:index+1},''));
      for(const [n,save] of report.saves.entries()) {
        assert.equal(save.stage,n+1,verdictReason('WB_PRIORITY_SAVE_STAGE_N_1',{cycle:index+1,stage:n+1},'')); assert.equal(save.priority,n?0:2,verdictReason('WB_PRIORITY_SAVE_PRIORITY_N_0_2',{cycle:index+1,stage:n+1},'')); assert.equal(save.expectedRevision,prep.revision+n,verdictReason('WB_PRIORITY_SAVE_EXPECTEDREVISION_PREP_REVISION_N',{cycle:index+1,stage:n+1},'')); assert.equal(save.revision,save.expectedRevision+1,verdictReason('PRIORITY_SAVE_REVISION',{cycle:index+1,stage:n+1},''));
        const ack=receipt(save.writeId,'archive:put',o.sunnyScope,sunny,'save-ack-'+(n+1)), fresh=receipt(save.readId,'archive:get',o.sunnyScope,sunny,'save-read-'+(n+1));
        assert.notEqual(save.readId,save.writeId,verdictReason('WB_PRIORITY_SAVE_READID_SAVE_WRITEID',{cycle:index+1,stage:n+1},'')); assert.equal(ack.generation,save.generation,verdictReason('WB_PRIORITY_ACK_GENERATION_SAVE_GENERATION',{cycle:index+1,stage:n+1},'')); assert.equal(fresh.generation,save.generation,verdictReason('PRIORITY_READ_GENERATION',{cycle:index+1,stage:n+1},''));
        assert.equal(save.generation,baseline.generation,verdictReason('PRIORITY_SAVE_BASELINE_GENERATION',{cycle:index+1,stage:n+1},'Priority save is from another connection generation'));
        assert.equal(save.scope,o.sunnyScope,verdictReason('WB_PRIORITY_SAVE_SCOPE_O_SUNNYSCOPE',{cycle:index+1,stage:n+1},'')); assert.equal(save.personaId,sunny,verdictReason('WB_PRIORITY_SAVE_PERSONAID_SUNNY',{cycle:index+1,stage:n+1},'')); assert.equal(ack.revision,save.revision,verdictReason('PRIORITY_ACK_REVISION',{cycle:index+1,stage:n+1},'')); assert.equal(fresh.revision,save.revision,verdictReason('WB_PRIORITY_FRESH_REVISION_SAVE_REVISION',{cycle:index+1,stage:n+1},''));
        assert.equal(ack.archiveHash,save.archiveHash,verdictReason('WB_PRIORITY_ACK_ARCHIVEHASH_SAVE_ARCHIVEHASH',{cycle:index+1,stage:n+1},'')); assert.equal(fresh.archiveHash,save.archiveHash,verdictReason('WB_PRIORITY_FRESH_ARCHIVEHASH_SAVE_ARCHIVEHASH',{cycle:index+1,stage:n+1},'')); assert.equal(save.restHash,baselineRest,verdictReason('PRIORITY_SAVE_REST_HASH',{cycle:index+1,stage:n+1},'')); assert.equal(fresh.restHash,baselineRest,verdictReason('WB_PRIORITY_FRESH_RESTHASH_BASELINEREST',{cycle:index+1,stage:n+1},''));
        priorityBook(ack.book,n?0:2,{cycle:index+1,stage:n+1,source:"save-ack"}); priorityBook(fresh.book,n?0:2,{cycle:index+1,stage:n+1,source:"save-read"}); assert.deepEqual(save.book,ack.book,verdictReason('PRIORITY_SAVE_BOOK',{cycle:index+1,stage:n+1},''));
        assert(save.binding?.armed===true && save.binding.status==='matched' && save.binding.failureReason==='',verdictReason('WB_PRIORITY_SAVE_BINDING_ARMED_TRUE_SAVE_BINDING_STATUS_MATCHED_SAVE_BINDING_FAILUREREASON',{cycle:index+1,stage:n+1},''));
        assert.equal(save.binding.requestId,save.writeId,verdictReason('PRIORITY_SAVE_REQUEST_BINDING',{cycle:index+1,stage:n+1},''));assert.equal(save.binding.scope,o.sunnyScope,verdictReason('WB_PRIORITY_SAVE_BINDING_SCOPE_O_SUNNYSCOPE',{cycle:index+1,stage:n+1},''));assert.equal(save.binding.generation,baseline.generation,verdictReason('WB_PRIORITY_SAVE_BINDING_GENERATION_BASELINE_GENERATION',{cycle:index+1,stage:n+1},''));
        assert(rowInteger(save.binding.baselineCount),verdictReason('WB_PRIORITY_ROWINTEGER_SAVE_BINDING_BASELINECOUNT',{cycle:index+1,stage:n+1},''));assert(rowInteger(save.readAtMs) && rowInteger(save.feedbackInputAtMs) && save.feedbackInputAtMs>=save.readAtMs && save.feedbackInputAtMs-save.readAtMs<10000,verdictReason('PRIORITY_FEEDBACK_INPUT_CLOCK',{cycle:index+1,stage:n+1},''));
        assert(typeof save.feedback==='string' && save.feedback.includes('已保存'),verdictReason('WB_PRIORITY_TYPEOF_SAVE_FEEDBACK_STRING_SAVE_FEEDBACK_INCLUDES',{cycle:index+1,stage:n+1},'')); wholeGeometry(save.feedbackGeometry,save.windowWidth,save.windowHeight,{cycle:index+1,stage:n+1,section:"save-feedback"});
        assert(typeof save.screenshot==='string' && save.screenshot.endsWith(`.worldbook-priority-save-${n+1}.png`),verdictReason('WB_PRIORITY_TYPEOF_SAVE_SCREENSHOT_STRING_SAVE_SCREENSHOT_ENDSWITH_WORLDBOOK_PRIORITY_SAVE',{cycle:index+1,stage:n+1},''));
      }
      assert.deepEqual(puts.map(p=>p.requestId),[o.prepareWriteId,...report.saves.map(s=>s.writeId)],verdictReason('WB_PRIORITY_PUTS_MAP_P_P_REQUESTID_O_PREPAREWRITEID_REPORT_SAVES_MAP_S_S_WRITEID',{cycle:index+1},''));
      assert.deepEqual(writeDispatches.map(d=>[d.cycle,d.request_id,d.persona_id,d.expected_revision]),puts.map((p,n)=>[1,p.requestId,sunny,o.sunnyBefore.revision+n]),verdictReason('WB_PRIORITY_WRITEDISPATCHES_MAP_D_D_CYCLE_D_REQUEST_ID_D_PERSONA_ID_D_EXPECTED_REVISION_PU',{cycle:index+1},''));
      assert(writeDispatches.every(d=>`${d.persona_id}:${d.persona_epoch}:${d.persona_fingerprint}`===o.sunnyScope),verdictReason('WB_PRIORITY_WRITEDISPATCHES_EVERY_D_D_PERSONA_ID_D_PERSONA_EPOCH_D_PERSONA_FINGERPRINT_O_S',{cycle:index+1},''));
    } else {
      assert.equal(o.prepareWriteId,undefined,verdictReason('PRIORITY_RESTART_PREP_ABSENT',{cycle:index+1},'')); assert.equal(o.prepareReadId,undefined,verdictReason('WB_PRIORITY_O_PREPAREREADID_UNDEFINED',{cycle:index+1},'')); assert.equal(o.preparedRevision,undefined,verdictReason('WB_PRIORITY_O_PREPAREDREVISION_UNDEFINED',{cycle:index+1},''));
      priorityBook(baseline.book,0,{cycle:index+1,source:"restart-baseline"}); assert.equal(o.sunnyBefore.archiveHash,first.observed.sunnyTerminal.archiveHash,verdictReason('PRIORITY_RESTART_ARCHIVE_HASH',{cycle:index+1},''));
      assert.equal(o.sunnyBefore.revision,first.observed.sunnyTerminal.revision,verdictReason('WB_PRIORITY_O_SUNNYBEFORE_REVISION_FIRST_OBSERVED_SUNNYTERMINAL_REVISION',{cycle:index+1},''));
      assert.deepEqual(o.sunnyBefore.messageIds,first.observed.sunnyTerminal.messageIds,verdictReason('PRIORITY_RESTART_HISTORY',{cycle:index+1},'Restart did not preserve full Sunny history'));
      assert.equal(o.sunnyTerminal.archiveHash,o.sunnyBefore.archiveHash,verdictReason('WB_PRIORITY_O_SUNNYTERMINAL_ARCHIVEHASH_O_SUNNYBEFORE_ARCHIVEHASH',{cycle:index+1},'')); assert.equal(o.sunnyTerminal.revision,o.sunnyBefore.revision,verdictReason('WB_PRIORITY_O_SUNNYTERMINAL_REVISION_O_SUNNYBEFORE_REVISION',{cycle:index+1},''));
    }
    let before=o.sunnyBefore.messageIds;
    for(const [n,chat] of report.chats.entries()) {
      const stage=index?3:n+1; assert.equal(chat.stage,stage,verdictReason('WB_PRIORITY_CHAT_STAGE_STAGE',{cycle:index+1,stage},'')); assert.equal(chat.personaId,sunny,verdictReason('PRIORITY_CHAT_PERSONA',{cycle:index+1,stage},'')); assert.equal(chat.scope,o.sunnyScope,verdictReason('WB_PRIORITY_CHAT_SCOPE_O_SUNNYSCOPE',{cycle:index+1,stage},''));
      assert.equal(chat.generation,baseline.generation,verdictReason('WB_PRIORITY_CHAT_GENERATION_BASELINE_GENERATION',{cycle:index+1,stage},'')); assert.equal(chat.text,PRIORITY_TEXTS[stage-1],verdictReason('WB_PRIORITY_CHAT_TEXT_PRIORITY_TEXTS_STAGE_1',{cycle:index+1,stage},'')); assert.equal(chat.reply,PRIORITY_REPLY,verdictReason('WB_PRIORITY_CHAT_REPLY_PRIORITY_REPLY',{cycle:index+1,stage},''));
      uniqueIds(chat.afterIds,{cycle:index+1,stage}); assert.deepEqual(chat.beforeIds,before,verdictReason('WB_PRIORITY_CHAT_BEFOREIDS_BEFORE',{cycle:index+1,stage},'')); assert.deepEqual(chat.afterIds.slice(0,-2),before,verdictReason('PRIORITY_CHAT_HISTORY_PREFIX',{cycle:index+1,stage},''));
      assert.deepEqual(chat.afterIds.slice(-2),[chat.userId,chat.assistantId],verdictReason('WB_PRIORITY_CHAT_AFTERIDS_SLICE_2_CHAT_USERID_CHAT_ASSISTANTID',{cycle:index+1,stage},'')); assert(ident(chat.requestId),verdictReason('WB_PRIORITY_IDENT_CHAT_REQUESTID',{cycle:index+1,stage},''));
      const dispatch=dispatches[stage-1], clock=timing[stage-1]; assert.equal(chat.requestId,dispatch.request_id,verdictReason('PRIORITY_CHAT_DISPATCH_ID',{cycle:index+1,stage},''));
      assert.equal(chat.scope,`${dispatch.persona_id}:${dispatch.persona_epoch}:${dispatch.persona_fingerprint}`,verdictReason('WB_PRIORITY_CHAT_SCOPE_DISPATCH_PERSONA_ID_DISPATCH_PERSONA_EPOCH_DISPATCH_PERSONA_FINGERP',{cycle:index+1,stage},''));
      assert.equal(dispatch.persona_epoch,clock.persona_epoch,verdictReason('PRIORITY_CHAT_TIMING_EPOCH',{cycle:index+1,stage},'')); assert.equal(dispatch.persona_fingerprint,clock.persona_fingerprint,verdictReason('WB_PRIORITY_DISPATCH_PERSONA_FINGERPRINT_CLOCK_PERSONA_FINGERPRINT',{cycle:index+1,stage},''));
      assert.equal(chat.revision,index?o.sunnyBefore.revision:report.saves[n].revision,verdictReason('WB_PRIORITY_CHAT_REVISION_INDEX_O_SUNNYBEFORE_REVISION_REPORT_SAVES_N_REVISION',{cycle:index+1,stage},''));
      assert.equal(chat.archiveHash,index?o.sunnyBefore.archiveHash:report.saves[n].archiveHash,verdictReason('WB_PRIORITY_CHAT_ARCHIVEHASH_INDEX_O_SUNNYBEFORE_ARCHIVEHASH_REPORT_SAVES_N_ARCHIVEHASH',{cycle:index+1,stage},'')); before=chat.afterIds;
    }
    assert.deepEqual(o.sunnyTerminal.messageIds,before,verdictReason('WB_PRIORITY_O_SUNNYTERMINAL_MESSAGEIDS_BEFORE',{cycle:index+1},'')); priorityBook(o.book,0,{cycle:index+1,source:"terminal"});
    assert.deepEqual(report.inputs.map(i=>i.step),INPUT_STEPS[index],verdictReason('PRIORITY_INPUT_STEP_ORDER',{cycle:index+1},'Real control input order changed'));
    const controls={51:'nav-character',1:'personaSwitch-'+sunny,2:'personaSwitchConfirm',16:'nav-memory',7:'reloadWorldbook',8:'worldbookBookSelector',9:'worldbookEntrySelector',10:'worldbookPriority',11:'saveWorldbook',14:'memory-close',30:'chatComposer',31:'sendChat',33:'nav-memory',34:'nav-character',40:'personaSwitch-'+o.originalBefore.personaId,41:'personaSwitchConfirm',29:'nav-chat'};
    assert.deepEqual(report.inputs.map(i=>i.control),INPUT_STEPS[index].map(step=>controls[step]),verdictReason('PRIORITY_INPUT_CONTROL_ORDER',{cycle:index+1},'Real control identity changed'));
    assert(report.inputs.every(i=>i.elapsedMs>=0 && i.elapsedMs<4000 && Number.isInteger(i.frame) && i.frame>0),verdictReason('PRIORITY_INPUT_DEADLINE_FRAME',{cycle:index+1},''));
    assert.deepEqual(report.inputs.filter(i=>i.control==='worldbookPriority').map(i=>[i.beforeValue,i.afterValue]),index?[]:[[0,2],[2,0]],verdictReason('WB_PRIORITY_REPORT_INPUTS_FILTER_I_I_CONTROL_WORLDBOOKPRIORITY_MAP_I_I_BEFOREVALUE_I_AFTER',{cycle:index+1},''));
    assert.equal(report.inputs.filter(i=>i.control==='saveWorldbook').length,index?0:2,verdictReason('WB_PRIORITY_REPORT_INPUTS_FILTER_I_I_CONTROL_SAVEWORLDBOOK_LENGTH_INDEX_0_2',{cycle:index+1},''));
    assert.equal(report.inputs.filter(i=>i.control==='worldbookBookSelector').length,index?0:1,verdictReason('WB_PRIORITY_REPORT_INPUTS_FILTER_I_I_CONTROL_WORLDBOOKBOOKSELECTOR_LENGTH_INDEX_0_1',{cycle:index+1},''));
    assert.equal(report.inputs.filter(i=>i.control==='worldbookEntrySelector').length,index?0:1,verdictReason('WB_PRIORITY_REPORT_INPUTS_FILTER_I_I_CONTROL_WORLDBOOKENTRYSELECTOR_LENGTH_INDEX_0_1',{cycle:index+1},''));
    assert.deepEqual(report.personaRowInputs?.map(r=>r.step),[1,40],verdictReason('PRIORITY_TAIL_ROW_STEPS',{cycle:index+1},''));
    for(const [n,row] of report.personaRowInputs.entries()) {
      const sourceScope=n?o.sunnyScope:o.originalScope;
      verifyPersonaRowInputRecord(row,{step:n?40:1,targetId:n?o.originalBefore.personaId:sunny,
        sourcePersonaId:n?sunny:o.originalBefore.personaId,livePersonaId:rowScope(sourceScope,{cycle:index+1,step:row.step}).personaId,
        scope:sourceScope,generation:n?baseline.generation:originalRead.generation,root:'taskSurface',page:'characterTasks'});
      const input=report.inputs.find(value=>value.step===row.step);
      assert(input && input.scope===row.scope && input.generation===row.generation,verdictReason('WB_PRIORITY_INPUT_INPUT_SCOPE_ROW_SCOPE_INPUT_GENERATION_ROW_GENERATION',{cycle:index+1,step:row.step},''));
      assert.equal(input.signals.mouseDispatchCount,row.mouseDispatchCount,verdictReason('WB_PRIORITY_INPUT_SIGNALS_MOUSEDISPATCHCOUNT_ROW_MOUSEDISPATCHCOUNT',{cycle:index+1,step:row.step},'')); assert.equal(input.signals.clickedSignals,row.clickedSignals,verdictReason('WB_PRIORITY_INPUT_SIGNALS_CLICKEDSIGNALS_ROW_CLICKEDSIGNALS',{cycle:index+1,step:row.step},''));
    }
    const bookSelect=report.inputs.find(input=>input.step===8);
    if(bookSelect) assert(rowInteger(bookSelect.inputAtMs) && rowInteger(bookSelect.stepAtMs) && bookSelect.inputAtMs>=bookSelect.stepAtMs && bookSelect.inputAtMs-bookSelect.stepAtMs<10000,verdictReason('PRIORITY_SELECTOR_CLOCK',{cycle:index+1},''));
    for(const [ordinal,input] of report.inputs.entries()) {
      assert.equal(input.scope,ordinal<3?o.originalScope:o.sunnyScope,verdictReason('PRIORITY_INPUT_SCOPE',{cycle:index+1,step:input.step},''));
      assert.equal(input.generation,ordinal<3?originalRead.generation:baseline.generation,verdictReason('WB_PRIORITY_INPUT_GENERATION_ORDINAL_3_ORIGINALREAD_GENERATION_BASELINE_GENERATION',{cycle:index+1,step:input.step},''));
      const layout=input.layout, current=layout?.last;
      assert(layout?.ready===true && layout.minimumStableMs===40 && current?.ready===true && current.layoutStable===true && current.enabled===true && current.surfaceClosed===true,verdictReason('WB_PRIORITY_LAYOUT_READY_TRUE_LAYOUT_MINIMUMSTABLEMS_40_CURRENT_READY_TRUE_CURRENT_LAYOUTS',{cycle:index+1,step:input.step},''));
      wholeGeometry(current,input.windowWidth,input.windowHeight,{cycle:index+1,step:input.step,section:"priority-input"});
      assert.equal(current.scope,input.scope,verdictReason('WB_PRIORITY_CURRENT_SCOPE_INPUT_SCOPE',{cycle:index+1,step:input.step},'')); assert.equal(current.fullyVisible,true,verdictReason('WB_PRIORITY_CURRENT_FULLYVISIBLE_TRUE',{cycle:index+1,step:input.step},''));
      assert(current.elapsedMs-current.stableSinceMs>=40 && current.elapsedMs<=input.elapsedMs && current.frameSerial>current.stableFrameSerial && current.frameSerial<=input.frame,verdictReason('PRIORITY_INPUT_STABILITY',{cycle:index+1,step:input.step},''));
      assert(input.hit?.acceptorFound===true && ['target','descendant'].includes(input.hit.hitResult),verdictReason('PRIORITY_INPUT_HIT',{cycle:index+1,step:input.step},''));
      assert(Number.isFinite(current.pointX) && Number.isFinite(current.pointY) && current.pointX>=current.sceneX && current.pointX<=current.sceneX+current.sceneWidth && current.pointY>=current.sceneY && current.pointY<=current.sceneY+current.sceneHeight && current.pointX>=current.clipX && current.pointX<=current.clipX+current.clipWidth && current.pointY>=current.clipY && current.pointY<=current.clipY+current.clipHeight,verdictReason('WB_PRIORITY_NUMBER_ISFINITE_CURRENT_POINTX_NUMBER_ISFINITE_CURRENT_POINTY_CURRENT_POINTX_C',{cycle:index+1,step:input.step},''));
      const signal=input.signals; assert.equal(signal?.mouseDispatchCount,1,verdictReason('PRIORITY_INPUT_MOUSE_DISPATCH',{cycle:index+1,step:input.step},''));
      if(input.control==='worldbookPriority') assert.deepEqual(signal,{kind:'integer',mouseDispatchCount:1,keyDispatchCount:2,valueModifiedSignals:2},verdictReason('PRIORITY_INPUT_INTEGER_SIGNALS',{cycle:index+1,step:input.step},''));
      else if(input.control==='chatComposer') assert.deepEqual(signal,{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true},verdictReason('WB_PRIORITY_SIGNAL_KIND_TEXT_MOUSEDISPATCHCOUNT_1_COMMITCOUNT_1_FOCUSINTARGET_TRUE',{cycle:index+1,step:input.step},''));
      else if(['worldbookBookSelector','worldbookEntrySelector'].includes(input.control)) assert.deepEqual(signal,{kind:'selector',mouseDispatchCount:1,activatedSignals:1,selectedIndex:1},verdictReason('WB_PRIORITY_SIGNAL_KIND_SELECTOR_MOUSEDISPATCHCOUNT_1_ACTIVATEDSIGNALS_1_SELECTEDINDEX_1',{cycle:index+1,step:input.step},''));
      else assert.deepEqual(signal,{kind:'button',mouseDispatchCount:1,clickedSignals:1},verdictReason('WB_PRIORITY_SIGNAL_KIND_BUTTON_MOUSEDISPATCHCOUNT_1_CLICKEDSIGNALS_1',{cycle:index+1,step:input.step},''));
    }
  }
  return {passed:true,checks:[6,4],http:25,legacyHttp:22,priorityHttp:3,preparationWrites:[1,0],saveWrites:[2,0],legacyModelCalls:legacy};
}
// Independent acquisition proof for the seven preserved persona-row inputs.
// This does not alter or replace any archive, prompt or priority verdict above.
const PERSONA_ROW_INPUT_CONTRACT = Object.freeze({
  schema:'reverie.persona-row-input-contract.v2',steps:[[401,405,418,422],[506,510,518]],
  root:'taskSurface',page:'characterTasks',inputDeadlineMs:4000,minimumStableMs:40,
  pollIntervalMs:40,sampleLimit:6,terminalCount:1,dispatches:[4,3],mouseDispatches:[4,3],livePersonaSource:'persona:get+persona:list'
});
const rowNumber = v => typeof v==='number' && Number.isFinite(v);
const rowInteger = v => Number.isSafeInteger(v) && v>=0;
const rowRectKeys = ['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'];
function rowScope(value, diagnostic = {}) {
  assert(typeof value==='string' && value.length<=300,verdictReason('WB_SCOPE_TYPEOF_VALUE_STRING_VALUE_LENGTH_300',diagnostic,'Persona row scope missing'));
  const parts=value.split(':');
  assert(parts.length===3 && ident(parts[0]) && /^\d+$/.test(parts[1]) && sha(parts[2]),verdictReason('WB_SCOPE_PARTS_LENGTH_3_IDENT_PARTS_0_D_TEST_PARTS_1_SHA_PARTS_2',diagnostic,'Persona row scope malformed'));
  const epoch=Number(parts[1]); assert(rowInteger(epoch),verdictReason('WB_SCOPE_ROWINTEGER_EPOCH',diagnostic,'Persona row epoch malformed'));
  return {personaId:parts[0],epoch,fingerprint:parts[2]};
}
function rowDraft(report, stage) {
  const drafts=[...(report.draftAssertions||[]),...(report.archiveInteraction?.draftAssertions||[]),...(report.personaRestart?.draftAssertions||[])];
  const found=drafts.filter(d=>d.stage===stage); assert.equal(found.length,1,verdictReason('WB_DRAFT_FOUND_LENGTH_1',{stage},'Persona row scope anchor missing or duplicated: '+stage));
  rowScope(found[0].scopeKey,{stage}); return found[0].scopeKey;
}
function verifyPersonaRowInputRecord(record, expected) {
  assert(record && expected && typeof record==='object' && typeof expected==='object',verdictReason('WB_ROW_RECORD_EXPECTED_TYPEOF_RECORD_OBJECT_TYPEOF_EXPECTED_OBJECT',{step:record?.step},''));
  for(const key of ['step','targetId','sourcePersonaId','livePersonaId','scope','generation','root','page'])
    assert.equal(record[key],expected[key],verdictReason('ROW_BINDING',{step:record?.step,field:key},'Persona row differs from independent binding: '+key));
  assert(rowInteger(record.step) && rowInteger(record.stepAtMs) && rowInteger(record.generation),verdictReason('WB_ROW_ROWINTEGER_RECORD_STEP_ROWINTEGER_RECORD_STEPATMS_ROWINTEGER_RECORD_GENERATION',{step:record?.step},''));
  assert(ident(record.targetId) && ident(record.sourcePersonaId) && ident(record.livePersonaId),verdictReason('WB_ROW_IDENT_RECORD_TARGETID_IDENT_RECORD_SOURCEPERSONAID_IDENT_RECORD_LIVEPERSONAID',{step:record?.step},''));
  assert.notEqual(record.targetId,record.sourcePersonaId,verdictReason('WB_ROW_RECORD_TARGETID_RECORD_SOURCEPERSONAID',{step:record?.step},'')); assert.equal(record.control,'personaSwitch-'+record.targetId,verdictReason('WB_ROW_RECORD_CONTROL_PERSONASWITCH_RECORD_TARGETID',{step:record?.step},''));
  assert.equal(record.root,'taskSurface',verdictReason('WB_ROW_RECORD_ROOT_TASKSURFACE',{step:record?.step},'')); assert.equal(record.page,'characterTasks',verdictReason('WB_ROW_RECORD_PAGE_CHARACTERTASKS',{step:record?.step},''));
  const boundScope=rowScope(record.scope,{step:record?.step}); assert.equal(boundScope.personaId,record.livePersonaId,verdictReason('WB_ROW_BOUNDSCOPE_PERSONAID_RECORD_LIVEPERSONAID',{step:record?.step},''));
  assert.equal(record.deadlineMs,4000,verdictReason('ROW_DEADLINE',{step:record?.step},'')); assert.equal(record.pollIntervalMs,40,verdictReason('WB_ROW_RECORD_POLLINTERVALMS_40',{step:record?.step},'')); assert.equal(record.minimumStableMs,40,verdictReason('WB_ROW_RECORD_MINIMUMSTABLEMS_40',{step:record?.step},''));
  assert.equal(record.sampleLimit,6,verdictReason('WB_ROW_RECORD_SAMPLELIMIT_6',{step:record?.step},'')); assert.equal(record.terminalCount,1,verdictReason('ROW_TERMINAL_COUNT',{step:record?.step},'')); assert.equal(record.status,'performed',verdictReason('ROW_STATUS',{step:record?.step},'')); assert.equal(record.failureReason,'',verdictReason('WB_ROW_RECORD_FAILUREREASON',{step:record?.step},''));
  assert.equal(record.dispatchCount,1,verdictReason('ROW_DISPATCH_COUNT',{step:record?.step},'')); assert.equal(record.dispatchAttemptCount,1,verdictReason('WB_ROW_RECORD_DISPATCHATTEMPTCOUNT_1',{step:record?.step},'')); assert.equal(record.mouseDispatchCount,1,verdictReason('ROW_MOUSE_DISPATCH_COUNT',{step:record?.step},'')); assert.equal(record.clickedSignals,1,verdictReason('ROW_CLICKED_SIGNALS',{step:record?.step},'')); assert(rowInteger(record.polls) && record.polls>=2,verdictReason('WB_ROW_ROWINTEGER_RECORD_POLLS_RECORD_POLLS_2',{step:record?.step},''));
  assert(rowNumber(record.windowWidth) && record.windowWidth>0 && rowNumber(record.windowHeight) && record.windowHeight>0,verdictReason('WB_ROW_ROWNUMBER_RECORD_WINDOWWIDTH_RECORD_WINDOWWIDTH_0_ROWNUMBER_RECORD_WINDOWHEIGH',{step:record?.step},''));
  assert(Array.isArray(record.samples) && record.samples.length>0 && record.samples.length<=6,verdictReason('ROW_SAMPLES',{step:record?.step},''));
  let previousElapsed=-1, previousFrame=-1;
  for(const sample of record.samples) {
    assert(rowInteger(sample.elapsedMs) && sample.elapsedMs>=previousElapsed && sample.elapsedMs<4000,verdictReason('WB_ROW_ROWINTEGER_SAMPLE_ELAPSEDMS_SAMPLE_ELAPSEDMS_PREVIOUSELAPSED_SAMPLE_ELAPSEDMS',{step:record?.step,sampleIndex:record.samples.indexOf(sample)},''));
    assert(rowInteger(sample.frameSerial) && sample.frameSerial>=previousFrame,verdictReason('WB_ROW_ROWINTEGER_SAMPLE_FRAMESERIAL_SAMPLE_FRAMESERIAL_PREVIOUSFRAME',{step:record?.step,sampleIndex:record.samples.indexOf(sample)},''));
    assert(sample.schedulingIntervalMs===null || rowInteger(sample.schedulingIntervalMs),verdictReason('WB_ROW_SAMPLE_SCHEDULINGINTERVALMS_NULL_ROWINTEGER_SAMPLE_SCHEDULINGINTERVALMS',{step:record?.step,sampleIndex:record.samples.indexOf(sample)},''));
    previousElapsed=sample.elapsedMs; previousFrame=sample.frameSerial;
  }
  const terminal=record.terminal;
  assert(terminal && typeof terminal==='object' && !Array.isArray(terminal),verdictReason('ROW_TERMINAL_SHAPE',{step:record?.step},'Persona row terminal snapshot missing'));
  assert(rowInteger(terminal.elapsedMs) && terminal.elapsedMs>=previousElapsed && terminal.elapsedMs<4000,verdictReason('ROW_TERMINAL_ELAPSED',{step:record?.step},''));
  assert(rowInteger(terminal.frameSerial) && terminal.frameSerial>=previousFrame,verdictReason('WB_ROW_ROWINTEGER_TERMINAL_FRAMESERIAL_TERMINAL_FRAMESERIAL_PREVIOUSFRAME',{step:record?.step},''));
  assert(rowInteger(terminal.dispatchElapsedMs) && terminal.dispatchElapsedMs>=terminal.elapsedMs && terminal.dispatchElapsedMs<4000,verdictReason('ROW_DISPATCH_ELAPSED',{step:record?.step},''));
  assert(rowInteger(terminal.dispatchFrameSerial) && terminal.dispatchFrameSerial>=terminal.frameSerial,verdictReason('WB_ROW_ROWINTEGER_TERMINAL_DISPATCHFRAMESERIAL_TERMINAL_DISPATCHFRAMESERIAL_TERMINAL',{step:record?.step},''));
  assert.equal(terminal.dispatchCount,1,verdictReason('ROW_TERMINAL_DISPATCH_COUNT',{step:record?.step},'')); assert.equal(terminal.dispatchAttemptCount,1,verdictReason('WB_ROW_TERMINAL_DISPATCHATTEMPTCOUNT_1',{step:record?.step},'')); assert.equal(terminal.mouseDispatchCount,1,verdictReason('ROW_TERMINAL_MOUSE_DISPATCH_COUNT',{step:record?.step},''));
  assert.equal(terminal.clickedSignals,1,verdictReason('ROW_TERMINAL_CLICKED_SIGNALS',{step:record?.step},'')); assert.equal(terminal.signalObserverValid,true,verdictReason('ROW_SIGNAL_OBSERVER',{step:record?.step},''));
  assert(rowInteger(terminal.mouseElapsedMs) && terminal.mouseElapsedMs>=terminal.dispatchElapsedMs && terminal.mouseElapsedMs<4000,verdictReason('ROW_MOUSE_ELAPSED',{step:record?.step},''));
  assert(rowInteger(terminal.mouseFrameSerial) && terminal.mouseFrameSerial>=terminal.dispatchFrameSerial,verdictReason('WB_ROW_ROWINTEGER_TERMINAL_MOUSEFRAMESERIAL_TERMINAL_MOUSEFRAMESERIAL_TERMINAL_DISPAT',{step:record?.step},''));
  assert.equal(terminal.status,'performed',verdictReason('WB_ROW_TERMINAL_STATUS_PERFORMED',{step:record?.step},'')); assert.equal(terminal.failureReason,'',verdictReason('WB_ROW_TERMINAL_FAILUREREASON',{step:record?.step},''));
  assert(rowInteger(terminal.schedulingIntervalMs),verdictReason('ROW_SCHEDULING_INTERVAL',{step:record?.step},''));
  for(const evidence of [...record.samples,terminal,terminal.stableAnchor,terminal.mouse]) {
    assert(evidence && typeof evidence==='object',verdictReason('ROW_TRACE_SHAPE',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));
    for(const key of ['root','page','targetId','sourcePersonaId','livePersonaId','scope','generation']) assert.equal(evidence[key],record[key],verdictReason('ROW_TRACE_IDENTITY',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{}),field:key},'Persona row trace identity changed: '+key));
    for(const key of ['taskSurfaceCount','characterTasksCount','rowCount','controlCount','targetProfileCount','sourceProfileCount','activeProfileCount']) assert(rowInteger(evidence[key]),verdictReason('ROW_TRACE_COUNT',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{}),field:key},'Persona row trace count unknown: '+key));
    for(const key of ['identityMatches','rowInactive','scopeMatches','generationMatches','personaMatches','liveMatches','surfaceReady']) assert.equal(typeof evidence[key],'boolean',verdictReason('ROW_TRACE_BOOLEAN',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{}),field:key},'Persona row trace state unknown: '+key));
    assert(evidence.scopeMatches && evidence.generationMatches && evidence.personaMatches && evidence.liveMatches,verdictReason('WB_ROW_EVIDENCE_SCOPEMATCHES_EVIDENCE_GENERATIONMATCHES_EVIDENCE_PERSONAMATCHES_EVIDE',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},'Persona row trace crossed scope or generation'));
    assert.equal(evidence.listPersonaId,boundScope.personaId,verdictReason('WB_ROW_EVIDENCE_LISTPERSONAID_BOUNDSCOPE_PERSONAID',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));assert.equal(evidence.listActivePersonaId,record.sourcePersonaId,verdictReason('ROW_LIVE_LIST_ACTIVE',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));
    assert.equal(evidence.personaEpoch,boundScope.epoch,verdictReason('WB_ROW_EVIDENCE_PERSONAEPOCH_BOUNDSCOPE_EPOCH',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));assert.equal(evidence.listPersonaEpoch,boundScope.epoch,verdictReason('ROW_LIVE_LIST_EPOCH',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));
    assert.equal(evidence.personaFingerprint,boundScope.fingerprint,verdictReason('ROW_LIVE_GET_FINGERPRINT',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));assert.equal(evidence.listPersonaFingerprint,boundScope.fingerprint,verdictReason('WB_ROW_EVIDENCE_LISTPERSONAFINGERPRINT_BOUNDSCOPE_FINGERPRINT',{step:record?.step,trace:evidence===terminal?'terminal':evidence===terminal.stableAnchor?'anchor':evidence===terminal.mouse?'mouse':'sample',...(record.samples.includes(evidence)?{sampleIndex:record.samples.indexOf(evidence)}:{})},''));
  }
  const sequence=record.sequence;
  assert(sequence?.performed===true && sequence.expired===false && sequence.failed===false && sequence.busy===false && sequence.actionIndex===1,verdictReason('ROW_SEQUENCE_STATE',{step:record?.step},''));
  assert(Array.isArray(sequence.actions) && sequence.actions.length===1,verdictReason('ROW_SEQUENCE_COUNT',{step:record?.step},''));
  const action=sequence.actions[0];
  assert.equal(action.name,record.control,verdictReason('WB_ROW_ACTION_NAME_RECORD_CONTROL',{step:record?.step},'')); assert.equal(action.index,0,verdictReason('WB_ROW_ACTION_INDEX_0',{step:record?.step},''));
  assert(action.attempted===true && action.performed===true && action.failed===false,verdictReason('ROW_SEQUENCE_ACTION',{step:record?.step},''));
  assert(rowInteger(action.actionElapsedMs) && action.actionElapsedMs<=terminal.dispatchElapsedMs && action.actionElapsedMs<4000,verdictReason('WB_ROW_ROWINTEGER_ACTION_ACTIONELAPSEDMS_ACTION_ACTIONELAPSEDMS_TERMINAL_DISPATCHELAP',{step:record?.step},''));
  for(const key of ['taskSurfaceCount','characterTasksCount','rowCount','controlCount','targetProfileCount','sourceProfileCount','activeProfileCount']) assert.equal(terminal[key],1,verdictReason('ROW_TARGET_UNIQUE',{step:record?.step,field:key},'Persona row lookup is not unique: '+key));
  for(const key of ['identityMatches','rowInactive','scopeMatches','generationMatches','personaMatches','surfaceReady']) assert.equal(terminal[key],true,verdictReason('ROW_ELIGIBLE',{step:record?.step,field:key},'Persona row terminal is ineligible: '+key));
  for(const row of [terminal,terminal.stableAnchor,terminal.mouse]) {
    assert.equal(row.rowIdKnown,true,verdictReason('WB_ROW_ROW_ROWIDKNOWN_TRUE',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},'')); assert.equal(row.rowActiveKnown,true,verdictReason('WB_ROW_ROW_ROWACTIVEKNOWN_TRUE',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},''));
    assert.equal(row.rowId,record.targetId,verdictReason('ROW_MODEL_ID',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},'')); assert.equal(row.rowActive,false,verdictReason('ROW_TARGET_ACTIVE',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},''));
    assert(['QVariantMap','QJSValue'].includes(row.modelDataType),verdictReason('ROW_MODEL_DATA_TYPE',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},'')); assert.equal(row.normalizedModelDataType,'QVariantMap',verdictReason('WB_ROW_ROW_NORMALIZEDMODELDATATYPE_QVARIANTMAP',{step:record?.step,trace:row===terminal?'terminal':row===terminal.stableAnchor?'anchor':'mouse'},''));
  }
  const current=terminal.control, anchor=terminal.stableAnchor;
  assert(current && anchor,verdictReason('WB_ROW_CURRENT_ANCHOR',{step:record?.step},'Persona row stable anchor or final control missing'));
  for(const key of ['found','bound','geometryValid','integerPointInsideClip','ready','enabled','visible','surfaceClosed','inputPointInsideClip']) assert.equal(current[key],true,verdictReason('ROW_CONTROL_READY',{step:record?.step,field:key},'Persona row control not ready: '+key));
  assert.equal(current.scope,record.scope,verdictReason('WB_ROW_CURRENT_SCOPE_RECORD_SCOPE',{step:record?.step},'')); assert(rowNumber(terminal.effectiveOpacity) && terminal.effectiveOpacity>=.05 && terminal.effectiveOpacity<=1,verdictReason('ROW_OPACITY',{step:record?.step},''));
  wholeGeometry(terminal.whole,record.windowWidth,record.windowHeight,{step:record?.step,section:"row-terminal"});
  for(const key of rowRectKeys) assert(rowNumber(current[key]) && Math.abs(current[key]-terminal.whole[key])<=.5,verdictReason('WB_ROW_ROWNUMBER_CURRENT_KEY_MATH_ABS_CURRENT_KEY_TERMINAL_WHOLE_KEY_5',{step:record?.step,field:key},'Persona row whole/final geometry differs'));
  assert(Number.isInteger(current.pointX) && Number.isInteger(current.pointY),verdictReason('ROW_INTEGER_POINT',{step:record?.step},'Persona row click point is not integer'));
  assert(current.pointX>=current.sceneX && current.pointX<=current.sceneX+current.sceneWidth && current.pointY>=current.sceneY && current.pointY<=current.sceneY+current.sceneHeight,verdictReason('ROW_POINT_IN_ITEM',{step:record?.step},''));
  assert(current.pointX>=current.clipX && current.pointX<=current.clipX+current.clipWidth && current.pointY>=current.clipY && current.pointY<=current.clipY+current.clipHeight,verdictReason('WB_ROW_CURRENT_POINTX_CURRENT_CLIPX_CURRENT_POINTX_CURRENT_CLIPX_CURRENT_CLIPWIDTH_CU',{step:record?.step},''));
  assert(current.pointX>=0 && current.pointX<record.windowWidth && current.pointY>=0 && current.pointY<record.windowHeight,verdictReason('WB_ROW_CURRENT_POINTX_0_CURRENT_POINTX_RECORD_WINDOWWIDTH_CURRENT_POINTY_0_CURRENT_PO',{step:record?.step},''));
  assert(terminal.hit?.acceptorFound===true && ['target','descendant'].includes(terminal.hit.hitResult),verdictReason('ROW_HIT',{step:record?.step},'Persona row click is intercepted'));
  const layout=terminal.layout;
  assert.equal(layout?.layoutStable,true,verdictReason('WB_ROW_LAYOUT_LAYOUTSTABLE_TRUE',{step:record?.step},'')); assert(rowInteger(layout.stableSinceMs) && rowInteger(layout.stableFrameSerial),verdictReason('WB_ROW_ROWINTEGER_LAYOUT_STABLESINCEMS_ROWINTEGER_LAYOUT_STABLEFRAMESERIAL',{step:record?.step},''));
  assert(terminal.elapsedMs-layout.stableSinceMs>=40 && terminal.frameSerial>layout.stableFrameSerial,verdictReason('ROW_STABILITY',{step:record?.step},'Persona row control was not stable across a new frame'));
  assert.equal(anchor.elapsedMs,layout.stableSinceMs,verdictReason('WB_ROW_ANCHOR_ELAPSEDMS_LAYOUT_STABLESINCEMS',{step:record?.step},'')); assert.equal(anchor.frameSerial,layout.stableFrameSerial,verdictReason('WB_ROW_ANCHOR_FRAMESERIAL_LAYOUT_STABLEFRAMESERIAL',{step:record?.step},''));
  assert.equal(anchor.scope,record.scope,verdictReason('WB_ROW_ANCHOR_SCOPE_RECORD_SCOPE',{step:record?.step},'')); assert.equal(anchor.generation,record.generation,verdictReason('WB_ROW_ANCHOR_GENERATION_RECORD_GENERATION',{step:record?.step},''));
  for(const key of rowRectKeys) assert(rowNumber(anchor.control?.[key]) && Math.abs(anchor.control[key]-current[key])<=.5,verdictReason('ROW_ANCHOR_GEOMETRY',{step:record?.step,field:key},'Persona row geometry changed after stable anchor'));
  assert.equal(anchor.control.pointX,current.pointX,verdictReason('WB_ROW_ANCHOR_CONTROL_POINTX_CURRENT_POINTX',{step:record?.step},'')); assert.equal(anchor.control.pointY,current.pointY,verdictReason('WB_ROW_ANCHOR_CONTROL_POINTY_CURRENT_POINTY',{step:record?.step},''));
  assert.equal(anchor.control.scope,current.scope,verdictReason('WB_ROW_ANCHOR_CONTROL_SCOPE_CURRENT_SCOPE',{step:record?.step},''));
  assert(Array.isArray(current.scrolls) && Array.isArray(anchor.control.scrolls) && current.scrolls.length===anchor.control.scrolls.length,verdictReason('WB_ROW_ARRAY_ISARRAY_CURRENT_SCROLLS_ARRAY_ISARRAY_ANCHOR_CONTROL_SCROLLS_CURRENT_SCR',{step:record?.step},''));
  for(const [i,scroll] of current.scrolls.entries()) {
    for(const key of ['contentY','contentHeight','sceneX','sceneY','sceneWidth','sceneHeight'])
      assert(rowNumber(scroll[key]) && rowNumber(anchor.control.scrolls[i][key]) && Math.abs(scroll[key]-anchor.control.scrolls[i][key])<=.5,verdictReason('ROW_ANCHOR_SCROLL',{step:record?.step,scrollIndex:i,field:key},'Persona row scroll changed after stable anchor'));
  }
  const mouse=terminal.mouse;
  assert(rowInteger(mouse.elapsedMs) && mouse.elapsedMs>=terminal.dispatchElapsedMs && mouse.elapsedMs<=terminal.mouseElapsedMs,verdictReason('WB_ROW_ROWINTEGER_MOUSE_ELAPSEDMS_MOUSE_ELAPSEDMS_TERMINAL_DISPATCHELAPSEDMS_MOUSE_EL',{step:record?.step},''));
  assert(rowInteger(mouse.frameSerial) && mouse.frameSerial>=terminal.dispatchFrameSerial && mouse.frameSerial<=terminal.mouseFrameSerial,verdictReason('WB_ROW_ROWINTEGER_MOUSE_FRAMESERIAL_MOUSE_FRAMESERIAL_TERMINAL_DISPATCHFRAMESERIAL_MO',{step:record?.step},''));
  assert.equal(mouse.ready,true,verdictReason('ROW_MOUSE_READY',{step:record?.step,field:'mouse.ready'},'')); assert.equal(mouse.identityMatches,true,verdictReason('WB_ROW_MOUSE_IDENTITYMATCHES_TRUE',{step:record?.step},'')); assert.equal(mouse.rowInactive,true,verdictReason('WB_ROW_MOUSE_ROWINACTIVE_TRUE',{step:record?.step},'')); assert.equal(mouse.surfaceReady,true,verdictReason('WB_ROW_MOUSE_SURFACEREADY_TRUE',{step:record?.step},''));
  for(const key of ['taskSurfaceCount','characterTasksCount','rowCount','controlCount','targetProfileCount','sourceProfileCount','activeProfileCount']) assert.equal(mouse[key],1,verdictReason('WB_ROW_MOUSE_KEY_1',{step:record?.step,field:key},''));
  wholeGeometry(mouse.whole,record.windowWidth,record.windowHeight,{step:record?.step,section:"row-mouse"});
  for(const key of ['found','bound','geometryValid','integerPointInsideClip','ready','enabled','visible','surfaceClosed','inputPointInsideClip','fullyVisible']) assert.equal(mouse.control?.[key],true,verdictReason('WB_ROW_MOUSE_CONTROL_KEY_TRUE',{step:record?.step,field:key},''));
  assert.equal(mouse.control.scope,record.scope,verdictReason('WB_ROW_MOUSE_CONTROL_SCOPE_RECORD_SCOPE',{step:record?.step},'')); assert(Number.isFinite(mouse.effectiveOpacity) && mouse.effectiveOpacity>=.05 && mouse.effectiveOpacity<=1,verdictReason('WB_ROW_NUMBER_ISFINITE_MOUSE_EFFECTIVEOPACITY_MOUSE_EFFECTIVEOPACITY_05_MOUSE_EFFECTI',{step:record?.step},''));
  for(const key of rowRectKeys) assert(rowNumber(mouse.control[key]) && Math.abs(mouse.control[key]-current[key])<=.5 && Math.abs(mouse.control[key]-mouse.whole[key])<=.5,verdictReason('WB_ROW_ROWNUMBER_MOUSE_CONTROL_KEY_MATH_ABS_MOUSE_CONTROL_KEY_CURRENT_KEY_5_MATH_ABS',{step:record?.step,field:key},''));
  assert.equal(mouse.control.pointX,current.pointX,verdictReason('ROW_MOUSE_POINT_X',{step:record?.step},''));assert.equal(mouse.control.pointY,current.pointY,verdictReason('WB_ROW_MOUSE_CONTROL_POINTY_CURRENT_POINTY',{step:record?.step},''));
  assert(mouse.hit?.acceptorFound===true && ['target','descendant'].includes(mouse.hit.hitResult),verdictReason('ROW_MOUSE_HIT',{step:record?.step},''));
  assert.equal(mouse.layout?.layoutStable,true,verdictReason('WB_ROW_MOUSE_LAYOUT_LAYOUTSTABLE_TRUE',{step:record?.step},''));assert.equal(mouse.layout.stableSinceMs,layout.stableSinceMs,verdictReason('WB_ROW_MOUSE_LAYOUT_STABLESINCEMS_LAYOUT_STABLESINCEMS',{step:record?.step},''));assert.equal(mouse.layout.stableFrameSerial,layout.stableFrameSerial,verdictReason('WB_ROW_MOUSE_LAYOUT_STABLEFRAMESERIAL_LAYOUT_STABLEFRAMESERIAL',{step:record?.step},''));
  // A claimed success cannot substitute for bounded, numeric reveal evidence.
  assert(terminal.reveal && terminal.reveal.expired===false && terminal.reveal.geometryValid===true,verdictReason('WB_ROW_TERMINAL_REVEAL_TERMINAL_REVEAL_EXPIRED_FALSE_TERMINAL_REVEAL_GEOMETRYVALID_TR',{step:record?.step},''));
  assert(Array.isArray(terminal.reveal.scrolls) && terminal.reveal.scrolls.length<=6,verdictReason('WB_ROW_ARRAY_ISARRAY_TERMINAL_REVEAL_SCROLLS_TERMINAL_REVEAL_SCROLLS_LENGTH_6',{step:record?.step},''));
  assert.equal(terminal.reveal.scrollLimit,6,verdictReason('WB_ROW_TERMINAL_REVEAL_SCROLLLIMIT_6',{step:record?.step},'')); assert(rowInteger(terminal.reveal.ancestorCount),verdictReason('WB_ROW_ROWINTEGER_TERMINAL_REVEAL_ANCESTORCOUNT',{step:record?.step},''));
  assert.equal(terminal.reveal.scrolls.length,Math.min(6,terminal.reveal.ancestorCount),verdictReason('WB_ROW_TERMINAL_REVEAL_SCROLLS_LENGTH_MATH_MIN_6_TERMINAL_REVEAL_ANCESTORCOUNT',{step:record?.step},''));
  assert(rowInteger(terminal.reveal.scrollCount) && terminal.reveal.scrollCount<=terminal.reveal.ancestorCount,verdictReason('WB_ROW_ROWINTEGER_TERMINAL_REVEAL_SCROLLCOUNT_TERMINAL_REVEAL_SCROLLCOUNT_TERMINAL_RE',{step:record?.step},''));
  assert(rowInteger(terminal.reveal.elapsedMs) && terminal.reveal.elapsedMs<=terminal.elapsedMs && terminal.reveal.elapsedMs<4000,verdictReason('ROW_REVEAL_ELAPSED',{step:record?.step},''));
  for(const scroll of terminal.reveal.scrolls) {
    for(const key of ['beforeY','afterY','minimumY','maximumY','contentHeight','viewportHeight','topYBefore','bottomYBefore','requestedY']) assert(rowNumber(scroll[key]),verdictReason('ROW_REVEAL_NUMERIC',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll),field:key},'Persona row scroll trace unknown'));
    assert(scroll.minimumY<=scroll.maximumY && scroll.contentHeight>=0 && scroll.viewportHeight>0,verdictReason('WB_ROW_SCROLL_MINIMUMY_SCROLL_MAXIMUMY_SCROLL_CONTENTHEIGHT_0_SCROLL_VIEWPORTHEIGHT_0',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
    assert(scroll.afterY>=scroll.minimumY-.5 && scroll.afterY<=scroll.maximumY+.5,verdictReason('ROW_REVEAL_BOUNDS',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},'Persona row reveal escaped scroll bounds'));
    assert.equal(scroll.afterObserved,true,verdictReason('ROW_REVEAL_AFTER_OBSERVED',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},'')); assert.equal(typeof scroll.scrolled,'boolean',verdictReason('WB_ROW_TYPEOF_SCROLL_SCROLLED_BOOLEAN',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},'')); assert.equal(typeof scroll.fitsViewport,'boolean',verdictReason('WB_ROW_TYPEOF_SCROLL_FITSVIEWPORT_BOOLEAN',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
    if(scroll.scrolled) {
      assert(rowNumber(scroll.appliedY) && rowInteger(scroll.elapsedMs) && scroll.elapsedMs<4000,verdictReason('ROW_REVEAL_WRITE_EVIDENCE',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
      assert(Math.abs(scroll.afterY-scroll.appliedY)<=.5,verdictReason('WB_ROW_MATH_ABS_SCROLL_AFTERY_SCROLL_APPLIEDY_5',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
    } else assert.equal(scroll.afterY,scroll.beforeY,verdictReason('WB_ROW_SCROLL_AFTERY_SCROLL_BEFOREY',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
    assert.equal(scroll.fitsViewport,scroll.bottomYBefore-scroll.topYBefore<=scroll.viewportHeight,verdictReason('WB_ROW_SCROLL_FITSVIEWPORT_SCROLL_BOTTOMYBEFORE_SCROLL_TOPYBEFORE_SCROLL_VIEWPORTHEIG',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},''));
    if(scroll.topYBefore>=-.5 && scroll.bottomYBefore<=scroll.viewportHeight+.5) assert.equal(scroll.scrolled,false,verdictReason('ROW_REVEAL_VISIBLE_NO_SCROLL',{step:record?.step,scrollIndex:terminal.reveal.scrolls.indexOf(scroll)},'Fully visible row was scrolled'));
  }
  return {passed:true,step:record.step,targetId:record.targetId,sourcePersonaId:record.sourcePersonaId,
    livePersonaId:record.livePersonaId,scope:record.scope,generation:record.generation,dispatchCount:record.dispatchCount,mouseDispatchCount:record.mouseDispatchCount};
}
function verifyPersonaRowInputs(reports, events) {
  assert(Array.isArray(reports) && reports.length===2 && Array.isArray(events),verdictReason('WB_ROWS_ARRAY_ISARRAY_REPORTS_REPORTS_LENGTH_2_ARRAY_ISARRAY_EVENTS',{},'Persona row reports missing'));
  const seeded=events.filter(e=>e.event==='persona_seeded');
  assert.equal(seeded.length,1,verdictReason('WB_ROWS_SEEDED_LENGTH_1',{},'')); assert.equal(seeded[0].cycle,1,verdictReason('WB_ROWS_SEEDED_0_CYCLE_1',{},''));
  const sunny=seeded[0].profile_id, moon=reports[0].archiveInteraction?.cardImport?.moonPersona;
  assert(ident(sunny) && ident(moon) && sunny!==moon && sunny!=='default' && moon!=='default',verdictReason('WB_ROWS_IDENT_SUNNY_IDENT_MOON_SUNNY_MOON_SUNNY_DEFAULT_MOON_DEFAULT',{},''));
  const profiles=reports[0].personas?.profiles;
  assert(Array.isArray(profiles) && profiles.length===4,verdictReason('WB_ROWS_ARRAY_ISARRAY_PROFILES_PROFILES_LENGTH_4',{},''));
  assert.equal(new Set(profiles.map(p=>p.id)).size,4,verdictReason('WB_ROWS_NEW_SET_PROFILES_MAP_P_P_ID_SIZE_4',{},''));
  const named=name=>{const rows=profiles.filter(p=>p.name===name);assert.equal(rows.length,1,verdictReason('WB_ROWS_ROWS_LENGTH_1',{profileName:name},'Persona row profile name not unique'));return rows[0].id;};
  assert.equal(named('测试人格·晴'),sunny,verdictReason('ROW_SEEDED_ID',{},'')); assert.equal(named('测试人格·月'),moon,verdictReason('ROW_MOON_ID',{},''));
  const frost=named('测试人格·霜'); assert(ident(frost) && !['default',sunny,moon].includes(frost),verdictReason('WB_ROWS_IDENT_FROST_DEFAULT_SUNNY_MOON_INCLUDES_FROST',{},''));
  const expectedIds=['default',sunny,moon,frost].sort();
  assert.deepEqual(profiles.map(p=>p.id).sort(),expectedIds,verdictReason('WB_ROWS_PROFILES_MAP_P_P_ID_SORT_EXPECTEDIDS',{},''));
  assert.deepEqual(reports[1].personas?.profiles?.map(p=>[p.id,p.name]).sort(),profiles.map(p=>[p.id,p.name]).sort(),verdictReason('ROW_PROFILES_RESTART',{},'Persona row profile identities changed at restart'));
  const boots=events.filter(e=>e.event==='bootstrap');
  assert.deepEqual(boots.map(b=>[b.cycle,b.active_id]),[[1,'default'],[2,moon]],verdictReason('WB_ROWS_BOOTS_MAP_B_B_CYCLE_B_ACTIVE_ID_1_DEFAULT_2_MOON',{},''));
  assert.deepEqual(boots[0].profile_ids.slice().sort(),['default',sunny].sort(),verdictReason('WB_ROWS_BOOTS_0_PROFILE_IDS_SLICE_SORT_DEFAULT_SUNNY_SORT',{},''));
  assert.deepEqual(boots[1].profile_ids.slice().sort(),expectedIds,verdictReason('WB_ROWS_BOOTS_1_PROFILE_IDS_SLICE_SORT_EXPECTEDIDS',{},''));
  assert.deepEqual(reports.map(r=>r.startupPersona?.activeId),['default',moon],verdictReason('ROW_STARTUP_PROFILE_IDS',{},''));
  const defaultAnchor=rowScope(rowDraft(reports[0],'before-first-synthetic-input'));
  const expectedSources=[['default',sunny,frost,'default'],[moon,'default',moon]];
  const expectedTargets=[[sunny,'default','default',moon],['default',moon,'default']];
  const records=[reports[0].archiveInteraction?.personaRowInputs,reports[1].personaRestart?.personaRowInputs];
  assert.equal(reports[0].personaRestart,undefined,verdictReason('WB_ROWS_REPORTS_0_PERSONARESTART_UNDEFINED',{},'First-cycle persona rows in restart section'));
  const directScopes=[[
    rowDraft(reports[0],'before-first-synthetic-input'),rowDraft(reports[0],'scope-cleared-first-to-seeded'),null,null
  ],[
    rowDraft(reports[1],'before-first-synthetic-input'),rowDraft(reports[1],'scope-cleared-restart-to-default'),rowDraft(reports[1],'scope-cleared-restart-to-moon')
  ]];
  for(const [cycle,rows] of records.entries()) {
    assert(Array.isArray(rows),verdictReason('WB_ROWS_ARRAY_ISARRAY_ROWS',{cycle:cycle+1},'')); assert.deepEqual(rows.map(r=>r.step),PERSONA_ROW_INPUT_CONTRACT.steps[cycle],verdictReason('ROW_STEP_ORDER',{cycle:cycle+1},'Persona row steps missing, reordered or repeated'));
    let previousEpoch=-1, previousGeneration=-1, previousStepAt=-1; const scopes=new Set();
    for(const [ordinal,record] of rows.entries()) {
      assert.equal(record.targetId,expectedTargets[cycle][ordinal],verdictReason('ROW_TARGET',{cycle:cycle+1,step:record.step},'')); assert.equal(record.sourcePersonaId,expectedSources[cycle][ordinal],verdictReason('ROW_SOURCE',{cycle:cycle+1,step:record.step},''));
      assert.notEqual(record.sourcePersonaId,record.targetId,verdictReason('WB_ROWS_RECORD_SOURCEPERSONAID_RECORD_TARGETID',{cycle:cycle+1,step:record.step},''));
      assert.equal(record.control,'personaSwitch-'+record.targetId,verdictReason('ROW_CONTROL',{cycle:cycle+1,step:record.step},'')); assert.equal(record.root,'taskSurface',verdictReason('ROW_ROOT',{cycle:cycle+1,step:record.step},'')); assert.equal(record.page,'characterTasks',verdictReason('WB_ROWS_RECORD_PAGE_CHARACTERTASKS',{cycle:cycle+1,step:record.step},''));
      assert(rowInteger(record.generation) && record.generation>previousGeneration,verdictReason('WB_ROWS_ROWINTEGER_RECORD_GENERATION_RECORD_GENERATION_PREVIOUSGENERATION',{cycle:cycle+1,step:record.step},'')); previousGeneration=record.generation; const scope=rowScope(record.scope,{cycle:cycle+1,step:record.step});
      assert.equal(scope.personaId,record.sourcePersonaId==='default'?defaultAnchor.personaId:record.sourcePersonaId,verdictReason('WB_ROWS_SCOPE_PERSONAID_RECORD_SOURCEPERSONAID_DEFAULT_DEFAULTANCHOR_PERSONAID_RECORD',{cycle:cycle+1,step:record.step},''));
      if(record.sourcePersonaId==='default') assert.equal(scope.fingerprint,defaultAnchor.fingerprint,verdictReason('WB_ROWS_SCOPE_FINGERPRINT_DEFAULTANCHOR_FINGERPRINT',{cycle:cycle+1,step:record.step},''));
      if(directScopes[cycle][ordinal]) assert.equal(record.scope,directScopes[cycle][ordinal],verdictReason('ROW_SCOPE_ANCHOR',{cycle:cycle+1,step:record.step},'Persona row uses an old or foreign scope'));
      assert(scope.epoch>previousEpoch && !scopes.has(record.scope),verdictReason('ROW_SCOPE_ADVANCES',{cycle:cycle+1,step:record.step},'Persona row scope did not advance'));
      scopes.add(record.scope); previousEpoch=scope.epoch;
      assert(rowInteger(record.stepAtMs) && record.stepAtMs>previousStepAt,verdictReason('WB_ROWS_ROWINTEGER_RECORD_STEPATMS_RECORD_STEPATMS_PREVIOUSSTEPAT',{cycle:cycle+1,step:record.step},'')); previousStepAt=record.stepAtMs;
      verifyPersonaRowInputRecord(record,{step:PERSONA_ROW_INPUT_CONTRACT.steps[cycle][ordinal],
        targetId:expectedTargets[cycle][ordinal],sourcePersonaId:expectedSources[cycle][ordinal],
        livePersonaId:scope.personaId,scope:directScopes[cycle][ordinal]||record.scope,generation:record.generation,
        root:'taskSurface',page:'characterTasks'});
    }
  }
  return {passed:true,contract:PERSONA_ROW_INPUT_CONTRACT,steps:records.map(rows=>rows.map(r=>r.step)),dispatches:records.map(rows=>rows.reduce((sum,r)=>sum+r.dispatchCount,0))};
}

function verifyAuthorControlReadiness(reports) {
  const priority=reports[0].worldbookPriority;
  assert(priority?.observed && Array.isArray(priority.receipts),verdictReason('WB_AUTHOR_PRIORITY_OBSERVED_ARRAY_ISARRAY_PRIORITY_RECEIPTS',{cycle:1},''));
  const original=priority.receipts.filter(r=>r.requestId===priority.observed.originalReadId);
  assert.equal(original.length,1,verdictReason('WB_AUTHOR_ORIGINAL_LENGTH_1',{cycle:1},''));assert.equal(original[0].command,'archive:get',verdictReason('WB_AUTHOR_ORIGINAL_0_COMMAND_ARCHIVE_GET',{cycle:1},''));assert.equal(original[0].ok,true,verdictReason('WB_AUTHOR_ORIGINAL_0_OK_TRUE',{cycle:1},''));
  assert.equal(original[0].scope,priority.observed.originalScope,verdictReason('WB_AUTHOR_ORIGINAL_0_SCOPE_PRIORITY_OBSERVED_ORIGINALSCOPE',{cycle:1},''));
  const restartRows=reports[1].personaRestart.personaRowInputs;
  const generation=step=>{const rows=restartRows.filter(row=>row.step===step);assert.equal(rows.length,1,verdictReason('WB_AUTHOR_ROWS_LENGTH_1',{step},''));return rows[0].generation;};
  const scopes=[[priority.observed.originalScope],[rowDraft(reports[1],'before-first-synthetic-input'),rowDraft(reports[1],'scope-cleared-restart-to-moon'),rowDraft(reports[1],'scope-cleared-restart-to-moon')]];
  const generations=[[original[0].generation],[generation(506),generation(518),generation(518)]];
  const groups=[reports[0].archiveInteraction.authorControlReadiness,reports[1].personaRestart.authorControlReadiness];
  for(const [cycle,rows]of groups.entries()) {
    assert(Array.isArray(rows),verdictReason('WB_AUTHOR_ARRAY_ISARRAY_ROWS',{cycle:cycle+1},''));assert.deepEqual(rows.map(row=>row.step),cycle?[502,513,514]:[425],verdictReason('AUTHOR_STEP_ORDER',{cycle:cycle+1},''));
    for(const [index,row]of rows.entries()) {
      const t=row.terminal,feedback=row.step===514;
      assert.equal(row.scope,scopes[cycle][index],verdictReason('AUTHOR_SCOPE',{step:row.step},''));assert.equal(row.generation,generations[cycle][index],verdictReason('WB_AUTHOR_ROW_GENERATION_GENERATIONS_CYCLE_INDEX',{step:row.step},''));assert(rowInteger(row.generation),verdictReason('WB_AUTHOR_ROWINTEGER_ROW_GENERATION',{step:row.step},''));
      assert.equal(row.control,feedback?'authorPromptFeedback':'authorPromptSwitch-post_history',verdictReason('WB_AUTHOR_ROW_CONTROL_FEEDBACK_AUTHORPROMPTFEEDBACK_AUTHORPROMPTSWITCH_POST_HISTORY',{step:row.step},''));
      assert(rowInteger(row.stepAtMs),verdictReason('WB_AUTHOR_ROWINTEGER_ROW_STEPATMS',{step:row.step},''));assert.equal(row.deadlineMs,4000,verdictReason('WB_AUTHOR_ROW_DEADLINEMS_4000',{step:row.step},''));assert.equal(row.sampleLimit,6,verdictReason('WB_AUTHOR_ROW_SAMPLELIMIT_6',{step:row.step},''));assert.equal(row.terminalCount,1,verdictReason('WB_AUTHOR_ROW_TERMINALCOUNT_1',{step:row.step},''));
      assert(Array.isArray(row.samples) && row.samples.length>0 && row.samples.length<=6,verdictReason('WB_AUTHOR_ARRAY_ISARRAY_ROW_SAMPLES_ROW_SAMPLES_LENGTH_0_ROW_SAMPLES_LENGTH_6',{step:row.step},''));
      assert(t && t.performed===true && t.scope===row.scope && t.generation===row.generation && t.step===row.step,verdictReason('WB_AUTHOR_T_T_PERFORMED_TRUE_T_SCOPE_ROW_SCOPE_T_GENERATION_ROW_GENERATION_T_STEP_ROW_ST',{step:row.step},''));
      assert.equal(t.root,'taskSurface',verdictReason('WB_AUTHOR_T_ROOT_TASKSURFACE',{step:row.step},''));assert.equal(t.page,'characterTasks',verdictReason('WB_AUTHOR_T_PAGE_CHARACTERTASKS',{step:row.step},''));
      assert(rowInteger(t.elapsedMs) && t.elapsedMs>=40 && t.elapsedMs<4000 && rowInteger(t.frameSerial),verdictReason('WB_AUTHOR_ROWINTEGER_T_ELAPSEDMS_T_ELAPSEDMS_40_T_ELAPSEDMS_4000_ROWINTEGER_T_FRAMESERIA',{step:row.step},''));
      for(const [key,name]of [['first',feedback?'authorPromptFeedback':'authorPromptSwitch-system'],['second',row.control]]) {
        const value=t[key],anchor=t[key+'Anchor'];
        assert(value && anchor,verdictReason('WB_AUTHOR_VALUE_ANCHOR',{step:row.step,part:key},''));assert.equal(value.control,name,verdictReason('WB_AUTHOR_VALUE_CONTROL_NAME',{step:row.step,part:key},''));assert.equal(value.objectName,name,verdictReason('AUTHOR_CONTROL_NAME',{step:row.step,part:key},''));assert.equal(value.scope,row.scope,verdictReason('WB_AUTHOR_VALUE_SCOPE_ROW_SCOPE',{step:row.step,part:key},''));
        for(const field of ['ready','layoutStable','found','enabled','visible','fullyVisible','surfaceClosed','integerPointInsideClip'])assert.equal(value[field],true,verdictReason('WB_AUTHOR_VALUE_FIELD_TRUE',{step:row.step,part:key,field},''));
        wholeGeometry(value,t.windowWidth,t.windowHeight,{step:row.step,part:key,section:"author-control"});wholeGeometry(anchor,t.windowWidth,t.windowHeight,{step:row.step,part:key,section:"author-anchor"});
        assert(rowInteger(value.stableSinceMs) && rowInteger(value.stableFrameSerial),verdictReason('WB_AUTHOR_ROWINTEGER_VALUE_STABLESINCEMS_ROWINTEGER_VALUE_STABLEFRAMESERIAL',{step:row.step,part:key},''));
        assert(rowInteger(value.elapsedMs) && value.elapsedMs<=t.elapsedMs && value.elapsedMs-value.stableSinceMs>=40,verdictReason('WB_AUTHOR_ROWINTEGER_VALUE_ELAPSEDMS_VALUE_ELAPSEDMS_T_ELAPSEDMS_VALUE_ELAPSEDMS_VALUE_S',{step:row.step,part:key},''));
        assert(value.frameSerial>value.stableFrameSerial && value.frameSerial<=t.frameSerial,verdictReason('AUTHOR_NEW_FRAME',{step:row.step,part:key},''));
        assert.equal(anchor.elapsedMs,value.stableSinceMs,verdictReason('WB_AUTHOR_ANCHOR_ELAPSEDMS_VALUE_STABLESINCEMS',{step:row.step,part:key},''));assert.equal(anchor.frameSerial,value.stableFrameSerial,verdictReason('WB_AUTHOR_ANCHOR_FRAMESERIAL_VALUE_STABLEFRAMESERIAL',{step:row.step,part:key},''));
        assert.equal(anchor.scope,row.scope,verdictReason('WB_AUTHOR_ANCHOR_SCOPE_ROW_SCOPE',{step:row.step,part:key},''));assert.equal(anchor.control,name,verdictReason('WB_AUTHOR_ANCHOR_CONTROL_NAME',{step:row.step,part:key},''));assert.equal(anchor.objectName,name,verdictReason('WB_AUTHOR_ANCHOR_OBJECTNAME_NAME',{step:row.step,part:key},''));
        for(const field of rowRectKeys)assert(rowNumber(value[field]) && rowNumber(anchor[field]) && Math.abs(value[field]-anchor[field])<=.5,verdictReason('WB_AUTHOR_ROWNUMBER_VALUE_FIELD_ROWNUMBER_ANCHOR_FIELD_MATH_ABS_VALUE_FIELD_ANCHOR_FIELD',{step:row.step,part:key,field},''));
        assert.equal(value.pointX,anchor.pointX,verdictReason('WB_AUTHOR_VALUE_POINTX_ANCHOR_POINTX',{step:row.step,part:key},''));assert.equal(value.pointY,anchor.pointY,verdictReason('WB_AUTHOR_VALUE_POINTY_ANCHOR_POINTY',{step:row.step,part:key},''));
      }
      for(const reveal of [t.firstReveal,...(feedback?[]:[t.secondReveal])]) {
        assert(reveal?.geometryValid===true && reveal.expired===false && rowInteger(reveal.elapsedMs) && reveal.elapsedMs<4000,verdictReason('WB_AUTHOR_REVEAL_GEOMETRYVALID_TRUE_REVEAL_EXPIRED_FALSE_ROWINTEGER_REVEAL_ELAPSEDMS_REV',{step:row.step,part:reveal===t.firstReveal?'first':'second'},''));
      }
      if(feedback)assert.deepEqual(t.secondReveal,{},verdictReason('WB_AUTHOR_T_SECONDREVEAL',{step:row.step},''));
      assert.equal(t.mouseDispatchCount,row.step===513?1:0,verdictReason('AUTHOR_MOUSE_COUNT',{step:row.step},''));
      if(row.step===513) {
        assert(Number.isInteger(t.clickedSignals) && [0,1].includes(t.clickedSignals),verdictReason('AUTHOR_CLICKED_SIGNALS',{step:row.step},''));assert.equal(t.toggledSignals,1,verdictReason('AUTHOR_TOGGLED_SIGNALS',{step:row.step},''));assert(rowInteger(t.mouseElapsedMs) && t.mouseElapsedMs>=t.elapsedMs && t.mouseElapsedMs<4000,verdictReason('AUTHOR_MOUSE_ELAPSED',{step:row.step},''));
        assert(rowInteger(t.mouseFrameSerial) && t.mouseFrameSerial>=t.frameSerial,verdictReason('WB_AUTHOR_ROWINTEGER_T_MOUSEFRAMESERIAL_T_MOUSEFRAMESERIAL_T_FRAMESERIAL',{step:row.step},''));
        assert(t.hit?.acceptorFound===true && ['target','descendant'].includes(t.hit.hitResult),verdictReason('WB_AUTHOR_T_HIT_ACCEPTORFOUND_TRUE_TARGET_DESCENDANT_INCLUDES_T_HIT_HITRESULT',{step:row.step},''));
      } else {assert.equal(t.clickedSignals,null,verdictReason('WB_AUTHOR_T_CLICKEDSIGNALS_NULL',{step:row.step},''));assert.equal(t.toggledSignals,null,verdictReason('WB_AUTHOR_T_TOGGLEDSIGNALS_NULL',{step:row.step},''));assert(!('mouseElapsedMs'in t),verdictReason('WB_AUTHOR_MOUSEELAPSEDMS_IN_T',{step:row.step},''));assert(!('mouseFrameSerial'in t),verdictReason('WB_AUTHOR_MOUSEFRAMESERIAL_IN_T',{step:row.step},''));}
      let time=-1,frame=-1;
      for(const sample of row.samples) {
        assert.equal(sample.step,row.step,verdictReason('WB_AUTHOR_SAMPLE_STEP_ROW_STEP',{step:row.step,sampleIndex:row.samples.indexOf(sample)},''));assert.equal(sample.scope,row.scope,verdictReason('WB_AUTHOR_SAMPLE_SCOPE_ROW_SCOPE',{step:row.step,sampleIndex:row.samples.indexOf(sample)},''));assert.equal(sample.generation,row.generation,verdictReason('WB_AUTHOR_SAMPLE_GENERATION_ROW_GENERATION',{step:row.step,sampleIndex:row.samples.indexOf(sample)},''));
        assert(rowInteger(sample.elapsedMs) && sample.elapsedMs>=time && sample.elapsedMs<=t.elapsedMs,verdictReason('WB_AUTHOR_ROWINTEGER_SAMPLE_ELAPSEDMS_SAMPLE_ELAPSEDMS_TIME_SAMPLE_ELAPSEDMS_T_ELAPSEDMS',{step:row.step,sampleIndex:row.samples.indexOf(sample)},''));
        assert(rowInteger(sample.frameSerial) && sample.frameSerial>=frame && sample.frameSerial<=t.frameSerial,verdictReason('WB_AUTHOR_ROWINTEGER_SAMPLE_FRAMESERIAL_SAMPLE_FRAMESERIAL_FRAME_SAMPLE_FRAMESERIAL_T_FR',{step:row.step,sampleIndex:row.samples.indexOf(sample)},''));
        time=sample.elapsedMs;frame=sample.frameSerial;
      }
    }
  }
  assert.deepEqual(reports[0].archiveInteraction.authorWriteReceipts,[],verdictReason('WB_AUTHOR_REPORTS_0_ARCHIVEINTERACTION_AUTHORWRITERECEIPTS',{cycle:1},''));
  const writes=reports[1].personaRestart.authorWriteReceipts;
  assert(Array.isArray(writes) && writes.length===1,verdictReason('WB_AUTHOR_ARRAY_ISARRAY_WRITES_WRITES_LENGTH_1',{cycle:2},''));
  const change=groups[1].find(row=>row.step===513),readback=groups[1].find(row=>row.step===514);
  const binding=change.terminal.writeBinding,ack=writes[0],old=reports[1].personaRestart.personaRestart;
  assert(binding?.armed===true && binding.status==='matched' && binding.failureReason==='',verdictReason('WB_AUTHOR_BINDING_ARMED_TRUE_BINDING_STATUS_MATCHED_BINDING_FAILUREREASON',{step:513},''));
  assert.equal(binding.scope,change.scope,verdictReason('WB_AUTHOR_BINDING_SCOPE_CHANGE_SCOPE',{step:513},''));assert.equal(binding.generation,change.generation,verdictReason('WB_AUTHOR_BINDING_GENERATION_CHANGE_GENERATION',{step:513},''));assert(rowInteger(binding.baselineCount),verdictReason('WB_AUTHOR_ROWINTEGER_BINDING_BASELINECOUNT',{step:513},''));
  assert(ident(binding.requestId),verdictReason('WB_AUTHOR_IDENT_BINDING_REQUESTID',{step:513},''));assert.equal(change.terminal.pendingFeedbackRequestId,binding.requestId,verdictReason('AUTHOR_PENDING_WRITE_ID',{step:513},''));
  assert.equal(ack.requestId,binding.requestId,verdictReason('WB_AUTHOR_ACK_REQUESTID_BINDING_REQUESTID',{step:513},''));assert.equal(ack.command,'archive:put',verdictReason('WB_AUTHOR_ACK_COMMAND_ARCHIVE_PUT',{step:513},''));assert.equal(ack.ok,true,verdictReason('WB_AUTHOR_ACK_OK_TRUE',{step:513},''));
  assert.equal(ack.scope,change.scope,verdictReason('WB_AUTHOR_ACK_SCOPE_CHANGE_SCOPE',{step:513},''));assert.equal(ack.generation,change.generation,verdictReason('WB_AUTHOR_ACK_GENERATION_CHANGE_GENERATION',{step:513},''));assert.equal(ack.cardMatches,1,verdictReason('WB_AUTHOR_ACK_CARDMATCHES_1',{step:513},''));
  assert.equal(ack.cardId,reports[0].archiveInteraction.cardImport.moonPersona,verdictReason('WB_AUTHOR_ACK_CARDID_REPORTS_0_ARCHIVEINTERACTION_CARDIMPORT_MOONPERSONA',{step:513},''));
  assert.equal(ack.systemEnabled,false,verdictReason('WB_AUTHOR_ACK_SYSTEMENABLED_FALSE',{step:513},''));assert.equal(ack.postHistoryEnabled,false,verdictReason('AUTHOR_ACK_POST_HISTORY_OFF',{step:513},''));
  assert(rowInteger(old?.switchRevision) && rowInteger(old?.disabledRevision),verdictReason('WB_AUTHOR_ROWINTEGER_OLD_SWITCHREVISION_ROWINTEGER_OLD_DISABLEDREVISION',{step:513},''));
  assert.equal(ack.revision,old.switchRevision+1,verdictReason('WB_AUTHOR_ACK_REVISION_OLD_SWITCHREVISION_1',{step:513},''));assert.equal(ack.revision,old.disabledRevision,verdictReason('WB_AUTHOR_ACK_REVISION_OLD_DISABLEDREVISION',{step:513},''));
  assert.deepEqual(readback.terminal.writeReadback,ack,verdictReason('AUTHOR_ACK_READBACK',{step:514},'Author write readback is not the actual captured ACK'));
  return {passed:true,steps:[[425],[502,513,514]],mouseDispatches:[0,1],toggledSignals:1,writeRequestId:binding.requestId};
}

module.exports={PRIORITY_TEXTS,PRIORITY_REPLY,INPUT_STEPS,FIRST_CHECKS,RESTART_CHECKS,LEGACY_SEQUENCE,priorityModelMetadata,verifyWorldbookPriority,PERSONA_ROW_INPUT_CONTRACT,verifyPersonaRowInputs,verifyPersonaRowInputRecord,verifyAuthorControlReadiness};
