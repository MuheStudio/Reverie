'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('../frontend/node_modules/typescript');
const GoBoard = require('../frontend/node_modules/@sabaki/go-board');

function loadRules(file) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, removeComments: false },
  });
  const exports = {};
  new Function('exports', outputText)(exports);
  return exports;
}

const { createGo, playGo, chooseGoMove, endGo, goOutcome } = loadRules('rules/goRules.ts');
const { scoreChineseArea } = loadRules('../frontend/src/components/DreamRoom/gameEngines.ts');
const options = { preventOverwrite: true, preventSuicide: true, preventKo: true };
const vertex = (index) => [index % 9, Math.floor(index / 9)];

function replay(moves) {
  let state = createGo();
  for (const move of moves) {
    const next = playGo(state, move);
    assert.notStrictEqual(next, state, `replay move ${move}`);
    state = next;
  }
  return state;
}

test('Go agrees with Sabaki throughout 200 seeded games and reuses the area score', () => {
  let seed = 0x57c3aa71;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };

  for (let game = 0; game < 200; game += 1) {
    let state = createGo();
    let reference = GoBoard.fromDimensions(9);
    let passes = 0;
    for (let ply = 0; passes < 2; ply += 1) {
      const sign = ply % 2 === 0 ? 1 : -1;
      const label = `game ${game + 1}, ply ${ply + 1}`;
      assert.equal(state.turn, sign, label);
      const moves = [];
      for (let index = 0; index < 81; index += 1) {
        const { overwrite, suicide, ko } = reference.analyzeMove(sign, vertex(index));
        const expected = !overwrite && !suicide && !ko;
        assert.equal(playGo(state, index) !== state, expected, `${label}, intersection ${index}`);
        if (expected) moves.push(index);
      }
      const pass = ply >= 120 || moves.length === 0 || (ply >= 24 && random() < 0.04);
      const move = pass ? null : moves[Math.floor(random() * moves.length)];
      const next = playGo(state, move);
      assert.notStrictEqual(next, state, `${label}, move ${move}`);
      state = next;
      reference = reference.makeMove(sign, pass ? [-1, -1] : vertex(move), options);
      passes = pass ? passes + 1 : 0;
      assert.deepEqual(state.board, reference.signMap.flat(), label);
      assert.equal(state.blackCaptures, reference.getCaptures(1), label);
      assert.equal(state.whiteCaptures, reference.getCaptures(-1), label);
      assert.equal(state.passes, passes, label);
      assert.equal(state.last, move, label);
    }
    const expected = scoreChineseArea(reference.signMap);
    const outcome = goOutcome(state, scoreChineseArea);
    assert.deepEqual(outcome, {
      ...expected,
      winner: expected.black > expected.white ? 1 : -1,
      margin: Math.abs(expected.black - expected.white),
    }, `game ${game + 1}, final score`);
  }
});

test('Go rejects occupied points, suicide and invalid indexes and captures groups', () => {
  const surrounded = replay([80, 1, 79, 9]);
  for (const index of [80, 0, -1, 81, 1.5, '2', undefined]) {
    assert.strictEqual(playGo(surrounded, index), surrounded, `invalid intersection ${index}`);
  }

  const before = replay([2, 0, 9, 1]);
  const captured = playGo(before, 10);
  assert.deepEqual(captured.board.slice(0, 3), [0, 0, 1]);
  assert.deepEqual(before.board.slice(0, 3), [-1, -1, 1]);
  assert.equal(captured.blackCaptures, 2);
  assert.equal(captured.whiteCaptures, 0);
  assert.equal(captured.ko, null);
});

test('Go forbids only immediate recapture at a single-stone ko', () => {
  const ko = replay([1, 10, 9, 18, 11, 20, 80, 28, 19]);
  assert.equal(ko.blackCaptures, 1);
  assert.equal(ko.ko, 10);
  assert.strictEqual(playGo(ko, 10), ko);

  const afterThreat = playGo(playGo(ko, 79), 78);
  const retake = playGo(afterThreat, 10);
  assert.equal(retake.whiteCaptures, 1);
  assert.equal(retake.board[19], 0);
  assert.equal(retake.board[10], -1);
  assert.strictEqual(playGo(retake, 19), retake);

  const afterPass = playGo(playGo(ko, null), 77);
  assert.equal(playGo(afterPass, 10).whiteCaptures, 1);
});

test('Go scores either winner after two passes or an explicit end', () => {
  const state = createGo();
  const passed = playGo(state, null);
  assert.equal(passed.turn, -1);
  assert.equal(passed.passes, 1);
  assert.equal(goOutcome(passed, scoreChineseArea), null);
  assert.equal(playGo(passed, 40).passes, 0);
  const finished = playGo(passed, null);
  assert.equal(finished.ended, false);
  assert.deepEqual(goOutcome(finished, scoreChineseArea), { black: 0, white: 6.5, winner: -1, margin: 6.5 });
  assert.strictEqual(playGo(finished, 40), finished);
  assert.strictEqual(playGo(finished, null), finished);

  const manualEnd = endGo(playGo(state, 40));
  assert.equal(manualEnd.ended, true);
  assert.deepEqual(goOutcome(manualEnd, scoreChineseArea), { black: 81, white: 6.5, winner: 1, margin: 74.5 });
  assert.strictEqual(playGo(manualEnd, null), manualEnd);
});

test('Go practice chooses captures and breaks score ties by intersection order', () => {
  assert.equal(chooseGoMove(createGo()), 40);
  const opening = replay([40]);
  assert.equal(chooseGoMove(opening), 31);
  assert.equal(chooseGoMove(opening), 31);
  assert.equal(chooseGoMove(replay([2, 0, 9, 1])), 10);
});

test('Go practice skips legal own eyes and passes when only eyes remain', () => {
  const board = Array(81).fill(1);
  board[40] = board[79] = board[80] = 0;
  const state = { ...createGo(), board };
  assert.notStrictEqual(playGo(state, 40), state);
  assert.equal(chooseGoMove(state), 79);

  const eyes = { ...state, board: state.board.slice() };
  eyes.board[79] = 1;
  assert.notStrictEqual(playGo(eyes, 40), eyes);
  assert.notStrictEqual(playGo(eyes, 80), eyes);
  assert.equal(chooseGoMove(eyes), null);
});
