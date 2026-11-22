'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {RELATIONSHIP_STATUS_CONTRACT, verifyRelationshipStatus} = require('./relationship-status-verdicts.cjs');

const note = '随聊天慢慢变化，离开多久都不会减少。';
const detail = '<b>礼貌、客气、保持边界</b>';
const scope = `builtin_hoshino_yumetsuki:1:${'a'.repeat(64)}`;
const epoch = 1794297600000;
const thresholds = () => [
  {key: 'initial', label: '初识期', min: 0, max: 99},
  {key: 'familiar', label: '熟悉期', min: 100, max: 499},
  {key: 'trusted', label: '信任期', min: 500, max: 1999},
  {key: 'enduring', label: '长久陪伴期', min: 2000, max: null},
];

function report(cycle) {
  const id = `qt_${String(cycle).repeat(32)}`;
  const command = {id, command: 'relationship:get', scope, generation: cycle + 1, atMs: 40};
  const tailStartEpochMs = epoch + cycle * 1000;
  const archive = {revision: 7, sha256: 'c'.repeat(64)};
  return {cycle: String(cycle), relationshipStatus: {
    passed: true, error: '', cycle, deadlineMs: 10000, elapsedMs: 120,
    tailStartEpochMs, tailEndEpochMs: tailStartEpochMs + 120,
    scopeBefore: scope, scopeAfter: scope, generationBefore: cycle + 1, generationAfter: cycle + 1,
    navigation: {control: 'nav-character', mouseDispatchCount: 1, clickedSignals: 1, atMs: 40},
    commands: [command], receipts: [{...command, atMs: 64, payload: {
      intimacy: 58, stage: '初识期', stage_key: 'initial', stage_number: 1, stage_detail: detail,
      interaction_count: 3, thresholds: thresholds(),
    }}],
    shownRequestId: id,
    shown: {stage: '关系：初识期', detail, intimacy: '亲密度 58，到「熟悉期」还差 42', note},
    archiveBefore: {...archive}, archiveAfter: {...archive},
  }};
}

function fixture() {
  return {reports: [report(1), report(2)], modelCallTiming: [
    {cycle: 1, receivedEpochMs: epoch + 700}, {cycle: 2, receivedEpochMs: epoch + 1700},
  ]};
}

const verify = ({reports, modelCallTiming}) => verifyRelationshipStatus(reports, modelCallTiming);
const first = value => value.reports[0].relationshipStatus;
const restart = value => value.reports[1].relationshipStatus;
const payload = tail => tail.receipts[0].payload;

test('accepts two fresh reads for the same persona and unchanged persisted values', () => {
  const proof = verify(fixture());
  assert.deepEqual(proof, {passed: true, contract: RELATIONSHIP_STATUS_CONTRACT, modelRequestsAdded: 0,
    cycles: [1, 2].map(cycle => ({cycle, requestId: `qt_${String(cycle).repeat(32)}`, stage: '初识期',
      intimacy: 58, interactionCount: 3, elapsedMs: 120}))});
});

test('reads the stage boundary and next-stage wording from the receipt', () => {
  const value = fixture();
  const a = first(value), b = restart(value);
  for (const tail of [a, b]) {
    const rows = payload(tail).thresholds;
    rows[0].max = 89;
    Object.assign(rows[1], {min: 90, label: '越来越熟悉'});
  }
  payload(a).intimacy = 89;
  a.shown.intimacy = '亲密度 89，到「越来越熟悉」还差 1';
  Object.assign(payload(b), {intimacy: 90, stage: '越来越熟悉', stage_key: 'familiar', stage_number: 2});
  Object.assign(b.shown, {stage: '关系：越来越熟悉', intimacy: '亲密度 90，到「信任期」还差 410'});
  assert.deepEqual(verify(value).cycles.map(row => row.stage), ['初识期', '越来越熟悉']);
});

test('accepts a higher persisted count, a final stage without a next stage, and an absent archive revision', () => {
  const value = fixture();
  const tail = restart(value);
  Object.assign(payload(tail), {intimacy: 2000, stage: '长久陪伴期', stage_key: 'enduring', stage_number: 4,
    interaction_count: 4});
  Object.assign(tail.shown, {stage: '关系：长久陪伴期', intimacy: '亲密度 2000'});
  tail.archiveBefore.revision = null;
  tail.archiveAfter.revision = null;
  assert.deepEqual(verify(value).cycles.map(row => [row.intimacy, row.interactionCount]), [[58, 3], [2000, 4]]);
});

const firstCycle = {cycle: 1}, secondCycle = {cycle: 2};
const rejections = [
  ['missing-cycle', 'CYCLES', {}, value => value.reports.pop()],
  ['missing-tail', 'CYCLE', secondCycle, value => { delete value.reports[1].relationshipStatus; }],
  ['wrong-raw-cycle', 'CYCLE', firstCycle, value => { value.reports[0].cycle = '2'; }],
  ['tail-timed-out', 'DEADLINE', secondCycle, value => { restart(value).elapsedMs = 10000; }],
  ['wrong-clock-type', 'TAIL_CLOCK', secondCycle, value => { restart(value).tailStartEpochMs = 'unknown'; }],
  ['invalid-tail-clock', 'TAIL_CLOCK', firstCycle, value => { first(value).tailEndEpochMs += 500; }],
  ['overlapping-tail-windows', 'TAIL_ORDER', {}, value => {
    restart(value).tailStartEpochMs = first(value).tailStartEpochMs;
    restart(value).tailEndEpochMs = first(value).tailEndEpochMs;
  }],
  ['wrong-navigation', 'NAVIGATION', firstCycle, value => { first(value).navigation.control = 'nav-settings'; }],
  ['no-navigation-signal', 'NAVIGATION', secondCycle, value => { restart(value).navigation.clickedSignals = 0; }],
  ['connection-generation-changed', 'SCOPE', firstCycle, value => { first(value).generationAfter++; }],
  ['archive-dispatch', 'COMMANDS', firstCycle, value => { first(value).commands.push({command: 'archive:get'}); }],
  ['duplicate-relationship-read', 'COMMANDS', secondCycle, value => {
    restart(value).commands.push({...restart(value).commands[0]});
  }],
  ['no-relationship-receipt', 'RECEIPTS', secondCycle, value => { restart(value).receipts.pop(); }],
  ['stale-receipt-id', 'REQUEST_BINDING', secondCycle, value => {
    restart(value).receipts[0].id = first(value).commands[0].id;
  }],
  ['stale-receipt-persona', 'REQUEST_BINDING', firstCycle, value => {
    first(value).receipts[0].scope = scope.replace('hoshino_yumetsuki', 'alternate');
  }],
  ['stale-receipt-generation', 'REQUEST_BINDING', firstCycle, value => { first(value).receipts[0].generation--; }],
  ['old-displayed-request', 'REQUEST_BINDING', secondCycle, value => {
    restart(value).shownRequestId = first(value).shownRequestId;
  }],
  ['dispatch-before-navigation', 'EVENT_ORDER', firstCycle, value => { first(value).commands[0].atMs = 39; }],
  ['receipt-before-dispatch', 'EVENT_ORDER', secondCycle, value => { restart(value).receipts[0].atMs = 39; }],
  ['receipt-after-tail', 'EVENT_ORDER', secondCycle, value => { restart(value).receipts[0].atMs = 121; }],
  ['read-failed', 'SNAPSHOT', firstCycle, value => { payload(first(value)).error = '关系系统未初始化'; }],
  ['wrong-count-type', 'SNAPSHOT', secondCycle, value => { payload(restart(value)).interaction_count = '3'; }],
  ['missing-stage-detail', 'SNAPSHOT', firstCycle, value => { delete payload(first(value)).stage_detail; }],
  ['missing-threshold', 'THRESHOLDS', secondCycle, value => { payload(restart(value)).thresholds.pop(); }],
  ['threshold-gap', 'THRESHOLDS', firstCycle, value => { payload(first(value)).thresholds[1].min++; }],
  ['bounded-final-threshold', 'THRESHOLDS', firstCycle, value => { payload(first(value)).thresholds[3].max = 3000; }],
  ['stage-outside-score-range', 'STAGE', firstCycle, value => {
    Object.assign(payload(first(value)), {stage: '熟悉期', stage_key: 'familiar', stage_number: 2});
    first(value).shown.stage = '关系：熟悉期';
  }],
  ['wrong-stage-text', 'DISPLAY', {...firstCycle, field: 'stage'}, value => {
    first(value).shown.stage = '初识期';
  }],
  ['interpreted-markup', 'DISPLAY', {...secondCycle, field: 'detail'}, value => {
    restart(value).shown.detail = '礼貌、客气、保持边界';
  }],
  ['wrong-remaining-score', 'DISPLAY', {...firstCycle, field: 'intimacy'}, value => {
    first(value).shown.intimacy = '亲密度 58，到「熟悉期」还差 41';
  }],
  ['missing-note', 'DISPLAY', {...secondCycle, field: 'note'}, value => { delete restart(value).shown.note; }],
  ['changed-archive-revision', 'ARCHIVE', firstCycle, value => { first(value).archiveAfter.revision++; }],
  ['changed-archive-hash', 'ARCHIVE', secondCycle, value => { restart(value).archiveAfter.sha256 = 'd'.repeat(64); }],
  ['zero-interactions', 'NO_INTERACTIONS', firstCycle, value => { payload(first(value)).interaction_count = 0; }],
  ['default-score', 'INITIAL_INTIMACY', firstCycle, value => {
    payload(first(value)).intimacy = 50;
    first(value).shown.intimacy = '亲密度 50，到「熟悉期」还差 50';
  }],
  ['restarted-different-persona', 'RESTART_PERSONA', secondCycle, value => {
    const tail = restart(value), otherScope = scope.replace('hoshino_yumetsuki', 'alternate');
    tail.scopeBefore = tail.scopeAfter = tail.commands[0].scope = tail.receipts[0].scope = otherScope;
  }],
  ['reused-request-across-cycles', 'RESTART_REQUEST', secondCycle, value => {
    const tail = restart(value);
    tail.commands[0].id = tail.receipts[0].id = tail.shownRequestId = first(value).shownRequestId;
  }],
  ['lower-persisted-score', 'RESTART_INTIMACY', secondCycle, value => {
    payload(restart(value)).intimacy = 57;
    restart(value).shown.intimacy = '亲密度 57，到「熟悉期」还差 43';
  }],
  ['lower-persisted-count', 'RESTART_INTERACTIONS', secondCycle, value => { payload(restart(value)).interaction_count--; }],
  ['missing-model-trace', 'MODEL_TRACE', {}, value => { delete value.modelCallTiming; }],
  ['wrong-model-time-type', 'MODEL_TRACE', {}, value => { value.modelCallTiming[0].receivedEpochMs = 'unknown'; }],
  ['missing-restart-model-trace', 'MODEL_TRACE', secondCycle, value => value.modelCallTiming.pop()],
  ['model-request-at-first-tail-start', 'MODEL_REQUEST', firstCycle, value => {
    value.modelCallTiming.push({cycle: 1, receivedEpochMs: first(value).tailStartEpochMs});
  }],
  ['model-request-at-restart-tail-end', 'MODEL_REQUEST', secondCycle, value => {
    value.modelCallTiming.push({cycle: 2, receivedEpochMs: restart(value).tailEndEpochMs});
  }],
];

function reject(id) {
  const [, reason, expectedContext, mutate] = rejections.find(([name]) => name === id);
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate,
    expectedReason: `RELATIONSHIP_STATUS_${reason}`, expectedContext});
}

test('rejects missing-cycle', () => reject('missing-cycle'));
test('rejects missing-tail', () => reject('missing-tail'));
test('rejects wrong-raw-cycle', () => reject('wrong-raw-cycle'));
test('rejects tail-timed-out', () => reject('tail-timed-out'));
test('rejects wrong-clock-type', () => reject('wrong-clock-type'));
test('rejects invalid-tail-clock', () => reject('invalid-tail-clock'));
test('rejects overlapping-tail-windows', () => reject('overlapping-tail-windows'));
test('rejects wrong-navigation', () => reject('wrong-navigation'));
test('rejects no-navigation-signal', () => reject('no-navigation-signal'));
test('rejects connection-generation-changed', () => reject('connection-generation-changed'));
test('rejects archive-dispatch', () => reject('archive-dispatch'));
test('rejects duplicate-relationship-read', () => reject('duplicate-relationship-read'));
test('rejects no-relationship-receipt', () => reject('no-relationship-receipt'));
test('rejects stale-receipt-id', () => reject('stale-receipt-id'));
test('rejects stale-receipt-persona', () => reject('stale-receipt-persona'));
test('rejects stale-receipt-generation', () => reject('stale-receipt-generation'));
test('rejects old-displayed-request', () => reject('old-displayed-request'));
test('rejects dispatch-before-navigation', () => reject('dispatch-before-navigation'));
test('rejects receipt-before-dispatch', () => reject('receipt-before-dispatch'));
test('rejects receipt-after-tail', () => reject('receipt-after-tail'));
test('rejects read-failed', () => reject('read-failed'));
test('rejects wrong-count-type', () => reject('wrong-count-type'));
test('rejects missing-stage-detail', () => reject('missing-stage-detail'));
test('rejects missing-threshold', () => reject('missing-threshold'));
test('rejects threshold-gap', () => reject('threshold-gap'));
test('rejects bounded-final-threshold', () => reject('bounded-final-threshold'));
test('rejects stage-outside-score-range', () => reject('stage-outside-score-range'));
test('rejects wrong-stage-text', () => reject('wrong-stage-text'));
test('rejects interpreted-markup', () => reject('interpreted-markup'));
test('rejects wrong-remaining-score', () => reject('wrong-remaining-score'));
test('rejects missing-note', () => reject('missing-note'));
test('rejects changed-archive-revision', () => reject('changed-archive-revision'));
test('rejects changed-archive-hash', () => reject('changed-archive-hash'));
test('rejects zero-interactions', () => reject('zero-interactions'));
test('rejects default-score', () => reject('default-score'));
test('rejects restarted-different-persona', () => reject('restarted-different-persona'));
test('rejects reused-request-across-cycles', () => reject('reused-request-across-cycles'));
test('rejects lower-persisted-score', () => reject('lower-persisted-score'));
test('rejects lower-persisted-count', () => reject('lower-persisted-count'));
test('rejects missing-model-trace', () => reject('missing-model-trace'));
test('rejects wrong-model-time-type', () => reject('wrong-model-time-type'));
test('rejects missing-restart-model-trace', () => reject('missing-restart-model-trace'));
test('rejects model-request-at-first-tail-start', () => reject('model-request-at-first-tail-start'));
test('rejects model-request-at-restart-tail-end', () => reject('model-request-at-restart-tail-end'));
