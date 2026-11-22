'use strict';

const assert = require('node:assert/strict');
const { verdictReason } = require('./verdict-test-support.cjs');

const CHAT_IMAGE_CONTRACT = 'reverie.native.chat-image.verdict.v1';
const DEADLINE_MS = 15000;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const FIXTURE = {sha256: 'af99b2fcf94914e08c74c7083e1fb36598ddbdbc5ffc09a93dfe5c61c0ec6f9a', width: 24, height: 16, bytes: 97};
const DISCLOSURE = '图片会发送给当前的模型服务。';
const CONTROLS = ['nav-chat', 'chatImageChoose', 'chatImageRemove'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const same = (a, b) => Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

function guard(condition, reason, context) {
  assert(condition, verdictReason(`CHAT_IMAGE_${reason}`, context));
}

function inOrder(times) {
  return times.every((time, index) => whole(time) && (index === 0 || times[index - 1] <= time));
}

function checkHistory(report, tail, context) {
  const {historyBefore, historyAfter} = tail;
  guard(Array.isArray(historyBefore) && historyBefore.length > 0 &&
    historyBefore.every(id => typeof id === 'string' && id.length > 0) && new Set(historyBefore).size === historyBefore.length &&
    same(historyBefore, historyAfter) && Array.isArray(report.messages) &&
    same(historyBefore, report.messages.map(message => message?.id)), 'HISTORY', context);
}

function checkFiles(tail, context) {
  const {filesBefore, filesAfter} = tail;
  const keys = ['runtimeImages', 'otherImages', 'avatarImages', 'avatarInventorySha256'];
  for (const files of [filesBefore, filesAfter]) {
    guard(exact(files, keys) && files.runtimeImages === 0 && files.otherImages === 0 &&
      whole(files.avatarImages) && sha256(files.avatarInventorySha256), 'ISOLATION_FILES', context);
  }
  guard(filesBefore.avatarImages === filesAfter.avatarImages &&
    filesBefore.avatarInventorySha256 === filesAfter.avatarInventorySha256, 'AVATAR_INVENTORY', context);
}

function view(value, staged) {
  return exact(value, ['atMs', 'previewVisible', 'previewReady', 'disclosure', 'removeVisible', 'sendVisible', 'sendEnabled',
    'composerEnabled', 'draftEmpty', 'draftSha256']) && value.previewVisible === staged &&
    value.previewReady === staged && value.disclosure === (staged ? DISCLOSURE : '') &&
    value.removeVisible === staged && typeof value.draftEmpty === 'boolean' &&
    value.sendVisible === true && value.sendEnabled === (staged || !value.draftEmpty) && value.composerEnabled === true &&
    sha256(value.draftSha256) && (value.draftSha256 !== EMPTY_SHA256 || value.draftEmpty === true);
}

function checkCycle(report, cycle) {
  const context = {cycle};
  const tail = report?.chatImage;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
    tail.passed === true && tail.error === '', 'CYCLE', context);
  guard(exact(tail, ['passed', 'error', 'cycle', 'deadlineMs', 'elapsedMs', 'tailStartEpochMs', 'tailEndEpochMs',
    'scopeBefore', 'scopeAfter', 'generationBefore', 'generationAfter', 'inputs', 'selectionAtMs', 'fixture',
    'chatSendDispatches', 'commands', 'receipts', 'historyBefore', 'historyAfter', 'filesBefore', 'filesAfter', 'initial', 'withPreview',
    'final', 'lastObservation']), 'REPORT_FIELDS', context);
  const {elapsedMs, deadlineMs, tailStartEpochMs, tailEndEpochMs} = tail;
  guard(deadlineMs === DEADLINE_MS && whole(elapsedMs) && elapsedMs < deadlineMs, 'DEADLINE', context);
  guard(whole(tailStartEpochMs) && tailStartEpochMs > 0 && whole(tailEndEpochMs) && tailEndEpochMs >= tailStartEpochMs &&
    Math.abs(tailEndEpochMs - tailStartEpochMs - elapsedMs) <= 100, 'TAIL_CLOCK', context);
  const previous = report.proactiveSettings;
  guard(previous?.passed === true && whole(previous.tailEndEpochMs) && previous.tailEndEpochMs <= tailStartEpochMs &&
    previous.scopeAfter === tail.scopeBefore && previous.generationAfter === tail.generationBefore, 'AFTER_W17', context);
  guard(typeof tail.scopeBefore === 'string' && /^[A-Za-z0-9_-]{4,128}:\d+:[a-f0-9]{64}$/.test(tail.scopeBefore) &&
    tail.scopeAfter === tail.scopeBefore && whole(tail.generationBefore) && tail.generationBefore > 0 &&
    tail.generationAfter === tail.generationBefore, 'SCOPE', context);
  guard(Array.isArray(tail.commands) && Array.isArray(tail.receipts) && [tail.commands, tail.receipts].every(rows =>
    rows.length <= 6 && rows.every(row => exact(row, ['id', 'command', 'generation', 'atMs']) &&
      typeof row.id === 'string' && /^qt_[a-f0-9]{32}$/.test(row.id) && typeof row.command === 'string' &&
      /^[a-z][a-z0-9_:]*$/.test(row.command) && whole(row.generation) && whole(row.atMs) && row.atMs <= elapsedMs)),
  'TRAFFIC_METADATA', context);
  guard(tail.chatSendDispatches === 0 && !tail.commands.some(row => row.command === 'chat:send'), 'SEND_DISPATCH', context);
  checkHistory(report, tail, context);
  checkFiles(tail, context);

  const {initial, withPreview, final, inputs, fixture, selectionAtMs, lastObservation} = tail;
  const first = cycle === 1;
  const controls = first ? CONTROLS : CONTROLS.slice(0, 1);
  guard(Array.isArray(inputs) && inputs.length === controls.length && inputs.every((row, index) =>
    exact(row, ['control', 'atMs', 'mouseDispatchCount', 'clickedSignals', 'hitAccepted']) &&
    row.control === controls[index] && row.mouseDispatchCount === 1 && row.clickedSignals === 1 && row.hitAccepted === true),
  'INPUTS', context);
  guard(view(initial, false) && view(final, false) && final.draftEmpty === initial.draftEmpty &&
    final.draftSha256 === initial.draftSha256 && final.sendEnabled === initial.sendEnabled, 'COMPOSER_RESTORED', context);
  guard(exact(lastObservation, ['phase', 'chatFound', 'chatReady', 'bridgePreview', 'previewVisible',
    'previewReady', 'disclosureVisible', 'removeVisible', 'sendVisible', 'sendEnabled', 'chooserEnabled']) && whole(lastObservation.phase) &&
    lastObservation.chatFound === true && lastObservation.chatReady === true && lastObservation.chooserEnabled === true &&
    ['bridgePreview', 'previewVisible', 'previewReady', 'disclosureVisible', 'removeVisible']
      .every(key => lastObservation[key] === false) && lastObservation.sendVisible === true &&
    lastObservation.sendEnabled === final.sendEnabled,
  'TERMINAL_OBSERVATION', context);
  if (first) {
    guard(exact(fixture, Object.keys(FIXTURE)) && Object.entries(FIXTURE).every(([key, value]) => fixture[key] === value),
      'FIXTURE', context);
    guard(view(withPreview, true) && withPreview.draftEmpty === initial.draftEmpty &&
      withPreview.draftSha256 === initial.draftSha256, 'PREVIEW', context);
    guard(inOrder([inputs[0].atMs, initial.atMs, inputs[1].atMs, selectionAtMs, withPreview.atMs,
      inputs[2].atMs, final.atMs, elapsedMs]), 'EVENT_ORDER', context);
  } else {
    guard(exact(fixture, []) && selectionAtMs === -1 && exact(withPreview, []), 'RESTART_SELECTION', context);
    guard(initial.atMs === final.atMs && inOrder([inputs[0].atMs, initial.atMs, elapsedMs]), 'EVENT_ORDER', context);
  }
  return tail;
}

function verifyChatImage(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const first = checkCycle(reports[0], 1);
  const restart = checkCycle(reports[1], 2);
  guard(first.tailEndEpochMs < restart.tailStartEpochMs, 'TAIL_ORDER');
  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    (call.cycle === 1 || call.cycle === 2) && whole(call.receivedEpochMs)), 'MODEL_TRACE');
  for (const tail of [first, restart]) {
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tail.tailStartEpochMs &&
      call.receivedEpochMs <= tail.tailEndEpochMs), 'MODEL_DURING_TAIL', {cycle: tail.cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');
  return {passed: true, contract: CHAT_IMAGE_CONTRACT, modelRequestsAdded: 0, systemFilePickerCovered: false,
    cycles: [first, restart].map(tail => ({cycle: tail.cycle, elapsedMs: tail.elapsedMs,
      userInputs: tail.inputs.length, historyCount: tail.historyAfter.length, sendDispatches: tail.chatSendDispatches,
      chatImageFiles: tail.filesAfter.runtimeImages + tail.filesAfter.otherImages,
      existingAvatarImageFiles: tail.filesAfter.avatarImages, previewAtMs: tail.withPreview.atMs ?? null}))};
}

module.exports = {CHAT_IMAGE_CONTRACT, verifyChatImage};
