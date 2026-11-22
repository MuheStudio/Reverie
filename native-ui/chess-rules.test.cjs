'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Chess } = require('../frontend/node_modules/chess.js');
const ts = require('../frontend/node_modules/typescript');

const source = fs.readFileSync(path.join(__dirname, 'rules/chessRules.ts'), 'utf8');
const generated = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, removeComments: false },
}).outputText;
const rules = new Function('exports', `${generated}\nreturn exports;`)({});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FIFTY_AND_MATE = '7k/5Q2/6K1/8/8/8/8/8 w - - 99 1';

function coordinates(text) {
  return { from: text.slice(0, 2), to: text.slice(2, 4), promotion: text[4] };
}

function positionKey(reference) {
  return reference.fen().split(' ').slice(0, 4).join(' ');
}

function recordPosition(reference, counts) {
  const key = positionKey(reference);
  const occurrences = (counts.get(key) || 0) + 1;
  counts.set(key, occurrences);
  return occurrences;
}

function playAll(start, moves) {
  let state = start;
  for (const coordinate of moves) {
    state = rules.playChess(state, coordinate);
    assert.ok(state, coordinate);
  }
  return state;
}

function legalMovePairings(moves) {
  return moves.map(move => `${move.coordinate} ${move.san}`).sort();
}

function oracleMovePairings(reference) {
  // chess.js 1.4.0's verbose Move constructor recomputes the same full legal move
  // list and two unused FEN strings for each candidate. Reuse the list through
  // its test-only internals. The fixed perft fixtures cross-check the public API.
  const moves = reference._moves();
  const squareName = square => 'abcdefgh'[square % 16] + (8 - Math.floor(square / 16));
  return moves.map(move => {
    const coordinate = squareName(move.from) + squareName(move.to) + (move.promotion || '');
    return `${coordinate} ${reference._moveToSan(move, moves)}`;
  }).sort();
}

test('matches published chess perft counts and chess.js from five standard positions', () => {
  // Published depth 1–3 counts for the initial position and positions 2–5:
  // https://www.chessprogramming.org/Perft_Results
  // The same positions are fixtures in the official Stockfish test suite:
  // https://github.com/official-stockfish/Stockfish/blob/master/tests/perft.sh
  const fixtures = [
    [START, [20, 400, 8902]],
    ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
    ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
    ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
    ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ];
  for (const [fen, expected] of fixtures) {
    const state = rules.createChess(fen);
    const reference = new Chess(fen);
    for (let depth = 1; depth <= expected.length; depth++) {
      const standard = expected[depth - 1];
      const label = `${fen} depth ${depth}`;
      assert.equal(reference.perft(depth), standard, `chess.js ${label}`);
      assert.equal(rules.chessPerft(state, depth), standard, `native ${label}`);
    }
    const publicMoves = reference.moves({ verbose: true }).map(move => ({
      coordinate: move.from + move.to + (move.promotion || ''), san: move.san,
    }));
    const expectedMoves = legalMovePairings(publicMoves);
    assert.deepEqual(oracleMovePairings(reference), expectedMoves, `${fen} oracle move format`);
    assert.deepEqual(legalMovePairings(rules.chessMoves(state)), expectedMoves, `${fen} moves and SAN`);
  }
});

test('resolves chess SAN disambiguation, both castlings, en passant, and all four promotions', () => {
  const examples = [
    ['4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1', 'b1d2', 'Nbd2', ' Nbd2?! '],
    ['4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1', 'f1d2', 'Nfd2', 'Nfd2'],
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 'O-O', '0-0!'],
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1c1', 'O-O-O', '0-0-0'],
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6', 'exd6', 'exd6'],
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7a8q', 'a8=Q+', 'a8=Q+?!'],
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7a8r', 'a8=R+', 'a8=R'],
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7a8b', 'a8=B', 'a8=B'],
    ['7k/P7/8/8/8/8/8/7K w - - 0 1', 'a7a8n', 'a8=N', 'a8=N'],
  ];
  for (const [fen, coordinate, san, decorated] of examples) {
    const state = rules.createChess(fen);
    const reference = new Chess(fen);
    const choice = reference.move(coordinates(coordinate));
    assert.equal(choice.san, san, coordinate);
    const legal = rules.chessMoves(state).find(move => move.coordinate === coordinate);
    const { from, to } = coordinates(coordinate);
    assert.deepEqual(legal, { from, to, coordinate, san });
    assert.equal(rules.parseChessMove(state, decorated), coordinate);
    assert.equal(rules.parseChessMove(state, coordinate), coordinate);
    const next = rules.playChess(state, coordinate);
    assert.deepEqual(next.history, [{ coordinate, san }]);
    assert.equal(rules.chessFen(next), reference.fen());
  }
  assert.equal(rules.parseChessMove(rules.createChess(examples[0][0]), 'Nd2'), null);
  assert.equal(rules.parseChessMove(rules.createChess(examples[5][0]), 'a7a8'), null);
  assert.equal(rules.playChess(rules.createChess(examples[5][0]), 'a7a8'), null);
  assert.equal(rules.parseChessMove(rules.createChess(), 'Nf3 e5'), null);
  assert.equal(rules.playChess(rules.createChess(), 'e2e4q'), null);
});

test('counts legal en passant availability and the initial position in chess repetition', () => {
  const fen = 'k3r3/3p4/8/4P3/8/8/8/4K3 b - - 0 1';
  const reference = new Chess(fen);
  const start = rules.createChess(fen);
  const kingCycle = ['e1f1', 'a8a7', 'f1e1', 'a7a8'];
  let state = start;
  const counts = new Map();
  let occurrences = recordPosition(reference, counts);
  for (const coordinate of ['d7d5', ...kingCycle, ...kingCycle]) {
    reference.move(coordinates(coordinate));
    state = rules.playChess(state, coordinate);
    assert.ok(state, coordinate);
    assert.equal(rules.chessFen(state), reference.fen());
    occurrences = recordPosition(reference, counts);
    if (coordinate === 'd7d5') {
      assert.equal(rules.parseChessMove(state, 'e5d6'), null);
      assert.equal(reference.fen().split(' ')[3], '-');
    }
    assert.equal(rules.chessEndConditions(state).repetition, occurrences >= 3);
  }
  assert.equal(occurrences, 3);
  // The pinned pawn was adjacent at the first occurrence. chess.js hashes that
  // pseudo-right, even though its own FEN correctly excludes it.
  assert.equal(reference.isThreefoldRepetition(), false);
  assert.deepEqual(rules.chessOutcome(state), { reason: 'repetition', winner: null });

  const knightCycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  const twice = playAll(rules.createChess(), knightCycle);
  assert.equal(rules.chessOutcome(twice), null);
  const threeTimes = playAll(twice, knightCycle);
  assert.deepEqual(rules.chessOutcome(threeTimes), { reason: 'repetition', winner: null });
  assert.equal(rules.playChess(threeTimes, 'e2e4'), null);
});

test('recognizes both same-color bishop fixtures and rejects opposite-color bishops as a draw', () => {
  const fixtures = [
    ['8/7k/8/8/8/B7/8/B6K w - - 0 1', true],
    ['8/7k/8/8/8/8/8/B5BK w - - 0 1', true],
    ['8/7k/8/8/8/Bb6/8/7K w - - 0 1', false],
  ];
  for (const [fen, expected] of fixtures) {
    const reference = new Chess(fen);
    assert.equal(reference.isInsufficientMaterial(), expected, fen);
    const state = rules.createChess(fen);
    assert.equal(rules.chessEndConditions(state).material, expected, fen);
    assert.deepEqual(rules.chessOutcome(state), expected ? { reason: 'material', winner: null } : null, fen);
  }
});

test('prioritizes checkmate, stalemate, insufficient material, and repetition over fifty moves', () => {
  const mate = playAll(rules.createChess(FIFTY_AND_MATE), ['f7g7']);
  const stalemate = rules.createChess('7k/5Q2/6K1/8/8/8/8/8 b - - 100 1');
  const material = rules.createChess('7k/8/8/8/8/8/8/K7 w - - 100 1');
  const repeatStart = rules.createChess('kn6/8/8/8/8/8/8/KN6 w - - 92 1');
  const cycle = ['b1c3', 'b8c6', 'c3b1', 'c6b8'];
  const repetition = playAll(repeatStart, [...cycle, ...cycle]);
  const quiet = rules.createChess('kn6/8/8/8/8/8/8/KN6 w - - 100 1');
  for (const [state, reason, winner] of [
    [mate, 'checkmate', 'w'], [stalemate, 'stalemate', null], [material, 'material', null],
    [repetition, 'repetition', null], [quiet, 'fifty-move', null],
  ]) {
    assert.equal(rules.chessEndConditions(state).fiftyMove, true);
    assert.deepEqual(rules.chessOutcome(state), { reason, winner });
    assert.equal(rules.chooseChessMove(state), null);
  }
});

test('rejects invalid chess records and emits the exact request board and SAN history', () => {
  for (const invalid of [{}, ['e2e4', 12], ['e2e4', 'E7E5'], ['e2e5'], ['e2e4q'],
    ['f2f3', 'e7e5', 'g2g4', 'd8h4', 'a2a3']]) {
    assert.equal(rules.replayChess(invalid), null, JSON.stringify(invalid));
  }
  assert.equal(rules.chessHistoryText(rules.createChess()), '（开局第一步）');
  const state = rules.replayChess(['e2e4', 'e7e5', 'g1f3']);
  assert.equal(rules.chessHistoryText(state), '1. e4 e5 2. Nf3');
  assert.equal(rules.chessBoardText(state), [
    '坐标：列 a–h 从左到右，行 8–1 从上到下；你执黑，在上方。',
    '△ 开头的是用户的白棋，▲ 开头的是你的黑棋；K 王 Q 后 R 车 B 象 N 马 P 兵；· 为空格。',
    'FEN：rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    '   a  b  c  d  e  f  g  h',
    '8 ▲R ▲N ▲B ▲Q ▲K ▲B ▲N ▲R',
    '7 ▲P ▲P ▲P ▲P · ▲P ▲P ▲P',
    '6 · · · · · · · ·',
    '5 · · · · ▲P · · ·',
    '4 · · · · △P · · ·',
    '3 · · · · · △N · ·',
    '2 △P △P △P △P · △P △P △P',
    '1 △R △N △B △Q △K △B · △R',
  ].join('\n'));
});

test('the local chess opponent consistently picks the first tied move and takes mate in one', () => {
  const start = rules.createChess();
  const first = rules.chessMoves(start)[0].coordinate;
  assert.equal(rules.chooseChessMove(start), first);
  assert.equal(rules.chooseChessMove(rules.createChess()), first);
  const mateInOne = rules.createChess(FIFTY_AND_MATE);
  const choice = rules.chooseChessMove(mateInOne);
  assert.deepEqual(rules.chessOutcome(playAll(mateInOne, [choice])), { reason: 'checkmate', winner: 'w' });
  assert.equal(rules.chooseChessMove(mateInOne), choice);
});

test('matches chess.js legal moves, SAN, and end conditions through 200 seeded games', () => {
  let seed = 0x71cf52a9;
  const randomIndex = length => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % length;
  };
  const maximumPlies = 200;
  for (let game = 0; game < 200; game++) {
    const reference = new Chess();
    let state = rules.createChess();
    const counts = new Map();
    for (let ply = 0; ply <= maximumPlies; ply++) {
      const fen = reference.fen();
      const label = `game ${game + 1}, ply ${ply}, ${fen}`;
      const occurrences = recordPosition(reference, counts);
      assert.equal(rules.chessFen(state), fen, `${label} FEN`);
      assert.equal(rules.chessInCheck(state), reference.isCheck(), `${label} check`);
      const expectedMoves = oracleMovePairings(reference);
      assert.deepEqual(legalMovePairings(rules.chessMoves(state)), expectedMoves, `${label} coordinates and SAN`);
      const conditions = {
        checkmate: reference.isCheckmate(),
        stalemate: reference.isStalemate(),
        material: reference.isInsufficientMaterial(),
        repetition: occurrences >= 3,
        fiftyMove: reference.isDrawByFiftyMoves(),
      };
      assert.deepEqual(rules.chessEndConditions(state), conditions, `${label} individual end conditions`);
      const winner = reference.turn() === 'w' ? 'b' : 'w';
      const expectedOutcome = conditions.checkmate ? { reason: 'checkmate', winner } :
        conditions.stalemate ? { reason: 'stalemate', winner: null } :
        conditions.material ? { reason: 'material', winner: null } :
        conditions.repetition ? { reason: 'repetition', winner: null } :
        conditions.fiftyMove ? { reason: 'fifty-move', winner: null } : null;
      assert.deepEqual(rules.chessOutcome(state), expectedOutcome, `${label} outcome`);
      if (expectedOutcome || ply === maximumPlies) break;
      const [coordinate] = expectedMoves[randomIndex(expectedMoves.length)].split(' ');
      reference.move(coordinates(coordinate));
      state = rules.playChess(state, coordinate);
      assert.ok(state, `${label} ${coordinate}`);
    }
  }
});
