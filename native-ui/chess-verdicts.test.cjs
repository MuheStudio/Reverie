'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {makeStrategicGameFixture} = require('./strategic-game-fixture.cjs');
const {CHESS_CONTRACT, verifyChess} = require('./chess-verdicts.cjs');

function board(moves) {
  const occupied = [...'bbbbbbbbbbbbbbbb', ...Array(32).fill(''), ...'wwwwwwwwwwwwwwww'];
  const squareIndex = square => (8 - Number(square[1])) * 8 + 'abcdefgh'.indexOf(square[0]);
  let last = [];
  for (const move of moves) {
    const from = squareIndex(move.slice(0, 2));
    const to = squareIndex(move.slice(2, 4));
    occupied[to] = occupied[from];
    occupied[from] = '';
    last = [from, to].sort((a, b) => a - b);
  }
  return {last, stones: occupied.flatMap((piece, index) =>
    piece ? [{index, color: piece === 'w' ? 'white' : 'black'}] : [])};
}

function fixture(opponentMoves = ['e7e5', 'c7c5']) {
  return makeStrategicGameFixture({id: 'chess', after: 'gomoku', moveControls: ['chess-e2', 'chess-e4'],
    userMove: 'e2e4', record: moves => [...moves], board, status: '轮到你执白走棋', boardSize: 64}, opponentMoves);
}

const verify = ({reports, modelCallTiming, requests}) => verifyChess(reports, modelCallTiming, requests);
const first = value => value.reports[0].chess;
const restart = value => value.reports[1].chess;
const c1 = {cycle: 1}, c2 = {cycle: 2};

function reject(id, reason, expectedContext, mutate) {
  assertRejectedMutation({id, makeFixture: fixture, verify, mutate, expectedReason: `CHESS_${reason}`, expectedContext});
}

function writeState(tail, exchange, moves) {
  tail.commands[exchange].fields.state = [...moves];
  tail.receipts[exchange].state = moves;
}

test('accepts two local chess rounds and a restart reset', () => {
  assert.deepEqual(verify(fixture()), {passed: true, contract: CHESS_CONTRACT, elapsedMs: [1600, 540],
    firstWrites: 6, restartWrites: 1, modelMoves: 0, modelRequestsAdded: 0,
    opponentMoves: ['e7e5', 'c7c5'], finalRevisions: [6, 7]});
});
test('accepts different legal black replies', () => {
  assert.deepEqual(verify(fixture(['g8f6', 'b8c6'])).opponentMoves, ['g8f6', 'b8c6']);
});
test('rejects chess starting before the Gomoku tail ends', () => reject('after-gomoku', 'TAIL_SEQUENCE', c1,
  value => { value.reports[0].gomoku.tailEndEpochMs = first(value).tailStartEpochMs + 1; }));
test('rejects the first chess tail at sixty seconds', () => reject('first-deadline', 'DEADLINE', c1,
  value => { first(value).elapsedMs = 60000; }));
test('rejects the restart chess tail at fifteen seconds', () => reject('restart-deadline', 'DEADLINE', c2,
  value => { restart(value).elapsedMs = 15000; }));
test('rejects a different connection generation during chess', () => reject('generation', 'SCOPE', c1,
  value => { first(value).generationAfter++; }));
test('rejects an archive change during chess', () => reject('archive', 'ARCHIVE', c2,
  value => { restart(value).archiveAfter.revision++; }));
test('rejects chess companion mode', () => reject('mode', 'MODE', c1,
  value => { first(value).observed.mode = '角色对手'; }));
test('rejects a missing e2 selection click', () => reject('missing-selection', 'INPUTS', c1,
  value => first(value).inputs.splice(2, 1)));
test('rejects an e4 click that misses its target', () => reject('missed-destination', 'INPUTS', c1,
  value => { first(value).inputs[3].hitAccepted = false; }));
test('rejects a reset confirmation before the restart', () => reject('first-confirm', 'INPUTS', c1,
  value => { first(value).inputs.at(-1).control = 'chessResetConfirm'; }));
test('rejects a model move request during local chess', () => reject('model-move', 'COMMANDS', c1,
  value => { first(value).commands[3].command = 'game:move'; }));
test('rejects a missing receipt for the restart reset', () => reject('no-reset-receipt', 'RECEIPTS', c2,
  value => restart(value).receipts.pop()));
test('rejects a chess receipt from another persona', () => reject('receipt-scope', 'REQUEST_BINDING', {...c1, exchange: 0},
  value => { first(value).receipts[0].scope = restart(value).scopeBefore; }));
test('rejects a failed chess state read', () => reject('read-failed', 'READ_FAILED', {...c2, exchange: 0},
  value => { restart(value).receipts[0].ok = false; }));
test('rejects a failed chess save', () => reject('write-failed', 'WRITE_FAILED', {...c1, exchange: 3},
  value => { first(value).receipts[3].ok = false; }));
test('rejects dispatching the Gomoku game ID from chess', () => reject('wrong-game-id', 'COMMAND_FIELDS', {...c1, exchange: 1},
  value => { first(value).commands[1].fields.game_id = 'gomoku'; }));
test('rejects a chess save with an unconfirmed revision', () => reject('stale-revision', 'EXPECTED_REVISION', {...c1, exchange: 2},
  value => { first(value).commands[2].fields.expected_revision = 0; }));
test('rejects a chess save receipt for another move', () => reject('write-readback', 'WRITE_READBACK', {...c1, exchange: 3},
  value => { first(value).commands[3].fields.state[1] = 'd7d5'; }));
test('rejects an illegal coordinate move in a saved chess position', () => reject('illegal-reply', 'REPLAY', {...c1, exchange: 3},
  value => writeState(first(value), 3, ['e2e4', 'e7e4'])));
test('rejects a SAN move in the stored coordinate record', () => reject('san-record', 'REPLAY', {...c1, exchange: 3},
  value => writeState(first(value), 3, ['e2e4', 'e5'])));
test('rejects a player move other than the clicked e2e4', () => reject('wrong-player-move', 'PLAYER_MOVE', {...c1, exchange: 2},
  value => writeState(first(value), 2, ['d2d4'])));
test('rejects a black save sent before the white save receipt', () => reject('early-opponent', 'EVENT_ORDER', c1,
  value => { first(value).commands[3].atMs = 309; }));
test('rejects a chess undo that leaves one move', () => reject('undo-retained-move', 'UNDO', c1,
  value => writeState(first(value), 4, ['e2e4'])));
test('rejects a changed position after canceling the chess reset', () => reject('cancel-changed-position', 'SNAPSHOT', {...c1, snapshot: 'final'},
  value => { first(value).observed.final.moves = []; }));
test('rejects a missing last-move endpoint marker', () => reject('missing-last-square', 'BOARD', {...c1, snapshot: 'second'},
  value => { first(value).observed.second.last.pop(); }));
test('rejects a different chess position after restart', () => reject('restart-position', 'RESTART_READBACK', c2,
  value => { restart(value).receipts[0].state[1] = 'd7d5'; }));
test('rejects a reset that does not increment the chess revision by one', () => reject('restart-revision', 'RESET', c2,
  value => { restart(value).receipts[1].revision++; }));
test('rejects a model request at the start of the chess tail', () => reject('tail-model-request', 'MODEL_REQUEST', c1,
  value => { value.modelCallTiming[0].receivedEpochMs = first(value).tailStartEpochMs; }));
test('rejects a settings model count other than nine', () => reject('model-count', 'MODEL_COUNT', {},
  value => { value.requests = 10; }));
