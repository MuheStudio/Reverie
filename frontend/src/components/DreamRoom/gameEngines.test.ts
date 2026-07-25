import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import GoBoard from '@sabaki/go-board';
import { Xiangqi } from 'elephantops/xiangqi';
import { Engine } from 'tetris-engine';
import {
  chooseGomokuMove,
  gomokuWinner,
  newGomokuState,
  newSnakeState,
  playGomoku,
  queueSnakeDirection,
  scoreChineseArea,
  snakeDirectionFromKey,
  spawnFood,
  tickSnake,
  toggleSnake,
} from './gameEngines';

describe('playable mini-game engines', () => {
  it('detects a gomoku win and refuses occupied cells', () => {
    let state = newGomokuState();
    for (const index of [0, 15, 1, 16, 2, 17, 3, 18, 4]) state = playGomoku(state, index);
    expect(state.winner).toBe(1);
    expect(gomokuWinner(state.board, 4)).toBe(1);
    expect(playGomoku(state, 4)).toBe(state);
  });

  it('blocks an immediate gomoku threat', () => {
    let state = newGomokuState();
    for (const index of [0, 30, 1, 31, 2, 32, 3]) state = playGomoku(state, index);
    expect(state.turn).toBe(2);
    expect(chooseGomokuMove(state)).toBe(4);
  });

  it('prevents snake reversal and ends at a wall', () => {
    let state = newSnakeState(5, 5);
    state = { ...state, status: 'playing', body: [2, 1, 0], direction: 'right', queuedDirection: 'right' };
    expect(queueSnakeDirection(state, 'left')).toBe(state);
    state = tickSnake(state);
    state = tickSnake(state);
    state = tickSnake(state);
    expect(state.status).toBe('over');
  });

  it('maps all four arrow keys and starts on the first legal direction', () => {
    expect(snakeDirectionFromKey('ArrowUp')).toBe('up');
    expect(snakeDirectionFromKey('ArrowDown')).toBe('down');
    expect(snakeDirectionFromKey('ArrowLeft')).toBe('left');
    expect(snakeDirectionFromKey('ArrowRight')).toBe('right');

    const ready = newSnakeState(7, 7);
    const started = queueSnakeDirection(ready, 'up');
    expect(started.status).toBe('playing');
    expect(tickSnake(started).body[0]).toBe(ready.body[0] - ready.width);
  });

  it('never spawns snake food on its body', () => {
    expect(spawnFood([0, 1, 2, 3], 5, () => 0)).toBe(4);
  });

  it('starts a fresh snake after game over instead of reviving the crashed body', () => {
    const over = { ...newSnakeState(7, 7), body: [6, 5, 4], score: 80, status: 'over' as const };
    const restarted = toggleSnake(over);
    expect(restarted.status).toBe('playing');
    expect(restarted.score).toBe(0);
    expect(restarted.body).not.toEqual(over.body);
  });

  it('uses chess.js to reject illegal moves and detect checkmate', () => {
    const chess = new Chess();
    expect(() => chess.move({ from: 'e2', to: 'e5' })).toThrow();
    chess.move('f3');
    chess.move('e5');
    chess.move('g4');
    chess.move('Qh4#');
    expect(chess.isCheckmate()).toBe(true);
  });

  it('uses elephantops legal destinations for xiangqi', () => {
    const position = Xiangqi.default();
    const destinations = position.allDests();
    expect(position.turn).toBe('red');
    expect(destinations.size).toBeGreaterThan(0);
    const first = [...destinations.entries()].find(([, dests]) => [...dests].length > 0);
    expect(first).toBeTruthy();
    const [from, dests] = first!;
    const to = [...dests][0];
    expect(position.isLegal({ from, to })).toBe(true);
  });

  it('uses go-board for captures, overwrite, and suicide prevention', () => {
    let board = GoBoard.fromDimensions(5);
    board = board.makeMove(-1, [1, 1], { preventOverwrite: true, preventSuicide: true, preventKo: true });
    board = board.makeMove(1, [0, 1], { preventOverwrite: true, preventSuicide: true, preventKo: true });
    board = board.makeMove(1, [1, 0], { preventOverwrite: true, preventSuicide: true, preventKo: true });
    board = board.makeMove(1, [2, 1], { preventOverwrite: true, preventSuicide: true, preventKo: true });
    board = board.makeMove(1, [1, 2], { preventOverwrite: true, preventSuicide: true, preventKo: true });
    expect(board.get([1, 1])).toBe(0);
    expect(board.getCaptures(1)).toBe(1);
    expect(() => board.makeMove(-1, [1, 1], {
      preventOverwrite: true, preventSuicide: true, preventKo: true,
    })).toThrow();
  });

  it('scores enclosed territory with Chinese area scoring', () => {
    const map = [
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ];
    expect(scoreChineseArea(map, 0)).toEqual({ black: 9, white: 0 });
  });

  it('creates the standard 10 by 20 tetris playfield', () => {
    const engine = new Engine(10, 20, () => {});
    expect(engine.state.body).toHaveLength(20);
    expect(engine.state.body.every((row) => row.length === 10)).toBe(true);
  });
});
