'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertRejectedMutation } = require('./verdict-test-support.cjs');
const { GOMOKU_CONTRACT, verifyGomoku } = require('./gomoku-verdicts.cjs');

const epoch = 1794297600000;
const fingerprint = 'a'.repeat(64);
const firstClicks = ['scene-navigation-search', 'search-result-activities-gomoku', 'gomoku-112', 'gomokuUndo',
  'gomoku-112', 'gomokuReset', 'gomokuResetCancel'];
const restartClicks = ['scene-navigation-search', 'search-result-activities-gomoku', 'gomokuReset', 'gomokuResetConfirm'];

function snapshot(receipt, atMs) {
  const moves = [...receipt.moves];
  const stones = moves.map((index, ply) => ({index, color: ply % 2 === 0 ? 'black' : 'white'}))
    .sort((a, b) => a.index - b.index);
  return {atMs, revision: receipt.revision, moves, boardSize: 225, stones, last: moves.slice(-1),
    status: '轮到你执黑落子', ready: true};
}

function report(cycle, whiteMoves) {
  const first = cycle === 1;
  const scope = `builtin_hoshino_yumetsuki:${cycle}:${fingerprint}`;
  const generation = cycle + 1;
  const start = epoch + (first ? 1000 : 4000);
  const elapsedMs = first ? 1600 : 540;
  const archive = {revision: 6, sha256: 'b'.repeat(64)};
  const moves = first ? [null, [], [112], [112, whiteMoves[0]], [], [112], [112, whiteMoves[1]]] :
    [[112, whiteMoves[1]], []];
  const revisions = first ? [0, 1, 2, 3, 4, 5, 6] : [6, 7];
  const sendAt = first ? [130, 138, 300, 650, 810, 980, 1300] : [130, 455];
  const receivedAt = first ? [140, 170, 310, 660, 820, 990, 1310] : [141, 460];
  const clickAt = first ? [40, 120, 280, 790, 960, 1400, 1500] : [40, 120, 280, 440];
  const controls = first ? firstClicks : restartClicks;
  const inputs = controls.map((control, index) => ({control, atMs: clickAt[index], mouseDispatchCount: 1,
    clickedSignals: 1, hitAccepted: true}));
  const events = moves.map((_, index) => ({id: `qt_${(cycle * 10 + index).toString(16).padStart(32, '0')}`,
    command: index === 0 ? 'game_state:get' : 'game_state:put', scope, generation}));
  const commands = events.map((event, index) => ({...event, atMs: sendAt[index], fields: index === 0 ?
    {game_id: 'gomoku'} : {game_id: 'gomoku', expected_revision: revisions[index - 1], state: [...moves[index]]}}));
  const receipts = events.map((event, index) => ({...event, atMs: receivedAt[index], ok: true, code: '',
    exists: moves[index] !== null, revision: revisions[index], moves: moves[index]}));
  const observed = first ? {loaded: snapshot(receipts[1], 190), first: snapshot(receipts[3], 700),
    undo: snapshot(receipts[4], 860), second: snapshot(receipts[6], 1350), final: snapshot(receipts[6], 1530)} :
    {loaded: snapshot(receipts[0], 180), final: snapshot(receipts[1], 510)};
  return {cycle: String(cycle), diary: {passed: true, tailEndEpochMs: start - 40, scopeAfter: scope,
    generationAfter: generation}, gomoku: {
    passed: true, error: '', cycle, deadlineMs: first ? 60000 : 15000, elapsedMs,
    tailStartEpochMs: start, tailEndEpochMs: start + elapsedMs,
    scopeBefore: scope, scopeAfter: scope, generationBefore: generation, generationAfter: generation,
    inputs, searchAtMs: 80, commands, receipts, observed: {...observed, mode: '本地练习'},
    archiveBefore: {...archive}, archiveAfter: {...archive},
    lastObservation: {phase: 12, phaseElapsedMs: 40, portalReady: true, visibility: {fullyVisible: true}},
  }};
}

function fixture(whiteMoves = [113, 97]) {
  return {reports: [report(1, whiteMoves), report(2, whiteMoves)], requests: 9, modelCallTiming: [
    ...Array.from({length: 8}, (_, index) => ({cycle: 1, receivedEpochMs: epoch + index * 100})),
    {cycle: 2, receivedEpochMs: epoch + 3200},
  ]};
}

const verify = ({reports, modelCallTiming, requests}) => verifyGomoku(reports, modelCallTiming, requests);
const first = value => value.reports[0].gomoku;
const restart = value => value.reports[1].gomoku;
const c1 = {cycle: 1}, c2 = {cycle: 2};

function reject(id, reason, expectedContext, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `GOMOKU_${reason}`, expectedContext});
}

function writtenMoves(tail, index, moves) {
  tail.commands[index].fields.state = [...moves];
  tail.receipts[index].moves = moves;
}

test('accepts the two local rounds and restart reset with nine model requests', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: GOMOKU_CONTRACT, elapsedMs: [1600, 540],
    firstWrites: 6, restartWrites: 1, modelMoves: 0, modelRequestsAdded: 0, whiteMoves: [113, 97], finalRevisions: [6, 7]});
});
test('accepts different legal white replies', () => {
  assert.deepEqual(verify(fixture([0, 224])).whiteMoves, [0, 224]);
});

test('rejects a missing restart cycle', () => reject('missing-cycle', 'CYCLES', {}, value => value.reports.pop()));
test('rejects a missing Gomoku report', () => reject('missing-tail', 'CYCLE', c2, value => { delete value.reports[1].gomoku; }));
test('rejects the first tail at sixty seconds', () => reject('first-deadline', 'DEADLINE', c1,
  value => { first(value).elapsedMs = 60000; }));
test('rejects the restart tail at fifteen seconds', () => reject('restart-deadline', 'DEADLINE', c2,
  value => { restart(value).elapsedMs = 15000; }));
test('rejects divergent elapsed and epoch timing', () => reject('clock', 'TAIL_CLOCK', c2,
  value => { restart(value).tailEndEpochMs += 200; }));
test('rejects a Gomoku tail that starts before Diary ends', () => reject('after-diary', 'AFTER_DIARY', c1,
  value => { value.reports[0].diary.tailEndEpochMs = first(value).tailStartEpochMs + 1; }));
test('rejects a connection generation change in the tail', () => reject('generation', 'SCOPE', c1,
  value => { first(value).generationAfter++; }));
test('rejects a changed archive digest', () => reject('archive', 'ARCHIVE', c2,
  value => { restart(value).archiveAfter.sha256 = 'c'.repeat(64); }));
test('rejects companion mode instead of local practice', () => reject('mode', 'MODE', c1,
  value => { first(value).observed.mode = '角色对手'; }));
test('rejects clicking the Xiangqi navigation row', () => reject('xiangqi-entry', 'INPUTS', c1,
  value => { first(value).inputs[1].control = 'search-result-activities-xiangqi'; }));
test('rejects a click that misses the center square', () => reject('missed-center', 'INPUTS', c1,
  value => { first(value).inputs[2].hitAccepted = false; }));
test('rejects a reset confirmation in the first cycle', () => reject('unexpected-confirm', 'INPUTS', c1,
  value => { first(value).inputs[6].control = 'gomokuResetConfirm'; }));
test('rejects a game move request in local practice', () => reject('model-move', 'COMMANDS', c1,
  value => { first(value).commands[3].command = 'game:move'; }));
test('rejects an archive command during the tail', () => reject('archive-command', 'COMMANDS', c2,
  value => { restart(value).commands.push({command: 'archive:get'}); }));
test('rejects a state write on reset cancellation', () => reject('cancel-write', 'COMMANDS', c1,
  value => { first(value).commands.push({...first(value).commands[6]}); }));
test('rejects a missing restart reset receipt', () => reject('missing-reset-receipt', 'RECEIPTS', c2,
  value => restart(value).receipts.pop()));
test('rejects a receipt from an older connection', () => reject('stale-receipt', 'REQUEST_BINDING', {...c2, exchange: 0},
  value => { restart(value).receipts[0].generation--; }));
test('rejects a reused request ID across cycles', () => reject('duplicate-id', 'REQUEST_BINDING', {...c2, exchange: 0},
  value => { restart(value).commands[0].id = restart(value).receipts[0].id = first(value).commands[0].id; }));
test('rejects a failed Gomoku read', () => reject('read-failed', 'READ_FAILED', {...c1, exchange: 0},
  value => { first(value).receipts[0].ok = false; }));
test('rejects a failed white move save', () => reject('white-save-failed', 'WRITE_FAILED', {...c1, exchange: 3},
  value => { first(value).receipts[3].ok = false; }));
test('rejects reading an Xiangqi game ID', () => reject('xiangqi-read', 'COMMAND_FIELDS', {...c1, exchange: 0},
  value => { first(value).commands[0].fields.game_id = 'xiangqi'; }));
test('rejects saving an Xiangqi game ID', () => reject('xiangqi-write', 'COMMAND_FIELDS', {...c2, exchange: 1},
  value => { restart(value).commands[1].fields.game_id = 'xiangqi'; }));
test('rejects an extra GET payload field', () => reject('extra-field', 'COMMAND_FIELDS', {...c2, exchange: 0},
  value => { restart(value).commands[0].fields.expected_revision = 6; }));
test('rejects saving against a revision not confirmed by the last receipt', () =>
  reject('stale-revision', 'EXPECTED_REVISION', {...c1, exchange: 4}, value => {
    first(value).commands[4].fields.expected_revision = 2;
  }));
test('rejects a save receipt for a different move', () => reject('wrong-save-state', 'WRITE_READBACK', {...c1, exchange: 3},
  value => { first(value).commands[3].fields.state[1] = 98; }));
test('rejects replay when white repeats the occupied center square', () => reject('occupied-square', 'REPLAY', {...c1, exchange: 3},
  value => writtenMoves(first(value), 3, [112, 112])));
test('rejects replay of a square outside the board', () => reject('outside-square', 'REPLAY', {...c1, exchange: 6},
  value => writtenMoves(first(value), 6, [112, 225])));
test('rejects a nonempty first PUT', () => reject('nonempty-creation', 'NEW_GAME', c1,
  value => writtenMoves(first(value), 1, [112])));
test('rejects an undo that retains a move', () => reject('undo-retained-move', 'UNDO', c1,
  value => writtenMoves(first(value), 4, [112])));
test('rejects a first black move outside the center', () => reject('wrong-black', 'BLACK_MOVE', {...c1, exchange: 2},
  value => writtenMoves(first(value), 2, [111])));
test('rejects a white reply that does not follow the black move', () => reject('reply-prefix', 'WHITE_REPLY', {...c1, exchange: 3},
  value => writtenMoves(first(value), 3, [111, 113])));
test('rejects a revision change after reset cancellation', () => reject('cancel-revision', 'SNAPSHOT', {...c1, snapshot: 'final'},
  value => { first(value).observed.final.revision++; }));
test('rejects a readback that is not the first cycle final position', () => reject('restart-moves', 'RESTART_READBACK', c2,
  value => { restart(value).receipts[0].moves[1] = 101; }));
test('rejects a restart reset that does not increment revision by one', () => reject('restart-revision', 'RESET', c2,
  value => { restart(value).receipts[1].revision++; }));
test('rejects the wrong current-turn text on restart', () => reject('turn-text', 'SNAPSHOT', {...c2, snapshot: 'loaded'},
  value => { restart(value).observed.loaded.status = '陪练思考中…'; }));
test('rejects the wrong visible stone color', () => reject('stone-color', 'BOARD', {...c1, snapshot: 'first'},
  value => { first(value).observed.first.stones[0].color = 'white'; }));
test('rejects a missing last-move marker', () => reject('last-marker', 'BOARD', {...c1, snapshot: 'second'},
  value => { first(value).observed.second.last = []; }));
test('rejects a white save dispatched before the black save receipt', () => reject('premature-white', 'EVENT_ORDER', c1,
  value => { first(value).commands[3].atMs = 309; }));
test('rejects saving the reset before the confirmation click', () => reject('premature-reset', 'EVENT_ORDER', c2,
  value => { restart(value).commands[1].atMs = 439; }));
test('rejects a different persona on restart', () => reject('restart-persona', 'RESTART_PERSONA', c2, value => {
  const tail = restart(value), scope = `other_persona:2:${fingerprint}`;
  tail.scopeBefore = tail.scopeAfter = value.reports[1].diary.scopeAfter = scope;
  for (const event of [...tail.commands, ...tail.receipts]) event.scope = scope;
}));
test('rejects a missing model timing trace', () => reject('missing-model-trace', 'MODEL_TRACE', {},
  value => { delete value.modelCallTiming; }));
test('rejects a model request at the start of the first Gomoku tail', () => reject('model-first', 'MODEL_REQUEST', c1,
  value => { value.modelCallTiming[0].receivedEpochMs = first(value).tailStartEpochMs; }));
test('rejects a model request at the end of the restart Gomoku tail', () => reject('model-restart', 'MODEL_REQUEST', c2,
  value => { value.modelCallTiming[0].receivedEpochMs = restart(value).tailEndEpochMs; }));
test('rejects a tenth model request outside the tails', () => reject('model-count', 'MODEL_COUNT', {}, value => {
  value.requests++;
  value.modelCallTiming.push({cycle: 2, receivedEpochMs: epoch + 4700});
}));
