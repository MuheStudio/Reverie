'use strict';

const assert = require('node:assert/strict');
const {isDeepStrictEqual} = require('node:util');
const {verdictReason} = require('./verdict-test-support.cjs');

const PERSONA_STATE_CONTRACT = 'reverie.native.persona-state.verdict.v1';
const DEADLINE_MS = 20000;
const RELATIONSHIP = 'relationship:get', MOOD = 'emotion:get', SWITCH = 'persona:activate';
const SWITCH_LIFECYCLE = new Set(['local_mode:set', 'persona:get', 'persona:list', 'settings:get', 'chat:history',
  'archive:get', 'summary:status', 'ai_usage:get', 'api:budget:get', 'user:profile:get', 'module:list', 'provider:get']);
const MOODS = new Map(Object.entries({happy: '开心', peaceful: '平静', excited: '兴奋', sad: '难过',
  angry: '生气', anxious: '焦虑', upset: '委屈', moved: '感动', 'low-energy': '没精神'}));
const EMOTIONS = new Map(Object.entries({joy: '喜悦', calm: '平静', excitement: '兴奋', sadness: '难过',
  anger: '生气', anxiety: '焦虑', grievance: '委屈', touched: '感动'}));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestId = value => typeof value === 'string' && /^qt_[a-f0-9]{32}$/.test(value);
const personaId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const number = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;

function guard(condition, reason, context) {
  assert(condition, verdictReason(`PERSONA_STATE_${reason}`, context));
}

function scopeParts(value, context) {
  guard(typeof value === 'string', 'SCOPE', context);
  const parts = value.split(':');
  guard(parts.length === 3 && personaId(parts[0]) && /^[0-9]+$/.test(parts[1]) && whole(Number(parts[1])) &&
    sha256(parts[2]), 'SCOPE', context);
  return {id: parts[0], epoch: Number(parts[1]), fingerprint: parts[2]};
}

function relationshipDisplay(payload, context) {
  guard(object(payload) && !Object.hasOwn(payload, 'error') && (!Object.hasOwn(payload, 'ok') || payload.ok === true) &&
    whole(payload.intimacy) && whole(payload.interaction_count) && typeof payload.stage_detail === 'string' &&
    payload.stage_detail.length > 0 && Array.isArray(payload.thresholds) && payload.thresholds.length === 4,
  'RELATIONSHIP_RECEIPT', context);
  const [rows, score] = [payload.thresholds, payload.intimacy];
  const keys = new Set();
  for (const [index, row] of rows.entries()) {
    guard(object(row) && typeof row.key === 'string' && row.key.length > 0 && !keys.has(row.key) &&
      typeof row.label === 'string' && row.label.length > 0 && row.min === (index === 0 ? 0 : rows[index - 1].max + 1) &&
      (index === rows.length - 1 ? row.max === null : whole(row.max) && row.max >= row.min),
    'RELATIONSHIP_RECEIPT', context);
    keys.add(row.key);
  }
  const index = rows.findIndex(row => row.min <= score && (row.max === null || score <= row.max));
  const stage = rows[index], next = rows[index + 1];
  guard(stage && payload.stage_number === index + 1 && payload.stage_key === stage.key && payload.stage === stage.label,
    'RELATIONSHIP_RECEIPT', context);
  return {stage: `关系：${stage.label}`, detail: payload.stage_detail, note: '随聊天慢慢变化，离开多久都不会减少。',
    intimacy: `亲密度 ${score}` + (next ? `，到「${next.label}」还差 ${next.min - score}` : '')};
}

function moodDisplay(payload, context) {
  guard(object(payload) && !Object.hasOwn(payload, 'error') && MOODS.has(payload.mood) && object(payload.emotions) &&
    Object.keys(payload.emotions).length === EMOTIONS.size && number(payload.intensity, 1) &&
    Array.isArray(payload.dominant) && payload.dominant.length >= 2 && payload.dominant.length <= EMOTIONS.size,
  'MOOD_RECEIPT', context);
  for (const [name, score] of Object.entries(payload.emotions)) {
    guard(EMOTIONS.has(name) && number(score, 100), 'MOOD_RECEIPT', context);
  }
  const names = new Set();
  for (const [index, row] of payload.dominant.entries()) {
    guard(object(row) && EMOTIONS.has(row.name) && !names.has(row.name) && row.value === payload.emotions[row.name] &&
      (index === 0 || payload.dominant[index - 1].value >= row.value), 'MOOD_RECEIPT', context);
    names.add(row.name);
  }
  return {label: `心情：${MOODS.get(payload.mood)}`, dominant: '现在最明显的是' + payload.dominant.slice(0, 2)
    .map(row => `${EMOTIONS.get(row.name)} ${Math.round(row.value)}`).join('、')};
}

function checkCycle(report, cycle, original, other, identities, allIds) {
  const context = {cycle};
  const tail = report?.personaState;
  guard(report?.cycle === String(cycle) && tail?.passed === true && tail.error === '' && tail.cycle === cycle, 'CYCLE', context);
  const {elapsedMs, tailStartEpochMs, tailEndEpochMs, commands, receipts, snapshots, inputs} = tail;
  guard(tail.deadlineMs === DEADLINE_MS && whole(elapsedMs) && elapsedMs < DEADLINE_MS && whole(tailStartEpochMs) &&
    tailStartEpochMs > 0 && whole(tailEndEpochMs) && tailEndEpochMs >= tailStartEpochMs &&
    tailEndEpochMs - tailStartEpochMs < DEADLINE_MS && Math.abs(tailEndEpochMs - tailStartEpochMs - elapsedMs) <= 100,
  'DEADLINE', context);
  guard(tail.initialPersonaId === original && tail.finalPersonaId === original &&
    report.cardEdit?.after?.activeId === original && Array.isArray(report.personas?.profiles) &&
    isDeepStrictEqual(report.personas.profiles.filter(row => row.active).map(row => row.id), [original]), 'PERSONA_PAIR', context);
  guard(Array.isArray(snapshots) && isDeepStrictEqual(snapshots.map(row => row?.personaId), [original, other, original]),
    'PERSONA_PAIR', context);
  const [initial, alternate, returned] = snapshots;
  guard(initial.scope === report.cardEdit.after.scope && initial.generation === report.cardEdit.after.generation &&
    whole(initial.generation) && initial.generation > 0, 'SCOPE', context);

  const controls = [`personaSwitch-${other}`, 'personaSwitchConfirm', `personaSwitch-${original}`, 'personaSwitchConfirm'];
  guard(Array.isArray(inputs) && inputs.length === controls.length && inputs.every((input, index) =>
    input?.control === controls[index] && input.mouseDispatchCount === 1 && input.clickedSignals === 1 && whole(input.atMs)),
  'INPUT', context);
  const groups = [[], [], []], switches = [];
  guard(Array.isArray(commands) && commands.length <= 64 && Array.isArray(receipts) && receipts.length === 6, 'TRAFFIC', context);
  let commandAt = 0;
  for (const command of commands) {
    guard(requestId(command?.id) && !allIds.has(command.id) && whole(command.atMs) && command.atMs >= commandAt &&
      command.atMs <= elapsedMs, 'COMMAND_ID', context);
    allIds.add(command.id);
    commandAt = command.atMs;
    const visit = switches.length;
    if (command.command === SWITCH) {
      guard(visit < 2, 'TRAFFIC', context);
      switches.push(command);
    } else {
      guard(command.command === RELATIONSHIP || command.command === MOOD || visit > 0 && SWITCH_LIFECYCLE.has(command.command),
        'TRAFFIC', context);
      groups[visit].push(command);
    }
    guard(command.scope === snapshots[visit].scope && command.generation === snapshots[visit].generation, 'COMMAND_SCOPE', context);
  }
  guard(switches.length === 2, 'TRAFFIC', context);
  let scope;
  const reads = new Set();
  const values = snapshots.map((snapshot, visit) => {
    const visitContext = {cycle, visit};
    const current = scopeParts(snapshot.scope, visitContext);
    const identity = identities.get(snapshot.personaId);
    guard(snapshot.generation === initial.generation + visit && current.id === identity.id &&
      current.fingerprint === identity.fingerprint &&
      (visit === 0 || current.epoch === scope.epoch + 1), 'SCOPE', visitContext);
    scope = current;
    guard(snapshot.emotionEnabled === true && whole(snapshot.atMs) && snapshot.atMs <= elapsedMs, 'EMOTION_ENABLED', visitContext);
    guard(Array.isArray(snapshot.history) && snapshot.history.some(row => row?.role === 'user') &&
      snapshot.history.every(row => typeof row?.id === 'string' && row.id.length > 0 && ['user', 'assistant'].includes(row.role)),
    'HISTORY', visitContext);
    guard(object(snapshot.archive) && whole(snapshot.archive.revision) && sha256(snapshot.archive.sha256), 'ARCHIVE', visitContext);
    const pair = [RELATIONSHIP, MOOD].map((kind, index) => {
      const id = index === 0 ? snapshot.relationshipId : snapshot.moodId;
      const matching = groups[visit].filter(row => row.command === kind);
      const replies = receipts.filter(row => row?.id === id && row.command === kind);
      guard(matching.length === 1 && matching[0].id === id && replies.length === 1 && !reads.has(id),
        'RECEIPT_BINDING', visitContext);
      const reply = replies[0];
      guard(reply.scope === snapshot.scope && reply.generation === snapshot.generation && whole(reply.atMs) &&
        matching[0].atMs <= reply.atMs && reply.atMs <= snapshot.atMs, 'RECEIPT_BINDING', visitContext);
      reads.add(id);
      return reply.payload;
    });
    if (visit > 0) {
      const previous = snapshots[visit - 1], sent = switches[visit - 1];
      const [select, confirm] = inputs.slice((visit - 1) * 2, visit * 2);
      guard([select, confirm].every(row => row.scope === previous.scope && row.generation === previous.generation) &&
        previous.atMs <= select.atMs && select.atMs <= confirm.atMs && confirm.atMs <= sent.atMs &&
        sent.atMs <= snapshot.atMs && snapshot.switchRequestId === sent.id &&
        groups[visit].every(command => sent.atMs <= command.atMs && command.atMs <= snapshot.atMs), 'SWITCH', visitContext);
    }
    guard(isDeepStrictEqual(snapshot.relationshipShown, relationshipDisplay(pair[0], visitContext)),
      'RELATIONSHIP_DISPLAY', visitContext);
    guard(isDeepStrictEqual(snapshot.moodShown, moodDisplay(pair[1], visitContext)), 'MOOD_DISPLAY', visitContext);
    return {personaId: snapshot.personaId, relationship: pair[0], mood: pair[1]};
  });
  guard(initial.switchRequestId === '' && reads.size === 6 && initial.archive.revision === report.cardEdit.after.archiveRevision &&
    isDeepStrictEqual(initial.history.map(row => row.id), report.cardEdit.after.messageIds) &&
    isDeepStrictEqual(initial.history, returned.history) &&
    isDeepStrictEqual(returned.history, report.messages?.map(({id, role}) => ({id, role}))), 'HISTORY', context);
  guard(isDeepStrictEqual(initial.archive, returned.archive), 'ARCHIVE', context);
  guard(isDeepStrictEqual(values[0].relationship, values[2].relationship), 'RETURN_RELATIONSHIP', context);
  guard(values[0].relationship.interaction_count >= 1 && values[1].relationship.interaction_count >= 1 &&
    values[0].relationship.interaction_count !== values[1].relationship.interaction_count &&
    (cycle !== 1 || values[0].relationship.intimacy !== 50), 'INTERACTION_COUNTS', context);
  return {cycle, elapsedMs, tailStartEpochMs, tailEndEpochMs, values: values.slice(0, 2)};
}

function verifyPersonaState(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const moon = reports[0].archiveInteraction?.cardImport?.moonPersona;
  guard(personaId(moon) && moon !== 'default' && reports[1].startupPersona?.activeId === moon, 'PERSONA_PAIR');
  // The registry's default row is an alias. The signed card-edit tail carries
  // the sealed ID and fingerprint for each cycle's active persona.
  const moonIdentity = scopeParts(reports[0].cardEdit?.after?.scope, {cycle: 1});
  const defaultIdentity = scopeParts(reports[1].cardEdit?.after?.scope, {cycle: 2});
  guard(moonIdentity.id === moon && defaultIdentity.id !== moon, 'PERSONA_PAIR');
  const identities = new Map([[moon, moonIdentity], ['default', defaultIdentity]]);
  const seenIds = new Set();
  const first = checkCycle(reports[0], 1, moon, 'default', identities, seenIds);
  const restart = checkCycle(reports[1], 2, 'default', moon, identities, seenIds);
  guard(first.tailEndEpochMs < restart.tailStartEpochMs, 'TAIL_ORDER');
  for (const before of first.values) {
    const after = restart.values.find(value => value.personaId === before.personaId);
    guard(after && after.relationship.interaction_count >= before.relationship.interaction_count, 'RESTART_INTERACTIONS',
      {cycle: 2, personaId: before.personaId});
  }
  guard(requests === 28 && Array.isArray(modelCallTiming) && modelCallTiming.length === 28 &&
    modelCallTiming.every(row => [1, 2].includes(row?.cycle) && whole(row.receivedEpochMs) && row.receivedEpochMs > 0),
  'MODEL_TRACE');
  for (const {cycle, tailStartEpochMs, tailEndEpochMs} of [first, restart]) {
    guard(modelCallTiming.some(row => row.cycle === cycle && row.receivedEpochMs < tailStartEpochMs), 'MODEL_TRACE', {cycle});
    guard(!modelCallTiming.some(row => row.receivedEpochMs >= tailStartEpochMs && row.receivedEpochMs <= tailEndEpochMs),
      'MODEL_REQUEST', {cycle});
  }
  return {passed: true, contract: PERSONA_STATE_CONTRACT, modelRequestsAdded: 0,
    cycles: [first, restart].map(({cycle, elapsedMs, values}) => ({cycle, elapsedMs,
      personas: values.map(({personaId, relationship, mood}) => ({personaId, intimacy: relationship.intimacy,
        interactionCount: relationship.interaction_count, mood: mood.mood}))}))};
}

module.exports = {PERSONA_STATE_CONTRACT, verifyPersonaState};
