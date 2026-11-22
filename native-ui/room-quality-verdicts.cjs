'use strict';

const assert = require('node:assert/strict');
const { verdictReason } = require('./verdict-test-support.cjs');
const ROOM_QUALITY_CONTRACT = 'reverie.native.room-quality.verdict.v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;

function guard(valid, reason, context) {
  assert(valid, verdictReason(`ROOM_QUALITY_${reason}`, context));
}

function inputValid(input, control, elapsedMs) {
  return object(input) && input.control === control && whole(input.atMs) && input.atMs <= elapsedMs &&
    input.mouseDispatchCount === 1 && input.clickedSignals === 1 && input.hitAccepted === true;
}

function checkCycle(report, cycle) {
  const context = {cycle};
  const tail = report?.roomQuality;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
    tail.passed === true && tail.error === '', 'CYCLE', context);
  guard(tail.deadlineMs === 20000 && whole(tail.elapsedMs) && tail.elapsedMs < tail.deadlineMs &&
    whole(tail.tailStartEpochMs) && tail.tailStartEpochMs > 0 && whole(tail.tailEndEpochMs) &&
    tail.tailEndEpochMs >= tail.tailStartEpochMs &&
    Math.abs(tail.tailEndEpochMs - tail.tailStartEpochMs - tail.elapsedMs) <= 100, 'CLOCK', context);
  guard(report.keepsake?.passed === true && whole(report.keepsake.tailEndEpochMs) &&
    report.keepsake.tailEndEpochMs <= tail.tailStartEpochMs, 'AFTER_KEEPSAKE', context);
  guard(tail.devicePixelRatio === 2, 'DPR', context);
  guard(Array.isArray(tail.navigationInputs) && tail.navigationInputs.length === 2 &&
    inputValid(tail.navigationInputs[0], 'nav-settings', tail.elapsedMs) &&
    inputValid(tail.navigationInputs[1], 'settingsTab-service', tail.elapsedMs) &&
    tail.navigationInputs[0].atMs <= tail.navigationInputs[1].atMs, 'NAVIGATION', context);
  const expected = cycle === 1 ? ['balanced', 'smooth'] : ['smooth', 'balanced'];
  guard(Array.isArray(tail.inputs) && tail.inputs.length === 1 &&
    inputValid(tail.inputs[0], `roomQuality-${expected[1]}`, tail.elapsedMs), 'INPUT', context);
  guard(Array.isArray(tail.readings) && tail.readings.length === 2, 'READINGS', context);
  for (const [index, reading] of tail.readings.entries()) {
    const at = {cycle, reading: index};
    guard(object(reading) && reading.quality === expected[index] && reading.roomQuality === expected[index],
      'VALUE', at);
    guard(object(reading.highlighted) && Object.keys(reading.highlighted).length === 3 &&
      ['clear', 'balanced', 'smooth'].every(value => reading.highlighted[value] === (value === expected[index])),
      'HIGHLIGHT', at);
    guard(whole(reading.atMs) && reading.atMs <= tail.elapsedMs && whole(reading.quietSinceMs) &&
      reading.changing === false && whole(reading.quietMs) && reading.quietMs >= 1000 &&
      reading.atMs - reading.quietSinceMs === reading.quietMs, 'QUIET', at);
    const scale = expected[index] === 'smooth' ? Math.max(1, tail.devicePixelRatio / 2) : tail.devicePixelRatio;
    guard(positive(reading.width) && positive(reading.height) &&
      reading.textureWidth === Math.round(reading.width * scale) &&
      reading.textureHeight === Math.round(reading.height * scale), 'TEXTURE', at);
  }
  const [before, after] = tail.readings;
  guard(tail.navigationInputs[1].atMs <= before.quietSinceMs && before.atMs <= tail.inputs[0].atMs &&
    tail.inputs[0].atMs <= after.quietSinceMs && after.atMs <= tail.elapsedMs, 'ORDER', context);
  return tail;
}

function verifyRoomQuality(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const tails = reports.map((report, index) => checkCycle(report, index + 1));
  guard(tails[0].tailEndEpochMs < tails[1].tailStartEpochMs, 'CYCLE_ORDER');
  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    (call.cycle === 1 || call.cycle === 2) && whole(call.receivedEpochMs)), 'MODEL_TRACE');
  for (const tail of tails) {
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tail.tailStartEpochMs &&
      call.receivedEpochMs <= tail.tailEndEpochMs), 'MODEL_DURING_TAIL', {cycle: tail.cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');
  return {passed: true, contract: ROOM_QUALITY_CONTRACT, modelRequestsAdded: 0,
    cycles: tails.map(tail => ({cycle: tail.cycle, devicePixelRatio: tail.devicePixelRatio,
      elapsedMs: tail.elapsedMs, readings: tail.readings, inputs: tail.inputs}))};
}

module.exports = {ROOM_QUALITY_CONTRACT, verifyRoomQuality};
