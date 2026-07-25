export type GomokuCell = 0 | 1 | 2;

export interface GomokuState {
  board: GomokuCell[];
  turn: GomokuCell;
  winner: GomokuCell;
  draw: boolean;
  moves: number[];
}

export const GOMOKU_SIZE = 15;

export function newGomokuState(): GomokuState {
  return {
    board: Array<GomokuCell>(GOMOKU_SIZE * GOMOKU_SIZE).fill(0),
    turn: 1,
    winner: 0,
    draw: false,
    moves: [],
  };
}

export function gomokuWinner(board: GomokuCell[], lastIndex: number): GomokuCell {
  const color = board[lastIndex];
  if (!color) return 0;
  const row = Math.floor(lastIndex / GOMOKU_SIZE);
  const col = lastIndex % GOMOKU_SIZE;
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;
  for (const [dr, dc] of directions) {
    let count = 1;
    for (const sign of [-1, 1]) {
      for (let step = 1; step < 5; step += 1) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= GOMOKU_SIZE || c < 0 || c >= GOMOKU_SIZE) break;
        if (board[r * GOMOKU_SIZE + c] !== color) break;
        count += 1;
      }
    }
    if (count >= 5) return color;
  }
  return 0;
}

export function playGomoku(state: GomokuState, index: number): GomokuState {
  if (state.winner || state.draw || state.board[index] || index < 0 || index >= state.board.length) {
    return state;
  }
  const board = [...state.board];
  board[index] = state.turn;
  const winner = gomokuWinner(board, index);
  const moves = [...state.moves, index];
  return {
    board,
    moves,
    winner,
    draw: !winner && moves.length === board.length,
    turn: state.turn === 1 ? 2 : 1,
  };
}

function gomokuRunScore(board: GomokuCell[], index: number, color: GomokuCell): number {
  const row = Math.floor(index / GOMOKU_SIZE);
  const col = index % GOMOKU_SIZE;
  let score = 0;
  for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
    let run = 1;
    let open = 0;
    for (const sign of [-1, 1]) {
      for (let step = 1; step < 5; step += 1) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= GOMOKU_SIZE || c < 0 || c >= GOMOKU_SIZE) break;
        const value = board[r * GOMOKU_SIZE + c];
        if (value === color) run += 1;
        else {
          if (value === 0) open += 1;
          break;
        }
      }
    }
    score += run >= 5 ? 1_000_000 : run ** 4 * (open + 1);
  }
  return score;
}

export function chooseGomokuMove(state: GomokuState): number | null {
  const empty = state.board.map((cell, index) => cell === 0 ? index : -1).filter((index) => index >= 0);
  if (!empty.length) return null;
  if (!state.moves.length) return Math.floor(state.board.length / 2);
  let best = empty[0];
  let bestScore = -Infinity;
  for (const index of empty) {
    const row = Math.floor(index / GOMOKU_SIZE);
    const col = index % GOMOKU_SIZE;
    const nearStone = state.moves.some((move) => {
      const mr = Math.floor(move / GOMOKU_SIZE);
      const mc = move % GOMOKU_SIZE;
      return Math.abs(mr - row) <= 2 && Math.abs(mc - col) <= 2;
    });
    if (!nearStone) continue;
    const attack = gomokuRunScore(state.board, index, 2);
    const defend = gomokuRunScore(state.board, index, 1);
    const center = 14 - Math.abs(row - 7) - Math.abs(col - 7);
    const score = attack * 1.1 + defend + center;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

export function undoGomokuRound(state: GomokuState): GomokuState {
  const remove = state.moves.length >= 2 ? 2 : state.moves.length;
  const moves = state.moves.slice(0, -remove);
  let next = newGomokuState();
  for (const move of moves) next = playGomoku(next, move);
  return next;
}

export type SnakeDirection = 'up' | 'down' | 'left' | 'right';
export type SnakeStatus = 'ready' | 'playing' | 'paused' | 'over';

export interface SnakeState {
  width: number;
  height: number;
  body: number[];
  direction: SnakeDirection;
  queuedDirection: SnakeDirection;
  food: number;
  score: number;
  status: SnakeStatus;
}

const OPPOSITE: Record<SnakeDirection, SnakeDirection> = {
  up: 'down', down: 'up', left: 'right', right: 'left',
};

const SNAKE_KEY_DIRECTIONS: Readonly<Record<string, SnakeDirection>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

export function snakeDirectionFromKey(key: string): SnakeDirection | undefined {
  return SNAKE_KEY_DIRECTIONS[key] ?? SNAKE_KEY_DIRECTIONS[key.toLowerCase()];
}

export function spawnFood(body: number[], total: number, random = Math.random): number {
  const empty = Array.from({ length: total }, (_, index) => index).filter((index) => !body.includes(index));
  if (!empty.length) return -1;
  return empty[Math.min(empty.length - 1, Math.floor(random() * empty.length))];
}

export function newSnakeState(width = 18, height = 18): SnakeState {
  const row = Math.floor(height / 2);
  const col = Math.floor(width / 2);
  const body = [row * width + col, row * width + col - 1, row * width + col - 2];
  return {
    width,
    height,
    body,
    direction: 'right',
    queuedDirection: 'right',
    food: spawnFood(body, width * height),
    score: 0,
    status: 'ready',
  };
}

export function queueSnakeDirection(state: SnakeState, direction: SnakeDirection): SnakeState {
  if (OPPOSITE[state.direction] === direction) return state;
  return {
    ...state,
    queuedDirection: direction,
    status: state.status === 'ready' ? 'playing' : state.status,
  };
}

export function tickSnake(state: SnakeState, random = Math.random): SnakeState {
  if (state.status !== 'playing') return state;
  const direction = state.queuedDirection;
  const head = state.body[0];
  const row = Math.floor(head / state.width);
  const col = head % state.width;
  const nextRow = row + (direction === 'down' ? 1 : direction === 'up' ? -1 : 0);
  const nextCol = col + (direction === 'right' ? 1 : direction === 'left' ? -1 : 0);
  if (nextRow < 0 || nextRow >= state.height || nextCol < 0 || nextCol >= state.width) {
    return { ...state, status: 'over' };
  }
  const nextHead = nextRow * state.width + nextCol;
  const ate = nextHead === state.food;
  const collisionBody = ate ? state.body : state.body.slice(0, -1);
  if (collisionBody.includes(nextHead)) return { ...state, status: 'over' };
  const body = [nextHead, ...collisionBody];
  const food = ate ? spawnFood(body, state.width * state.height, random) : state.food;
  return {
    ...state,
    body,
    direction,
    food,
    score: state.score + (ate ? 10 : 0),
    status: food === -1 ? 'over' : state.status,
  };
}

export function toggleSnake(state: SnakeState): SnakeState {
  if (state.status === 'over') {
    return { ...newSnakeState(state.width, state.height), status: 'playing' };
  }
  return {
    ...state,
    status: state.status === 'playing' ? 'paused' : 'playing',
  };
}

export function scoreChineseArea(signMap: number[][], komi = 6.5): { black: number; white: number } {
  const height = signMap.length;
  const width = signMap[0]?.length ?? 0;
  const visited = new Set<number>();
  let black = 0;
  let white = komi;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sign = signMap[y][x];
      if (sign === 1) { black += 1; continue; }
      if (sign === -1) { white += 1; continue; }
      const key = y * width + x;
      if (visited.has(key)) continue;
      const region: number[] = [];
      const borders = new Set<number>();
      const stack = [key];
      visited.add(key);
      while (stack.length) {
        const current = stack.pop()!;
        region.push(current);
        const cy = Math.floor(current / width);
        const cx = current % width;
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const value = signMap[ny][nx];
          const neighbor = ny * width + nx;
          if (value === 0 && !visited.has(neighbor)) {
            visited.add(neighbor);
            stack.push(neighbor);
          } else if (value !== 0) borders.add(value);
        }
      }
      if (borders.size === 1 && borders.has(1)) black += region.length;
      if (borders.size === 1 && borders.has(-1)) white += region.length;
    }
  }
  return { black, white };
}
