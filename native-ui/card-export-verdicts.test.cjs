'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {verifyCardExport, captureCardExport, verifySavedCardExport, readCardFile} = require('./card-export-verdicts.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const card = {spec:'chara_card_v2', spec_version:'2.0', data:{name:'测试人格·月', description:'合成正文',
    personality:'', scenario:'', first_mes:'你好', mes_example:'', alternate_greetings:[],
    system_prompt:'以安静简洁的语气回应。', post_history_instructions:'每次回复以一句晚安收尾。',
    creator:'', character_version:'', creator_notes:'', tags:[], extensions:{}, character_book:{
      name:'测试人格·月的世界书', description:'', scan_depth:50, token_budget:500, recursive_scanning:false, extensions:{},
      entries:[{keys:['月光'], secondary_keys:[], content:'隔离观景室中的月光落在窗边。', enabled:true,
        insertion_order:100, priority:10, case_sensitive:false, comment:'', constant:false, selective:false, id:1,
        depth:4, role:'system', scan_depth:null, token_budget:null, use_regex:false, position:'before_char',
        extensions:{reverie:{id:'synthetic_entry'}}}]}}};
  const bytes = Buffer.from(JSON.stringify(card) + '\n');
  const input = control => ({control, deadlineMs:4000, layout:{ready:true,layoutStable:true,enabled:true,
    visible:true,found:true,fullyVisible:true,integerPointInsideClip:true,elapsedMs:80,stableSinceMs:40,frameSerial:3,stableFrameSerial:2},
    gate:{performed:true,sampleLimit:6,pollIntervalMs:40,last:{ready:true,elapsedMs:80}}});
  const whole = {found:true,visible:true,fullyVisible:true,sceneX:10,sceneY:10,sceneWidth:150,sceneHeight:30,
    clipX:10,clipY:10,clipWidth:150,clipHeight:30};
  const personaId = 'st_' + 'a'.repeat(20), bookId = 'synthetic_book';
  const evidence = {schema:'reverie.native.card-export.gui-evidence.v1',passed:true,importBaselineUnchanged:true,
    systemSaveDialogCovered:false,saveDialogConfirmCovered:false,
    export:{personaId,scope:personaId+':3:'+'b'.repeat(64),generation:7,archiveRevision:1,bookId,
      bookName:'测试人格·月的世界书',expectedName:'测试人格·月',expectedEntryCount:1,entryClickCount:1,
      bridgeHandoffCount:1,defaultBookSelected:true,savedNoticeVisible:true,selectedBookId:bookId},
    receipt:{status:'success',requestId:'export_request_0001',file_name:'p1-card-export.json',bytes:bytes.length,
      sha256:sha(bytes),world_book_id:bookId,world_book_name:'测试人格·月的世界书',entry_count:1,persona_id:personaId},
    inputs:[input('personaCardExport'),input('personaCardExportBook')],
    builtin:{activeId:'default',buttonDisabled:true,noticeVisible:true,dispatchCount:0,button:{...whole},notice:{...whole}}};
  const result = {cardExportContract:'v1',reports:[{archiveInteraction:{cardExport:evidence,
    cardImport:{moonPersona:personaId,requestId:'valid_import_0001',duplicateRequestId:'duplicate_import_0001',flaggedRequestId:'flagged_import_0001'}}},
    {personaRestart:{}}]};
  // A broken fresh baseline must fail before any mutation or expected rejection.
  verifyCardExport(result.reports,bytes);
  return {card,bytes,evidence,result};
}
function changedCard(mutator) {
  const value = fixture(); mutator(value.card);
  value.bytes = Buffer.from(JSON.stringify(value.card) + '\n');
  Object.assign(value.evidence.receipt,{bytes:value.bytes.length,sha256:sha(value.bytes)});
  return value;
}
test('card export verifies independent default-book and builtin evidence with actual bytes', () => {
  const v=fixture(), proof=verifyCardExport(v.result.reports,v.bytes);
  assert.deepEqual(proof.cycleChecks,[2,0]); assert.equal(proof.bytes,v.bytes.length);
  assert.equal(proof.systemSaveDialogCovered,false); assert.equal(proof.saveDialogConfirmCovered,false);
});
test('card export rejects a receipt that differs from actual file bytes or SHA256', () => {
  const v=fixture(); v.evidence.receipt.bytes++;
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_ACTUAL_FILE_HASH/);
  const w=fixture(); w.evidence.receipt.sha256='0'.repeat(64);
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_ACTUAL_FILE_HASH/);
});
test('card export rejects false success, foreign persona and a reused import acknowledgement', () => {
  const v=fixture(); v.evidence.receipt.status='unknown';
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_RECEIPT_BINDING/);
  const w=fixture(); w.evidence.receipt.persona_id='other';
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_RECEIPT_BINDING/);
  const x=fixture(); x.evidence.receipt.requestId=x.result.reports[0].archiveInteraction.cardImport.requestId;
  assert.throws(()=>verifyCardExport(x.result.reports,x.bytes),/CARD_EXPORT_REUSED_IMPORT_ACK/);
});
test('card export rejects missing default choice or duplicate bridge handoff', () => {
  const v=fixture(); v.evidence.export.selectedBookId='different_book';
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_DEFAULT_SELECTION/);
  const w=fixture(); w.evidence.export.bridgeHandoffCount=2;
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_DEFAULT_SELECTION/);
});
test('card export rejects missing geometry stability and a dispatch at the old deadline', () => {
  const v=fixture(); v.evidence.inputs[0].layout.frameSerial=2;
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_INPUT_STABILITY/);
  const w=fixture(); w.evidence.inputs[1].gate.last.elapsedMs=4000;
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_INPUT_GATE/);
});
test('card export rejects enabled builtin controls and clipped explanation', () => {
  const v=fixture(); v.evidence.builtin.buttonDisabled=false;
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_BUILTIN_GATE/);
  const w=fixture(); w.evidence.builtin.notice.sceneWidth=200;
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_BUILTIN_NOTICE_CLIPPED/);
});
test('card export rejects wrong V2, fixture name and entry count', () => {
  const v=changedCard(c=>{c.spec='chara_card_v3';});
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_NOT_V2/);
  const w=changedCard(c=>{c.data.name='other';});
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_FIXTURE_CARD_FIELDS/);
  const x=changedCard(c=>{c.data.character_book.entries=[];});
  assert.throws(()=>verifyCardExport(x.result.reports,x.bytes),/CARD_EXPORT_BOOK_OR_ENTRY_COUNT/);
});
test('card export rejects forbidden data and nested extension fields', () => {
  const v=changedCard(c=>{c.data.persona_id='private';});
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_FORBIDDEN_DATA_FIELD/);
  const w=changedCard(c=>{c.data.character_book.entries[0].extensions.reverie.path='/private';});
  assert.throws(()=>verifyCardExport(w.result.reports,w.bytes),/CARD_EXPORT_FORBIDDEN_REVERIE_EXTENSION/);
});
test('card export rejects duplicate JSON keys that could hide prohibited material', () => {
  const v=fixture();
  v.bytes=Buffer.from(v.bytes.toString('utf8').replace('"name":"测试人格·月"',
    '"name":{"credentials":"hidden"},"name":"测试人格·月"'));
  Object.assign(v.evidence.receipt,{bytes:v.bytes.length,sha256:sha(v.bytes)});
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_DUPLICATE_JSON_KEY/);
});
test('card export rejects a repeated addition in the restart cycle', () => {
  const v=fixture(); v.result.reports[1].personaRestart.cardExport=v.evidence;
  assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_RESTART_ADDITION/);
});
test('card export captures actual output before cleanup and replays its saved artifact', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-card-export-verdict-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'data'), report=path.join(root,'report'); fs.mkdirSync(data); fs.mkdirSync(report);
  const v=fixture(); fs.writeFileSync(path.join(data,'p1-card-export.json'),v.bytes,{mode:0o600});
  v.result.cardExportEvidence=captureCardExport(v.result,data,report);
  fs.rmSync(data,{recursive:true});
  assert.deepEqual(verifySavedCardExport(v.result,report),v.result.cardExportEvidence);
  fs.appendFileSync(path.join(report,'card-export.json'),' ');
  assert.throws(()=>verifySavedCardExport(v.result,report),/CARD_EXPORT_ACTUAL_FILE_HASH/);
});
test('card export refuses symlink and hardlink output files', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-card-export-path-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'file.json'), link=path.join(root,'link.json');
  fs.writeFileSync(file,fixture().bytes,{mode:0o600}); fs.symlinkSync(file,link);
  assert.throws(()=>readCardFile(link),/CARD_EXPORT_FILE_NOT_PRIVATE_REGULAR/);
  fs.unlinkSync(link); fs.linkSync(file,link);
  assert.throws(()=>readCardFile(file),/CARD_EXPORT_FILE_NOT_PRIVATE_REGULAR/);
});
test('card export rejects nested objects in every mapped character string field', () => {
  for (const key of ['name','description','personality','scenario','first_mes','mes_example','system_prompt',
    'post_history_instructions','creator','character_version','creator_notes']) {
    const v=changedCard(card=>{card.data[key]={credentials:'synthetic-hidden-value'};});
    assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_DATA_VALUE_SHAPE/,key);
  }
});
test('card export rejects non-list and nested-object tags or alternate greetings', () => {
  for (const key of ['tags','alternate_greetings']) for (const invalid of ['not-a-list',[{path:'/synthetic-private'}],[1]]) {
    const v=changedCard(card=>{card.data[key]=invalid;});
    assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_DATA_LIST_SHAPE/,key);
  }
});
test('card export rejects invalid worldbook string numeric and boolean value shapes', () => {
  for (const [key,invalid] of [['name',{path:'/synthetic-private'}],['description',{credentials:'synthetic'}],
    ['scan_depth',true],['scan_depth',1.5],['token_budget',{path:'/synthetic-private'}],
    ['token_budget',Number.MAX_SAFE_INTEGER+1],['recursive_scanning','false'],['entries',{settings:{}}]]) {
    const v=changedCard(card=>{card.data.character_book[key]=invalid;});
    assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_BOOK_VALUE_SHAPE/,key);
  }
});
test('card export rejects nested objects and wrong primitive types in every mapped entry field', () => {
  const changes=[['keys',[{path:'/synthetic-private'}]],['secondary_keys',[{credentials:'synthetic'}]],
    ['content',{memory:'synthetic'}],['comment',{settings:{}}],
    ...['enabled','case_sensitive','constant','selective','use_regex'].map(key=>[key,1]),
    ...['insertion_order','priority','id','depth'].map(key=>[key,true]),
    ['insertion_order',1.5],['priority',Number.MAX_SAFE_INTEGER+1],
    ['scan_depth',{path:'/synthetic-private'}],['token_budget',false]];
  for (const [key,invalid] of changes) {
    const v=changedCard(card=>{card.data.character_book.entries[0][key]=invalid;});
    assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_ENTRY_VALUE_SHAPE/,key);
  }
});
test('card export rejects invalid entry role and position enums', () => {
  for (const [key,invalid] of [['role',{credentials:'synthetic'}],['role','tool'],['position',{path:'/synthetic-private'}],
    ['position','at_depth']]) {
    const v=changedCard(card=>{card.data.character_book.entries[0][key]=invalid;});
    assert.throws(()=>verifyCardExport(v.result.reports,v.bytes),/CARD_EXPORT_ENTRY_ENUM/,key);
  }
});
