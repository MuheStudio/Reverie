'use strict';

const assert = require('node:assert/strict');
const {verdictReason} = require('./verdict-test-support.cjs');

const RELATIONSHIP_STATUS_CONTRACT = 'reverie.native.relationship-status.verdict.v1';
const DEADLINE_MS = 10000;
const READ = 'relationship:get';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function guard(condition, reason, context) {
  assert(condition, verdictReason(`RELATIONSHIP_STATUS_${reason}`, context));
}

function persona(scope, context) {
  guard(typeof scope === 'string', 'SCOPE', context);
  const parts = scope.split(':');
  guard(parts.length === 3 && /^[A-Za-z0-9_-]{4,128}$/.test(parts[0]) &&
    /^[0-9]+$/.test(parts[1]) && whole(Number(parts[1])) && sha256(parts[2]), 'SCOPE', context);
  return {id: parts[0], fingerprint: parts[2]};
}

function snapshotText(payload, context) {
  guard(object(payload) && !Object.hasOwn(payload, 'error') &&
    (!Object.hasOwn(payload, 'ok') || payload.ok === true) &&
    whole(payload.intimacy) && whole(payload.interaction_count) && nonempty(payload.stage) &&
    nonempty(payload.stage_key) && whole(payload.stage_number) && nonempty(payload.stage_detail), 'SNAPSHOT', context);

  const thresholds = payload.thresholds;
  guard(Array.isArray(thresholds) && thresholds.length === 4, 'THRESHOLDS', context);
  const keys = new Set(), labels = new Set();
  for (const [index, row] of thresholds.entries()) {
    const last = index === thresholds.length - 1;
    const minimum = index === 0 ? 0 : thresholds[index - 1].max + 1;
    guard(object(row) && nonempty(row.key) && nonempty(row.label) &&
      !keys.has(row.key) && !labels.has(row.label) && whole(row.min) && row.min === minimum &&
      (last ? row.max === null : whole(row.max) && row.max >= row.min), 'THRESHOLDS', context);
    keys.add(row.key);
    labels.add(row.label);
  }

  const index = thresholds.findIndex(row => payload.intimacy >= row.min &&
    (row.max === null || payload.intimacy <= row.max));
  const stage = thresholds[index], next = thresholds[index + 1];
  guard(stage && stage.key === payload.stage_key && stage.label === payload.stage &&
    payload.stage_number === index + 1, 'STAGE', context);

  const intimacy = `亲密度 ${payload.intimacy}`;
  return {
    stage: `关系：${stage.label}`,
    detail: payload.stage_detail,
    intimacy: next ? `${intimacy}，到「${next.label}」还差 ${next.min - payload.intimacy}` : intimacy,
    note: '随聊天慢慢变化，离开多久都不会减少。',
  };
}

function checkCycle(report, cycle) {
  const context = {cycle};
  const tail = report?.relationshipStatus;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
    tail.passed === true && tail.error === '', 'CYCLE', context);
  const {deadlineMs, elapsedMs, tailStartEpochMs, tailEndEpochMs} = tail;
  guard(deadlineMs === DEADLINE_MS && whole(elapsedMs) && elapsedMs < DEADLINE_MS, 'DEADLINE', context);
  guard(whole(tailStartEpochMs) && tailStartEpochMs > 0 && whole(tailEndEpochMs), 'TAIL_CLOCK', context);
  const epochElapsed = tailEndEpochMs - tailStartEpochMs;
  // The application uses elapsed time for the deadline and wall time to join
  // its window to the model server's independently observed request times.
  guard(whole(epochElapsed) && epochElapsed < DEADLINE_MS && Math.abs(epochElapsed - elapsedMs) <= 100,
    'TAIL_CLOCK', context);

  const activePersona = persona(tail.scopeBefore, context);
  guard(tail.scopeAfter === tail.scopeBefore && whole(tail.generationBefore) && tail.generationBefore > 0 &&
    tail.generationAfter === tail.generationBefore, 'SCOPE', context);
  const {navigation, commands, receipts} = tail;
  guard(object(navigation) && navigation.control === 'nav-character' &&
    navigation.mouseDispatchCount === 1 && navigation.clickedSignals === 1, 'NAVIGATION', context);
  guard(Array.isArray(commands) && commands.length === 1 && commands[0]?.command === READ, 'COMMANDS', context);
  guard(Array.isArray(receipts) && receipts.length === 1 && receipts[0]?.command === READ, 'RECEIPTS', context);
  const [command] = commands, [receipt] = receipts;
  guard(typeof command.id === 'string' && /^qt_[a-f0-9]{32}$/.test(command.id) &&
    receipt.id === command.id && tail.shownRequestId === command.id &&
    command.scope === tail.scopeBefore && receipt.scope === tail.scopeBefore &&
    command.generation === tail.generationBefore && receipt.generation === tail.generationBefore,
    'REQUEST_BINDING', context);
  guard([navigation.atMs, command.atMs, receipt.atMs].every(whole) && navigation.atMs <= command.atMs &&
    command.atMs <= receipt.atMs && receipt.atMs <= elapsedMs, 'EVENT_ORDER', context);

  const shown = snapshotText(receipt.payload, context);
  for (const [field, value] of Object.entries(shown)) {
    guard(tail.shown?.[field] === value, 'DISPLAY', {cycle, field});
  }

  const {archiveBefore, archiveAfter} = tail;
  guard(object(archiveBefore) && object(archiveAfter) && sha256(archiveBefore.sha256) &&
    (archiveBefore.revision === null || whole(archiveBefore.revision)) &&
    archiveBefore.sha256 === archiveAfter.sha256 && archiveBefore.revision === archiveAfter.revision,
    'ARCHIVE', context);

  return {cycle, elapsedMs, tailStartEpochMs, tailEndEpochMs, persona: activePersona, requestId: command.id,
    stage: receipt.payload.stage, intimacy: receipt.payload.intimacy, interactionCount: receipt.payload.interaction_count};
}

function verifyRelationshipStatus(reports, modelCallTiming) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const cycles = [checkCycle(reports[0], 1), checkCycle(reports[1], 2)];
  const [first, restart] = cycles;
  guard(first.interactionCount >= 1, 'NO_INTERACTIONS', {cycle: 1});
  guard(first.intimacy !== 50, 'INITIAL_INTIMACY', {cycle: 1});
  guard(first.tailEndEpochMs < restart.tailStartEpochMs, 'TAIL_ORDER');
  guard(restart.persona.id === first.persona.id && restart.persona.fingerprint === first.persona.fingerprint,
    'RESTART_PERSONA', {cycle: 2});
  guard(restart.requestId !== first.requestId, 'RESTART_REQUEST', {cycle: 2});
  guard(restart.intimacy >= first.intimacy, 'RESTART_INTIMACY', {cycle: 2});
  guard(restart.interactionCount >= first.interactionCount, 'RESTART_INTERACTIONS', {cycle: 2});

  guard(Array.isArray(modelCallTiming), 'MODEL_TRACE');
  for (const call of modelCallTiming) {
    guard(object(call) && [1, 2].includes(call.cycle) && whole(call.receivedEpochMs) && call.receivedEpochMs > 0,
      'MODEL_TRACE');
  }
  for (const tail of cycles) {
    const {cycle, tailStartEpochMs, tailEndEpochMs} = tail;
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tailStartEpochMs && call.receivedEpochMs <= tailEndEpochMs),
      'MODEL_REQUEST', {cycle});
    guard(modelCallTiming.some(call => call.cycle === cycle && call.receivedEpochMs < tailStartEpochMs),
      'MODEL_TRACE', {cycle});
  }

  return {passed: true, contract: RELATIONSHIP_STATUS_CONTRACT, modelRequestsAdded: 0,
    cycles: cycles.map(({cycle, requestId, stage, intimacy, interactionCount, elapsedMs}) =>
      ({cycle, requestId, stage, intimacy, interactionCount, elapsedMs}))};
}

module.exports = {RELATIONSHIP_STATUS_CONTRACT, verifyRelationshipStatus};
