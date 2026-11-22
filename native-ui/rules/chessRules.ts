type Side = 'w' | 'b';
type Promotion = 'q' | 'r' | 'b' | 'n';
type Reason = 'checkmate' | 'stalemate' | 'material' | 'repetition' | 'fifty-move';

type Position = {
  board: string[];
  turn: Side;
  castling: string;
  enPassant: number;
  halfmove: number;
  fullmove: number;
};

type ChessState = Position & {
  history: Array<{ coordinate: string; san: string }>;
  positions: string[];
};

type Castle = {
  right: string;
  side: Side;
  kingFrom: number;
  kingTo: number;
  rookFrom: number;
  rookTo: number;
  clear: number[];
  san: string;
};

type Move = {
  from: number;
  to: number;
  promotion?: Promotion;
  enPassantCapture?: number;
  castle?: Castle;
};

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';
const COORDINATE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const PROMOTIONS: Promotion[] = ['q', 'r', 'b', 'n'];
const ORTHOGONAL = [[-1, 0], [0, -1], [0, 1], [1, 0]];
const DIAGONAL = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const DIRECTIONS = ORTHOGONAL.concat(DIAGONAL);
const KNIGHT_STEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const CASTLES: Castle[] = [
  { right: 'K', side: 'w', kingFrom: 60, kingTo: 62, rookFrom: 63, rookTo: 61, clear: [61, 62], san: 'O-O' },
  { right: 'Q', side: 'w', kingFrom: 60, kingTo: 58, rookFrom: 56, rookTo: 59, clear: [57, 58, 59], san: 'O-O-O' },
  { right: 'k', side: 'b', kingFrom: 4, kingTo: 6, rookFrom: 7, rookTo: 5, clear: [5, 6], san: 'O-O' },
  { right: 'q', side: 'b', kingFrom: 4, kingTo: 2, rookFrom: 0, rookTo: 3, clear: [1, 2, 3], san: 'O-O-O' },
];

const row = (square: number) => square >> 3;
const file = (square: number) => square & 7;
const other = (side: Side): Side => side === 'w' ? 'b' : 'w';
const pieceFor = (side: Side, type: string) => side === 'w' ? type.toUpperCase() : type;
const isSide = (piece: string, side: Side) => piece !== '' && (piece < 'a') === (side === 'w');
const pawnDirection = (side: Side) => side === 'w' ? -1 : 1;
const squareName = (square: number) => FILES[file(square)] + (8 - row(square));
const squareIndex = (name: string) => (8 - Number(name[1])) * 8 + FILES.indexOf(name[0]);

function step(square: number, dr: number, df: number): number {
  const r = row(square) + dr;
  const f = file(square) + df;
  return r >= 0 && r < 8 && f >= 0 && f < 8 ? r * 8 + f : -1;
}

const SQUARES = Array.from({ length: 64 }, (_, square) => square);
const KNIGHT_TARGETS = SQUARES.map(square => KNIGHT_STEPS.map(([dr, df]) => step(square, dr, df)).filter(to => to >= 0));
const RAYS = SQUARES.map(square => DIRECTIONS.map(([dr, df]) => {
  const ray: number[] = [];
  for (let to = step(square, dr, df); to >= 0; to = step(to, dr, df)) ray.push(to);
  return ray;
}));
const KING_TARGETS = RAYS.map(rays => rays.filter(ray => ray.length).map(ray => ray[0]));

function attacked(board: string[], square: number, by: Side): boolean {
  const pawn = pieceFor(by, 'p');
  const reverse = -pawnDirection(by);
  if (board[step(square, reverse, -1)] === pawn || board[step(square, reverse, 1)] === pawn) return true;
  const knight = pieceFor(by, 'n');
  if (KNIGHT_TARGETS[square].some(to => board[to] === knight)) return true;
  const king = pieceFor(by, 'k');
  if (KING_TARGETS[square].some(to => board[to] === king)) return true;
  const queen = pieceFor(by, 'q');
  const rook = pieceFor(by, 'r');
  const bishop = pieceFor(by, 'b');
  const rays = RAYS[square];
  for (let i = 0; i < rays.length; i++) {
    const slider = i < ORTHOGONAL.length ? rook : bishop;
    for (const to of rays[i]) {
      const piece = board[to];
      if (!piece) continue;
      if (piece === queen || piece === slider) return true;
      break;
    }
  }
  return false;
}

export function chessInCheck(position: Position): boolean {
  const king = position.board.indexOf(pieceFor(position.turn, 'k'));
  return attacked(position.board, king, other(position.turn));
}

function boardAfter(position: Position, move: Move): string[] {
  const { from, to, promotion, enPassantCapture, castle } = move;
  const board = position.board.slice();
  board[to] = promotion ? pieceFor(position.turn, promotion) : board[from];
  board[from] = '';
  if (enPassantCapture !== undefined) board[enPassantCapture] = '';
  if (castle) {
    board[castle.rookTo] = board[castle.rookFrom];
    board[castle.rookFrom] = '';
  }
  return board;
}

function legalEnPassant(position: Position): number {
  const { board, turn, enPassant: to } = position;
  if (to < 0 || board[to]) return -1;
  const direction = pawnDirection(turn);
  const opponent = other(turn);
  const captured = step(to, -direction, 0);
  if (board[captured] !== pieceFor(opponent, 'p')) return -1;
  const king = board.indexOf(pieceFor(turn, 'k'));
  for (const df of [-1, 1]) {
    const from = step(to, -direction, df);
    if (board[from] !== pieceFor(turn, 'p')) continue;
    if (!attacked(boardAfter(position, { from, to, enPassantCapture: captured }), king, opponent)) return to;
  }
  return -1;
}

function pseudoMoves(position: Position): Move[] {
  const { board, turn, castling, enPassant } = position;
  const opponent = other(turn);
  const opponentKing = pieceFor(opponent, 'k');
  const moves: Move[] = [];
  const direction = pawnDirection(turn);
  // Generation order breaks equal scores for the local opponent.
  for (let from = 0; from < board.length; from++) {
    if (!isSide(board[from], turn)) continue;
    const type = board[from].toLowerCase();
    if (type === 'p') {
      const targets: Move[] = [];
      const one = step(from, direction, 0);
      if (one >= 0 && board[one] === '') {
        targets.push({ from, to: one });
        const two = step(one, direction, 0);
        if (row(from) === (turn === 'w' ? 6 : 1) && board[two] === '') targets.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const to = step(from, direction, df);
        if (to < 0) continue;
        if (isSide(board[to], opponent) && board[to] !== opponentKing) targets.push({ from, to });
        else if (to === enPassant) targets.push({ from, to, enPassantCapture: step(to, -direction, 0) });
      }
      for (const move of targets) {
        if (row(move.to) === (turn === 'w' ? 0 : 7)) {
          for (const promotion of PROMOTIONS) moves.push({ ...move, promotion });
        } else {
          moves.push(move);
        }
      }
    } else if (type === 'n' || type === 'k') {
      for (const to of (type === 'n' ? KNIGHT_TARGETS : KING_TARGETS)[from]) {
        if (!isSide(board[to], turn) && board[to] !== opponentKing) moves.push({ from, to });
      }
      if (type === 'k') {
        for (const castle of CASTLES) {
          if (castle.side === turn && from === castle.kingFrom && castling.includes(castle.right) &&
              board[castle.rookFrom] === pieceFor(turn, 'r') && castle.clear.every(to => !board[to]) &&
              !attacked(board, from, opponent) && !attacked(board, castle.rookTo, opponent)) {
            moves.push({ from, to: castle.kingTo, castle });
          }
        }
      }
    } else {
      const rays = RAYS[from];
      const begin = type === 'b' ? ORTHOGONAL.length : 0;
      const end = type === 'r' ? ORTHOGONAL.length : rays.length;
      for (let i = begin; i < end; i++) {
        for (const to of rays[i]) {
          if (!isSide(board[to], turn) && board[to] !== opponentKing) moves.push({ from, to });
          if (board[to]) break;
        }
      }
    }
  }
  return moves;
}

function legalMoves(position: Position): Move[] {
  const { board, turn } = position;
  const king = board.indexOf(pieceFor(turn, 'k'));
  const opponent = other(turn);
  return pseudoMoves(position).filter(move =>
    !attacked(boardAfter(position, move), move.from === king ? move.to : king, opponent));
}

function advance(position: Position, move: Move): Position {
  const { board, turn, halfmove, fullmove } = position;
  const piece = board[move.from].toLowerCase();
  const capture = board[move.to] !== '' || move.enPassantCapture !== undefined;
  let castling = position.castling;
  for (const castle of CASTLES) {
    if ((castle.side === turn && piece === 'k') || move.from === castle.rookFrom || move.to === castle.rookFrom) {
      castling = castling.replace(castle.right, '');
    }
  }
  const next = {
    board: boardAfter(position, move),
    turn: other(turn),
    castling,
    enPassant: piece === 'p' && Math.abs(move.from - move.to) === 16 ? (move.from + move.to) / 2 : -1,
    halfmove: piece === 'p' || capture ? 0 : halfmove + 1,
    fullmove: fullmove + Number(turn === 'b'),
  };
  next.enPassant = legalEnPassant(next);
  return next;
}

function positionKey(position: Position): string {
  const ranks: string[] = [];
  for (let start = 0; start < 64; start += 8) {
    let rank = '';
    let empty = 0;
    for (const piece of position.board.slice(start, start + 8)) {
      if (!piece) {
        empty++;
      } else {
        if (empty) rank += String(empty);
        rank += piece;
        empty = 0;
      }
    }
    if (empty) rank += String(empty);
    ranks.push(rank);
  }
  const enPassant = position.enPassant < 0 ? '-' : squareName(position.enPassant);
  return `${ranks.join('/')} ${position.turn} ${position.castling || '-'} ${enPassant}`;
}

export function createChess(fen = INITIAL_FEN): ChessState {
  const fields = fen.trim().split(/\s+/);
  const [placement, turn, castling, enPassant, halfmove, fullmove] = fields;
  if (fields.length !== 6 || (turn !== 'w' && turn !== 'b') ||
      !/^(?:-|K?Q?k?q?)$/.test(castling) || !/^(?:-|[a-h][36])$/.test(enPassant) ||
      (enPassant !== '-' && enPassant[1] !== (turn === 'w' ? '6' : '3')) ||
      !/^\d+$/.test(halfmove) || !/^\d+$/.test(fullmove) ||
      !Number.isSafeInteger(Number(halfmove)) || !Number.isSafeInteger(Number(fullmove)) || Number(fullmove) < 1) {
    throw new Error('Invalid chess FEN fields');
  }
  const ranks = placement.split('/').map(rank => rank.replace(/[1-8]/g, count => '.'.repeat(Number(count))));
  if (ranks.length !== 8 || ranks.some(rank => !/^[prnbqkPRNBQK.]{8}$/.test(rank)) || /p/i.test(ranks[0] + ranks[7])) {
    throw new Error('Invalid chess FEN board');
  }
  const board = ranks.join('').split('').map(piece => piece === '.' ? '' : piece);
  if (board.filter(piece => piece === 'K').length !== 1 || board.filter(piece => piece === 'k').length !== 1) {
    throw new Error('Invalid chess FEN kings');
  }
  const position: Position = {
    board,
    turn,
    castling: castling === '-' ? '' : castling,
    enPassant: enPassant === '-' ? -1 : squareIndex(enPassant),
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
  position.enPassant = legalEnPassant(position);
  return { ...position, history: [], positions: [positionKey(position)] };
}

export function chessFen(position: Position): string {
  return `${positionKey(position)} ${position.halfmove} ${position.fullmove}`;
}

function insufficientMaterial(board: string[]): boolean {
  const pieces = SQUARES.filter(square => board[square] && board[square].toLowerCase() !== 'k');
  if (pieces.length === 0) return true;
  if (pieces.length === 1) return 'bn'.includes(board[pieces[0]].toLowerCase());
  const squareColor = (square: number) => (row(square) + file(square)) % 2;
  return pieces.every(square => board[square].toLowerCase() === 'b' && squareColor(square) === squareColor(pieces[0]));
}

function repeated(positions: string[]): boolean {
  let occurrences = 0;
  const current = positions[positions.length - 1];
  // Equal positions must have the same side to move.
  for (let i = positions.length - 1; i >= 0; i -= 2) {
    if (positions[i] === current && ++occurrences === 3) return true;
  }
  return false;
}

export function chessEndConditions(state: ChessState, moves = legalMoves(state)) {
  const check = chessInCheck(state);
  return {
    checkmate: moves.length === 0 && check,
    stalemate: moves.length === 0 && !check,
    material: insufficientMaterial(state.board),
    repetition: repeated(state.positions),
    fiftyMove: state.halfmove >= 100,
  };
}

export function chessOutcome(state: ChessState, moves = legalMoves(state)): { reason: Reason; winner: Side | null } | null {
  const conditions = chessEndConditions(state, moves);
  if (conditions.checkmate) return { reason: 'checkmate', winner: other(state.turn) };
  if (conditions.stalemate) return { reason: 'stalemate', winner: null };
  if (conditions.material) return { reason: 'material', winner: null };
  if (conditions.repetition) return { reason: 'repetition', winner: null };
  if (conditions.fiftyMove) return { reason: 'fifty-move', winner: null };
  return null;
}

function coordinateFor(move: Move): string {
  return squareName(move.from) + squareName(move.to) + (move.promotion || '');
}

function sanFor(position: Position, move: Move, moves: Move[], next: Position): string {
  const { from, to, promotion, enPassantCapture, castle } = move;
  let san = castle ? castle.san : '';
  if (!castle) {
    const piece = position.board[from];
    const pawn = piece.toLowerCase() === 'p';
    const capture = position.board[to] !== '' || enPassantCapture !== undefined;
    const origin = squareName(from);
    if (pawn) {
      if (capture) san += origin[0];
    } else {
      san += piece.toUpperCase();
      const alternatives = moves.filter(candidate =>
        candidate.from !== from && candidate.to === to && position.board[candidate.from] === piece);
      if (alternatives.length) {
        const sameFile = alternatives.some(candidate => file(candidate.from) === file(from));
        const sameRank = alternatives.some(candidate => row(candidate.from) === row(from));
        san += sameFile && sameRank ? origin : sameFile ? origin[1] : origin[0];
      }
    }
    san += (capture ? 'x' : '') + squareName(to);
    if (promotion) san += '=' + promotion.toUpperCase();
  }
  if (chessInCheck(next)) san += legalMoves(next).length ? '+' : '#';
  return san;
}

export function chessMoves(state: ChessState) {
  const moves = legalMoves(state);
  return moves.map(move => ({
    from: squareName(move.from),
    to: squareName(move.to),
    coordinate: coordinateFor(move),
    san: sanFor(state, move, moves, advance(state, move)),
  }));
}

export function playChess(state: ChessState, coordinate: string): ChessState | null {
  if (typeof coordinate !== 'string' || !COORDINATE.test(coordinate)) return null;
  const moves = legalMoves(state);
  if (chessOutcome(state, moves)) return null;
  const move = moves.find(candidate => coordinateFor(candidate) === coordinate);
  if (!move) return null;
  const next = advance(state, move);
  const san = sanFor(state, move, moves, next);
  return {
    ...next,
    history: [...state.history, { coordinate, san }],
    positions: [...state.positions, positionKey(next)],
  };
}

export function replayChess(record: unknown): ChessState | null {
  if (!Array.isArray(record)) return null;
  let state = createChess();
  for (const coordinate of record) {
    const next = playChess(state, coordinate);
    if (!next) return null;
    state = next;
  }
  return state;
}

export function parseChessMove(state: ChessState, text: string): string | null {
  if (typeof text !== 'string') return null;
  let answer = text.trim().replace(/[+#!?]+$/, '');
  if (answer === '0-0' || answer === '0-0-0') answer = answer.replace(/0/g, 'O');
  const moves = legalMoves(state);
  if (chessOutcome(state, moves)) return null;
  if (COORDINATE.test(answer)) return moves.some(move => coordinateFor(move) === answer) ? answer : null;
  for (const move of moves) {
    if (sanFor(state, move, moves, advance(state, move)).replace(/[+#]$/, '') === answer) return coordinateFor(move);
  }
  return null;
}

const CAPTURE_VALUES: { [piece: string]: number } = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function chooseChessMove(state: ChessState): string | null {
  const moves = legalMoves(state);
  if (chessOutcome(state, moves)) return null;
  let best: Move | null = null;
  let bestScore = -1;
  for (const move of moves) {
    const captured = state.board[move.enPassantCapture ?? move.to].toLowerCase();
    let score = (CAPTURE_VALUES[captured] || 0) * 20;
    const next = advance(state, move);
    if (chessInCheck(next)) score += 4 + (legalMoves(next).length ? 0 : 10000);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best ? coordinateFor(best) : null;
}

export function chessBoardText(state: ChessState): string {
  const lines = [
    '坐标：列 a–h 从左到右，行 8–1 从上到下；你执黑，在上方。',
    '△ 开头的是用户的白棋，▲ 开头的是你的黑棋；K 王 Q 后 R 车 B 象 N 马 P 兵；· 为空格。',
    'FEN：' + chessFen(state),
    '   a  b  c  d  e  f  g  h',
  ];
  for (let r = 0; r < 8; r++) {
    const pieces = state.board.slice(r * 8, (r + 1) * 8).map(piece =>
      piece ? (isSide(piece, 'w') ? '△' : '▲') + piece.toUpperCase() : '·');
    lines.push(`${8 - r} ${pieces.join(' ')}`);
  }
  return lines.join('\n');
}

export function chessHistoryText(state: ChessState): string {
  if (!state.history.length) return '（开局第一步）';
  const initialPly = 2 * (state.fullmove - 1) + Number(state.turn === 'b') - state.history.length;
  return state.history.map(({ san }, i) => {
    const ply = initialPly + i;
    if (ply % 2 === 0) return `${Math.floor(ply / 2) + 1}. ${san}`;
    return i === 0 ? `${Math.floor(ply / 2) + 1}... ${san}` : san;
  }).join(' ');
}

// Perft isolates legal move generation from the game's automatic draw rules.
export function chessPerft(position: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(position);
  if (depth === 1) return moves.length;
  let leaves = 0;
  for (const move of moves) leaves += chessPerft(advance(position, move), depth - 1);
  return leaves;
}
