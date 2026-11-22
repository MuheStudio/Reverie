'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {PERSONA_STATE_CONTRACT, verifyPersonaState} = require('./persona-state-verdicts.cjs');

const moon = 'st_moon_fixture';
const builtin = 'builtin_hoshino_yumetsuki';
const scopes = new Map([[moon, '1'.repeat(64)], ['default', '2'.repeat(64)]]);
const epoch = 1794500000000;
const id = (cycle, serial) => 'qt_' + (cycle * 1000 + serial).toString(16).padStart(32, '0');
const relationship = (intimacy, interaction_count) => ({intimacy, interaction_count,
  stage: '初识期', stage_key: 'initial', stage_number: 1, stage_detail: '礼貌、客气、保持边界。',
  thresholds: [{key: 'initial', label: '初识期', min: 0, max: 99}, {key: 'familiar', label: '熟悉期', min: 100, max: 499},
    {key: 'trusted', label: '信任期', min: 500, max: 1999}, {key: 'enduring', label: '长久陪伴期', min: 2000, max: null}]});
const mood = () => ({mood: 'happy', emotions: {joy: 71.6, calm: 60.4, excitement: 30, sadness: 10,
  anger: 5, anxiety: 15, grievance: 5, touched: 20}, intensity: .1,
  dominant: [{name: 'joy', value: 71.6}, {name: 'calm', value: 60.4}, {name: 'excitement', value: 30}, {name: 'touched', value: 20}]});

function report(cycle) {
  const original = cycle === 1 ? moon : 'default', other = cycle === 1 ? 'default' : moon;
  const commands = [], receipts = [], snapshots = [], inputs = [];
  for (const [visit, personaId] of [original, other, original].entries()) {
    const scope = `${personaId === 'default' ? builtin : personaId}:${cycle * 10 + visit}:${scopes.get(personaId)}`;
    const generation = 3 + visit;
    const atMs = 10 + 100 * visit;
    const switchRequestId = visit === 0 ? '' : id(cycle, atMs - 5);
    if (visit > 0) {
      const previous = snapshots.at(-1);
      for (const [index, control] of [`personaSwitch-${personaId}`, 'personaSwitchConfirm'].entries()) {
        inputs.push({control, atMs: atMs - 8 + index, scope: previous.scope, generation: previous.generation,
          mouseDispatchCount: 1, clickedSignals: 1});
      }
      commands.push({id: switchRequestId, command: 'persona:activate', atMs: atMs - 5,
        scope: previous.scope, generation: previous.generation});
      commands.push({id: id(cycle, atMs - 4), command: 'archive:get', atMs: atMs - 4, scope, generation});
    }
    const score = personaId === moon ? 60 : 74;
    const count = (personaId === moon ? 3 : 14) + cycle - 1;
    const relationshipId = id(cycle, visit * 8 + 1), moodId = id(cycle, visit * 8 + 2);
    const relationshipCommand = {id: relationshipId, command: 'relationship:get', atMs, scope, generation};
    const moodCommand = {id: moodId, command: 'emotion:get', atMs: atMs + 1, scope, generation};
    commands.push(relationshipCommand, moodCommand);
    receipts.push({...relationshipCommand, atMs: atMs + 4, payload: relationship(score, count)},
      {...moodCommand, atMs: atMs + 5, payload: mood()});
    snapshots.push({personaId, scope, generation, atMs: atMs + 10, emotionEnabled: true, relationshipId, moodId, switchRequestId,
      relationshipShown: {stage: '关系：初识期', detail: '礼貌、客气、保持边界。', note: '随聊天慢慢变化，离开多久都不会减少。',
        intimacy: `亲密度 ${score}，到「熟悉期」还差 ${100 - score}`},
      moodShown: {label: '心情：开心', dominant: '现在最明显的是喜悦 72、平静 60'},
      history: [{id: `${personaId}-user`, role: 'user'}, {id: `${personaId}-assistant`, role: 'assistant'}],
      archive: {revision: personaId === moon ? 3 : 20, sha256: scopes.get(personaId)}});
  }
  const initial = snapshots[0], tailStartEpochMs = epoch + cycle * 1000;
  return {cycle: String(cycle), archiveInteraction: {cardImport: {moonPersona: moon}}, startupPersona: {activeId: moon},
    cardEdit: {after: {activeId: original, scope: initial.scope, generation: initial.generation,
      messageIds: initial.history.map(row => row.id), archiveRevision: initial.archive.revision}},
    personas: {profiles: [{id: original, active: true}, {id: other, active: false}]}, messages: initial.history,
    personaState: {passed: true, error: '', cycle, deadlineMs: 20000, elapsedMs: 230, tailStartEpochMs,
      tailEndEpochMs: tailStartEpochMs + 230, initialPersonaId: original, finalPersonaId: original,
      snapshots, commands, receipts, inputs}};
}

function fixture() {
  return {reports: [report(1), report(2)], requests: 28, modelCallTiming: [
    ...Array.from({length: 23}, (_, i) => ({cycle: 1, receivedEpochMs: epoch + 100 + i})),
    ...Array.from({length: 5}, (_, i) => ({cycle: 2, receivedEpochMs: epoch + 1500 + i})),
  ]};
}

const verify = ({reports, modelCallTiming, requests}) => verifyPersonaState(reports, modelCallTiming, requests);
const first = input => input.reports[0].personaState;
const restart = input => input.reports[1].personaState;
function reject(id, reason, expectedContext, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `PERSONA_STATE_${reason}`, expectedContext});
}

test('accepts independent relationship and mood receipts when active personas swap across restart', () => {
  const result = verify(fixture());
  assert.equal(result.contract, PERSONA_STATE_CONTRACT);
  assert.equal(result.modelRequestsAdded, 0);
  assert.deepEqual(result.cycles.map(row => row.personas.map(({personaId, interactionCount}) => [personaId, interactionCount])),
    [[[moon, 3], ['default', 14]], [['default', 15], [moon, 4]]]);
});
test('rejects a missing restart tail', () => reject('missing-tail', 'CYCLE', {cycle: 2}, input => { delete input.reports[1].personaState; }));
test('rejects a tail that reaches its deadline', () => reject('deadline', 'DEADLINE', {cycle: 1}, input => { first(input).elapsedMs = 20000; }));
test('rejects a tail that leaves the alternate persona active', () => reject('wrong-final', 'PERSONA_PAIR', {cycle: 1},
  input => { first(input).finalPersonaId = 'default'; }));
test('rejects a switch without a physical click signal', () => reject('missing-click', 'INPUT', {cycle: 1},
  input => { first(input).inputs[1].clickedSignals = 0; }));
test('rejects a stale scope on a command', () => reject('command-scope', 'COMMAND_SCOPE', {cycle: 1},
  input => { first(input).commands[3].scope = first(input).snapshots[0].scope; }));
test('rejects a scope that substitutes the default registry alias for its sealed identity', () =>
  reject('default-alias', 'SCOPE', {cycle: 1, visit: 1}, input => {
    const tail = first(input), snapshot = tail.snapshots[1];
    const scope = snapshot.scope.replace(builtin + ':', 'default:');
    for (const row of [...tail.commands, ...tail.receipts, ...tail.inputs]) {
      if (row.scope === snapshot.scope) row.scope = scope;
    }
    snapshot.scope = scope;
  }));
test('rejects a new command before any switch', () => reject('read-only', 'TRAFFIC', {cycle: 1},
  input => { first(input).commands[0].command = 'archive:get'; }));
test('rejects an archive write during switch refresh', () => reject('archive-write', 'TRAFFIC', {cycle: 1},
  input => { first(input).commands[3].command = 'archive:put'; }));
test('rejects a missing emotion receipt', () => reject('missing-mood', 'TRAFFIC', {cycle: 1}, input => { first(input).receipts.pop(); }));
test('rejects an emotion snapshot with settings disabled', () => reject('disabled', 'EMOTION_ENABLED', {cycle: 1, visit: 1},
  input => { first(input).snapshots[1].emotionEnabled = false; }));
test('rejects a previous generation emotion receipt', () => reject('stale-receipt', 'RECEIPT_BINDING', {cycle: 1, visit: 1},
  input => { first(input).receipts[3].generation--; }));
test('rejects mismatched activation feedback request identity', () => reject('switch-receipt', 'SWITCH', {cycle: 1, visit: 1},
  input => { first(input).snapshots[1].switchRequestId = first(input).commands[0].id; }));
test('rejects an unknown mood label', () => reject('unknown-mood', 'MOOD_RECEIPT', {cycle: 2, visit: 0},
  input => { restart(input).receipts[1].payload.mood = 'unknown'; }));
test('rejects an emotion score displayed without rounding', () => reject('mood-display', 'MOOD_DISPLAY', {cycle: 1, visit: 0},
  input => { first(input).snapshots[0].moodShown.dominant = '现在最明显的是喜悦 71.6、平静 60'; }));
test('rejects a relationship stage display that disagrees with its receipt', () => reject('relationship-display', 'RELATIONSHIP_DISPLAY',
  {cycle: 1, visit: 0}, input => { first(input).snapshots[0].relationshipShown.stage = '关系：熟悉期'; }));
test('rejects changed original relationship payload after returning', () => reject('relationship-return', 'RETURN_RELATIONSHIP', {cycle: 1},
  input => { first(input).receipts[4].payload.interaction_count++; }));
test('rejects equal relationship interaction counts on the first cycle', () => reject('same-counts', 'INTERACTION_COUNTS', {cycle: 1},
  input => { first(input).receipts[2].payload.interaction_count = first(input).receipts[0].payload.interaction_count; }));
test('rejects fewer restart interactions for the same persona in the alternate position', () =>
  reject('restart-interactions', 'RESTART_INTERACTIONS', {cycle: 2, personaId: moon},
    input => { restart(input).receipts[2].payload.interaction_count = 2; }));
test('rejects an archive change after the return switch', () => reject('archive-changed', 'ARCHIVE', {cycle: 1},
  input => { first(input).snapshots[2].archive.revision++; }));
test('rejects a history change after the return switch', () => reject('history-changed', 'HISTORY', {cycle: 1},
  input => { first(input).snapshots[2].history.pop(); }));
test('rejects a model request during the first persona state tail', () => reject('model-request', 'MODEL_REQUEST', {cycle: 1},
  input => { input.modelCallTiming[0].receivedEpochMs = first(input).tailStartEpochMs; }));
test('rejects a changed total model request count', () => reject('model-count', 'MODEL_TRACE', {}, input => { input.requests++; }));
