'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {verifyXiangqi} = require('./xiangqi-verdicts.cjs');

function fixture() {
  const red = {from: 25, to: 22};
  const first = [red, {from: 54, to: 45}];
  const second = [red, {from: 56, to: 47}];
  const opening = ['scene-navigation-search', 'search-result-activities-xiangqi'];
  function cycle(number, revisions, moves, inputs, positions) {
    const commands = revisions.map((_, i) => ({
      id: 'qt_' + (number * 16 + i).toString(16).padStart(32, '0'),
      command: i === 0 ? 'game_state:get' : 'game_state:put',
    }));
    return {xiangqi: {
      passed: true, error: '', cycle: number, elapsedMs: 5000,
      deadlineMs: number === 1 ? 60000 : 15000,
      archiveResults: 0, archiveUnchanged: true,
      clicks: [...opening, ...inputs].map(control => ({control, mouseDispatchCount: 1, clickedSignals: 1, elapsedMs: 100})),
      commands,
      receipts: commands.map((command, i) => ({
        ...command, ok: true, exists: revisions[i] > 0, generation: 1, revision: revisions[i], moves: moves[i],
      })),
      observed: {mode: '本地练习', retiredControls: 0,
        ...Object.fromEntries(Object.entries(positions).map(([key, i]) => [
          key, {revision: revisions[i], moves: moves[i], redTurn: true, exchanges: i + 1},
        ]))},
    }};
  }
  return [
    cycle(1, [0, 1, 2, 3, 4, 5, 6], [null, [], [red], first, [], [red], second],
      ['xiangqi-25', 'xiangqi-22', 'xiangqiUndo', 'xiangqi-25', 'xiangqi-22', 'xiangqiReset', 'xiangqiResetCancel'],
      {loaded: 1, first: 3, undo: 4, second: 6, final: 6}),
    cycle(2, [6, 7], [second, []], ['xiangqiReset', 'xiangqiResetConfirm'], {loaded: 0, final: 1}),
  ];
}

function rejects(reason, mutate) {
  const reports = fixture();
  assert.equal(verifyXiangqi(reports).passed, true);
  mutate(reports);
  assert.throws(() => verifyXiangqi(reports),
    error => error instanceof assert.AssertionError && error.message.startsWith(reason));
}

test('xiangqi proves two legal practice replies and restart reset', () => {
  const proof = verifyXiangqi(fixture());
  assert.deepEqual(proof.blackMoves, [{from: 54, to: 45}, {from: 56, to: 47}]);
  assert.deepEqual(proof.finalRevisions, [6, 7]);
  assert.equal(proof.modelMoves, 0);
});

test('xiangqi rejects a model move', () => {
  rejects('XIANGQI_COMMAND_ORDER', reports => { reports[0].xiangqi.commands[3].command = 'game:move'; });
});

test('xiangqi rejects an unrelated receipt', () => {
  rejects('XIANGQI_RECEIPT_BINDING', reports => {
    reports[0].xiangqi.receipts[3].id = reports[0].xiangqi.receipts[2].id;
  });
});

test('xiangqi rejects an illegal black reply', () => {
  rejects('XIANGQI_REPLAY', reports => { reports[0].xiangqi.receipts[3].moves[1] = {from: 54, to: 36}; });
});

test('xiangqi rejects a nonconsecutive save revision', () => {
  rejects('XIANGQI_FIRST_REVISIONS', reports => { reports[0].xiangqi.receipts[3].revision = 2; });
});

test('xiangqi rejects a changed board after cancelling reset', () => {
  rejects('XIANGQI_SNAPSHOT:final', reports => { reports[0].xiangqi.observed.final.moves = []; });
});

test('xiangqi rejects a different legal board on restart', () => {
  rejects('XIANGQI_RESTART_MOVES', reports => {
    reports[1].xiangqi.receipts[0].moves = structuredClone(reports[0].xiangqi.receipts[3].moves);
  });
});

test('xiangqi rejects an unconfirmed restart reset', () => {
  rejects('XIANGQI_RECEIPTS', reports => { reports[1].xiangqi.receipts.pop(); });
});

test('xiangqi rejects a restart beyond its deadline', () => {
  rejects('XIANGQI_DEADLINE', reports => { reports[1].xiangqi.elapsedMs = 15000; });
});

test('xiangqi rejects an extra physical click', () => {
  rejects('XIANGQI_INPUT_PROOF', reports => { reports[0].xiangqi.clicks[3].clickedSignals = 2; });
});
