/** First-party 90-intersection rules, written from the approved behavior contract.
 * Movement follows public Xiangqi rules. Draws retain the existing local game's
 * simplified behavior; this is not a tournament adjudicator.
 */
export type XiangqiSide = 'red' | 'black';
export type XiangqiRole = 'king' | 'advisor' | 'elephant' | 'horse' | 'chariot' | 'cannon' | 'pawn';
export interface XiangqiPiece { readonly color: XiangqiSide; readonly role: XiangqiRole }
export interface XiangqiMove { from: number; to: number }
export interface XiangqiPosition { readonly board: ReadonlyArray<XiangqiPiece | null>; readonly turn: XiangqiSide; readonly quietHalfmoves: number }
export interface XiangqiOutcome { winner: XiangqiSide | null; reason: 'king-missing' | 'checkmate' | 'stalemate' | 'quiet-limit' | 'material' }
export type XiangqiReplay = { valid: true; position: XiangqiPosition } | { valid: false; index: number; code: 'shape' | 'move' | 'after-end' };
const other = (side: XiangqiSide): XiangqiSide => side === 'red' ? 'black' : 'red';
const file = (square: number) => square % 9;
const rank = (square: number) => Math.floor(square / 9);
const squareValid = (square: number) => Number.isInteger(square) && square >= 0 && square < 90;
export function xiangqiSquare(x: number, y: number): number | null {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 9 && y >= 0 && y < 10 ? y * 9 + x : null;
}
export function initialXiangqi(): XiangqiPosition {
  const board: Array<XiangqiPiece | null> = Array(90).fill(null);
  const back: XiangqiRole[] = ['chariot', 'horse', 'elephant', 'advisor', 'king', 'advisor', 'elephant', 'horse', 'chariot'];
  for (const color of ['red', 'black'] as const) {
    const y = color === 'red' ? 0 : 9;
    for (let x = 0; x < 9; x++) board[y * 9 + x] = { color, role: back[x] };
    for (const x of [1, 7]) board[(color === 'red' ? 2 : 7) * 9 + x] = { color, role: 'cannon' };
    for (const x of [0, 2, 4, 6, 8]) board[(color === 'red' ? 3 : 6) * 9 + x] = { color, role: 'pawn' };
  }
  return { board, turn: 'red', quietHalfmoves: 0 };
}
function palace(side: XiangqiSide, square: number) {
  return file(square) >= 3 && file(square) <= 5 && (side === 'red' ? rank(square) <= 2 : rank(square) >= 7);
}
function screens(board: XiangqiPosition['board'], from: number, to: number): number {
  if (file(from) !== file(to) && rank(from) !== rank(to)) return -1;
  const step = file(from) === file(to) ? Math.sign(to - from) * 9 : Math.sign(to - from);
  let result = 0;
  for (let s = from + step; s !== to; s += step) if (board[s]) result++;
  return result;
}
function reaches(board: XiangqiPosition['board'], from: number, to: number, piece: XiangqiPiece): boolean {
  if (from === to) return false;
  const dx = file(to) - file(from), dy = rank(to) - rank(from), ax = Math.abs(dx), ay = Math.abs(dy);
  switch (piece.role) {
    case 'king':
      if (dx === 0 && board[to]?.role === 'king' && board[to]?.color !== piece.color && screens(board, from, to) === 0) return true;
      return ax + ay === 1 && palace(piece.color, from) && palace(piece.color, to);
    case 'advisor': return ax === 1 && ay === 1 && palace(piece.color, from) && palace(piece.color, to);
    case 'elephant': {
      const ownHalf = piece.color === 'red' ? rank(from) <= 4 && rank(to) <= 4 : rank(from) >= 5 && rank(to) >= 5;
      return ownHalf && ax === 2 && ay === 2 && !board[(rank(from) + dy / 2) * 9 + file(from) + dx / 2];
    }
    case 'horse':
      if (ax === 2 && ay === 1) return !board[rank(from) * 9 + file(from) + Math.sign(dx)];
      if (ax === 1 && ay === 2) return !board[(rank(from) + Math.sign(dy)) * 9 + file(from)];
      return false;
    case 'chariot': return screens(board, from, to) === 0;
    case 'cannon': return screens(board, from, to) === (board[to] ? 1 : 0);
    case 'pawn':
      if (dx === 0 && dy === (piece.color === 'red' ? 1 : -1)) return true;
      return dy === 0 && ax === 1 && (piece.color === 'red' ? rank(from) >= 5 : rank(from) <= 4);
  }
}
export function xiangqiInCheck(position: XiangqiPosition, side: XiangqiSide = position.turn): boolean {
  const king = position.board.findIndex(p => p?.color === side && p.role === 'king');
  if (king < 0) return true;
  return position.board.some((p, from) => p?.color === other(side) && reaches(position.board, from, king, p));
}
function moved(position: XiangqiPosition, move: XiangqiMove): XiangqiPosition {
  const board = position.board.slice();
  const captured = board[move.to];
  board[move.to] = board[move.from]; board[move.from] = null;
  return { board, turn: other(position.turn), quietHalfmoves: captured ? 0 : position.quietHalfmoves + 1 };
}
export function xiangqiIsLegal(position: XiangqiPosition, move: XiangqiMove): boolean {
  if (!squareValid(move.from) || !squareValid(move.to) || move.from === move.to) return false;
  const piece = position.board[move.from];
  if (!piece || piece.color !== position.turn || position.board[move.to]?.color === piece.color) return false;
  return reaches(position.board, move.from, move.to, piece) && !xiangqiInCheck(moved(position, move), piece.color);
}
export function xiangqiLegalMoves(position: XiangqiPosition, from?: number): XiangqiMove[] {
  const result: XiangqiMove[] = [];
  for (let source = 0; source < 90; source++) {
    if (from !== undefined && source !== from) continue;
    if (position.board[source]?.color !== position.turn) continue;
    for (let to = 0; to < 90; to++) if (xiangqiIsLegal(position, { from: source, to })) result.push({ from: source, to });
  }
  return result;
}
export function xiangqiInsufficient(position: XiangqiPosition, side: XiangqiSide): boolean {
  const pieces = position.board.filter((p): p is XiangqiPiece => p !== null);
  if (pieces.some(p => p.color === side && ['horse', 'chariot', 'pawn'].includes(p.role))) return false;
  if (!pieces.some(p => p.color === side && p.role === 'cannon')) return true;
  return !pieces.some(p => p.role === 'advisor');
}
export function xiangqiOutcome(position: XiangqiPosition): XiangqiOutcome | null {
  if (!position.board.some(p => p?.color === position.turn && p.role === 'king')) return { winner: other(position.turn), reason: 'king-missing' };
  if (!position.board.some(p => p?.color === other(position.turn) && p.role === 'king')) return { winner: position.turn, reason: 'king-missing' };
  if (position.quietHalfmoves >= 50) return { winner: null, reason: 'quiet-limit' };
  if (xiangqiInsufficient(position, 'red') && xiangqiInsufficient(position, 'black')) return { winner: null, reason: 'material' };
  if (xiangqiLegalMoves(position).length) return null;
  return { winner: other(position.turn), reason: xiangqiInCheck(position) ? 'checkmate' : 'stalemate' };
}
export function xiangqiPlay(position: XiangqiPosition, move: XiangqiMove): XiangqiPosition {
  if (xiangqiOutcome(position) || !xiangqiIsLegal(position, move)) throw new Error('Illegal Xiangqi move');
  return moved(position, move);
}
export function replayXiangqi(value: unknown): XiangqiReplay {
  if (!Array.isArray(value) || value.length > 1000) return { valid: false, index: 0, code: 'shape' };
  let position = initialXiangqi();
  for (let index = 0; index < value.length; index++) {
    const move = value[index];
    if (!move || typeof move !== 'object' || !squareValid(move.from) || !squareValid(move.to)) return { valid: false, index, code: 'shape' };
    if (xiangqiOutcome(position)) return { valid: false, index, code: 'after-end' };
    if (!xiangqiIsLegal(position, move)) return { valid: false, index, code: 'move' };
    position = moved(position, move);
  }
  return { valid: true, position };
}
export function parseXiangqiMove(text: string, position: XiangqiPosition): { move: XiangqiMove | null; error: string | null } {
  const parts = text.trim().split(/[，,\s]+/).map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p))) return { move: null, error: '走法需要四个整数坐标' };
  const from = xiangqiSquare(parts[0], parts[1]), to = xiangqiSquare(parts[2], parts[3]);
  if (from === null || to === null) return { move: null, error: '坐标超出棋盘' };
  const move = { from, to };
  return xiangqiIsLegal(position, move) && !xiangqiOutcome(position) ? { move, error: null } : { move: null, error: '这不是一步合法的走法' };
}
const VALUE: Record<XiangqiRole, number> = { king: 1000, chariot: 90, cannon: 45, horse: 40, elephant: 20, advisor: 20, pawn: 10 };
export function chooseXiangqiPracticeMove(position: XiangqiPosition, random: () => number = Math.random): XiangqiMove | null {
  if (xiangqiOutcome(position)) return null;
  let best: XiangqiMove | null = null, score = -Infinity;
  for (const move of xiangqiLegalMoves(position)) {
    const next = moved(position, move), outcome = xiangqiOutcome(next), captured = position.board[move.to];
    const candidate = (captured ? VALUE[captured.role] * 10 : 0) + (outcome?.winner === position.turn ? 100000 : xiangqiInCheck(next) ? 20 : 0) + Math.max(0, Math.min(1, random())) * 5;
    if (candidate > score) { best = move; score = candidate; }
  }
  return best;
}
