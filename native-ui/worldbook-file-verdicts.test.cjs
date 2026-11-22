'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {verifyWorldbookFile,captureWorldbookFile,readWorldbookFile,SOURCE_FILE,EXPORT_FILE} = require('./worldbook-file-verdicts.cjs');
const h = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const BOOK = '文件导入验证书', SAVED = '文件导入验证书（已保存修改）';
const BODY = 'W9_FILE_GUI_BODY_MARKER_20261107', KEY = 'W9_FILE_GUI_KEY_MARKER_20261107';
const DISABLED = 'W9_FILE_GUI_DISABLED_BODY_20261107';
const scope = `builtin_hoshino_yumetsuki:1:${h('persona')}`;
const checks = [
  ['source-inspected-with-closed-summary','real-confirmation-imports-and-selects-new-book','dirty-draft-disables-file-operations',
    'real-name-edit-and-save-read-back','export-writes-selected-saved-book','original-books-and-messages-preserved'],
  ['restart-rereads-persisted-file-book','restart-controls-show-saved-name-and-configuration','restart-sends-no-file-controls-or-saves'],
];
function sourceDocument() {
  return {name:BOOK,entries:{
    '0':{key:[KEY],content:BODY+'\u200b',comment:'文件导入条目',probability:60,position:4,depth:2,role:2},
    '1':{key:['/w9-file-gui-regex/','w9-file-gui-literal'],content:DISABLED,comment:'混合正则停用条目'},
    '2':{key:['empty'],content:''},
  }};
}
function exportDocument() {
  const defaults = {
    vectorized:false,addMemo:false,ignoreBudget:false,excludeRecursion:false,preventRecursion:false,groupOverride:false,
    matchPersonaDescription:false,matchCharacterDescription:false,matchCharacterPersonality:false,
    matchCharacterDepthPrompt:false,matchScenario:false,matchCreatorNotes:false,delayUntilRecursion:0,
    probability:100,groupWeight:100,useProbability:true,outletName:'',group:'',automationId:'',
    matchWholeWords:null,useGroupScoring:null,sticky:null,cooldown:null,delay:null,triggers:[],
  };
  const entries = {};
  for (const n of [0,1]) entries[String(n)] = {
    ...clone(defaults),uid:n,key:n === 0 ? [KEY] : ['/w9-file-gui-regex/','w9-file-gui-literal'],keysecondary:[],
    comment:n === 0 ? '文件导入条目' : '混合正则停用条目',content:n === 0 ? BODY : DISABLED,
    constant:false,selective:true,selectiveLogic:0,order:100,position:n === 0 ? 4 : 0,disable:n === 1,
    depth:n === 0 ? 2 : 0,scanDepth:null,caseSensitive:false,role:n === 0 ? 2 : 0,priority:0,
    extensions:{reverie:{tokenBudget:null,useRegex:false}},
  };
  return {name:SAVED,entries,extensions:{reverie:{scanDepth:50,tokenBudget:500,recursiveScanning:false}}};
}
function configuration() {
  return {bookId:'world_synthetic_book',bookName:SAVED,scanDepth:50,tokenBudget:500,recursiveScanning:false,entryCount:2,
    entries:[0,1].map(n => ({id:`entry_synthetic_${n}`,enabled:n === 0,alwaysActive:false,
      position:n === 0 ? 'at_depth' : 'before_char',depth:n === 0 ? 2 : 0,role:n === 0 ? 'assistant' : 'system',
      insertionOrder:100,priority:0,selectiveLogic:'and_any',scanDepth:null,tokenBudget:null,caseSensitive:false,useRegex:false,
      contentSha256:h(n === 0 ? BODY : DISABLED),
      keywordsSha256:h(JSON.stringify(n === 0 ? [KEY] : ['/w9-file-gui-regex/','w9-file-gui-literal'])),
      secondaryKeywordsSha256:h('[]')}))};
}
function input(step,control,kind,generation) {
  const snapshot = {scope,ready:true,found:true,enabled:true,visible:true,bound:true,geometryValid:true,
    integerPointInsideClip:true,fullyVisible:true,sceneX:10,sceneY:10,sceneWidth:80,sceneHeight:30,
    clipX:0,clipY:0,clipWidth:100,clipHeight:100,pointX:50,pointY:25};
  const row = {step,control,kind,scopeKey:scope,generation,deadlineMs:4000,elapsedMs:80,frame:3,
    layout:{...snapshot,layoutStable:true,elapsedMs:70,stableSinceMs:20,stableFrameSerial:1,frameSerial:2},
    gate:{performed:true,polls:1,sampleLimit:6,pollIntervalMs:40,
      samples:[{...snapshot,elapsedMs:75}],last:{...snapshot,elapsedMs:75}},
    hit:{hitResult:'target',acceptorFound:true}};
  if (kind === 'path-handoff') Object.assign(row,{pathHandoffCount:1,mouseDispatchCount:0});
  else if (kind === 'text') Object.assign(row,{mouseDispatchCount:1,inputMethodCommitCount:1,textEditedSignals:1});
  else if (kind === 'selector') Object.assign(row,{mouseDispatchCount:1,activatedSignals:1,selectedIndex:2,keyDispatchCount:4});
  else Object.assign(row,{mouseDispatchCount:1,clickedSignals:1});
  return row;
}
function fixture() {
  const sourceText = JSON.stringify(sourceDocument()), exportText = JSON.stringify(exportDocument());
  const bookId = 'world_synthetic_book', final = configuration(), messages = ['original-message-01'];
  const receipt = (requestId,command,revision,generation) => ({requestId,command,revision,generation,scopeKey:scope,ok:true});
  const importRead = receipt('archive-import-read-01','archive:get',8,2);
  const save = receipt('archive-save-01','archive:put',9,2);
  const restartRead = receipt('archive-restart-read-01','archive:get',9,1);
  const common = index => ({schema:'reverie.native.worldbook-file.gui-evidence.v1',passed:true,error:'',
    mode:index === 0 ? 'import-edit-export' : 'restart-readback',step:index === 0 ? 11 : 22,
    deadlineMs:index === 0 ? 30000 : 15000,elapsedMs:5000,pollIntervalMs:40,
    checks:checks[index].map(name => ({name,passed:true})),systemOpenDialogCovered:false,systemSaveDialogCovered:false,
    contentCollected:false,inputMethodScope:'synthetic QInputMethodEvent commit, not physical OS IME acceptance'});
  const first = {...common(0),observed:{scopeKey:scope,generation:2,baselineRevision:7,baselineBookCount:1,bookId,
    initialMessageIds:messages.slice(),finalMessageIds:messages.slice(),messageIdsUnchanged:true,
    source:{file_name:SOURCE_FILE,file_bytes:Buffer.byteLength(sourceText),sha256:h(sourceText)},
    inspect:{operation:'inspect',requestId:'inspect-control-01',scopeKey:scope,generation:2,archiveRevision:7,status:'confirmation',
      book_name:BOOK,importable_entry_count:2,skipped:{empty:1},dropped_fields:{probability:1},
      disabled_regex_entry_count:1,cleaned_entry_count:1,sha256:h(sourceText),file_bytes:Buffer.byteLength(sourceText)},
    confirmation:{summaryText:`${BOOK}；将导入 2 条；跳过 1 条；probability；1 条正则已关闭；1 条文字被清理`,
      plainText:true,visible:true,noBodyOrKeywords:true},
    import:{operation:'import',requestId:'import-control-01',scopeKey:scope,generation:2,archiveRevision:7,status:'success',
      world_book_id:bookId,book_name:BOOK,imported_entry_count:2,revision:8,readbackRevision:8,selectedWorldBookId:bookId,
      sha256:h(sourceText),file_bytes:Buffer.byteLength(sourceText)},importRead,
    nameEdit:{field:'name',before:BOOK,after:SAVED,dirty:true,importEnabled:false,exportEnabled:false},
    save:{...save,expectedRevision:8,dirtyBefore:true,dirtyAfter:false,bookId,bookName:SAVED,changedFields:['name']},
    export:{operation:'export',requestId:'export-control-01',scopeKey:scope,generation:2,archiveRevision:9,status:'success',
      world_book_id:bookId,book_name:SAVED,entry_count:2,file_name:EXPORT_FILE,bytes:Buffer.byteLength(exportText),sha256:h(exportText)},
    final,finalRevision:9,restHashBefore:h('rest'),restHashAfter:h('rest'),finalArchiveHash:h('final-archive'),
    archivePutReceiptCount:1,fileControlRequestIds:{inspect:['inspect-control-01'],import:['import-control-01'],export:['export-control-01']}},
    inputs:[[1,'nav-memory','button'],[2,'worldbookFileImport','path-handoff'],[4,'worldbookFileImportConfirm','button'],
      [6,'worldbookName','text'],[8,'saveWorldbook','button'],[10,'worldbookFileExport','path-handoff']].map(row => input(...row,2)),
    archiveReceipts:[receipt('archive-baseline-read-01','archive:get',7,2),clone(importRead),save]};
  const second = {...common(1),observed:{scopeKey:scope,generation:1,baselineRevision:9,baselineBookCount:2,bookId,
    initialMessageIds:messages.slice(),finalMessageIds:messages.slice(),messageIdsUnchanged:true,final:clone(final),finalRevision:9,
    archiveHashBefore:h('final-archive'),archiveHashAfter:h('final-archive'),restartRead,
    archivePutReceiptCount:0,fileControlRequestIds:{inspect:[],import:[],export:[]}},
    inputs:[[1,'nav-memory','button'],[2,'reloadWorldbook','button'],[21,'worldbookBookSelector','selector']].map(row => input(...row,1)),
    archiveReceipts:[clone(restartRead)]};
  return {first,second,sourceText,exportText};
}
const verify = value => verifyWorldbookFile(value.first,value.second,
  {sourceBytes:Buffer.from(value.sourceText),exportBytes:Buffer.from(value.exportText)});
function editExport(value,mutate) {
  const document = JSON.parse(value.exportText); mutate(document); value.exportText = JSON.stringify(document);
  value.first.observed.export.bytes = Buffer.byteLength(value.exportText);
  value.first.observed.export.sha256 = h(value.exportText);
}
function rejects(rows) {
  for (const row of rows) assertRejectedMutation({makeFixture:fixture,verify,...row});
}

test('accepts the file import, real edit/save/export and unchanged restart against actual bytes',() => {
  const proof = verify(fixture());
  assert.equal(proof.passed,true); assert.deepEqual(proof.checks,[6,3]);
  assert.deepEqual(proof.revisions,[7,8,9,9]); assert.deepEqual(proof.archiveSaves,[1,0]);
  assert.equal(JSON.stringify(proof).includes(BODY),false);
});
test('accepts restart when its real controls already select the saved book',() => {
  const value = fixture(); value.second.inputs.pop(); assert.equal(verify(value).passed,true);
});
test('rejects missing, repeated, false or reordered independent checks',() => rejects([
  {id:'file.check-missing',expectedReason:'WORLDBOOK_FILE_CHECKS',mutate:v => v.first.checks.pop()},
  {id:'file.check-duplicate',expectedReason:'WORLDBOOK_FILE_CHECKS',mutate:v => v.second.checks.push(clone(v.second.checks[0]))},
  {id:'file.check-false',expectedReason:'WORLDBOOK_FILE_CHECKS',mutate:v => {v.first.checks[0].passed=false;}},
  {id:'file.check-order',expectedReason:'WORLDBOOK_FILE_CHECKS',mutate:v => v.first.checks.reverse()},
  {id:'file.cycle-late',expectedReason:'WORLDBOOK_FILE_CYCLE_DEADLINE',mutate:v => {v.first.elapsedMs=30000;}},
]));
test('rejects absent, stale or duplicated control and readback evidence',() => rejects([
  {id:'file.inspect-stale',expectedReason:'WORLDBOOK_FILE_CONTROL_SCOPE',mutate:v => {v.first.observed.inspect.generation++;}},
  {id:'file.import-stale-scope',expectedReason:'WORLDBOOK_FILE_CONTROL_SCOPE',mutate:v => {v.first.observed.import.scopeKey='other';}},
  {id:'file.export-stale-revision',expectedReason:'WORLDBOOK_FILE_CONTROL_SCOPE',mutate:v => {v.first.observed.export.archiveRevision--;}},
  {id:'file.control-repeated',expectedReason:'WORLDBOOK_FILE_CONTROL_COUNT',mutate:v => {v.first.observed.fileControlRequestIds.import.push('extra-control-01');}},
  {id:'file.ack-only',expectedReason:'WORLDBOOK_FILE_CORRELATED_READBACK',mutate:v => {delete v.first.observed.importRead;}},
  {id:'file.import-not-selected',expectedReason:'WORLDBOOK_FILE_IMPORT_READBACK',mutate:v => {v.first.observed.import.selectedWorldBookId='old-book';}},
  {id:'file.receipt-duplicate',expectedReason:'WORLDBOOK_FILE_RECEIPT_UNIQUE',mutate:v => v.first.archiveReceipts.push(clone(v.first.archiveReceipts[0]))},
  {id:'file.receipt-old-generation',expectedReason:'WORLDBOOK_FILE_RECEIPT_SCOPE',mutate:v => {v.second.archiveReceipts[0].generation++;}},
  {id:'file.save-version-chain',expectedReason:'WORLDBOOK_FILE_SAVE',mutate:v => {v.first.observed.save.expectedRevision--;}},
]));
test('rejects false readiness, unstable geometry, intercepted input and dispatch counts',() => rejects([
  {id:'file.input-missing',expectedReason:'WORLDBOOK_FILE_INPUT_SEQUENCE',mutate:v => v.first.inputs.splice(2,1)},
  {id:'file.input-stale',expectedReason:'WORLDBOOK_FILE_INPUT_SCOPE',mutate:v => {v.first.inputs[0].generation++;}},
  {id:'file.input-not-whole',expectedReason:'WORLDBOOK_FILE_INPUT_READY',mutate:v => {v.first.inputs[2].layout.fullyVisible=false;}},
  {id:'file.input-outside',expectedReason:'WORLDBOOK_FILE_INPUT_GEOMETRY',mutate:v => {v.first.inputs[2].layout.pointX=101;}},
  {id:'file.input-no-frame',expectedReason:'WORLDBOOK_FILE_INPUT_STABILITY',mutate:v => {v.first.inputs[2].layout.stableFrameSerial=2;}},
  {id:'file.input-empty-gate',expectedReason:'WORLDBOOK_FILE_INPUT_GATE',mutate:v => {v.first.inputs[2].gate.samples=[];}},
  {id:'file.input-intercepted',expectedReason:'WORLDBOOK_FILE_INPUT_HIT',mutate:v => {v.first.inputs[2].hit.hitResult='ancestor';}},
  {id:'file.confirm-double-click',expectedReason:'WORLDBOOK_FILE_INPUT_COUNTS',mutate:v => {v.first.inputs[2].mouseDispatchCount=2;}},
  {id:'file.text-programmatic',expectedReason:'WORLDBOOK_FILE_INPUT_COUNTS',mutate:v => {v.first.inputs[3].inputMethodCommitCount=0;}},
  {id:'file.selector-string-count',expectedReason:'WORLDBOOK_FILE_INPUT_COUNTS',mutate:v => {v.second.inputs[2].activatedSignals='1';}},
]));
test('rejects changed unrelated state, writes on restart, dirty bypasses and plaintext leaks',() => rejects([
  {id:'file.other-book-edited',expectedReason:'WORLDBOOK_FILE_UNRELATED_ARCHIVE',mutate:v => {v.first.observed.restHashAfter=h('changed');}},
  {id:'file.message-changed',expectedReason:'WORLDBOOK_FILE_MESSAGES',mutate:v => {v.first.observed.finalMessageIds.push('new-message-01');}},
  {id:'file.restart-archive-changed',expectedReason:'WORLDBOOK_FILE_RESTART_ARCHIVE',mutate:v => {v.second.observed.archiveHashBefore=h('changed');}},
  {id:'file.restart-entry-id-changed',expectedReason:'WORLDBOOK_FILE_RESTART_CONFIGURATION',mutate:v => {v.second.observed.final.entries[0].id='entry_wrong';}},
  {id:'file.restart-save',expectedReason:'WORLDBOOK_FILE_WRITE_COUNT',mutate:v => {v.second.observed.archivePutReceiptCount=1;}},
  {id:'file.restart-control',expectedReason:'WORLDBOOK_FILE_RESTART_WRITES',mutate:v => {v.second.observed.fileControlRequestIds.export=['unexpected-control-01'];}},
  {id:'file.dirty-export-enabled',expectedReason:'WORLDBOOK_FILE_DIRTY_GATE',mutate:v => {v.first.observed.nameEdit.exportEnabled=true;}},
  {id:'file.body-in-summary',expectedReason:'WORLDBOOK_FILE_CONTENT_LEAK',mutate:v => {v.first.observed.confirmation.summaryText+=BODY;}},
  {id:'file.keyword-leak',expectedReason:'WORLDBOOK_FILE_CONTENT_LEAK',mutate:v => {v.first.observed.import.keywords=[KEY];}},
  {id:'file.rich-summary',expectedReason:'WORLDBOOK_FILE_CONFIRMATION',mutate:v => {v.first.observed.confirmation.plainText=false;}},
]));
test('requires source digest/size and actual exported fields rather than acknowledgements',() => rejects([
  {id:'file.source-size',expectedReason:'WORLDBOOK_FILE_SOURCE_BINDING',mutate:v => {v.first.observed.source.file_bytes++;}},
  {id:'file.inspect-digest',expectedReason:'WORLDBOOK_FILE_INSPECTION',mutate:v => {v.first.observed.inspect.sha256=h('wrong');}},
  {id:'file.export-digest',expectedReason:'WORLDBOOK_FILE_EXPORT_BINDING',mutate:v => {v.first.observed.export.sha256=h('wrong');}},
  {id:'file.export-wrong-body',expectedReason:'WORLDBOOK_FILE_EXPORT_DOCUMENT',mutate:v => editExport(v,d => {d.entries['0'].content='wrong';})},
  {id:'file.export-enabled-disabled-entry',expectedReason:'WORLDBOOK_FILE_EXPORT_DOCUMENT',mutate:v => editExport(v,d => {d.entries['1'].disable=false;})},
  {id:'file.export-wrong-default',expectedReason:'WORLDBOOK_FILE_EXPORT_DOCUMENT',mutate:v => editExport(v,d => {d.entries['0'].probability=60;})},
  {id:'file.export-extra-field',expectedReason:'WORLDBOOK_FILE_EXPORT_DOCUMENT',mutate:v => editExport(v,d => {d.entries['0'].privateField='hidden';})},
  {id:'file.duplicate-json',expectedReason:'WORLDBOOK_FILE_JSON',mutate:v => {v.sourceText='{"name":"first",'+v.sourceText.slice(1);}},
]));

function fileFixture() {
  const value = fixture(); value.directory = fs.mkdtempSync(path.join(os.tmpdir(),'worldbook-file-verdict-'));
  value.data = path.join(value.directory,'data'); value.report = path.join(value.directory,'report');
  fs.mkdirSync(value.data); fs.mkdirSync(value.report);
  fs.writeFileSync(path.join(value.data,SOURCE_FILE),value.sourceText,{mode:0o600});
  fs.writeFileSync(path.join(value.data,EXPORT_FILE),value.exportText,{mode:0o600});
  return value;
}
function verifyFiles(value) {
  return verifyWorldbookFile(value.first,value.second,{
    sourceBytes:readWorldbookFile(path.join(value.data,SOURCE_FILE)),exportBytes:readWorldbookFile(path.join(value.data,EXPORT_FILE))});
}
const dispose = value => fs.rmSync(value.directory,{recursive:true,force:true});
test('captures actual source, export and metadata proof before isolation cleanup',() => {
  const value = fileFixture();
  try {
    const proof = captureWorldbookFile([{worldbookFile:value.first},{worldbookFile:value.second}],value.data,value.report);
    assert.equal(proof.passed,true); assert.equal(proof.artifacts.length,2);
    for (const artifact of proof.artifacts) assert.equal(h(fs.readFileSync(path.join(value.report,artifact.path))),artifact.sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(value.report,'worldbook-file-proof.json'),'utf8')),proof);
  } finally { dispose(value); }
});
test('bounded capture rejects symlinks, hardlinks and non-regular files using fresh owned fixtures',() => {
  for (const [name,mutate] of [
    ['symlink',v => {const target=path.join(v.data,EXPORT_FILE);fs.renameSync(target,target+'.actual');fs.symlinkSync(target+'.actual',target);}],
    ['hardlink',v => {fs.linkSync(path.join(v.data,EXPORT_FILE),path.join(v.data,'hardlink.json'));}],
    ['directory',v => {const target=path.join(v.data,EXPORT_FILE);fs.unlinkSync(target);fs.mkdirSync(target);}],
    ['oversized',v => {fs.writeFileSync(path.join(v.data,EXPORT_FILE),Buffer.alloc(5*1024*1024+1));}],
  ]) assertRejectedMutation({id:`file.actual-${name}`,makeFixture:fileFixture,verify:verifyFiles,mutate,
    expectedReason:'WORLDBOOK_FILE_REGULAR_FILE',kind:'files',dispose});
});

// The storage alias `default` is not the authenticated runtime persona ID.
// Mutate every matching scope in a cycle so earlier correlation guards remain
// valid and the intended cross-restart identity guard is exercised.
test('rejects storage aliases and changed authenticated restart scope',() => {
  const change = (value,next) => JSON.parse(JSON.stringify(value),(key,item) => item === scope ? next : item);
  rejects([
    {id:'file.scope-storage-alias',expectedReason:'WORLDBOOK_FILE_SCOPE',mutate:v => {v.first=change(v.first,`default:1:${h('persona')}`);}},
    {id:'file.scope-other-persona',expectedReason:'WORLDBOOK_FILE_SCOPE',mutate:v => {v.second=change(v.second,`other_persona:1:${h('persona')}`);}},
    {id:'file.scope-new-epoch',expectedReason:'WORLDBOOK_FILE_RESTART_SCOPE',mutate:v => {v.second=change(v.second,`builtin_hoshino_yumetsuki:2:${h('persona')}`);}},
    {id:'file.scope-new-fingerprint',expectedReason:'WORLDBOOK_FILE_RESTART_SCOPE',mutate:v => {v.second=change(v.second,`builtin_hoshino_yumetsuki:1:${h('changed-persona')}`);}},
  ]);
});
