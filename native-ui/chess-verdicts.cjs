'use strict';

const {loadRules, verifyStrategicGame} = require('./strategic-game-verdict.cjs');

const CHESS_CONTRACT = 'reverie.native.chess.verdict.v1';

function squareIndex(square) {
  return (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 'a'.charCodeAt(0);
}

function replay(record) {
  const rules = loadRules('chessRules.ts');
  const position = rules.replayChess(record);
  if (!position)
    return null;
  const moves = position.history.map(move => move.coordinate);
  const latest = moves.at(-1);
  const last = latest ? [squareIndex(latest.slice(0, 2)), squareIndex(latest.slice(2, 4))].sort((a, b) => a - b) : [];
  const stones = position.board.flatMap((piece, index) =>
    piece ? [{index, color: piece === piece.toUpperCase() ? 'white' : 'black'}] : []);
  return {moves, last, stones, playerTurn: position.turn === 'w' && !rules.chessOutcome(position)};
}

function verifyChess(reports, modelCallTiming, requests) {
  return verifyStrategicGame({id: 'chess', after: 'gomoku', contract: CHESS_CONTRACT,
    moveControls: ['chess-e2', 'chess-e4'], empty: [], userMove: 'e2e4', turn: '轮到你执白走棋', boardSize: 64, replay},
  reports, modelCallTiming, requests);
}

module.exports = {CHESS_CONTRACT, verifyChess};
