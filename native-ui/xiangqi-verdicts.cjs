'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const redMove = {from: 25, to: 22};
const navigation = ['scene-navigation-search', 'search-result-activities-xiangqi'];
const clickOrder = [
  [...navigation, 'xiangqi-25', 'xiangqi-22', 'xiangqiUndo', 'xiangqi-25', 'xiangqi-22',
    'xiangqiReset', 'xiangqiResetCancel'],
  [...navigation, 'xiangqiReset', 'xiangqiResetConfirm'],
];
const get = 'game_state:get', put = 'game_state:put';

function loadReplay() {
  const ts = require('../frontend/node_modules/typescript');
  const engine = path.join(__dirname, '../frontend/src/components/DreamRoom/xiangqiEngine.ts');
  const source = ts.transpileModule(fs.readFileSync(engine, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const rules = {};
  new Function('exports', source)(rules);
  return rules.replayXiangqi;
}

function checkCycle(report, index, seenIds, replay) {
  const cycle = report?.xiangqi;
  assert(cycle?.passed === true && cycle.error === '' && cycle.cycle === index + 1, 'XIANGQI_CYCLE');
  const deadline = index === 0 ? 60000 : 15000;
  assert(Number.isInteger(cycle.elapsedMs) && cycle.elapsedMs >= 0 &&
    cycle.elapsedMs < deadline && cycle.deadlineMs === deadline, 'XIANGQI_DEADLINE');
  assert(cycle.archiveResults === 0 && cycle.archiveUnchanged === true, 'XIANGQI_ARCHIVE');
  assert(cycle.observed?.mode === '本地练习' && cycle.observed.retiredControls === 0, 'XIANGQI_VIEW');

  assert.deepEqual(cycle.clicks?.map(row => row.control), clickOrder[index], 'XIANGQI_INPUT_ORDER');
  assert(cycle.clicks.every(row => row.mouseDispatchCount === 1 && row.clickedSignals === 1 &&
    Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs < 4000), 'XIANGQI_INPUT_PROOF');

  const commandOrder = [get, ...Array(index === 0 ? 6 : 1).fill(put)];
  assert.deepEqual(cycle.commands?.map(row => row.command), commandOrder, 'XIANGQI_COMMAND_ORDER');
  assert(Array.isArray(cycle.receipts) && cycle.receipts.length === commandOrder.length, 'XIANGQI_RECEIPTS');
  for (const [i, row] of cycle.commands.entries()) {
    const receipt = cycle.receipts[i];
    assert(typeof row.id === 'string' && /^qt_[a-f0-9]{32}$/.test(row.id) &&
      !seenIds.has(row.id) && receipt?.id === row.id && receipt.command === row.command &&
      receipt.ok === true && typeof receipt.exists === 'boolean' &&
      Number.isInteger(receipt.generation) && receipt.generation > 0 &&
      receipt.generation === cycle.receipts[0].generation, 'XIANGQI_RECEIPT_BINDING');
    seenIds.add(row.id);
    if (receipt.exists) {
      assert(Array.isArray(receipt.moves) && receipt.moves.every(move =>
        move && Number.isInteger(move.from) && Number.isInteger(move.to) &&
        Object.keys(move).length === 2), 'XIANGQI_MOVE_SHAPE');
      assert(replay(receipt.moves).valid === true, 'XIANGQI_REPLAY');
    }
  }
  return cycle;
}

function snapshot(cycle, name, at) {
  const actual = cycle.observed[name];
  const receipt = cycle.receipts[at];
  assert.deepEqual(actual, {revision: receipt.revision, moves: receipt.moves, redTurn: true, exchanges: at + 1},
    'XIANGQI_SNAPSHOT:' + name);
  return actual;
}

function verifyXiangqi(reports) {
  assert(Array.isArray(reports) && reports.length === 2, 'XIANGQI_CYCLES');
  const ids = new Set(), replay = loadReplay();
  const first = checkCycle(reports[0], 0, ids, replay);
  const restarted = checkCycle(reports[1], 1, ids, replay);
  const a = first.receipts, b = restarted.receipts;
  assert(a[0].exists === false && a[0].revision === 0 && a[0].moves === null &&
    a.slice(1).every((row, i) => row.exists && row.revision === i + 1), 'XIANGQI_FIRST_REVISIONS');
  assert.deepEqual(a[1].moves, [], 'XIANGQI_NEW_GAME');
  assert.deepEqual(a[4].moves, [], 'XIANGQI_UNDO');
  for (const i of [2, 5]) {
    assert.deepEqual(a[i].moves, [redMove], 'XIANGQI_RED_MOVE');
    assert(a[i + 1].moves.length === 2 && replay(a[i + 1].moves).position.turn === 'red', 'XIANGQI_PRACTICE_REPLY');
    assert.deepEqual(a[i + 1].moves.slice(0, 1), a[i].moves, 'XIANGQI_PRACTICE_PREFIX');
  }
  snapshot(first, 'loaded', 1);
  snapshot(first, 'first', 3);
  snapshot(first, 'undo', 4);
  snapshot(first, 'second', 6);
  const end = snapshot(first, 'final', 6);
  assert(b.every(row => row.exists) && b[0].revision === end.revision &&
    b[1].revision === end.revision + 1, 'XIANGQI_RESTART_REVISION');
  assert.deepEqual(b[0].moves, end.moves, 'XIANGQI_RESTART_MOVES');
  assert.deepEqual(b[1].moves, [], 'XIANGQI_RESTART_RESET');
  snapshot(restarted, 'loaded', 0);
  snapshot(restarted, 'final', 1);
  return {passed: true, elapsedMs: [first.elapsedMs, restarted.elapsedMs], firstWrites: 6, restartWrites: 1,
    modelMoves: 0, blackMoves: [a[3].moves[1], a[6].moves[1]], finalRevisions: [end.revision, b[1].revision]};
}

module.exports = {verifyXiangqi};
