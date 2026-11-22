'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { CHAT_IMAGE_CONTRACT, verifyChatImage } = require('./chat-image-verdicts.cjs');

const epoch = 1794623500000;
const scope = `builtin_hoshino_yumetsuki:1:${'a'.repeat(64)}`;
const generation = 1;
const ids = ['first-user', 'first-assistant'];
const fileInventory = () => ({runtimeImages: 0, otherImages: 0, avatarImages: 2, avatarInventorySha256: 'b'.repeat(64)});
const view = (atMs, staged, draftEmpty = true) => ({atMs, previewVisible: staged, previewReady: staged,
  disclosure: staged ? '图片会发送给当前的模型服务。' : '', removeVisible: staged,
  sendVisible: true, sendEnabled: staged || !draftEmpty, composerEnabled: true, draftEmpty,
  draftSha256: draftEmpty ? 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' : 'd'.repeat(64)});
const input = (control, atMs) => ({control, atMs, hitAccepted: true, mouseDispatchCount: 1, clickedSignals: 1});

function report(cycle) {
  const first = cycle === 1;
  const tailStartEpochMs = epoch + cycle * 10000;
  const elapsedMs = first ? 510 : 230;
  return {cycle: String(cycle), messages: ids.map(id => ({id})), proactiveSettings: {passed: true,
    tailEndEpochMs: tailStartEpochMs - 40, scopeAfter: scope, generationAfter: generation}, chatImage: {
    passed: true, error: '', cycle, deadlineMs: 15000, elapsedMs,
    tailStartEpochMs, tailEndEpochMs: tailStartEpochMs + elapsedMs,
    scopeBefore: scope, scopeAfter: scope, generationBefore: generation, generationAfter: generation,
    inputs: first ? [input('nav-chat', 40), input('chatImageChoose', 260), input('chatImageRemove', 410)] : [input('nav-chat', 40)],
    selectionAtMs: first ? 261 : -1,
    fixture: first ? {sha256: 'af99b2fcf94914e08c74c7083e1fb36598ddbdbc5ffc09a93dfe5c61c0ec6f9a', width: 24, height: 16, bytes: 97} : {},
    chatSendDispatches: 0, commands: [], receipts: [], historyBefore: [...ids], historyAfter: [...ids],
    filesBefore: fileInventory(), filesAfter: fileInventory(), initial: view(185, false, first),
    withPreview: first ? view(300, true) : {}, final: view(first ? 475 : 185, false, first),
    lastObservation: {phase: first ? 5 : 1, chatFound: true, chatReady: true, bridgePreview: false,
      previewVisible: false, previewReady: false, disclosureVisible: false, removeVisible: false,
      sendVisible: true, sendEnabled: !first, chooserEnabled: true},
  }};
}

function fixture() {
  return {reports: [report(1), report(2)], requests: 9, modelCallTiming: [
    ...Array.from({length: 8}, (_, index) => ({cycle: 1, receivedEpochMs: epoch + index * 100})),
    {cycle: 2, receivedEpochMs: epoch + 14000},
  ]};
}

const verify = ({reports, modelCallTiming, requests}) => verifyChatImage(reports, modelCallTiming, requests);
const first = value => value.reports[0].chatImage;
const restart = value => value.reports[1].chatImage;

function reject(id, reason, cycle, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `CHAT_IMAGE_${reason}`,
    expectedContext: cycle ? {cycle} : {}});
}

test('accepts the unsent fixture preview and removal with no staged image after restart', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: CHAT_IMAGE_CONTRACT, modelRequestsAdded: 0,
    systemFilePickerCovered: false, cycles: [
      {cycle: 1, elapsedMs: 510, userInputs: 3, historyCount: 2, sendDispatches: 0, chatImageFiles: 0,
        existingAvatarImageFiles: 2, previewAtMs: 300},
      {cycle: 2, elapsedMs: 230, userInputs: 1, historyCount: 2, sendDispatches: 0, chatImageFiles: 0,
        existingAvatarImageFiles: 2, previewAtMs: null},
    ]});
});

test('rejects a missing second cycle', () => reject('cycle-count', 'CYCLES', 0, value => value.reports.pop()));
test('rejects a missing image report', () => reject('missing-tail', 'CYCLE', 2, value => {
  delete value.reports[1].chatImage;
}));
test('rejects the image tail starting before the proactive settings tail ends', () => reject('after-w17', 'AFTER_W17', 1, value => {
  value.reports[0].proactiveSettings.tailEndEpochMs = first(value).tailStartEpochMs + 1;
}));
test('rejects a tail at the deadline', () => reject('deadline', 'DEADLINE', 1, value => {
  first(value).elapsedMs = 15000;
}));
test('rejects an image cleanup from a different connection generation', () => reject('generation', 'SCOPE', 1, value => {
  first(value).generationAfter++;
}));
test('rejects an observed chat send despite zero model calls in the tail', () => reject('send-dispatch', 'SEND_DISPATCH', 1, value => {
  first(value).chatSendDispatches = 1;
}));
test('rejects a chat send captured in the local command trace', () => reject('send-trace', 'SEND_DISPATCH', 1, value => {
  first(value).commands.push({id: `qt_${'a'.repeat(32)}`, command: 'chat:send', generation, atMs: 300});
}));
test('rejects added history even if the signed request count is unchanged', () => reject('history-count', 'HISTORY', 1, value => {
  first(value).historyAfter.push('unregistered-message');
}));
test('rejects changed history identities at the same count', () => reject('history-ids', 'HISTORY', 2, value => {
  restart(value).historyAfter[0] = 'replacement-user';
}));
test('rejects a tail history snapshot different from the same cycle output', () => reject('history-report-binding', 'HISTORY', 2, value => {
  value.reports[1].messages[0].id = 'replacement-user';
}));
test('rejects an image file in the isolated runtime workspace', () => reject('runtime-image-file', 'ISOLATION_FILES', 1, value => {
  first(value).filesAfter.runtimeImages = 1;
}));
test('rejects a new image elsewhere in the owned isolation', () => reject('other-image-file', 'ISOLATION_FILES', 2, value => {
  restart(value).filesAfter.otherImages = 1;
}));
test('rejects an altered avatar image inventory despite the same file count', () => reject('avatar-inventory', 'AVATAR_INVENTORY', 1, value => {
  first(value).filesAfter.avatarInventorySha256 = 'c'.repeat(64);
}));
test('rejects a selected image different from the tracked fixture', () => reject('wrong-fixture', 'FIXTURE', 1, value => {
  first(value).fixture.sha256 = 'c'.repeat(64);
}));
test('rejects a fixture path included in the image evidence', () => reject('fixture-path', 'FIXTURE', 1, value => {
  first(value).fixture.path = '/synthetic/example.png';
}));
test('rejects a picker path handoff without one real image click', () => reject('no-image-click', 'INPUTS', 1, value => {
  first(value).inputs[1].mouseDispatchCount = 0;
}));
test('rejects removal without one observed control signal', () => reject('no-remove-signal', 'INPUTS', 1, value => {
  first(value).inputs[2].clickedSignals = 0;
}));
test('rejects a send click in place of removal', () => reject('send-click', 'INPUTS', 1, value => {
  first(value).inputs[2].control = 'sendChat';
}));
test('rejects a chooser handoff before the image button click', () => reject('handoff-before-click', 'EVENT_ORDER', 1, value => {
  first(value).selectionAtMs = first(value).inputs[1].atMs - 1;
}));
test('rejects a preview without the disclosure text', () => reject('missing-disclosure', 'PREVIEW', 1, value => {
  first(value).withPreview.disclosure = '';
}));
test('rejects a preview whose image is not ready', () => reject('preview-not-ready', 'PREVIEW', 1, value => {
  first(value).withPreview.previewReady = false;
}));
test('rejects a preview that cannot enable sending', () => reject('preview-send-disabled', 'PREVIEW', 1, value => {
  first(value).withPreview.sendEnabled = false;
}));
test('rejects a changed composer draft after removal', () => reject('draft-changed', 'COMPOSER_RESTORED', 1, value => {
  first(value).final.draftSha256 = 'c'.repeat(64);
}));
test('rejects a preview still present after restarting', () => reject('preview-on-restart', 'COMPOSER_RESTORED', 2, value => {
  restart(value).final.previewVisible = true;
}));
test('rejects a staged image still present in the bridge despite hidden UI', () => reject('bridge-staged-image', 'TERMINAL_OBSERVATION', 2, value => {
  restart(value).lastObservation.bridgePreview = true;
}));
test('rejects a new selection passed off as restart readback', () => reject('selection-on-restart', 'RESTART_SELECTION', 2, value => {
  restart(value).selectionAtMs = 180;
}));
test('rejects a model HTTP request inside the nominally unsent tail', () => reject('model-in-tail', 'MODEL_DURING_TAIL', 1, value => {
  value.modelCallTiming[7].receivedEpochMs = first(value).tailStartEpochMs + 300;
}));
test('rejects a changed settings model request count', () => reject('model-count', 'MODEL_COUNT', 0, value => {
  value.requests++;
}));
