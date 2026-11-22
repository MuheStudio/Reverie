'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { PROACTIVE_SETTINGS_CONTRACT, verifyProactiveSettings } = require('./proactive-settings-verdicts.cjs');

const epoch = 1794594080000;
const scope = `builtin_hoshino_yumetsuki:1:${'a'.repeat(64)}`;
const generation = 1;
const off = '未开启';
const needsGrant = '已开启，还需要授权费用';
const authorized = '已开启并已授权';
const input = (control, atMs) => ({control, atMs, hitAccepted: true, mouseDispatchCount: 1, signals: 1});
const settings = (enabled, dailyLimit, intervalMinutes) => ({enabled, dailyLimit, intervalMinutes});
const permission = (granted, effective) => ({granted, effective, costAcknowledged: granted});
const view = (atMs, text, state, grant) => ({atMs, text, checked: state.enabled, settings: state, permission: grant,
  dailySelected: state.dailyLimit, intervalSelected: state.intervalMinutes, authorizeVisible: state.enabled && !grant.effective});
const saveFields = (key, value) => ({section: 'features', [key]: value});

function report(cycle) {
  const first = cycle === 1;
  const tailStartEpochMs = epoch + cycle * 10000;
  const elapsedMs = first ? 550 : 270;
  const commands = [];
  const receipts = [];
  function exchange(command, atMs, state, fields = {}) {
    const id = `qt_${(cycle * 16 + commands.length).toString(16).padStart(32, '0')}`;
    const binding = {id, command, scope, generation};
    commands.push({...binding, atMs, fields});
    receipts.push({...binding, atMs: atMs + 5, ok: true, state});
  }
  const inputs = [input('nav-settings', 40), input('settingsTab-chat', 120)];
  const views = {};
  if (first) {
    inputs.push(input('settingsProactiveEnabled', 180), input('settingsProactiveAuthorize', 240),
      input('settingsCostConsentConfirm', 280), input('settingsProactiveDailyLimit-3', 340),
      input('settingsProactiveMinInterval-240', 405), input('settingsProactiveEnabled', 470));
    views.initial = view(150, off, settings(false, 2, 120), permission(false, false));
    exchange('settings:update', 180, settings(true, 2, 120), saveFields('proactive_chat_enabled', true));
    exchange('settings:get', 185, settings(true, 2, 120));
    exchange('ai_usage:get', 190, permission(false, false));
    views.needsGrant = view(215, needsGrant, settings(true, 2, 120), permission(false, false));
    exchange('ai_usage:grant', 280, permission(true, true),
      {feature: 'proactive_chat', api_cost_acknowledged: true, user_confirmed: true});
    views.authorized = view(305, authorized, settings(true, 2, 120), permission(true, true));
    exchange('settings:update', 340, settings(true, 3, 120), saveFields('proactive_daily_limit', 3));
    exchange('settings:get', 345, settings(true, 3, 120));
    views.daily = view(365, authorized, settings(true, 3, 120), permission(true, true));
    exchange('settings:update', 405, settings(true, 3, 240), saveFields('proactive_min_interval_minutes', 240));
    exchange('settings:get', 410, settings(true, 3, 240));
    views.interval = view(435, authorized, settings(true, 3, 240), permission(true, true));
    exchange('settings:update', 470, settings(false, 3, 240), saveFields('proactive_chat_enabled', false));
    exchange('settings:get', 475, settings(false, 3, 240));
    exchange('ai_usage:get', 480, permission(true, false));
    views.off = view(525, off, settings(false, 3, 240), permission(true, false));
  } else {
    exchange('settings:get', 150, settings(false, 3, 240));
    exchange('ai_usage:get', 150, permission(true, false));
    views.restart = view(245, off, settings(false, 3, 240), permission(true, false));
  }
  return {cycle: String(cycle), go: {passed: true, tailEndEpochMs: tailStartEpochMs - 40,
    scopeAfter: scope, generationAfter: generation}, proactiveSettings: {
    passed: true, error: '', cycle, deadlineMs: 20000, elapsedMs,
    tailStartEpochMs, tailEndEpochMs: tailStartEpochMs + elapsedMs,
    scopeBefore: scope, scopeAfter: scope, generationBefore: generation, generationAfter: generation,
    enabledAtMs: first ? 180 : -1, disabledAtMs: first ? 525 : -1, enabledDurationMs: first ? 345 : 0,
    inputs, commands, receipts, views, lastObservation: {phase: first ? 15 : 4,
      visibility: {found: true, visible: true, fullyVisible: true, sceneX: 125, sceneY: 200, sceneWidth: 154,
        sceneHeight: 20, clipX: 125, clipY: 200, clipWidth: 154, clipHeight: 20}},
  }};
}

function fixture() {
  return {reports: [report(1), report(2)], requests: 9, modelCallTiming: [
    ...Array.from({length: 8}, (_, index) => ({cycle: 1, receivedEpochMs: epoch + index * 100})),
    {cycle: 2, receivedEpochMs: epoch + 14000},
  ]};
}

const verify = ({reports, modelCallTiming, requests}) => verifyProactiveSettings(reports, modelCallTiming, requests);
const first = value => value.reports[0].proactiveSettings;
const restart = value => value.reports[1].proactiveSettings;

function reject(id, reason, cycle, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `PROACTIVE_SETTINGS_${reason}`,
    expectedContext: cycle ? {cycle} : {}});
}

test('accepts real consent, cap saves, switch off and a fresh read-only restart', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: PROACTIVE_SETTINGS_CONTRACT, modelRequestsAdded: 0,
    enabledDurationMs: 345, cycles: [
      {cycle: 1, elapsedMs: 550, commandCount: 11, receiptCount: 11,
        states: {initial: off, needsGrant, authorized, daily: authorized, interval: authorized, off}},
      {cycle: 2, elapsedMs: 270, commandCount: 2, receiptCount: 2, states: {restart: off}},
    ]});
});

test('rejects a missing restart report', () => reject('missing-cycle', 'CYCLES', 0, value => value.reports.pop()));
test('rejects a failed tail', () => reject('failed-tail', 'CYCLE', 1, value => { first(value).passed = false; }));
test('rejects a tail before the final Go proof ends', () => reject('tail-early', 'AFTER_GO', 1, value => {
  value.reports[0].go.tailEndEpochMs = first(value).tailStartEpochMs + 1;
}));
test('rejects a changed connection generation', () => reject('generation', 'SCOPE', 2, value => {
  restart(value).generationAfter++;
}));
test('rejects a tail at the deadline', () => reject('deadline', 'DEADLINE', 1, value => {
  first(value).elapsedMs = 20000;
}));
test('rejects conflicting epoch and elapsed clocks', () => reject('clock', 'TAIL_CLOCK', 2, value => {
  restart(value).tailEndEpochMs += 200;
}));
test('rejects approval without one real confirmation click', () => reject('confirmation-click', 'INPUTS', 1, value => {
  first(value).inputs[4].signals = 0;
}));
test('rejects another settings preset as the clicked control', () => reject('wrong-preset', 'INPUTS', 1, value => {
  first(value).inputs[5].control = 'settingsProactiveDailyLimit-5';
}));
test('rejects a settings write in the restart tail', () => reject('restart-write', 'COMMANDS', 2, value => {
  restart(value).commands[1].command = 'settings:update';
}));
test('rejects a missing real permission read', () => reject('missing-permission-read', 'COMMANDS', 1, value => {
  first(value).commands.pop();
}));
test('rejects granting another feature', () => reject('wrong-feature', 'COMMAND_FIELDS', 1, value => {
  first(value).commands[3].fields.feature = 'diary_generation';
}));
test('rejects a grant without explicit cost acknowledgement', () => reject('cost-unacknowledged', 'COMMAND_FIELDS', 1, value => {
  first(value).commands[3].fields.api_cost_acknowledged = false;
}));
test('rejects an unrelated setting in a cap save', () => reject('extra-field', 'COMMAND_FIELDS', 1, value => {
  first(value).commands[4].fields.diary_enabled = true;
}));
test('rejects reusing a request identity across cycles', () => reject('reused-request', 'REQUEST_BINDING', 2, value => {
  const id = first(value).commands[0].id;
  restart(value).commands[0].id = id;
  restart(value).receipts[0].id = id;
}));
test('rejects a grant receipt from an old connection generation', () => reject('stale-receipt', 'REQUEST_BINDING', 1, value => {
  first(value).receipts[3].generation--;
}));
test('rejects a failed settings receipt', () => reject('receipt-failed', 'RECEIPT_STATE', 1, value => {
  first(value).receipts[6].ok = false;
}));
test('rejects a restart receipt reporting that the switch is on', () => reject('restart-enabled', 'RECEIPT_STATE', 2, value => {
  restart(value).receipts[0].state.enabled = true;
}));
test('rejects an active grant after restart', () => reject('restart-effective', 'RECEIPT_STATE', 2, value => {
  restart(value).receipts[1].state.effective = true;
}));
test('rejects a missing persisted grant even though the switch is off', () => reject('restart-grant-lost', 'RECEIPT_STATE', 2, value => {
  restart(value).receipts[1].state.granted = false;
}));
test('rejects an authorized label before consent is recorded', () => reject('wrong-label', 'DISPLAY', 1, value => {
  first(value).views.needsGrant.text = authorized;
}));
test('rejects a restart UI preset different from its readback', () => reject('wrong-restart-preset', 'DISPLAY', 2, value => {
  restart(value).views.restart.intervalSelected = 120;
}));
test('rejects a missing authorization action in the ungranted view', () => reject('hidden-authorize', 'DISPLAY', 1, value => {
  first(value).views.needsGrant.authorizeVisible = false;
}));
test('rejects a switch-on window longer than sixty seconds', () => reject('enabled-limit', 'ENABLED_DURATION', 1, value => {
  first(value).enabledDurationMs = 60001;
}));
test('rejects an enabled duration inconsistent with its endpoints', () => reject('enabled-clock', 'ENABLED_DURATION', 1, value => {
  first(value).enabledDurationMs--;
}));
test('rejects the grant being sent before the confirmation click', () => reject('grant-before-confirm', 'EVENT_ORDER', 1, value => {
  first(value).inputs[4].atMs = 300;
}));
test('rejects a model request in the enabled tail window', () => reject('model-in-tail', 'MODEL_DURING_TAIL', 1, value => {
  value.modelCallTiming[7].receivedEpochMs = first(value).tailStartEpochMs + 300;
}));
test('rejects a model request after the restart readback', () => reject('model-after-tail', 'MODEL_TRACE', 2, value => {
  value.modelCallTiming[8].receivedEpochMs = restart(value).tailEndEpochMs + 1;
}));
test('rejects a changed settings model request count', () => reject('model-count', 'MODEL_COUNT', 0, value => {
  value.requests = 10;
}));
