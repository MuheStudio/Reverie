'use strict';

const {loadRules, verifyStrategicGame} = require('./strategic-game-verdict.cjs');

const GO_CONTRACT = 'reverie.native.go.verdict.v1';
const turn = '轮到你执黑落子 · 提子 黑 0：白 0';

function replay(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2 ||
    !Array.isArray(record.moves) || record.ended !== false)
    return null;
  const rules = loadRules('goRules.ts');
  let position = rules.createGo();
  for (const move of record.moves) {
    const next = rules.playGo(position, move);
    if (next === position)
      return null;
    position = next;
  }
  const stones = position.board.flatMap((stone, index) =>
    stone ? [{index, color: stone === 1 ? 'black' : 'white'}] : []);
  const last = position.last === null ? [] : [position.last];
  return {moves: record.moves, last, stones, playerTurn: position.turn === 1 && position.passes < 2};
}

function verifyGo(reports, modelCallTiming, requests) {
  return verifyStrategicGame({id: 'go', after: 'chess', contract: GO_CONTRACT,
    moveControls: ['go-40'], empty: {moves: [], ended: false}, userMove: 40, turn, boardSize: 81, replay},
  reports, modelCallTiming, requests);
}

module.exports = {GO_CONTRACT, verifyGo};
