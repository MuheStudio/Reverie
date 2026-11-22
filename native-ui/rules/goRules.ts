type Side = 1 | -1;
type Stone = 0 | Side;

export interface GoState {
  readonly board: readonly Stone[];
  readonly turn: Side;
  readonly last: number | null;
  readonly passes: number;
  readonly blackCaptures: number;
  readonly whiteCaptures: number;
  readonly ended: boolean;
  readonly ko: number | null;
}

interface AreaScore {
  black: number;
  white: number;
}

interface GoOutcome extends AreaScore {
  winner: Side;
  margin: number;
}

const size = 9;
const points = size * size;
const neighbors = Array.from({ length: points }, (_, index) => {
  const adjacent: number[] = [];
  const column = index % size;
  if (column > 0) adjacent.push(index - 1);
  if (column < size - 1) adjacent.push(index + 1);
  if (index >= size) adjacent.push(index - size);
  if (index < points - size) adjacent.push(index + size);
  return adjacent;
});

export function createGo(): GoState {
  return {
    board: Array<Stone>(points).fill(0),
    turn: 1,
    last: null,
    passes: 0,
    blackCaptures: 0,
    whiteCaptures: 0,
    ended: false,
    ko: null,
  };
}

function finished(state: GoState): boolean {
  return state.ended || state.passes >= 2;
}

function groupAt(board: readonly Stone[], index: number) {
  const color = board[index];
  const stones = new Set([index]);
  const liberties = new Set<number>();
  const pending = [index];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const neighbor of neighbors[current]) {
      const value = board[neighbor];
      if (value === 0) {
        liberties.add(neighbor);
      } else if (value === color && !stones.has(neighbor)) {
        stones.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return { stones, liberties };
}

export function playGo(state: GoState, index: number | null): GoState {
  if (finished(state)) return state;
  const nextTurn = state.turn === 1 ? -1 : 1;
  if (index === null) {
    return { ...state, turn: nextTurn, last: null, passes: state.passes + 1, ko: null };
  }
  if (!Number.isInteger(index) || index < 0 || index >= points ||
      state.board[index] !== 0 || index === state.ko) return state;

  const board = state.board.slice();
  board[index] = state.turn;
  const captured: number[] = [];
  const checked = new Set<number>();
  for (const neighbor of neighbors[index]) {
    if (board[neighbor] !== nextTurn || checked.has(neighbor)) continue;
    const group = groupAt(board, neighbor);
    for (const stone of group.stones) {
      checked.add(stone);
      if (group.liberties.size === 0) {
        captured.push(stone);
        board[stone] = 0;
      }
    }
  }
  const ownGroup = groupAt(board, index);
  if (ownGroup.liberties.size === 0) return state;

  // Only an immediate recapture that restores the prior position is forbidden.
  const ko = captured.length === 1 && ownGroup.stones.size === 1 && ownGroup.liberties.size === 1
    ? captured[0] : null;
  return {
    ...state,
    board,
    turn: nextTurn,
    last: index,
    passes: 0,
    blackCaptures: state.blackCaptures + (state.turn === 1 ? captured.length : 0),
    whiteCaptures: state.whiteCaptures + (state.turn === -1 ? captured.length : 0),
    ko,
  };
}

export function chooseGoMove(state: GoState): number | null {
  if (finished(state)) return null;
  const center = (size - 1) / 2;
  const previousCaptures = state.turn === 1 ? state.blackCaptures : state.whiteCaptures;
  let bestMove: number | null = null;
  let bestScore = -Infinity;
  for (let index = 0; index < points; index += 1) {
    if (state.board[index] !== 0 || neighbors[index].every((neighbor) => state.board[neighbor] === state.turn)) {
      continue;
    }
    const next = playGo(state, index);
    if (next === state) continue;
    const captures = state.turn === 1 ? next.blackCaptures : next.whiteCaptures;
    const occupiedNeighbors = neighbors[index].filter((neighbor) => next.board[neighbor] !== 0).length;
    const distance = Math.abs(index % size - center) + Math.abs(Math.floor(index / size) - center);
    const score = 100 * (captures - previousCaptures) + 3 * occupiedNeighbors + 2 * center - distance;
    if (score > bestScore) {
      bestScore = score;
      bestMove = index;
    }
  }
  return bestMove;
}

export function endGo(state: GoState): GoState {
  return state.ended ? state : { ...state, ended: true };
}

export function goOutcome(state: GoState, scoreChineseArea: (signMap: number[][]) => AreaScore): GoOutcome | null {
  if (!finished(state)) return null;
  const signMap = Array.from({ length: size }, (_, row) => state.board.slice(row * size, (row + 1) * size));
  const { black, white } = scoreChineseArea(signMap);
  return { black, white, winner: black > white ? 1 : -1, margin: Math.abs(black - white) };
}
