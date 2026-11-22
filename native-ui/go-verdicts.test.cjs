'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {makeStrategicGameFixture} = require('./strategic-game-fixture.cjs');
const {GO_CONTRACT, verifyGo} = require('./go-verdicts.cjs');

function board(moves) {
  return {last: moves.slice(-1).filter(move => move !== null),
    stones: moves.map((index, ply) => ({index, color: ply === 0 ? 'black' : 'white'}))
      .filter(stone => stone.index !== null).sort((a, b) => a.index - b.index)};
}

function fixture(opponentMoves = [31, 39]) {
  return makeStrategicGameFixture({id: 'go', after: 'chess', moveControls: ['go-40'],
    userMove: 40, record: moves => ({moves: [...moves], ended: false}), board,
    status: '轮到你执黑落子 · 提子 黑 0：白 0', boardSize: 81}, opponentMoves);
}

const verify = ({reports, modelCallTiming, requests}) => verifyGo(reports, modelCallTiming, requests);
const first = value => value.reports[0].go;
const restart = value => value.reports[1].go;
const c1 = {cycle: 1}, c2 = {cycle: 2};

function reject(id, reason, expectedContext, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `GO_${reason}`, expectedContext});
}

function writeState(tail, exchange, state) {
  tail.commands[exchange].fields.state = structuredClone(state);
  tail.receipts[exchange].state = state;
}

test('accepts two local Go rounds and a restart reset', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: GO_CONTRACT, elapsedMs: [1600, 540],
    firstWrites: 6, restartWrites: 1, modelMoves: 0, modelRequestsAdded: 0,
    opponentMoves: [31, 39], finalRevisions: [6, 7]});
});
test('accepts different legal white replies', () => {
  assert.deepEqual(verify(fixture([0, 80])).opponentMoves, [0, 80]);
});
test('rejects Go starting before the chess tail ends', () => reject('after-chess', 'TAIL_SEQUENCE', c2,
  value => { value.reports[1].chess.tailEndEpochMs = restart(value).tailStartEpochMs + 1; }));
test('rejects the restart Go tail at fifteen seconds', () => reject('restart-deadline', 'DEADLINE', c2,
  value => { restart(value).elapsedMs = 15000; }));
test('rejects an archive change during Go', () => reject('archive', 'ARCHIVE', c1,
  value => { first(value).archiveAfter.sha256 = 'c'.repeat(64); }));
test('rejects selecting another intersection instead of the center', () => reject('wrong-click', 'INPUTS', c1,
  value => { first(value).inputs[2].control = 'go-41'; }));
test('rejects canceling the required restart reset', () => reject('restart-cancel', 'INPUTS', c2,
  value => { restart(value).inputs.at(-1).control = 'goResetCancel'; }));
test('rejects an archive command during Go', () => reject('archive-command', 'COMMANDS', c1,
  value => { first(value).commands.push({command: 'archive:get'}); }));
test('rejects an opponent service command during local Go', () => reject('model-move', 'COMMANDS', c1,
  value => { first(value).commands[3].command = 'game:move'; }));
test('rejects reusing the first Go request ID after restart', () => reject('reused-request', 'REQUEST_BINDING', {...c2, exchange: 0},
  value => { restart(value).commands[0].id = restart(value).receipts[0].id = first(value).commands[0].id; }));
test('rejects a failed Go state read', () => reject('read-failed', 'READ_FAILED', {...c1, exchange: 0},
  value => { first(value).receipts[0].ok = false; }));
test('rejects a failed Go restart reset', () => reject('reset-failed', 'WRITE_FAILED', {...c2, exchange: 1},
  value => { restart(value).receipts[1].ok = false; }));
test('rejects using the chess game ID for Go', () => reject('wrong-game-id', 'COMMAND_FIELDS', {...c1, exchange: 0},
  value => { first(value).commands[0].fields.game_id = 'chess'; }));
test('rejects sending a Go save with an unconfirmed revision', () => reject('stale-revision', 'EXPECTED_REVISION', {...c1, exchange: 3},
  value => { first(value).commands[3].fields.expected_revision = 1; }));
test('rejects a Go receipt for a different move record', () => reject('write-readback', 'WRITE_READBACK', {...c1, exchange: 3},
  value => { first(value).commands[3].fields.state.moves[1] = 30; }));
test('rejects storing a bare move array instead of the Go record', () => reject('bare-array', 'REPLAY', {...c1, exchange: 2},
  value => writeState(first(value), 2, [40])));
test('rejects storing a Go record with an extra key', () => reject('extra-state-key', 'REPLAY', {...c1, exchange: 2},
  value => writeState(first(value), 2, {moves: [40], ended: false, side: 'black'})));
test('rejects marking the Go fixture position as ended', () => reject('ended-record', 'REPLAY', {...c1, exchange: 3},
  value => writeState(first(value), 3, {moves: [40, 31], ended: true})));
test('rejects replaying a Go move at an occupied point', () => reject('occupied-point', 'REPLAY', {...c1, exchange: 3},
  value => writeState(first(value), 3, {moves: [40, 40], ended: false})));
test('rejects replaying a Go move outside the board', () => reject('out-of-board', 'REPLAY', {...c1, exchange: 6},
  value => writeState(first(value), 6, {moves: [40, 81], ended: false})));
test('rejects a Go first move away from the center', () => reject('wrong-first-move', 'PLAYER_MOVE', {...c1, exchange: 2},
  value => writeState(first(value), 2, {moves: [41], ended: false})));
test('rejects a Go undo that retains a stone', () => reject('undo-retained-stone', 'UNDO', c1,
  value => writeState(first(value), 4, {moves: [40], ended: false})));
test('rejects a cancel that leaves a different Go revision', () => reject('cancel-changed-revision', 'SNAPSHOT', {...c1, snapshot: 'final'},
  value => { first(value).observed.final.revision++; }));
test('rejects a missing Go last-move marker', () => reject('missing-last', 'BOARD', {...c2, snapshot: 'loaded'},
  value => { restart(value).observed.loaded.last = []; }));
test('rejects sending the white move before the black save receipt', () => reject('early-white', 'EVENT_ORDER', c1,
  value => { first(value).commands[3].atMs = 309; }));
test('rejects a changed Go move record after restart', () => reject('restart-readback', 'RESTART_READBACK', c2,
  value => { restart(value).receipts[0].state.moves[1] = 32; }));
test('rejects a reset that does not increment the Go revision by one', () => reject('restart-revision', 'RESET', c2,
  value => { restart(value).receipts[1].revision++; }));
test('rejects a model request at the end of the Go restart tail', () => reject('tail-model-request', 'MODEL_REQUEST', c2,
  value => { value.modelCallTiming[0].receivedEpochMs = restart(value).tailEndEpochMs; }));
test('rejects a tenth settings request outside the Go tails', () => reject('model-count', 'MODEL_COUNT', {}, value => {
  value.requests++;
  value.modelCallTiming.push({cycle: 2, receivedEpochMs: restart(value).tailEndEpochMs + 1});
}));
