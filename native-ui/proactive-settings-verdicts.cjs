'use strict';

const assert = require('node:assert/strict');
const { verdictReason } = require('./verdict-test-support.cjs');

const PROACTIVE_SETTINGS_CONTRACT = 'reverie.native.proactive-settings.verdict.v1';
const DEADLINE_MS = 20000;
const ENABLED_LIMIT_MS = 60000;
const SAVE = 'settings:update';
const READ = 'settings:get';
const GRANT = 'ai_usage:grant';
const PERMISSION = 'ai_usage:get';
const TOGGLE = 'settingsProactiveEnabled';
const OFF = '未开启';
const NEEDS_GRANT = '已开启，还需要授权费用';
const AUTHORIZED = '已开启并已授权';
const FIRST_CONTROLS = ['nav-settings', 'settingsTab-chat', TOGGLE, 'settingsProactiveAuthorize',
  'settingsCostConsentConfirm', 'settingsProactiveDailyLimit-3', 'settingsProactiveMinInterval-240', TOGGLE];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const equal = (value, expected) => exact(value, Object.keys(expected)) &&
  Object.entries(expected).every(([key, offered]) => value[key] === offered);
const settings = (enabled, dailyLimit, intervalMinutes) => ({enabled, dailyLimit, intervalMinutes});
const permission = (granted, effective) => ({granted, effective, costAcknowledged: granted});
const feature = (key, value) => ({section: 'features', [key]: value});
const eventKeys = ['id', 'command', 'scope', 'generation', 'atMs'];

const FIRST_EXCHANGES = [
  [SAVE, feature('proactive_chat_enabled', true), settings(true, 2, 120)],
  [READ, {}, settings(true, 2, 120)],
  [PERMISSION, {}, permission(false, false)],
  [GRANT, {feature: 'proactive_chat', api_cost_acknowledged: true, user_confirmed: true}, permission(true, true)],
  [SAVE, feature('proactive_daily_limit', 3), settings(true, 3, 120)],
  [READ, {}, settings(true, 3, 120)],
  [SAVE, feature('proactive_min_interval_minutes', 240), settings(true, 3, 240)],
  [READ, {}, settings(true, 3, 240)],
  [SAVE, feature('proactive_chat_enabled', false), settings(false, 3, 240)],
  [READ, {}, settings(false, 3, 240)],
  [PERMISSION, {}, permission(true, false)],
];
const RESTART_EXCHANGES = [[READ, {}, settings(false, 3, 240)], [PERMISSION, {}, permission(true, false)]];

const FIRST_VIEWS = [
  ['initial', OFF, settings(false, 2, 120), permission(false, false)],
  ['needsGrant', NEEDS_GRANT, settings(true, 2, 120), permission(false, false)],
  ['authorized', AUTHORIZED, settings(true, 2, 120), permission(true, true)],
  ['daily', AUTHORIZED, settings(true, 3, 120), permission(true, true)],
  ['interval', AUTHORIZED, settings(true, 3, 240), permission(true, true)],
  ['off', OFF, settings(false, 3, 240), permission(true, false)],
];
const RESTART_VIEWS = [['restart', OFF, settings(false, 3, 240), permission(true, false)]];

function guard(condition, reason, context) {
  assert(condition, verdictReason(`PROACTIVE_SETTINGS_${reason}`, context));
}

function inOrder(times) {
  return times.every((time, index) => whole(time) && (index === 0 || times[index - 1] <= time));
}

function checkClock(tail, context) {
  const {deadlineMs, elapsedMs, tailStartEpochMs, tailEndEpochMs} = tail;
  guard(deadlineMs === DEADLINE_MS && whole(elapsedMs) && elapsedMs < deadlineMs, 'DEADLINE', context);
  guard(whole(tailStartEpochMs) && tailStartEpochMs > 0 && whole(tailEndEpochMs) && tailEndEpochMs >= tailStartEpochMs &&
    Math.abs(tailEndEpochMs - tailStartEpochMs - elapsedMs) <= 100, 'TAIL_CLOCK', context);
}

function checkInputs(inputs, expected, context) {
  guard(Array.isArray(inputs) && inputs.length === expected.length && inputs.every((row, index) =>
    exact(row, ['control', 'atMs', 'mouseDispatchCount', 'signals', 'hitAccepted']) &&
    row.control === expected[index] && row.mouseDispatchCount === 1 && row.signals === 1 && row.hitAccepted === true),
  'INPUTS', context);
}

function checkTraffic(tail, expected, seenIds, context) {
  const {commands, receipts, scopeBefore, generationBefore, elapsedMs} = tail;
  guard(Array.isArray(commands) && commands.length === expected.length && commands.every((row, index) =>
    exact(row, [...eventKeys, 'fields']) && row.command === expected[index][0]), 'COMMANDS', context);
  guard(Array.isArray(receipts) && receipts.length === expected.length && receipts.every(row =>
    exact(row, [...eventKeys, 'ok', 'state'])), 'RECEIPTS', context);
  guard(inOrder([...commands.map(row => row.atMs), elapsedMs]), 'COMMAND_TIMING', context);

  const byId = new Map(receipts.map(row => [row.id, row]));
  return commands.map((command, index) => {
    const [, fields, state] = expected[index];
    guard(equal(command.fields, fields), 'COMMAND_FIELDS', context);
    const response = byId.get(command.id);
    guard(typeof command.id === 'string' && /^qt_[a-f0-9]{32}$/.test(command.id) && !seenIds.has(command.id) &&
      response?.command === command.command && command.scope === scopeBefore && response.scope === scopeBefore &&
      command.generation === generationBefore && response.generation === generationBefore, 'REQUEST_BINDING', context);
    seenIds.add(command.id);
    guard(response.ok === true && equal(response.state, state), 'RECEIPT_STATE', context);
    guard(inOrder([command.atMs, response.atMs, elapsedMs]), 'RECEIPT_TIMING', context);
    return response;
  });
}

function checkViews(views, expected, context) {
  guard(exact(views, expected.map(([name]) => name)) && expected.every(([name, text, settingsValue, permissionValue]) => {
    const view = views[name];
    return exact(view, ['atMs', 'text', 'checked', 'settings', 'permission', 'dailySelected', 'intervalSelected',
      'authorizeVisible']) && view.text === text && view.checked === settingsValue.enabled &&
      view.dailySelected === settingsValue.dailyLimit && view.intervalSelected === settingsValue.intervalMinutes &&
      view.authorizeVisible === (settingsValue.enabled && !permissionValue.effective) &&
      equal(view.settings, settingsValue) && equal(view.permission, permissionValue);
  }), 'DISPLAY', context);
}

function checkFirstChronology(tail, responses, context) {
  const {inputs, commands, views, elapsedMs, enabledAtMs, disabledAtMs, enabledDurationMs} = tail;
  guard(whole(enabledDurationMs) && enabledDurationMs > 0 && enabledDurationMs <= ENABLED_LIMIT_MS &&
    enabledAtMs === inputs[2].atMs && disabledAtMs === views.off.atMs &&
    enabledDurationMs === disabledAtMs - enabledAtMs, 'ENABLED_DURATION', context);
  const settledAt = (start, end) => Math.max(...responses.slice(start, end).map(row => row.atMs));
  guard(inOrder([inputs[0].atMs, inputs[1].atMs, views.initial.atMs, enabledAtMs, commands[0].atMs,
    settledAt(0, 3), views.needsGrant.atMs, inputs[3].atMs, inputs[4].atMs, commands[3].atMs,
    settledAt(3, 4), views.authorized.atMs, inputs[5].atMs, commands[4].atMs, settledAt(4, 6),
    views.daily.atMs, inputs[6].atMs, commands[6].atMs, settledAt(6, 8), views.interval.atMs,
    inputs[7].atMs, commands[8].atMs, settledAt(8, 11), disabledAtMs, elapsedMs]), 'EVENT_ORDER', context);
}

function checkCycle(report, cycle, seenIds) {
  const context = {cycle};
  const tail = report?.proactiveSettings;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
    tail.passed === true && tail.error === '', 'CYCLE', context);
  guard(exact(tail, ['passed', 'error', 'cycle', 'deadlineMs', 'elapsedMs', 'tailStartEpochMs', 'tailEndEpochMs',
    'scopeBefore', 'scopeAfter', 'generationBefore', 'generationAfter', 'enabledAtMs', 'disabledAtMs',
    'enabledDurationMs', 'inputs', 'commands', 'receipts', 'views', 'lastObservation']) &&
    exact(tail.lastObservation, ['phase', 'visibility']) && whole(tail.lastObservation.phase) &&
    exact(tail.lastObservation.visibility, ['found', 'visible', 'fullyVisible', 'sceneX', 'sceneY', 'sceneWidth',
      'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight']) &&
    ['found', 'visible', 'fullyVisible'].every(key => tail.lastObservation.visibility[key] === true) &&
    ['sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight']
      .every(key => Number.isFinite(tail.lastObservation.visibility[key])),
  'REPORT_FIELDS', context);
  checkClock(tail, context);

  const go = report.go;
  guard(go?.passed === true && whole(go.tailEndEpochMs) && go.tailEndEpochMs <= tail.tailStartEpochMs &&
    go.scopeAfter === tail.scopeBefore && go.generationAfter === tail.generationBefore, 'AFTER_GO', context);
  guard(typeof tail.scopeBefore === 'string' && /^[A-Za-z0-9_-]{4,128}:\d+:[a-f0-9]{64}$/.test(tail.scopeBefore) &&
    tail.scopeAfter === tail.scopeBefore && whole(tail.generationBefore) && tail.generationBefore > 0 &&
    tail.generationBefore === tail.generationAfter, 'SCOPE', context);

  const first = cycle === 1;
  checkInputs(tail.inputs, first ? FIRST_CONTROLS : FIRST_CONTROLS.slice(0, 2), context);
  const responses = checkTraffic(tail, first ? FIRST_EXCHANGES : RESTART_EXCHANGES, seenIds, context);
  checkViews(tail.views, first ? FIRST_VIEWS : RESTART_VIEWS, context);
  if (first) checkFirstChronology(tail, responses, context);
  else {
    const [nav, chat] = tail.inputs;
    guard(tail.enabledAtMs === -1 && tail.disabledAtMs === -1 && tail.enabledDurationMs === 0, 'ENABLED_DURATION', context);
    guard(inOrder([nav.atMs, chat.atMs, tail.commands[0].atMs, Math.max(...responses.map(row => row.atMs)),
      tail.views.restart.atMs, tail.elapsedMs]), 'EVENT_ORDER', context);
  }
  return tail;
}

function verifyProactiveSettings(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const seenIds = new Set();
  const first = checkCycle(reports[0], 1, seenIds);
  const restart = checkCycle(reports[1], 2, seenIds);
  guard(first.tailEndEpochMs < restart.tailStartEpochMs, 'TAIL_ORDER');
  guard(first.scopeBefore === restart.scopeBefore &&
    equal(restart.views.restart.settings, first.views.off.settings) &&
    equal(restart.views.restart.permission, first.views.off.permission), 'RESTART_PERSISTENCE');
  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    (call.cycle === 1 || call.cycle === 2) && whole(call.receivedEpochMs)), 'MODEL_TRACE');
  for (const tail of [first, restart]) {
    const calls = modelCallTiming.filter(call => call.cycle === tail.cycle);
    guard(!calls.some(call => call.receivedEpochMs >= tail.tailStartEpochMs && call.receivedEpochMs <= tail.tailEndEpochMs),
      'MODEL_DURING_TAIL', {cycle: tail.cycle});
    guard(calls.length > 0 && calls.every(call => call.receivedEpochMs < tail.tailStartEpochMs),
      'MODEL_TRACE', {cycle: tail.cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');
  return {passed: true, contract: PROACTIVE_SETTINGS_CONTRACT, modelRequestsAdded: 0,
    enabledDurationMs: first.enabledDurationMs,
    cycles: [first, restart].map(tail => ({cycle: tail.cycle, elapsedMs: tail.elapsedMs,
      commandCount: tail.commands.length, receiptCount: tail.receipts.length,
      states: Object.fromEntries(Object.entries(tail.views).map(([key, view]) => [key, view.text]))}))};
}

module.exports = {PROACTIVE_SETTINGS_CONTRACT, verifyProactiveSettings};
