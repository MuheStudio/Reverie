'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { KEEPSAKE_CONTRACT, verifyKeepsake } = require('./keepsake-verdicts.cjs');

const epoch = 1794700000000;
const scope = `builtin_hoshino_yumetsuki:1:${'a'.repeat(64)}`;
const originalTime = '2026-11-14T15:30:00+00:00';
const text = '合成收藏消息';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const selected = () => ({messageId: 'user-message', role: 'user', originalTime,
  contentSha256: digest(text), characters: [...text].length});
const entry = () => ({id: 'keepsake-record', ...selected(), contentOffset: 0,
  contentNextOffset: null, contentTotalChars: [...text].length});
const messages = () => [{id: 'user-message', role: 'user', content: text, created_at_utc: originalTime},
  {id: 'assistant-message', role: 'assistant', content: '合成回复', created_at_utc: originalTime}];
const history = () => messages().map(row => ({id: row.id, role: row.role,
  contentSha256: digest(row.content), originalTime: row.created_at_utc}));
const input = (control, atMs) => ({control, atMs, mouseDispatchCount: 1, clickedSignals: 1, hitAccepted: true});
const rect = (height, x = 0, y = 0) => ({x, y, width: 350, height, sceneX: x + 50, sceneY: y + 100});
const row = (atMs, saved) => ({atMs, label: saved ? '已收藏' : '收藏', enabled: !saved,
  contentSha256: digest(text), row: rect(54), box: rect(40), text: rect(18, 12, 11)});

function report(cycle) {
  const first = cycle === 1;
  const base = (index, command, atMs) => ({id: `qt_${String(cycle * 10 + index).padStart(32, '0')}`,
    command, atMs, scope, generation: cycle});
  const collect = base(1, 'keepsake:collect', 300);
  const page = base(2, 'keepsake:page', first ? 700 : 500);
  const remove = base(3, 'keepsake:remove', 900);
  const elapsedMs = first ? 900 : 1300;
  const tailStartEpochMs = epoch + cycle * 10000;
  return {cycle: String(cycle), messages: messages(), chatImage: {passed: true, tailEndEpochMs: tailStartEpochMs - 100,
    scopeAfter: scope, generationAfter: cycle}, keepsake: {
    passed: true, error: '', cycle, deadlineMs: 20000, elapsedMs, tailStartEpochMs, tailEndEpochMs: tailStartEpochMs + elapsedMs,
    scopeBefore: scope, scopeAfter: scope, generationBefore: cycle, generationAfter: cycle,
    inputs: first ? [input('nav-reading', 100), input('keepsakeMessage-user-message', 300),
      input('scene-navigation-search', 500), input('search-result-keepsake-list', 700)] :
      [input('nav-reading', 100), input('scene-navigation-search', 300), input('search-result-keepsake-list', 500),
        input('keepsakeRemove-keepsake-record', 700), input('keepsakeRemoveConfirm', 900), input('nav-reading', 1100)],
    searchAtMs: first ? 600 : 400,
    commands: first ? [{...collect, fields: {message_id: 'user-message'}}, {...page, fields: {offset: 0}}] :
      [{...page, fields: {offset: 0}}, {...remove, fields: {keepsake_id: 'keepsake-record'}}],
    receipts: first ? [{...collect, atMs: 350, ok: true, operation: 'collect', item: entry(), created: true},
      {...page, atMs: 750, ok: true, operation: 'page', mode: 'list', items: [entry()], total: 1, hasMore: false}] :
      [{...page, atMs: 550, ok: true, operation: 'page', mode: 'list', items: [entry()], total: 1, hasMore: false},
        {...remove, atMs: 950, ok: true, operation: 'remove', keepsakeId: 'keepsake-record', messageId: 'user-message', removed: true}],
    chatSendDispatches: 0, historyBefore: history(), historyAfter: history(), keepsakeFilesBefore: 0, keepsakeFilesAfter: 0,
    selected: selected(), rowBefore: row(250, !first), rowAfter: row(first ? 450 : 1200, first),
    listView: {atMs: first ? 800 : 600, count: 1, item: entry(), displayedContentSha256: digest(text), removeEnabled: true},
    emptyView: first ? {} : {atMs: 1000, count: 0, visible: true},
    removalDialog: first ? {} : {atMs: 800, cancelLabel: '取消', confirmLabel: '移除', warning: '移除后不能恢复', visible: true},
    lastObservation: {phase: first ? 7 : 12, phaseElapsedMs: 40, viewportWidth: 1200, viewportHeight: 800, frame: 20},
  }};
}

function fixture() {
  return {reports: [report(1), report(2)], requests: 9,
    modelCallTiming: Array.from({length: 9}, (_, index) => ({cycle: index === 8 ? 2 : 1,
      receivedEpochMs: epoch + (index === 8 ? 15000 : index * 100)}))};
}

const verify = value => verifyKeepsake(value.reports, value.modelCallTiming, value.requests);
function unicodeFixture() {
  const value = fixture();
  const content = text + '🌠';
  const contentSha256 = digest(content);
  const characters = [...content].length;
  for (const report of value.reports) {
    const tail = report.keepsake;
    report.messages[0].content = content;
    tail.historyBefore[0].contentSha256 = contentSha256;
    tail.historyAfter[0].contentSha256 = contentSha256;
    Object.assign(tail.selected, {contentSha256, characters});
    Object.assign(tail.listView.item, {contentSha256, characters, contentTotalChars: characters});
    tail.listView.displayedContentSha256 = contentSha256;
    tail.rowBefore.contentSha256 = contentSha256;
    tail.rowAfter.contentSha256 = contentSha256;
    for (const receipt of tail.receipts) {
      if (receipt.item) Object.assign(receipt.item, {contentSha256, characters, contentTotalChars: characters});
      for (const item of receipt.items || []) Object.assign(item, {contentSha256, characters, contentTotalChars: characters});
    }
  }
  return value;
}
function rejects(id, reason, mutate, cycle = 1) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate,
    expectedReason: `KEEPSAKE_${reason}`, expectedContext: cycle ? {cycle} : {}});
}

test('keepsake verdict binds collection, restart, removal and unchanged history', () => {
  const proof = verify(fixture());
  assert.equal(proof.contract, KEEPSAKE_CONTRACT);
  assert.equal(proof.passed, true);
  assert.equal(proof.contentCollected, false);
  assert.deepEqual(proof.cycles.map(value => [value.userInputs, value.finalListCount]), [[4, 1], [6, 0]]);
});

test('keepsake counts a non-BMP character as one Unicode code point', () => {
  assert.equal(verify(unicodeFixture()).passed, true);
});

test('keepsake rejects a UTF-16 count substituted for the Unicode code-point count', () => {
  assertRejectedMutation({id: 'utf16-count', makeFixture: unicodeFixture, verify,
    mutate: value => value.reports[0].keepsake.selected.characters++,
    expectedReason: 'KEEPSAKE_SELECTED_HISTORY_BINDING', expectedContext: {cycle: 1}});
});

test('keepsake rejects a missing restart cycle', () => {
  rejects('missing-cycle', 'CYCLES', value => value.reports.pop(), 0);
});

test('keepsake rejects an unsuccessful native tail', () => {
  rejects('failed-tail', 'CYCLE', value => value.reports[0].keepsake.passed = false);
});

test('keepsake rejects a report containing plaintext content', () => {
  rejects('extra-body', 'REPORT_FIELDS', value => value.reports[0].keepsake.body = text);
});

test('keepsake rejects extending the independent deadline', () => {
  rejects('deadline-change', 'DEADLINE', value => value.reports[0].keepsake.deadlineMs++);
});

test('keepsake rejects a changed persona scope', () => {
  rejects('scope-change', 'SCOPE', value => value.reports[0].keepsake.scopeAfter += '-changed');
});

test('keepsake rejects starting before the picture tail completes', () => {
  rejects('before-w18', 'AFTER_W18', value => value.reports[0].chatImage.tailEndEpochMs += 200);
});

test('keepsake rejects sending a chat during the tail', () => {
  rejects('chat-send', 'SEND_DISPATCH', value => value.reports[0].keepsake.chatSendDispatches = 1);
});

test('keepsake rejects a plaintext keepsakes file in isolation', () => {
  rejects('plaintext-file', 'PLAINTEXT_FILE', value => value.reports[0].keepsake.keepsakeFilesAfter = 1);
});

test('keepsake rejects a changed history message identity', () => {
  rejects('history-id', 'HISTORY', value => value.reports[0].keepsake.historyAfter[0].id = 'other');
});

test('keepsake rejects a changed message body in the final report', () => {
  rejects('report-body', 'REPORT_HISTORY', value => value.reports[0].messages[0].content += '!');
});

test('keepsake rejects a selected message outside the history', () => {
  rejects('selected-id', 'SELECTED_HISTORY_BINDING', value => value.reports[0].keepsake.selected.messageId = 'other');
});

test('keepsake rejects a message row whose height changed', () => {
  rejects('row-height', 'ROW_GEOMETRY_CHANGED', value => value.reports[0].keepsake.rowAfter.row.height++);
});

test('keepsake rejects a message bubble whose size changed', () => {
  rejects('box-width', 'ROW_GEOMETRY_CHANGED', value => value.reports[0].keepsake.rowAfter.box.width++);
});

test('keepsake rejects a moved message text', () => {
  rejects('text-position', 'ROW_GEOMETRY_CHANGED', value => value.reports[0].keepsake.rowAfter.text.sceneY++);
});

test('keepsake rejects an enabled already-collected button', () => {
  rejects('saved-enabled', 'BUTTON_STATE', value => value.reports[0].keepsake.rowAfter.enabled = true);
});

test('keepsake rejects a list displaying different text', () => {
  rejects('list-text', 'LIST_VIEW', value => value.reports[0].keepsake.listView.displayedContentSha256 = 'b'.repeat(64));
});

test('keepsake rejects a click lacking a real clicked signal', () => {
  rejects('missing-clicked', 'INPUTS', value => value.reports[0].keepsake.inputs[1].clickedSignals = 0);
});

test('keepsake rejects a repeated mouse input', () => {
  rejects('repeated-mouse', 'INPUTS', value => value.reports[1].keepsake.inputs[4].mouseDispatchCount = 2, 2);
});

test('keepsake rejects an unexpected command', () => {
  rejects('unexpected-command', 'COMMANDS', value => value.reports[0].keepsake.commands[0].command = 'chat:send');
});

test('keepsake rejects a receipt from an old connection', () => {
  rejects('old-receipt', 'RECEIPT_BINDING', value => value.reports[0].keepsake.receipts[0].generation++);
});

test('keepsake rejects collecting a different message', () => {
  rejects('collect-id', 'COLLECT_RECEIPT', value => value.reports[0].keepsake.commands[0].fields.message_id = 'other');
});

test('keepsake rejects accepting an already-existing record as a new collection', () => {
  rejects('duplicate-collect', 'COLLECT_RECEIPT', value => value.reports[0].keepsake.receipts[0].created = false);
});

test('keepsake rejects a page receipt with altered content', () => {
  rejects('page-text', 'PAGE_RECEIPT', value => value.reports[0].keepsake.receipts[1].items[0].contentSha256 = 'b'.repeat(64));
});

test('keepsake rejects removing a different record', () => {
  rejects('remove-id', 'REMOVE_RECEIPT', value => value.reports[1].keepsake.receipts[1].keepsakeId = 'other', 2);
});

test('keepsake rejects a missing destructive-action warning', () => {
  rejects('missing-warning', 'REMOVAL_DISPLAY', value => value.reports[1].keepsake.removalDialog.warning = '', 2);
});

test('keepsake rejects removal dispatched before confirmation', () => {
  rejects('early-remove', 'EVENT_ORDER', value => value.reports[1].keepsake.commands[1].atMs = 850, 2);
});

test('keepsake rejects a missing final observation', () => {
  rejects('observation', 'LAST_OBSERVATION', value => value.reports[0].keepsake.lastObservation = {});
});

test('keepsake rejects a different persisted record after restart', () => {
  rejects('restart-record', 'RESTART_PERSISTENCE', value => {
    const tail = value.reports[1].keepsake;
    tail.listView.item.id = 'other-record';
    tail.inputs[3].control = 'keepsakeRemove-other-record';
    tail.commands[1].fields.keepsake_id = 'other-record';
    tail.receipts[0].items[0].id = 'other-record';
    tail.receipts[1].keepsakeId = 'other-record';
  }, 0);
});

test('keepsake rejects a model request inside the tail', () => {
  rejects('tail-model', 'MODEL_DURING_TAIL', value => value.modelCallTiming[0].receivedEpochMs = epoch + 10500);
});

test('keepsake rejects a changed total model request count', () => {
  rejects('model-count', 'MODEL_COUNT', value => value.requests++, 0);
});
