'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { ROOM_QUALITY_CONTRACT, verifyRoomQuality } = require('./room-quality-verdicts.cjs');

const epoch = 1794780000000;
function input(control, atMs) {
  return {control, atMs, mouseDispatchCount: 1, clickedSignals: 1, hitAccepted: true};
}
function reading(quality, atMs, quietSinceMs) {
  const scale = quality === 'smooth' ? 1 : 2;
  return {quality, roomQuality: quality, atMs, quietSinceMs, quietMs: atMs - quietSinceMs, changing: false,
    width: 1380, height: 900, textureWidth: 1380 * scale, textureHeight: 900 * scale,
    highlighted: {clear: false, balanced: quality === 'balanced', smooth: quality === 'smooth'}};
}
function report(cycle) {
  const start = epoch + cycle * 10000;
  const qualities = cycle === 1 ? ['balanced', 'smooth'] : ['smooth', 'balanced'];
  return {cycle: String(cycle), keepsake: {passed: true, tailEndEpochMs: start - 100}, roomQuality: {
    passed: true, error: '', cycle, deadlineMs: 20000, elapsedMs: 3500,
    tailStartEpochMs: start, tailEndEpochMs: start + 3500, devicePixelRatio: 2,
    navigationInputs: [input('nav-settings', 100), input('settingsTab-service', 300)],
    inputs: [input(`roomQuality-${qualities[1]}`, 1800)],
    readings: [reading(qualities[0], 1500, 500), reading(qualities[1], 3000, 2000)],
  }};
}
function fixture() {
  return {reports: [report(1), report(2)], requests: 9,
    modelCallTiming: Array.from({length: 9}, (_, index) => ({cycle: index === 8 ? 2 : 1,
      receivedEpochMs: epoch + (index === 8 ? 15000 : index * 100)}))};
}
const verify = value => verifyRoomQuality(value.reports, value.modelCallTiming, value.requests);
function rejects(id, reason, mutate, context = {}) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate,
    expectedReason: `ROOM_QUALITY_${reason}`, expectedContext: context});
}

const tail = (value, cycle) => value.reports[cycle - 1].roomQuality;
const read = (value, cycle, index) => tail(value, cycle).readings[index];

test('room quality tail binds restart persistence and both texture scales', () => {
  const result = verify(fixture());
  assert.equal(result.passed, true);
  assert.equal(result.contract, ROOM_QUALITY_CONTRACT);
  assert.equal(result.modelRequestsAdded, 0);
  assert.deepEqual(result.cycles.map(cycle => cycle.readings.map(row => row.quality)),
    [['balanced', 'smooth'], ['smooth', 'balanced']]);
});
test('room quality rejects missing-cycle',
  () => rejects('missing-cycle', 'CYCLES', value => value.reports.pop()));
test('room quality rejects wrong-cycle-order',
  () => rejects('wrong-cycle-order', 'CYCLE', value => value.reports.reverse(), {cycle: 1}));
test('room quality rejects missing-tail',
  () => rejects('missing-tail', 'CYCLE', value => delete value.reports[0].roomQuality, {cycle: 1}));
test('room quality rejects failed-tail',
  () => rejects('failed-tail', 'CYCLE', value => value.reports[0].roomQuality.passed = false, {cycle: 1}));
test('room quality rejects error-in-tail',
  () => rejects('error-in-tail', 'CYCLE', value => value.reports[0].roomQuality.error = 'failed', {cycle: 1}));
test('room quality rejects deadline-extended',
  () => rejects('deadline-extended', 'CLOCK', value => value.reports[0].roomQuality.deadlineMs++, {cycle: 1}));
test('room quality rejects elapsed-exceeds-deadline',
  () => rejects('elapsed-exceeds-deadline', 'CLOCK', value => value.reports[0].roomQuality.elapsedMs = 20000, {cycle: 1}));
test('room quality rejects inconsistent-epoch-clock',
  () => rejects('inconsistent-epoch-clock', 'CLOCK', value => value.reports[0].roomQuality.tailEndEpochMs += 101, {cycle: 1}));
test('room quality rejects tail-before-keepsake',
  () => rejects('tail-before-keepsake', 'AFTER_KEEPSAKE', value => value.reports[0].keepsake.tailEndEpochMs += 101, {cycle: 1}));
test('room quality rejects keepsake-failed',
  () => rejects('keepsake-failed', 'AFTER_KEEPSAKE', value => value.reports[0].keepsake.passed = false, {cycle: 1}));

test('room quality rejects cycle-1-dpr-one',
  () => rejects('cycle-1-dpr-one', 'DPR', value => tail(value, 1).devicePixelRatio = 1, {cycle: 1}));
test('room quality rejects cycle-1-dpr-string',
  () => rejects('cycle-1-dpr-string', 'DPR', value => tail(value, 1).devicePixelRatio = '2', {cycle: 1}));
test('room quality rejects cycle-1-missing-navigation',
  () => rejects('cycle-1-missing-navigation', 'NAVIGATION', value => tail(value, 1).navigationInputs.pop(), {cycle: 1}));
test('room quality rejects cycle-1-missing-click',
  () => rejects('cycle-1-missing-click', 'INPUT', value => tail(value, 1).inputs = [], {cycle: 1}));
test('room quality rejects cycle-1-extra-click',
  () => rejects('cycle-1-extra-click', 'INPUT', value => tail(value, 1).inputs.push({...tail(value, 1).inputs[0]}), {cycle: 1}));
test('room quality rejects cycle-1-wrong-button',
  () => rejects('cycle-1-wrong-button', 'INPUT', value => tail(value, 1).inputs[0].control = 'roomQuality-clear', {cycle: 1}));
test('room quality rejects cycle-1-mouseDispatchCount',
  () => rejects('cycle-1-mouseDispatchCount', 'INPUT', value => tail(value, 1).inputs[0].mouseDispatchCount = 2, {cycle: 1}));
test('room quality rejects cycle-1-clickedSignals',
  () => rejects('cycle-1-clickedSignals', 'INPUT', value => tail(value, 1).inputs[0].clickedSignals = 2, {cycle: 1}));
test('room quality rejects cycle-1-missed-hit',
  () => rejects('cycle-1-missed-hit', 'INPUT', value => tail(value, 1).inputs[0].hitAccepted = false, {cycle: 1}));
test('room quality rejects cycle-1-missing-reading',
  () => rejects('cycle-1-missing-reading', 'READINGS', value => tail(value, 1).readings.pop(), {cycle: 1}));

test('room quality rejects cycle-1-reading-0-wrong-quality',
  () => rejects('cycle-1-reading-0-wrong-quality', 'VALUE', value => read(value, 1, 0).quality = 'clear', {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-main-not-bound',
  () => rejects('cycle-1-reading-0-main-not-bound', 'VALUE', value => read(value, 1, 0).roomQuality = 'clear', {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-extra-highlight',
  () => rejects('cycle-1-reading-0-extra-highlight', 'HIGHLIGHT', value => read(value, 1, 0).highlighted.clear = true, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-no-highlight',
  () => rejects('cycle-1-reading-0-no-highlight', 'HIGHLIGHT', value => read(value, 1, 0).highlighted[read(value, 1, 0).quality] = false, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-still-changing',
  () => rejects('cycle-1-reading-0-still-changing', 'QUIET', value => read(value, 1, 0).changing = true, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-not-one-second',
  () => rejects('cycle-1-reading-0-not-one-second', 'QUIET', value => {
    read(value, 1, 0).quietSinceMs++;
    read(value, 1, 0).quietMs--;
  }, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-quiet-clock-mismatch',
  () => rejects('cycle-1-reading-0-quiet-clock-mismatch', 'QUIET', value => read(value, 1, 0).quietMs++, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-wrong-width',
  () => rejects('cycle-1-reading-0-wrong-width', 'TEXTURE', value => read(value, 1, 0).textureWidth++, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-wrong-height',
  () => rejects('cycle-1-reading-0-wrong-height', 'TEXTURE', value => read(value, 1, 0).textureHeight++, {cycle: 1, reading: 0}));
test('room quality rejects cycle-1-reading-0-zero-geometry',
  () => rejects('cycle-1-reading-0-zero-geometry', 'TEXTURE', value => read(value, 1, 0).width = 0, {cycle: 1, reading: 0}));

test('room quality rejects cycle-1-reading-1-wrong-quality',
  () => rejects('cycle-1-reading-1-wrong-quality', 'VALUE', value => read(value, 1, 1).quality = 'clear', {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-main-not-bound',
  () => rejects('cycle-1-reading-1-main-not-bound', 'VALUE', value => read(value, 1, 1).roomQuality = 'clear', {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-extra-highlight',
  () => rejects('cycle-1-reading-1-extra-highlight', 'HIGHLIGHT', value => read(value, 1, 1).highlighted.clear = true, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-no-highlight',
  () => rejects('cycle-1-reading-1-no-highlight', 'HIGHLIGHT', value => read(value, 1, 1).highlighted[read(value, 1, 1).quality] = false, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-still-changing',
  () => rejects('cycle-1-reading-1-still-changing', 'QUIET', value => read(value, 1, 1).changing = true, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-not-one-second',
  () => rejects('cycle-1-reading-1-not-one-second', 'QUIET', value => {
    read(value, 1, 1).quietSinceMs++;
    read(value, 1, 1).quietMs--;
  }, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-quiet-clock-mismatch',
  () => rejects('cycle-1-reading-1-quiet-clock-mismatch', 'QUIET', value => read(value, 1, 1).quietMs++, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-wrong-width',
  () => rejects('cycle-1-reading-1-wrong-width', 'TEXTURE', value => read(value, 1, 1).textureWidth++, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-wrong-height',
  () => rejects('cycle-1-reading-1-wrong-height', 'TEXTURE', value => read(value, 1, 1).textureHeight++, {cycle: 1, reading: 1}));
test('room quality rejects cycle-1-reading-1-zero-geometry',
  () => rejects('cycle-1-reading-1-zero-geometry', 'TEXTURE', value => read(value, 1, 1).width = 0, {cycle: 1, reading: 1}));

test('room quality rejects cycle-1-quiet-started-before-click',
  () => rejects('cycle-1-quiet-started-before-click', 'ORDER', value => {
    const after = tail(value, 1).readings[1];
    after.quietSinceMs = tail(value, 1).inputs[0].atMs - 1;
    after.quietMs = after.atMs - after.quietSinceMs;
  }, {cycle: 1}));
test('room quality rejects cycle-1-click-before-initial-read',
  () => rejects('cycle-1-click-before-initial-read', 'ORDER', value => tail(value, 1).inputs[0].atMs = 1499, {cycle: 1}));
test('room quality rejects cycle-1-model-request-in-tail',
  () => rejects('cycle-1-model-request-in-tail', 'MODEL_DURING_TAIL', value => {
    value.modelCallTiming[0].receivedEpochMs = tail(value, 1).tailStartEpochMs;
  }, {cycle: 1}));

test('room quality rejects cycle-2-dpr-one',
  () => rejects('cycle-2-dpr-one', 'DPR', value => tail(value, 2).devicePixelRatio = 1, {cycle: 2}));
test('room quality rejects cycle-2-dpr-string',
  () => rejects('cycle-2-dpr-string', 'DPR', value => tail(value, 2).devicePixelRatio = '2', {cycle: 2}));
test('room quality rejects cycle-2-missing-navigation',
  () => rejects('cycle-2-missing-navigation', 'NAVIGATION', value => tail(value, 2).navigationInputs.pop(), {cycle: 2}));
test('room quality rejects cycle-2-missing-click',
  () => rejects('cycle-2-missing-click', 'INPUT', value => tail(value, 2).inputs = [], {cycle: 2}));
test('room quality rejects cycle-2-extra-click',
  () => rejects('cycle-2-extra-click', 'INPUT', value => tail(value, 2).inputs.push({...tail(value, 2).inputs[0]}), {cycle: 2}));
test('room quality rejects cycle-2-wrong-button',
  () => rejects('cycle-2-wrong-button', 'INPUT', value => tail(value, 2).inputs[0].control = 'roomQuality-clear', {cycle: 2}));
test('room quality rejects cycle-2-mouseDispatchCount',
  () => rejects('cycle-2-mouseDispatchCount', 'INPUT', value => tail(value, 2).inputs[0].mouseDispatchCount = 2, {cycle: 2}));
test('room quality rejects cycle-2-clickedSignals',
  () => rejects('cycle-2-clickedSignals', 'INPUT', value => tail(value, 2).inputs[0].clickedSignals = 2, {cycle: 2}));
test('room quality rejects cycle-2-missed-hit',
  () => rejects('cycle-2-missed-hit', 'INPUT', value => tail(value, 2).inputs[0].hitAccepted = false, {cycle: 2}));
test('room quality rejects cycle-2-missing-reading',
  () => rejects('cycle-2-missing-reading', 'READINGS', value => tail(value, 2).readings.pop(), {cycle: 2}));

test('room quality rejects cycle-2-reading-0-wrong-quality',
  () => rejects('cycle-2-reading-0-wrong-quality', 'VALUE', value => read(value, 2, 0).quality = 'clear', {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-main-not-bound',
  () => rejects('cycle-2-reading-0-main-not-bound', 'VALUE', value => read(value, 2, 0).roomQuality = 'clear', {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-extra-highlight',
  () => rejects('cycle-2-reading-0-extra-highlight', 'HIGHLIGHT', value => read(value, 2, 0).highlighted.clear = true, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-no-highlight',
  () => rejects('cycle-2-reading-0-no-highlight', 'HIGHLIGHT', value => read(value, 2, 0).highlighted[read(value, 2, 0).quality] = false, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-still-changing',
  () => rejects('cycle-2-reading-0-still-changing', 'QUIET', value => read(value, 2, 0).changing = true, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-not-one-second',
  () => rejects('cycle-2-reading-0-not-one-second', 'QUIET', value => {
    read(value, 2, 0).quietSinceMs++;
    read(value, 2, 0).quietMs--;
  }, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-quiet-clock-mismatch',
  () => rejects('cycle-2-reading-0-quiet-clock-mismatch', 'QUIET', value => read(value, 2, 0).quietMs++, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-wrong-width',
  () => rejects('cycle-2-reading-0-wrong-width', 'TEXTURE', value => read(value, 2, 0).textureWidth++, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-wrong-height',
  () => rejects('cycle-2-reading-0-wrong-height', 'TEXTURE', value => read(value, 2, 0).textureHeight++, {cycle: 2, reading: 0}));
test('room quality rejects cycle-2-reading-0-zero-geometry',
  () => rejects('cycle-2-reading-0-zero-geometry', 'TEXTURE', value => read(value, 2, 0).width = 0, {cycle: 2, reading: 0}));

test('room quality rejects cycle-2-reading-1-wrong-quality',
  () => rejects('cycle-2-reading-1-wrong-quality', 'VALUE', value => read(value, 2, 1).quality = 'clear', {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-main-not-bound',
  () => rejects('cycle-2-reading-1-main-not-bound', 'VALUE', value => read(value, 2, 1).roomQuality = 'clear', {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-extra-highlight',
  () => rejects('cycle-2-reading-1-extra-highlight', 'HIGHLIGHT', value => read(value, 2, 1).highlighted.clear = true, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-no-highlight',
  () => rejects('cycle-2-reading-1-no-highlight', 'HIGHLIGHT', value => read(value, 2, 1).highlighted[read(value, 2, 1).quality] = false, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-still-changing',
  () => rejects('cycle-2-reading-1-still-changing', 'QUIET', value => read(value, 2, 1).changing = true, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-not-one-second',
  () => rejects('cycle-2-reading-1-not-one-second', 'QUIET', value => {
    read(value, 2, 1).quietSinceMs++;
    read(value, 2, 1).quietMs--;
  }, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-quiet-clock-mismatch',
  () => rejects('cycle-2-reading-1-quiet-clock-mismatch', 'QUIET', value => read(value, 2, 1).quietMs++, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-wrong-width',
  () => rejects('cycle-2-reading-1-wrong-width', 'TEXTURE', value => read(value, 2, 1).textureWidth++, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-wrong-height',
  () => rejects('cycle-2-reading-1-wrong-height', 'TEXTURE', value => read(value, 2, 1).textureHeight++, {cycle: 2, reading: 1}));
test('room quality rejects cycle-2-reading-1-zero-geometry',
  () => rejects('cycle-2-reading-1-zero-geometry', 'TEXTURE', value => read(value, 2, 1).width = 0, {cycle: 2, reading: 1}));

test('room quality rejects cycle-2-quiet-started-before-click',
  () => rejects('cycle-2-quiet-started-before-click', 'ORDER', value => {
    const after = tail(value, 2).readings[1];
    after.quietSinceMs = tail(value, 2).inputs[0].atMs - 1;
    after.quietMs = after.atMs - after.quietSinceMs;
  }, {cycle: 2}));
test('room quality rejects cycle-2-click-before-initial-read',
  () => rejects('cycle-2-click-before-initial-read', 'ORDER', value => tail(value, 2).inputs[0].atMs = 1499, {cycle: 2}));
test('room quality rejects cycle-2-model-request-in-tail',
  () => rejects('cycle-2-model-request-in-tail', 'MODEL_DURING_TAIL', value => {
    value.modelCallTiming[0].receivedEpochMs = tail(value, 2).tailStartEpochMs;
  }, {cycle: 2}));

test('room quality rejects overlapping-cycles',
  () => rejects('overlapping-cycles', 'CYCLE_ORDER', value => {
    const first = value.reports[0].roomQuality, second = value.reports[1].roomQuality;
    second.tailStartEpochMs = first.tailEndEpochMs;
    second.tailEndEpochMs = second.tailStartEpochMs + second.elapsedMs;
    value.reports[1].keepsake.tailEndEpochMs = second.tailStartEpochMs - 100;
  }));
test('room quality rejects invalid-model-timing',
  () => rejects('invalid-model-timing', 'MODEL_TRACE', value => value.modelCallTiming[0].receivedEpochMs = null));
test('room quality rejects wrong-model-count',
  () => rejects('wrong-model-count', 'MODEL_COUNT', value => value.requests++));
test('room quality rejects missing-model-timing',
  () => rejects('missing-model-timing', 'MODEL_COUNT', value => value.modelCallTiming.pop()));
