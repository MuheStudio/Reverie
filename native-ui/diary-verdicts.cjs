'use strict';

const assert = require('node:assert/strict');
const { verdictReason } = require('./verdict-test-support.cjs');

const DIARY_CONTRACT = 'reverie.native.diary.verdict.v1';
const DEADLINE_MS = 15000;
const LIST = 'diary:request';
const SAVE = 'settings:update';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function guard(condition, reason, context) {
  assert(condition, verdictReason(`DIARY_${reason}`, context));
}

function parseScope(value, context) {
  guard(typeof value === 'string', 'SCOPE', context);
  const parts = value.split(':');
  guard(parts.length === 3 && /^[A-Za-z0-9_-]{4,128}$/.test(parts[0]) &&
    /^[0-9]+$/.test(parts[1]) && whole(Number(parts[1])) && sha256(parts[2]), 'SCOPE', context);
  return {id: parts[0], fingerprint: parts[2]};
}

function numericMetadata(value) {
  return object(value) && Object.values(value).every(field =>
    typeof field === 'boolean' || Number.isFinite(field) || numericMetadata(field));
}

function checkCycle(report, cycle) {
  const context = {cycle};
  const tail = report?.diary;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
    tail.passed === true && tail.error === '', 'CYCLE', context);
  guard(exact(tail, ['passed', 'error', 'cycle', 'deadlineMs', 'elapsedMs', 'tailStartEpochMs', 'tailEndEpochMs',
    'scopeBefore', 'scopeAfter', 'generationBefore', 'generationAfter', 'inputs', 'searchAtMs', 'commands', 'receipts',
    'initial', 'authorizedView', 'archiveBefore', 'archiveAfter', 'lastObservation']) &&
    numericMetadata(tail.lastObservation) && tail.lastObservation.portalReady === true &&
    tail.lastObservation.visibility?.fullyVisible === true, 'REPORT_FIELDS', context);

  const {deadlineMs, elapsedMs, tailStartEpochMs, tailEndEpochMs, searchAtMs} = tail;
  guard(deadlineMs === DEADLINE_MS && whole(elapsedMs) && elapsedMs < DEADLINE_MS, 'DEADLINE', context);
  guard(whole(tailStartEpochMs) && tailStartEpochMs > 0 && whole(tailEndEpochMs), 'TAIL_CLOCK', context);
  const epochElapsed = tailEndEpochMs - tailStartEpochMs;
  guard(whole(epochElapsed) && epochElapsed < DEADLINE_MS && Math.abs(epochElapsed - elapsedMs) <= 100, 'TAIL_CLOCK', context);

  const previous = report.relationshipStatus;
  guard(previous?.passed === true && whole(previous.tailEndEpochMs) && previous.tailEndEpochMs <= tailStartEpochMs &&
    previous.scopeAfter === tail.scopeBefore && previous.generationAfter === tail.generationBefore,
    'AFTER_RELATIONSHIP', context);
  const persona = parseScope(tail.scopeBefore, context);
  guard(tail.scopeAfter === tail.scopeBefore && whole(tail.generationBefore) && tail.generationBefore > 0 &&
    tail.generationAfter === tail.generationBefore, 'SCOPE', context);

  const {inputs, commands, receipts, initial, authorizedView, archiveBefore, archiveAfter} = tail;
  const first = cycle === 1;
  const controls = ['scene-navigation-search', 'search-result-activities-diary'];
  const expectedCommands = [LIST];
  if (first) {
    controls.push('diaryEnabled');
    expectedCommands.push(SAVE);
  }
  guard(Array.isArray(inputs) && inputs.length === controls.length && inputs.every((event, index) =>
    exact(event, ['control', 'atMs', 'mouseDispatchCount', 'signals', 'hitAccepted']) &&
    event.control === controls[index] && event.mouseDispatchCount === 1 && event.signals === 1 &&
    event.hitAccepted === true), 'INPUTS', context);
  guard(Array.isArray(commands) && commands.length === expectedCommands.length &&
    commands.every((event, index) => event?.command === expectedCommands[index]), 'COMMANDS', context);
  guard(Array.isArray(receipts) && receipts.length === expectedCommands.length &&
    receipts.every((event, index) => event?.command === expectedCommands[index]), 'RECEIPTS', context);

  const eventKeys = ['id', 'command', 'scope', 'generation', 'atMs'];
  const [list, save] = commands;
  const [listReceipt, saveReceipt] = receipts;
  guard(commands.every(event => exact(event, [...eventKeys, 'fields'])) &&
    exact(listReceipt, [...eventKeys, 'ok', 'entryCount', 'writing']) &&
    (!first || exact(saveReceipt, [...eventKeys, 'ok', 'diaryEnabled'])), 'REPORT_FIELDS', context);
  guard(exact(list.fields, ['action']) && list.fields.action === 'list' &&
    (!first || (exact(save.fields, ['section', 'diary_enabled']) && save.fields.section === 'features' &&
      save.fields.diary_enabled === true)), 'COMMAND_FIELDS', context);
  guard(commands.every((event, index) => {
    const receipt = receipts[index];
    return typeof event.id === 'string' && /^qt_[a-f0-9]{32}$/.test(event.id) && receipt.id === event.id &&
      event.scope === tail.scopeBefore && receipt.scope === tail.scopeBefore &&
      event.generation === tail.generationBefore && receipt.generation === tail.generationBefore;
  }), 'REQUEST_BINDING', context);
  guard(listReceipt.ok === true && listReceipt.entryCount === 0 && listReceipt.writing === false, 'LIST_RECEIPT', context);
  guard(!first || (saveReceipt.ok === true && saveReceipt.diaryEnabled === true), 'SAVE_RECEIPT', context);

  guard(exact(initial, ['atMs', 'checked', 'enabled', 'emptyText', 'listRequestId']) &&
    initial.checked === !first && initial.enabled === !first && initial.emptyText === '还没有日记。',
    'INITIAL_DISPLAY', context);
  guard(initial.listRequestId === list.id, 'DISPLAY_BINDING', context);
  guard(exact(authorizedView, ['atMs', 'checked', 'enabled', 'authorized', 'authorizationText', 'writeText', 'writeEnabled']) &&
    authorizedView.checked === true && authorizedView.enabled === true && authorizedView.authorized === false &&
    authorizedView.authorizationText === '还需要授权这项费用' && authorizedView.writeText === '现在写今天的日记' &&
    authorizedView.writeEnabled === false, 'AUTHORIZATION_DISPLAY', context);
  const times = [inputs[0].atMs, searchAtMs, inputs[1].atMs, list.atMs, listReceipt.atMs, initial.atMs];
  if (first) times.push(inputs[2].atMs, save.atMs, saveReceipt.atMs);
  times.push(authorizedView.atMs, elapsedMs);
  guard(times.every((at, index) => whole(at) && (index === 0 || times[index - 1] <= at)), 'EVENT_ORDER', context);

  guard(exact(archiveBefore, ['revision', 'sha256']) && exact(archiveAfter, ['revision', 'sha256']) &&
    sha256(archiveBefore.sha256) && (archiveBefore.revision === null || whole(archiveBefore.revision)) &&
    archiveBefore.sha256 === archiveAfter.sha256 && archiveBefore.revision === archiveAfter.revision, 'ARCHIVE', context);

  return {cycle, elapsedMs, tailStartEpochMs, tailEndEpochMs, persona, listRequestId: list.id,
    saveRequestId: save?.id ?? null, startsEnabled: initial.checked};
}

function verifyDiary(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const cycles = [checkCycle(reports[0], 1), checkCycle(reports[1], 2)];
  const [first, restart] = cycles;
  guard(first.tailEndEpochMs < restart.tailStartEpochMs, 'TAIL_ORDER');
  guard(restart.persona.id === first.persona.id && restart.persona.fingerprint === first.persona.fingerprint,
    'RESTART_PERSONA', {cycle: 2});
  guard(new Set([first.listRequestId, first.saveRequestId, restart.listRequestId]).size === 3, 'REUSED_REQUEST');

  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    [1, 2].includes(call.cycle) && whole(call.receivedEpochMs) && call.receivedEpochMs > 0), 'MODEL_TRACE');
  for (const {cycle, tailStartEpochMs, tailEndEpochMs} of cycles) {
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tailStartEpochMs && call.receivedEpochMs <= tailEndEpochMs),
      'MODEL_REQUEST', {cycle});
    guard(modelCallTiming.some(call => call.cycle === cycle && call.receivedEpochMs < tailStartEpochMs), 'MODEL_TRACE', {cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');

  return {passed: true, contract: DIARY_CONTRACT, modelRequestsAdded: 0,
    cycles: cycles.map(({cycle, elapsedMs, listRequestId, saveRequestId, startsEnabled}) =>
      ({cycle, elapsedMs, listRequestId, saveRequestId, startsEnabled}))};
}

module.exports = {DIARY_CONTRACT, verifyDiary};
