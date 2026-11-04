'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CARD_EXPORT_CONTRACT = 'v1';
const CARD_EXPORT_FILE = 'p1-card-export.json';
const CARD_EXPORT_ARTIFACT = 'card-export.json';
const MAX_CARD_BYTES = 2 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isInteger(value) && value >= 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const safeInteger = value => typeof value === 'number' && Number.isSafeInteger(value);
const optionalInteger = value => value === null || safeInteger(value);
function parseCardJson(text) {
  // JSON.parse alone silently drops earlier duplicate fields, which could hide
  // prohibited material in an otherwise matching synthetic output.
  let at = 0;
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) ++at; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === '\\') { ++at; continue; }
      if (character === '"') return JSON.parse(text.slice(start, at));
    }
    assert.fail('CARD_EXPORT_INVALID_JSON_STRING');
  };
  const value = depth => {
    assert(depth <= 32, 'CARD_EXPORT_JSON_DEPTH'); space();
    if (text[at] === '{') {
      ++at; space(); const seen = new Set();
      if (text[at] === '}') { ++at; return; }
      while (true) {
        space(); assert.equal(text[at], '"', 'CARD_EXPORT_INVALID_JSON_OBJECT');
        const key = string(); assert(!seen.has(key), 'CARD_EXPORT_DUPLICATE_JSON_KEY'); seen.add(key);
        space(); assert.equal(text[at++], ':', 'CARD_EXPORT_INVALID_JSON_OBJECT'); value(depth + 1); space();
        const separator = text[at++]; if (separator === '}') return;
        assert.equal(separator, ',', 'CARD_EXPORT_INVALID_JSON_OBJECT');
      }
    }
    if (text[at] === '[') {
      ++at; space(); if (text[at] === ']') { ++at; return; }
      while (true) { value(depth + 1); space(); const separator = text[at++];
        if (separator === ']') return; assert.equal(separator, ',', 'CARD_EXPORT_INVALID_JSON_ARRAY'); }
    }
    if (text[at] === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    assert(token, 'CARD_EXPORT_INVALID_JSON_VALUE'); at += token[0].length;
    const parsed = JSON.parse(token[0]);
    assert(typeof parsed !== 'number' || Number.isFinite(parsed), 'CARD_EXPORT_NONFINITE_JSON');
  };
  value(0); space(); assert.equal(at, text.length, 'CARD_EXPORT_TRAILING_JSON');
  return JSON.parse(text);
}
function keys(value, expected, reason) {
  assert(object(value), reason);
  assert.deepEqual(Object.keys(value).sort(), expected.slice().sort(), reason);
}
function whole(value, reason) {
  assert(value?.found === true && value.visible === true && value.fullyVisible === true, reason);
  assert(['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight']
    .every(key => Number.isFinite(value[key])), reason);
  assert(value.sceneWidth > 1 && value.sceneHeight > 1 && value.clipWidth > 0 && value.clipHeight > 0 &&
    value.sceneX + .5 >= value.clipX && value.sceneY + .5 >= value.clipY &&
    value.sceneX + value.sceneWidth - .5 <= value.clipX + value.clipWidth &&
    value.sceneY + value.sceneHeight - .5 <= value.clipY + value.clipHeight, reason);
}
function input(value, control) {
  assert.equal(value?.control, control, 'CARD_EXPORT_INPUT_IDENTITY');
  assert.equal(value.deadlineMs, 4000, 'CARD_EXPORT_INPUT_DEADLINE');
  const layout = value.layout, gate = value.gate;
  assert(layout?.ready === true && layout.layoutStable === true && layout.enabled === true &&
    layout.visible === true && layout.found === true && layout.fullyVisible === true && layout.integerPointInsideClip === true,
    'CARD_EXPORT_INPUT_NOT_READY');
  assert(integer(layout.elapsedMs) && layout.elapsedMs < 4000 && integer(layout.stableSinceMs) &&
    layout.elapsedMs - layout.stableSinceMs >= 40 && integer(layout.stableFrameSerial) &&
    integer(layout.frameSerial) && layout.frameSerial > layout.stableFrameSerial, 'CARD_EXPORT_INPUT_STABILITY');
  assert(gate?.performed === true && gate.sampleLimit === 6 && gate.pollIntervalMs === 40 && gate.last?.ready === true &&
    integer(gate.last.elapsedMs) && gate.last.elapsedMs < 4000, 'CARD_EXPORT_INPUT_GATE');
}

function verifyCardExport(reports, bytes) {
  assert(Array.isArray(reports) && reports.length === 2, 'CARD_EXPORT_TWO_CYCLES');
  const evidence = reports[0].archiveInteraction?.cardExport;
  assert.equal(reports[1].personaRestart?.cardExport, undefined, 'CARD_EXPORT_RESTART_ADDITION');
  assert(evidence?.schema === 'reverie.native.card-export.gui-evidence.v1' && evidence.passed === true &&
    evidence.importBaselineUnchanged === true && evidence.systemSaveDialogCovered === false &&
    evidence.saveDialogConfirmCovered === false, 'CARD_EXPORT_EVIDENCE_MISSING');
  const exported = evidence.export, receipt = evidence.receipt;
  assert(object(exported) && typeof exported.personaId === 'string' && exported.personaId.startsWith('st_') &&
    exported.scope?.startsWith(exported.personaId + ':') && integer(exported.generation) &&
    integer(exported.archiveRevision) && exported.expectedName === '测试人格·月' &&
    exported.expectedEntryCount === 1 && exported.entryClickCount === 1 && exported.bridgeHandoffCount === 1 &&
    exported.defaultBookSelected === true && exported.savedNoticeVisible === true &&
    typeof exported.bookId === 'string' && exported.bookId.length > 0 &&
    exported.selectedBookId === exported.bookId && exported.bookName === '测试人格·月的世界书',
    'CARD_EXPORT_DEFAULT_SELECTION');
  assert.equal(reports[0].archiveInteraction.cardImport?.moonPersona, exported.personaId, 'CARD_EXPORT_PERSONA_BINDING');
  keys(receipt, ['status','requestId','file_name','bytes','sha256','world_book_id','world_book_name','entry_count','persona_id'],
    'CARD_EXPORT_RECEIPT_FIELDS');
  assert(receipt.status === 'success' && typeof receipt.requestId === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(receipt.requestId) && receipt.file_name === CARD_EXPORT_FILE &&
    receipt.persona_id === exported.personaId && receipt.world_book_id === exported.bookId &&
    receipt.world_book_name === exported.bookName && receipt.entry_count === 1, 'CARD_EXPORT_RECEIPT_BINDING');
  const importIds = ['requestId','duplicateRequestId','flaggedRequestId'].map(key => reports[0].archiveInteraction.cardImport?.[key]);
  assert(!importIds.includes(receipt.requestId), 'CARD_EXPORT_REUSED_IMPORT_ACK');
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_CARD_BYTES &&
    receipt.bytes === bytes.length && receipt.sha256 === hash(bytes), 'CARD_EXPORT_ACTUAL_FILE_HASH');
  const text = bytes.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(bytes) && text.endsWith('\n'), 'CARD_EXPORT_UTF8_OR_NEWLINE');
  const card = parseCardJson(text);
  keys(card, ['spec','spec_version','data'], 'CARD_EXPORT_FORBIDDEN_TOP_FIELD');
  assert(card.spec === 'chara_card_v2' && card.spec_version === '2.0', 'CARD_EXPORT_NOT_V2');
  const data = card.data;
  keys(data, ['name','description','personality','scenario','first_mes','mes_example','alternate_greetings',
    'system_prompt','post_history_instructions','creator','character_version','creator_notes','tags','extensions','character_book'],
    'CARD_EXPORT_FORBIDDEN_DATA_FIELD');
  assert(['name','description','personality','scenario','first_mes','mes_example','system_prompt',
    'post_history_instructions','creator','character_version','creator_notes']
    .every(key => typeof data[key] === 'string'), 'CARD_EXPORT_DATA_VALUE_SHAPE');
  assert(strings(data.alternate_greetings) && strings(data.tags), 'CARD_EXPORT_DATA_LIST_SHAPE');
  assert(data.name === exported.expectedName && data.personality === '' && data.scenario === '' &&
    data.system_prompt === '以安静简洁的语气回应。' && data.post_history_instructions === '每次回复以一句晚安收尾。',
    'CARD_EXPORT_FIXTURE_CARD_FIELDS');
  keys(data.extensions, [], 'CARD_EXPORT_FORBIDDEN_EXTENSION');
  const book = data.character_book;
  keys(book, ['name','description','scan_depth','token_budget','recursive_scanning','extensions','entries'],
    'CARD_EXPORT_FORBIDDEN_BOOK_FIELD');
  assert(typeof book.name === 'string' && typeof book.description === 'string' &&
    safeInteger(book.scan_depth) && safeInteger(book.token_budget) &&
    typeof book.recursive_scanning === 'boolean' && Array.isArray(book.entries), 'CARD_EXPORT_BOOK_VALUE_SHAPE');
  assert(book.name === exported.bookName && Array.isArray(book.entries) && book.entries.length === 1,
    'CARD_EXPORT_BOOK_OR_ENTRY_COUNT');
  keys(book.extensions, [], 'CARD_EXPORT_FORBIDDEN_BOOK_EXTENSION');
  const entry = book.entries[0];
  keys(entry, ['keys','secondary_keys','content','enabled','insertion_order','priority','case_sensitive','comment','constant',
    'selective','id','depth','role','scan_depth','token_budget','use_regex','position','extensions'], 'CARD_EXPORT_FORBIDDEN_ENTRY_FIELD');
  assert(strings(entry.keys) && strings(entry.secondary_keys) && typeof entry.content === 'string' &&
    typeof entry.comment === 'string' && ['enabled','case_sensitive','constant','selective','use_regex']
      .every(key => typeof entry[key] === 'boolean') &&
    ['insertion_order','priority','id','depth'].every(key => safeInteger(entry[key])) &&
    optionalInteger(entry.scan_depth) && optionalInteger(entry.token_budget), 'CARD_EXPORT_ENTRY_VALUE_SHAPE');
  assert(['system','user','assistant'].includes(entry.role) && ['before_char','after_char'].includes(entry.position),
    'CARD_EXPORT_ENTRY_ENUM');
  assert(entry.content === '隔离观景室中的月光落在窗边。' && entry.id === 1 && entry.position === 'before_char',
    'CARD_EXPORT_FIXTURE_ENTRY');
  assert.deepEqual(entry.keys, ['月光'], 'CARD_EXPORT_FIXTURE_KEYS');
  keys(entry.extensions, ['reverie'], 'CARD_EXPORT_FORBIDDEN_ENTRY_EXTENSION');
  keys(entry.extensions.reverie, ['id'], 'CARD_EXPORT_FORBIDDEN_REVERIE_EXTENSION');
  assert(typeof entry.extensions.reverie.id === 'string' && entry.extensions.reverie.id.length > 0,
    'CARD_EXPORT_ORIGINAL_ENTRY_ID');
  assert(Array.isArray(evidence.inputs) && evidence.inputs.length === 2, 'CARD_EXPORT_INPUT_COUNT');
  evidence.inputs.forEach((value, index) => input(value, ['personaCardExport','personaCardExportBook'][index]));
  const builtin = evidence.builtin;
  assert(builtin?.activeId === 'default' && builtin.buttonDisabled === true && builtin.noticeVisible === true &&
    builtin.dispatchCount === 0, 'CARD_EXPORT_BUILTIN_GATE');
  whole(builtin.button, 'CARD_EXPORT_BUILTIN_BUTTON_CLIPPED');
  whole(builtin.notice, 'CARD_EXPORT_BUILTIN_NOTICE_CLIPPED');
  return {schema:'reverie.native.card-export.host-proof.v1', passed:true, contract:CARD_EXPORT_CONTRACT,
    checks:2, cycleChecks:[2,0], fileName:CARD_EXPORT_FILE, bytes:bytes.length, sha256:hash(bytes),
    personaId:exported.personaId, worldBookId:exported.bookId, worldBookName:book.name, entryCount:1,
    defaultBookSelected:true, builtinDisabled:true, systemSaveDialogCovered:false, saveDialogConfirmCovered:false};
}

function readCardFile(filename) {
  const before = fs.lstatSync(filename);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 &&
    before.size <= MAX_CARD_BYTES, 'CARD_EXPORT_FILE_NOT_PRIVATE_REGULAR');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assert(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1 &&
      opened.size === before.size, 'CARD_EXPORT_FILE_IDENTITY_CHANGED');
    const bounded = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bounded.length) {
      const received = fs.readSync(fd, bounded, length, bounded.length - length, null);
      if (received === 0) break;
      length += received;
    }
    const bytes = bounded.subarray(0, length), after = fs.fstatSync(fd), named = fs.lstatSync(filename);
    assert(bytes.length === opened.size && after.dev === opened.dev && after.ino === opened.ino && after.size === bytes.length &&
      after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      named.dev === opened.dev && named.ino === opened.ino && named.nlink === 1,
      'CARD_EXPORT_FILE_CHANGED_DURING_READ');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function captureCardExport(result, dataDirectory, reportDirectory) {
  const bytes = readCardFile(path.join(dataDirectory, CARD_EXPORT_FILE));
  const proof = verifyCardExport(result.reports, bytes);
  fs.writeFileSync(path.join(reportDirectory, CARD_EXPORT_ARTIFACT), bytes, {flag:'wx', mode:0o600});
  assert.equal(hash(readCardFile(path.join(reportDirectory, CARD_EXPORT_ARTIFACT))), proof.sha256,
    'CARD_EXPORT_ARTIFACT_COPY_CHANGED');
  return {...proof, artifact:{path:CARD_EXPORT_ARTIFACT, bytes:bytes.length, sha256:hash(bytes)}};
}
function verifySavedCardExport(result, reportDirectory) {
  assert.equal(result.cardExportContract, CARD_EXPORT_CONTRACT, 'CARD_EXPORT_RESULT_CONTRACT_CHANGED');
  const bytes = readCardFile(path.join(reportDirectory, CARD_EXPORT_ARTIFACT));
  const proof = {...verifyCardExport(result.reports, bytes),
    artifact:{path:CARD_EXPORT_ARTIFACT, bytes:bytes.length, sha256:hash(bytes)}};
  assert.deepEqual(result.cardExportEvidence, proof, 'CARD_EXPORT_SAVED_PROOF_CHANGED');
  return proof;
}
module.exports = {CARD_EXPORT_CONTRACT, CARD_EXPORT_FILE, CARD_EXPORT_ARTIFACT, verifyCardExport,
  captureCardExport, verifySavedCardExport, readCardFile};
