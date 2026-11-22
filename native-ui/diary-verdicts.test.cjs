'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { DIARY_CONTRACT, verifyDiary } = require('./diary-verdicts.cjs');

const epoch = 1794297600000;
const fingerprint = 'a'.repeat(64);
const listId = cycle => `qt_${String(cycle).repeat(32)}`;
const saveId = `qt_${'3'.repeat(32)}`;

function report(cycle) {
  const first = cycle === 1;
  const scope = `builtin_hoshino_yumetsuki:${cycle}:${fingerprint}`;
  const generation = cycle + 1;
  const tailStartEpochMs = epoch + cycle * 1000;
  const archive = {revision: 6, sha256: 'b'.repeat(64)};
  const inputs = [
    {control: 'scene-navigation-search', atMs: 40, mouseDispatchCount: 1, signals: 1, hitAccepted: true},
    {control: 'search-result-activities-diary', atMs: 120, mouseDispatchCount: 1, signals: 1, hitAccepted: true},
  ];
  const list = {id: listId(cycle), command: 'diary:request', scope, generation, atMs: 120};
  const commands = [{...list, fields: {action: 'list'}}];
  const receipts = [{...list, atMs: 130, ok: true, entryCount: 0, writing: false}];
  if (first) {
    inputs.push({control: 'diaryEnabled', atMs: 200, mouseDispatchCount: 1, signals: 1, hitAccepted: true});
    const save = {id: saveId, command: 'settings:update', scope, generation, atMs: 200};
    commands.push({...save, fields: {section: 'features', diary_enabled: true}});
    receipts.push({...save, atMs: 210, ok: true, diaryEnabled: true});
  }
  return {cycle: String(cycle),
    relationshipStatus: {passed: true, scopeAfter: scope, generationAfter: generation, tailEndEpochMs: tailStartEpochMs - 40},
    diary: {
      passed: true, error: '', cycle, deadlineMs: 15000, elapsedMs: 300,
      tailStartEpochMs, tailEndEpochMs: tailStartEpochMs + 300,
      scopeBefore: scope, scopeAfter: scope, generationBefore: generation, generationAfter: generation,
      inputs, searchAtMs: 80, commands, receipts,
      initial: {atMs: 160, checked: !first, enabled: !first, emptyText: '还没有日记。', listRequestId: list.id},
      authorizedView: {atMs: 280, checked: true, enabled: true, authorized: false,
        authorizationText: '还需要授权这项费用', writeText: '现在写今天的日记', writeEnabled: false},
      archiveBefore: {...archive}, archiveAfter: {...archive},
      lastObservation: {phase: 6, phaseElapsedMs: 40, portalReady: true, visibility: {fullyVisible: true}},
    }};
}

function fixture() {
  return {reports: [report(1), report(2)], requests: 9, modelCallTiming: [
    ...Array.from({length: 8}, (_, index) => ({cycle: 1, receivedEpochMs: epoch + index * 100})),
    {cycle: 2, receivedEpochMs: epoch + 1700},
  ]};
}

const verify = ({reports, modelCallTiming, requests}) => verifyDiary(reports, modelCallTiming, requests);
const first = value => value.reports[0].diary;
const restart = value => value.reports[1].diary;

function reject(id, reason, cycle, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `DIARY_${reason}`,
    expectedContext: cycle ? {cycle} : {}});
}

test('accepts an ungranted switch save and fresh restart readback with nine model requests', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: DIARY_CONTRACT, modelRequestsAdded: 0, cycles: [
    {cycle: 1, elapsedMs: 300, listRequestId: listId(1), saveRequestId: saveId, startsEnabled: false},
    {cycle: 2, elapsedMs: 300, listRequestId: listId(2), saveRequestId: null, startsEnabled: true},
  ]});
});

test('rejects a missing restart cycle', () => reject('missing-cycle', 'CYCLES', 0, value => value.reports.pop()));
test('rejects a missing diary tail', () => reject('missing-tail', 'CYCLE', 2, value => { delete value.reports[1].diary; }));
test('rejects a tail at the deadline', () => reject('deadline', 'DEADLINE', 1, value => { first(value).elapsedMs = 15000; }));
test('rejects divergent elapsed and epoch timing', () => reject('clock', 'TAIL_CLOCK', 2,
  value => { restart(value).tailEndEpochMs += 200; }));
test('rejects a diary tail before the relationship tail ends', () => reject('after-relationship', 'AFTER_RELATIONSHIP', 1,
  value => { value.reports[0].relationshipStatus.tailEndEpochMs = first(value).tailStartEpochMs + 1; }));
test('rejects overlapping cycle windows', () => reject('overlap', 'TAIL_ORDER', 0, value => {
  const tail = restart(value);
  tail.tailStartEpochMs = first(value).tailEndEpochMs;
  tail.tailEndEpochMs = tail.tailStartEpochMs + tail.elapsedMs;
  value.reports[1].relationshipStatus.tailEndEpochMs = tail.tailStartEpochMs;
}));
test('rejects a connection generation change', () => reject('generation', 'SCOPE', 1,
  value => { first(value).generationAfter++; }));
test('rejects the wrong activity search result', () => reject('wrong-nav', 'INPUTS', 1,
  value => { first(value).inputs[1].control = 'search-result-activities-xiangqi'; }));
test('rejects navigation without an observed mouse dispatch', () => reject('no-nav-dispatch', 'INPUTS', 2,
  value => { restart(value).inputs[0].mouseDispatchCount = 0; }));
test('rejects a navigation click that misses its target', () => reject('nav-miss', 'INPUTS', 1,
  value => { first(value).inputs[1].hitAccepted = false; }));
test('rejects a switch click without one toggle signal', () => reject('no-toggle-signal', 'INPUTS', 1,
  value => { first(value).inputs[2].signals = 0; }));
test('rejects a save after restart', () => reject('restart-save', 'COMMANDS', 2,
  value => { restart(value).commands.push(first(value).commands[1]); }));
test('rejects a real diary write command', () => reject('write', 'COMMANDS', 1,
  value => { first(value).commands[1].command = 'diary:write'; }));
test('rejects a settings readback command', () => reject('settings-read', 'COMMANDS', 1,
  value => { first(value).commands.push({command: 'settings:get'}); }));
test('rejects a diary body read in place of a list', () => reject('body-read', 'COMMAND_FIELDS', 1,
  value => { first(value).commands[0].fields = {action: 'read', date: '2026-11-10'}; }));
test('rejects saving another feature with the switch', () => reject('extra-setting', 'COMMAND_FIELDS', 1,
  value => { first(value).commands[1].fields.diary_privacy_enabled = true; }));
test('rejects a string switch value', () => reject('save-value-type', 'COMMAND_FIELDS', 1,
  value => { first(value).commands[1].fields.diary_enabled = 'true'; }));
test('rejects a missing save receipt', () => reject('missing-save-receipt', 'RECEIPTS', 1,
  value => first(value).receipts.pop()));
test('rejects a receipt from the previous generation', () => reject('stale-receipt', 'REQUEST_BINDING', 2,
  value => { restart(value).receipts[0].generation--; }));
test('rejects a receipt with another request ID', () => reject('wrong-receipt-id', 'REQUEST_BINDING', 1,
  value => { first(value).receipts[1].id = listId(1); }));
test('rejects diary content in a receipt report', () => reject('receipt-body', 'REPORT_FIELDS', 1,
  value => { first(value).receipts[0].body = 'diary body'; }));
test('rejects diary content in a diagnostic observation', () => reject('diagnostic-body', 'REPORT_FIELDS', 2,
  value => { restart(value).lastObservation.body = 'diary body'; }));
test('rejects an unsuccessful list receipt', () => reject('list-failed', 'LIST_RECEIPT', 1,
  value => { first(value).receipts[0].ok = false; }));
test('rejects a nonempty list behind the empty message', () => reject('nonempty-list', 'LIST_RECEIPT', 2,
  value => { restart(value).receipts[0].entryCount = 1; }));
test('rejects an unsuccessful save receipt', () => reject('save-failed', 'SAVE_RECEIPT', 1,
  value => { first(value).receipts[1].ok = false; }));
test('rejects a restart with the switch off', () => reject('restart-switch-off', 'INITIAL_DISPLAY', 2,
  value => { restart(value).initial.checked = false; }));
test('rejects an incorrect empty list message', () => reject('empty-message', 'INITIAL_DISPLAY', 1,
  value => { first(value).initial.emptyText = '正在读取…'; }));
test('rejects an initial display bound to another list request', () => reject('display-request', 'DISPLAY_BINDING', 2,
  value => { restart(value).initial.listRequestId = listId(1); }));
test('rejects an enabled write button with no consent', () => reject('write-enabled', 'AUTHORIZATION_DISPLAY', 1,
  value => { first(value).authorizedView.writeEnabled = true; }));
test('rejects missing authorization wording after restart', () => reject('missing-authorization', 'AUTHORIZATION_DISPLAY', 2,
  value => { restart(value).authorizedView.authorizationText = ''; }));
test('rejects saving before the actual toggle', () => reject('save-order', 'EVENT_ORDER', 1,
  value => { first(value).commands[1].atMs = 199; }));
test('rejects an authorization display predating the save receipt', () => reject('authorization-order', 'EVENT_ORDER', 1,
  value => { first(value).authorizedView.atMs = 209; }));
test('rejects a changed archive digest', () => reject('archive-digest', 'ARCHIVE', 2,
  value => { restart(value).archiveAfter.sha256 = 'c'.repeat(64); }));
test('rejects a different persona on restart', () => reject('restart-persona', 'RESTART_PERSONA', 2, value => {
  const tail = restart(value), scope = `other_persona:2:${fingerprint}`;
  tail.scopeBefore = tail.scopeAfter = tail.commands[0].scope = tail.receipts[0].scope = scope;
  value.reports[1].relationshipStatus.scopeAfter = scope;
}));
test('rejects a request ID reused after restart', () => reject('reused-id', 'REUSED_REQUEST', 0, value => {
  const tail = restart(value);
  tail.commands[0].id = tail.receipts[0].id = tail.initial.listRequestId = listId(1);
}));
test('rejects a missing model call trace', () => reject('model-trace', 'MODEL_TRACE', 0,
  value => { delete value.modelCallTiming; }));
test('rejects a model request at the start of the first tail', () => reject('model-first', 'MODEL_REQUEST', 1,
  value => { value.modelCallTiming[0].receivedEpochMs = first(value).tailStartEpochMs; }));
test('rejects a model request at the end of the restart tail', () => reject('model-restart', 'MODEL_REQUEST', 2,
  value => { value.modelCallTiming[0].receivedEpochMs = restart(value).tailEndEpochMs; }));
test('rejects an additional model request outside both tails', () => reject('model-count', 'MODEL_COUNT', 0,
  value => { value.requests++; value.modelCallTiming.push({cycle: 2, receivedEpochMs: epoch + 2700}); }));
