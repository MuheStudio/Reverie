'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const {verdictReason} = require('./verdict-test-support.cjs');

const WORLDBOOK_FILE_CONTRACT = 'reverie.native.worldbook-file.verdict.v1';
const SOURCE_FILE = 'p1-worldbook-source.json', EXPORT_FILE = 'p1-worldbook-export.json';
const BOOK_NAME = '文件导入验证书', SAVED_NAME = '文件导入验证书（已保存修改）';
const BODY = 'W9_FILE_GUI_BODY_MARKER_20261107', KEY = 'W9_FILE_GUI_KEY_MARKER_20261107';
const DISABLED_BODY = 'W9_FILE_GUI_DISABLED_BODY_20261107';
const MAX_BYTES = 5 * 1024 * 1024;
const CHECKS = [
  ['source-inspected-with-closed-summary', 'real-confirmation-imports-and-selects-new-book',
    'dirty-draft-disables-file-operations', 'real-name-edit-and-save-read-back',
    'export-writes-selected-saved-book', 'original-books-and-messages-preserved'],
  ['restart-rereads-persisted-file-book', 'restart-controls-show-saved-name-and-configuration',
    'restart-sends-no-file-controls-or-saves'],
];
const DEFAULTS = {
  vectorized:false, addMemo:false, ignoreBudget:false, excludeRecursion:false, preventRecursion:false,
  groupOverride:false, matchPersonaDescription:false, matchCharacterDescription:false,
  matchCharacterPersonality:false, matchCharacterDepthPrompt:false, matchScenario:false, matchCreatorNotes:false,
  delayUntilRecursion:0, probability:100, groupWeight:100, useProbability:true, outletName:'', group:'', automationId:'',
  matchWholeWords:null, useGroupScoring:null, sticky:null, cooldown:null, delay:null, triggers:[],
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function guard(value, reason) { assert(value, verdictReason(reason)); }
function equal(actual, expected, reason) { assert.deepEqual(actual, expected, verdictReason(reason)); }
function keys(value, expected, reason) {
  guard(object(value), reason); equal(Object.keys(value).sort(), expected.slice().sort(), reason);
}

function strictJson(bytes) {
  guard(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES, 'WORLDBOOK_FILE_BYTES');
  try {
    const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    let at = 0;
    const space = () => { while (at < text.length && /[ \n\r\t]/.test(text[at])) ++at; };
    const string = () => {
      const start = at++;
      while (at < text.length) {
        const character = text[at++];
        if (character === '\\') { ++at; continue; }
        if (character === '"') return JSON.parse(text.slice(start, at));
      }
      throw new Error('string');
    };
    const value = depth => {
      if (depth > 64) throw new Error('depth');
      space();
      if (text[at] === '{') {
        ++at; space(); const seen = new Set();
        if (text[at] === '}') { ++at; return; }
        while (true) {
          space(); if (text[at] !== '"') throw new Error('object');
          const key = string(); if (seen.has(key)) throw new Error('duplicate'); seen.add(key);
          space(); if (text[at++] !== ':') throw new Error('object');
          value(depth + 1); space(); const separator = text[at++];
          if (separator === '}') return;
          if (separator !== ',') throw new Error('object');
        }
      }
      if (text[at] === '[') {
        ++at; space(); if (text[at] === ']') { ++at; return; }
        while (true) {
          value(depth + 1); space(); const separator = text[at++];
          if (separator === ']') return;
          if (separator !== ',') throw new Error('array');
        }
      }
      if (text[at] === '"') { string(); return; }
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
      if (!token) throw new Error('value');
      at += token[0].length;
      const parsed = JSON.parse(token[0]);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('number');
    };
    value(0); space(); if (at !== text.length) throw new Error('trailing');
    return JSON.parse(text);
  } catch { assert.fail(verdictReason('WORLDBOOK_FILE_JSON')); }
}

function rectangle(value, prefix) {
  const out = ['X','Y','Width','Height'].map(key => value[prefix + key]);
  guard(out.every(Number.isFinite) && out[2] > 1 && out[3] > 1, 'WORLDBOOK_FILE_INPUT_GEOMETRY');
  return out;
}
function inside(rect, x, y) { return x >= rect[0] && y >= rect[1] && x <= rect[0]+rect[2] && y <= rect[1]+rect[3]; }
function geometry(value, scope) {
  guard(object(value) && value.scope === scope &&
    ['ready','found','enabled','visible','bound','geometryValid','integerPointInsideClip','fullyVisible'].every(key => value[key] === true),
  'WORLDBOOK_FILE_INPUT_READY');
  const scene = rectangle(value,'scene'), clip = rectangle(value,'clip');
  guard(scene[0]+.5 >= clip[0] && scene[1]+.5 >= clip[1] &&
    scene[0]+scene[2]-.5 <= clip[0]+clip[2] && scene[1]+scene[3]-.5 <= clip[1]+clip[3] &&
    Number.isSafeInteger(value.pointX) && Number.isSafeInteger(value.pointY) &&
    inside(scene,value.pointX,value.pointY) && inside(clip,value.pointX,value.pointY) &&
    value.pointX === Math.round(scene[0]+scene[2]/2) && value.pointY === Math.round(scene[1]+scene[3]/2),
  'WORLDBOOK_FILE_INPUT_GEOMETRY');
}
function input(value, spec, observed) {
  guard(object(value), 'WORLDBOOK_FILE_INPUT_IDENTITY');
  equal([value.step,value.control,value.kind],spec,'WORLDBOOK_FILE_INPUT_IDENTITY');
  guard(value.scopeKey === observed.scopeKey && value.generation === observed.generation, 'WORLDBOOK_FILE_INPUT_SCOPE');
  guard(value.deadlineMs === 4000 && integer(value.elapsedMs) && value.elapsedMs < 4000 && integer(value.frame),
    'WORLDBOOK_FILE_INPUT_DEADLINE');
  const layout = value.layout, gate = value.gate;
  geometry(layout,observed.scopeKey);
  guard(layout.layoutStable === true && integer(layout.elapsedMs) && layout.elapsedMs <= value.elapsedMs &&
    integer(layout.stableSinceMs) && layout.elapsedMs-layout.stableSinceMs >= 40 &&
    integer(layout.stableFrameSerial) && integer(layout.frameSerial) && layout.frameSerial > layout.stableFrameSerial &&
    value.frame >= layout.frameSerial, 'WORLDBOOK_FILE_INPUT_STABILITY');
  guard(object(gate) && gate.performed === true && gate.sampleLimit === 6 && gate.pollIntervalMs === 40 &&
    integer(gate.polls) && gate.polls >= 1 && Array.isArray(gate.samples) && gate.samples.length >= 1 &&
    gate.samples.length <= 6 && gate.polls >= gate.samples.length && object(gate.last), 'WORLDBOOK_FILE_INPUT_GATE');
  geometry(gate.last,observed.scopeKey);
  guard(integer(gate.last.elapsedMs) && gate.last.elapsedMs >= layout.elapsedMs &&
    gate.last.elapsedMs <= value.elapsedMs, 'WORLDBOOK_FILE_INPUT_GATE');
  let previous = -1;
  for (const sample of gate.samples) {
    guard(object(sample) && integer(sample.elapsedMs) && sample.elapsedMs >= previous && sample.elapsedMs <= gate.last.elapsedMs,
      'WORLDBOOK_FILE_INPUT_GATE');
    previous = sample.elapsedMs;
  }
  for (const key of ['scope','pointX','pointY','sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'])
    equal(gate.last[key],layout[key],'WORLDBOOK_FILE_INPUT_GATE_GEOMETRY');
  guard(object(value.hit) && ['target','descendant'].includes(value.hit.hitResult) && value.hit.acceptorFound === true,
    'WORLDBOOK_FILE_INPUT_HIT');
  if (value.kind === 'path-handoff')
    equal([value.pathHandoffCount,value.mouseDispatchCount],[1,0],'WORLDBOOK_FILE_INPUT_COUNTS');
  else if (value.kind === 'text')
    equal([value.mouseDispatchCount,value.inputMethodCommitCount,value.textEditedSignals],[1,1,1],'WORLDBOOK_FILE_INPUT_COUNTS');
  else if (value.kind === 'selector') {
    guard(integer(value.selectedIndex) && value.selectedIndex > 0 && value.selectedIndex === observed.baselineBookCount,
      'WORLDBOOK_FILE_INPUT_COUNTS');
    equal([value.mouseDispatchCount,value.activatedSignals,value.keyDispatchCount],
      [1,1,value.selectedIndex+2],'WORLDBOOK_FILE_INPUT_COUNTS');
  } else equal([value.mouseDispatchCount,value.clickedSignals],[1,1],'WORLDBOOK_FILE_INPUT_COUNTS');
}

function cycle(report, index) {
  guard(object(report) && report.schema === 'reverie.native.worldbook-file.gui-evidence.v1' && report.passed === true &&
    report.error === '' && report.mode === ['import-edit-export','restart-readback'][index] && report.step === [11,22][index],
  'WORLDBOOK_FILE_CYCLE');
  guard(report.deadlineMs === [30000,15000][index] && integer(report.elapsedMs) && report.elapsedMs < report.deadlineMs &&
    report.pollIntervalMs === 40, 'WORLDBOOK_FILE_CYCLE_DEADLINE');
  guard(report.systemOpenDialogCovered === false && report.systemSaveDialogCovered === false && report.contentCollected === false &&
    report.inputMethodScope === 'synthetic QInputMethodEvent commit, not physical OS IME acceptance', 'WORLDBOOK_FILE_COVERAGE');
  guard(Array.isArray(report.checks), 'WORLDBOOK_FILE_CHECKS');
  equal(report.checks.map(check => [check.name,check.passed]),CHECKS[index].map(name => [name,true]),'WORLDBOOK_FILE_CHECKS');
  guard(![BODY,KEY,DISABLED_BODY].some(marker => JSON.stringify(report).includes(marker)), 'WORLDBOOK_FILE_CONTENT_LEAK');
  const observed = report.observed;
  guard(object(observed) && typeof observed.scopeKey === 'string' && /^builtin_hoshino_yumetsuki:[1-9][0-9]*:[0-9a-f]{64}$/.test(observed.scopeKey) &&
    integer(observed.generation) && observed.generation > 0 && integer(observed.baselineRevision) &&
    integer(observed.baselineBookCount) &&
    typeof observed.bookId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(observed.bookId), 'WORLDBOOK_FILE_SCOPE');
  guard(Array.isArray(observed.initialMessageIds) && observed.initialMessageIds.every(id) &&
    new Set(observed.initialMessageIds).size === observed.initialMessageIds.length && observed.messageIdsUnchanged === true,
  'WORLDBOOK_FILE_MESSAGES');
  equal(observed.finalMessageIds,observed.initialMessageIds,'WORLDBOOK_FILE_MESSAGES');
  guard(Array.isArray(report.inputs), 'WORLDBOOK_FILE_INPUT_SEQUENCE');
  const specs = index === 0 ? [[1,'nav-memory','button'],[2,'worldbookFileImport','path-handoff'],
    [4,'worldbookFileImportConfirm','button'],[6,'worldbookName','text'],[8,'saveWorldbook','button'],[10,'worldbookFileExport','path-handoff']] :
    [[1,'nav-memory','button'],[2,'reloadWorldbook','button'],...(report.inputs.length === 3 ? [[21,'worldbookBookSelector','selector']] : [])];
  equal(report.inputs.map(value => [value.step,value.control,value.kind]),specs,'WORLDBOOK_FILE_INPUT_SEQUENCE');
  report.inputs.forEach((value,number) => input(value,specs[number],observed));
  guard(Array.isArray(report.archiveReceipts) && report.archiveReceipts.length > 0, 'WORLDBOOK_FILE_ARCHIVE_RECEIPTS');
  const ids = new Set();
  for (const receipt of report.archiveReceipts) {
    guard(object(receipt) && id(receipt.requestId) && !ids.has(receipt.requestId), 'WORLDBOOK_FILE_RECEIPT_UNIQUE');
    ids.add(receipt.requestId);
    guard(receipt.scopeKey === observed.scopeKey && receipt.generation === observed.generation && receipt.ok === true &&
      ['archive:get','archive:put'].includes(receipt.command) && integer(receipt.revision), 'WORLDBOOK_FILE_RECEIPT_SCOPE');
    guard(receipt.revision >= observed.baselineRevision && receipt.revision <= observed.baselineRevision+(index === 0 ? 2 : 0),
      'WORLDBOOK_FILE_RECEIPT_REVISION');
  }
  equal(report.archiveReceipts.filter(receipt => receipt.command === 'archive:put').length,index === 0 ? 1 : 0,
    'WORLDBOOK_FILE_WRITE_COUNT');
  equal(observed.archivePutReceiptCount,index === 0 ? 1 : 0,'WORLDBOOK_FILE_WRITE_COUNT');
  return observed;
}

function matchingReceipt(report, snapshot, command, revision) {
  guard(object(snapshot) && snapshot.command === command && snapshot.revision === revision && snapshot.ok === true,
    'WORLDBOOK_FILE_CORRELATED_READBACK');
  const matches = report.archiveReceipts.filter(receipt => receipt.requestId === snapshot.requestId);
  guard(matches.length === 1, 'WORLDBOOK_FILE_CORRELATED_READBACK');
  for (const key of ['requestId','command','revision','ok','generation','scopeKey'])
    equal(snapshot[key],matches[0][key],'WORLDBOOK_FILE_CORRELATED_READBACK');
}

function expectedEntry(number) {
  return {enabled:number === 0, alwaysActive:false, position:number === 0 ? 'at_depth' : 'before_char',
    depth:number === 0 ? 2 : 0, role:number === 0 ? 'assistant' : 'system', insertionOrder:100, priority:0,
    selectiveLogic:'and_any', scanDepth:null, tokenBudget:null, caseSensitive:false, useRegex:false,
    contentSha256:hash(number === 0 ? BODY : DISABLED_BODY),
    keywordsSha256:hash(JSON.stringify(number === 0 ? [KEY] : ['/w9-file-gui-regex/','w9-file-gui-literal'])),
    secondaryKeywordsSha256:hash('[]')};
}
function configuration(value, bookId) {
  keys(value,['bookId','bookName','scanDepth','tokenBudget','recursiveScanning','entryCount','entries'],
    'WORLDBOOK_FILE_CONFIGURATION');
  guard(object(value) && value.bookId === bookId && value.bookName === SAVED_NAME && value.scanDepth === 50 &&
    value.tokenBudget === 500 && value.recursiveScanning === false && value.entryCount === 2 &&
    Array.isArray(value.entries) && value.entries.length === 2, 'WORLDBOOK_FILE_CONFIGURATION');
  const ids = value.entries.map(entry => entry.id);
  guard(ids.every(item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item)) &&
    new Set(ids).size === 2 && !ids.includes(bookId), 'WORLDBOOK_FILE_CONFIGURATION');
  value.entries.forEach((entry,number) => equal(entry,{id:ids[number],...expectedEntry(number)},'WORLDBOOK_FILE_CONFIGURATION'));
}

function verifyWorldbookFile(first, second, {sourceBytes,exportBytes} = {}) {
  const a = cycle(first,0), b = cycle(second,1);
  const source = strictJson(sourceBytes), exported = strictJson(exportBytes);
  equal(source,{name:BOOK_NAME,entries:{
    '0':{key:[KEY],content:BODY+'\u200b',comment:'文件导入条目',probability:60,position:4,depth:2,role:2},
    '1':{key:['/w9-file-gui-regex/','w9-file-gui-literal'],content:DISABLED_BODY,comment:'混合正则停用条目'},
    '2':{key:['empty'],content:''},
  }},'WORLDBOOK_FILE_SOURCE_DOCUMENT');
  equal(a.source,{file_name:SOURCE_FILE,file_bytes:sourceBytes.length,sha256:hash(sourceBytes)},'WORLDBOOK_FILE_SOURCE_BINDING');
  const operations = ['inspect','import','export'];
  keys(a.fileControlRequestIds,operations,'WORLDBOOK_FILE_CONTROL_COUNT');
  for (const operation of operations) {
    const state = a[operation];
    guard(object(state) && id(state.requestId) && state.operation === operation && state.scopeKey === a.scopeKey &&
      state.generation === a.generation && state.archiveRevision === a.baselineRevision+(operation === 'export' ? 2 : 0) &&
      state.status === (operation === 'inspect' ? 'confirmation' : 'success'), 'WORLDBOOK_FILE_CONTROL_SCOPE');
    equal(a.fileControlRequestIds?.[operation],[state.requestId],'WORLDBOOK_FILE_CONTROL_COUNT');
  }
  const controls = operations.map(operation => a[operation].requestId);
  guard(new Set(controls).size === 3 && !controls.some(value => first.archiveReceipts.some(receipt => receipt.requestId === value)),
    'WORLDBOOK_FILE_CONTROL_COUNT');
  const inspect = a.inspect, imported = a.import, output = a.export;
  equal([inspect.book_name,inspect.importable_entry_count,inspect.skipped,inspect.dropped_fields,
    inspect.disabled_regex_entry_count,inspect.cleaned_entry_count,inspect.sha256,inspect.file_bytes],
  [BOOK_NAME,2,{empty:1},{probability:1},1,1,hash(sourceBytes),sourceBytes.length],'WORLDBOOK_FILE_INSPECTION');
  const summary = a.confirmation;
  guard(object(summary) && summary.plainText === true && summary.visible === true && summary.noBodyOrKeywords === true &&
    typeof summary.summaryText === 'string' && [BOOK_NAME,'将导入 2 条','跳过 1 条','probability','1 条正则已关闭','1 条文字被清理']
      .every(text => summary.summaryText.includes(text)), 'WORLDBOOK_FILE_CONFIRMATION');
  equal([imported.world_book_id,imported.book_name,imported.imported_entry_count,imported.revision,imported.readbackRevision,
    imported.selectedWorldBookId,imported.sha256,imported.file_bytes],
  [a.bookId,BOOK_NAME,2,a.baselineRevision+1,a.baselineRevision+1,a.bookId,hash(sourceBytes),sourceBytes.length],
  'WORLDBOOK_FILE_IMPORT_READBACK');
  matchingReceipt(first,a.importRead,'archive:get',a.baselineRevision+1);
  equal(first.archiveReceipts.filter(receipt => receipt.command === 'archive:get' && receipt.revision === a.baselineRevision+1).length,
    1,'WORLDBOOK_FILE_IMPORT_READBACK');
  equal(a.nameEdit,{field:'name',before:BOOK_NAME,after:SAVED_NAME,dirty:true,importEnabled:false,exportEnabled:false},
    'WORLDBOOK_FILE_DIRTY_GATE');
  const save = a.save;
  matchingReceipt(first,save,'archive:put',a.baselineRevision+2);
  equal([save.expectedRevision,save.dirtyBefore,save.dirtyAfter,save.bookId,save.bookName,save.changedFields],
    [a.baselineRevision+1,true,false,a.bookId,SAVED_NAME,['name']],'WORLDBOOK_FILE_SAVE');
  equal([output.world_book_id,output.book_name,output.entry_count,output.file_name,output.bytes,output.sha256],
    [a.bookId,SAVED_NAME,2,EXPORT_FILE,exportBytes.length,hash(exportBytes)],'WORLDBOOK_FILE_EXPORT_BINDING');
  guard(digest(a.restHashBefore) && a.restHashBefore === a.restHashAfter && digest(a.finalArchiveHash),
    'WORLDBOOK_FILE_UNRELATED_ARCHIVE');
  equal(a.finalRevision,a.baselineRevision+2,'WORLDBOOK_FILE_REVISION_CHAIN');
  configuration(a.final,a.bookId);
  equal(b.scopeKey,a.scopeKey,'WORLDBOOK_FILE_RESTART_SCOPE');
  equal([b.baselineRevision,b.finalRevision],[a.finalRevision,a.finalRevision],'WORLDBOOK_FILE_REVISION_CHAIN');
  equal(b.baselineBookCount,a.baselineBookCount+1,'WORLDBOOK_FILE_RESTART_CONFIGURATION');
  equal([b.bookId,b.final],[a.bookId,a.final],'WORLDBOOK_FILE_RESTART_CONFIGURATION');
  equal([b.archiveHashBefore,b.archiveHashAfter],[a.finalArchiveHash,a.finalArchiveHash],'WORLDBOOK_FILE_RESTART_ARCHIVE');
  equal(b.initialMessageIds,a.finalMessageIds,'WORLDBOOK_FILE_MESSAGES');
  equal(b.fileControlRequestIds,{inspect:[],import:[],export:[]},'WORLDBOOK_FILE_RESTART_WRITES');
  matchingReceipt(second,b.restartRead,'archive:get',a.finalRevision);
  guard(!second.archiveReceipts.some(receipt => first.archiveReceipts.some(old => old.requestId === receipt.requestId)),
    'WORLDBOOK_FILE_RESTART_FRESH_READ');
  keys(exported,['name','entries','extensions'],'WORLDBOOK_FILE_EXPORT_DOCUMENT');
  equal(exported.name,SAVED_NAME,'WORLDBOOK_FILE_EXPORT_DOCUMENT');
  equal(exported.extensions,{reverie:{scanDepth:50,tokenBudget:500,recursiveScanning:false}},'WORLDBOOK_FILE_EXPORT_DOCUMENT');
  keys(exported.entries,['0','1'],'WORLDBOOK_FILE_EXPORT_DOCUMENT');
  for (const number of [0,1]) equal(exported.entries[String(number)],{
    ...DEFAULTS,uid:number,key:number === 0 ? [KEY] : ['/w9-file-gui-regex/','w9-file-gui-literal'],keysecondary:[],
    comment:number === 0 ? '文件导入条目' : '混合正则停用条目',content:number === 0 ? BODY : DISABLED_BODY,
    constant:false,selective:true,selectiveLogic:0,order:100,position:number === 0 ? 4 : 0,disable:number === 1,
    depth:number === 0 ? 2 : 0,scanDepth:null,caseSensitive:false,role:number === 0 ? 2 : 0,priority:0,
    extensions:{reverie:{tokenBudget:null,useRegex:false}},
  },'WORLDBOOK_FILE_EXPORT_DOCUMENT');
  return {passed:true,contract:WORLDBOOK_FILE_CONTRACT,checks:[6,3],fileControls:[3,0],archiveSaves:[1,0],
    scopeKey:a.scopeKey,bookId:a.bookId,entryIds:a.final.entries.map(entry => entry.id),
    revisions:[a.baselineRevision,a.baselineRevision+1,a.finalRevision,b.finalRevision],
    source:{file_name:SOURCE_FILE,bytes:sourceBytes.length,sha256:hash(sourceBytes)},
    export:{file_name:EXPORT_FILE,bytes:exportBytes.length,sha256:hash(exportBytes)},
    archiveSha256:a.finalArchiveHash,contentCollected:false,systemDialogsCovered:false};
}

function readWorldbookFile(filename) {
  const before = fs.lstatSync(filename);
  guard(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= MAX_BYTES,
    'WORLDBOOK_FILE_REGULAR_FILE');
  const fd = fs.openSync(filename,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    guard(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino &&
      opened.size === before.size, 'WORLDBOOK_FILE_REGULAR_FILE');
    const bounded = Buffer.alloc(MAX_BYTES+1); let length = 0;
    while (length < bounded.length) {
      const count = fs.readSync(fd,bounded,length,bounded.length-length,null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(filename);
    guard(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      named.dev === opened.dev && named.ino === opened.ino && named.nlink === 1,'WORLDBOOK_FILE_READ_CHANGED');
    return bounded.subarray(0,length);
  } finally { fs.closeSync(fd); }
}
function captureWorldbookFile(reports,dataDirectory,reportDirectory) {
  guard(Array.isArray(reports) && reports.length === 2,'WORLDBOOK_FILE_TWO_CYCLES');
  const sourceBytes = readWorldbookFile(path.join(dataDirectory,SOURCE_FILE));
  const exportBytes = readWorldbookFile(path.join(dataDirectory,EXPORT_FILE));
  const proof = verifyWorldbookFile(reports[0].worldbookFile,reports[1].worldbookFile,{sourceBytes,exportBytes});
  const artifacts = [];
  for (const [name,bytes] of [['worldbook-file-source.json',sourceBytes],['worldbook-file-export.json',exportBytes]]) {
    const filename = path.join(reportDirectory,name);
    fs.writeFileSync(filename,bytes,{flag:'wx',mode:0o600});
    guard(hash(readWorldbookFile(filename)) === hash(bytes),'WORLDBOOK_FILE_ARTIFACT_CHANGED');
    artifacts.push({path:name,bytes:bytes.length,sha256:hash(bytes)});
  }
  const result = {...proof,artifacts};
  fs.writeFileSync(path.join(reportDirectory,'worldbook-file-proof.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  return result;
}
module.exports = {WORLDBOOK_FILE_CONTRACT,SOURCE_FILE,EXPORT_FILE,verifyWorldbookFile,captureWorldbookFile,readWorldbookFile};
