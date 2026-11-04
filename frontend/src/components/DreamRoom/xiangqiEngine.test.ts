import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { initialXiangqi, xiangqiSquare as sq, xiangqiIsLegal as legal, xiangqiPlay as play, xiangqiInCheck as check, xiangqiOutcome as outcome, replayXiangqi, parseXiangqiMove, chooseXiangqiPracticeMove, xiangqiInsufficient, type XiangqiPiece, type XiangqiPosition, type XiangqiRole } from './xiangqiEngine';
function position(pieces: Array<[number, XiangqiPiece['color'], XiangqiRole]>, turn: XiangqiPiece['color'] = 'red', quietHalfmoves = 0): XiangqiPosition {
  const board = Array<XiangqiPiece | null>(90).fill(null);
  for (const [s, color, role] of pieces) board[s] = { color, role };
  return { board, turn, quietHalfmoves };
}
const kings: Array<[number, XiangqiPiece['color'], XiangqiRole]> = [[3, 'red', 'king'], [85, 'black', 'king']];
describe('independent Xiangqi movement and king safety', () => {
  it('keeps the legacy coordinates, 32 pieces and red first', () => {
    const p = initialXiangqi(); expect(p.board.filter(Boolean)).toHaveLength(32);
    expect(p.turn).toBe('red'); expect(sq(0,0)).toBe(0); expect(sq(8,9)).toBe(89);
    for (const [x,y] of [[9,0],[-1,0],[0,10],[1.5,0]]) expect(sq(x,y)).toBe(null);
    const before = JSON.stringify(p); const next = play(p,{from:27,to:36});
    expect(next.turn).toBe('black'); expect(next.board[36]?.role).toBe('pawn'); expect(JSON.stringify(p)).toBe(before);
  });
  it('restricts palace movement for king and advisor', () => {
    const p=position([...kings,[13,'red','advisor']]);
    expect(legal(p,{from:3,to:12})).toBe(true); expect(legal(p,{from:3,to:2})).toBe(false);
    expect(legal(p,{from:13,to:23})).toBe(true); expect(legal(p,{from:13,to:12})).toBe(false);
  });
  it('blocks elephant eyes and prohibits crossing the river', () => {
    const p=position([...kings,[20,'red','elephant']]);expect(legal(p,{from:20,to:40})).toBe(true);
    expect(legal(position([...kings,[20,'red','elephant'],[30,'red','pawn']]),{from:20,to:40})).toBe(false);
    expect(legal(position([...kings,[40,'red','elephant']]),{from:40,to:60})).toBe(false);
  });
  it('blocks the orthogonal horse leg without making it a jumping knight', () => {
    const p=position([...kings,[20,'red','horse']]);expect(legal(p,{from:20,to:31})).toBe(true);
    expect(legal(position([...kings,[20,'red','horse'],[21,'black','pawn']]),{from:20,to:31})).toBe(false);
    expect(legal(p,{from:20,to:30})).toBe(false);
  });
  it('moves rooks along unobstructed ranks or files', () => {
    const p=position([...kings,[27,'red','chariot'],[30,'black','pawn']]);expect(legal(p,{from:27,to:30})).toBe(true);
    expect(legal(p,{from:27,to:31})).toBe(false);expect(legal(p,{from:27,to:37})).toBe(false);
  });
  it('requires exactly one cannon screen for capture, none for a quiet move', () => {
    const p=position([...kings,[27,'red','cannon'],[29,'red','pawn'],[32,'black','horse']]);
    expect(legal(p,{from:27,to:28})).toBe(true);expect(legal(p,{from:27,to:30})).toBe(false);
    expect(legal(p,{from:27,to:32})).toBe(true);
    expect(legal(position([...kings,[27,'red','cannon'],[32,'black','horse']]),{from:27,to:32})).toBe(false);
    expect(legal(position([...kings,[27,'red','cannon'],[29,'red','pawn'],[30,'black','pawn'],[32,'black','horse']]),{from:27,to:32})).toBe(false);
  });
  it('keeps pawn direction and adds sideways moves after crossing', () => {
    const p=position([...kings,[27,'red','pawn']]);expect(legal(p,{from:27,to:36})).toBe(true);
    expect(legal(p,{from:27,to:28})).toBe(false);expect(legal(p,{from:27,to:18})).toBe(false);
    expect(legal(position([...kings,[45,'red','pawn']]),{from:45,to:46})).toBe(true);
    const black=position([...kings,[36,'black','pawn']],'black');expect(legal(black,{from:36,to:37})).toBe(true);expect(legal(black,{from:36,to:27})).toBe(true);
  });
  it('rejects opening the generals file and moving a pinned piece', () => {
    const facing=position([[4,'red','king'],[85,'black','king'],[40,'red','chariot']]);
    expect(legal(facing,{from:40,to:41})).toBe(false);expect(legal(facing,{from:40,to:49})).toBe(true);
    const pinned=position([...kings,[12,'red','chariot'],[48,'black','chariot']]);expect(legal(pinned,{from:12,to:13})).toBe(false);
  });
  it('reports mate and stalemate as losses for the side without legal moves', () => {
    const mate=position([[4,'red','king'],[85,'black','king'],[12,'black','chariot'],[14,'black','chariot'],[22,'black','chariot']]);
    expect(check(mate)).toBe(true);expect(outcome(mate)).toEqual({winner:'black',reason:'checkmate'});
    const stale=position([[4,'red','king'],[86,'black','king'],[12,'black','chariot'],[14,'black','chariot']]);
    expect(check(stale)).toBe(false);expect(outcome(stale)).toEqual({winner:'black',reason:'stalemate'});
  });
  it('preserves simplified draw counters without resetting them on pawn movement', () => {
    const p={...initialXiangqi(),quietHalfmoves:49};expect(outcome(play(p,{from:27,to:36}))).toEqual({winner:null,reason:'quiet-limit'});
    const next=play({...initialXiangqi(),quietHalfmoves:49},{from:19,to:82});expect(next.quietHalfmoves).toBe(0);expect(outcome(next)).toBe(null);
    expect(outcome(position(kings))).toEqual({winner:null,reason:'material'});
  });
  it('matches all 324 independently captured public material observations', () => {
    const observation = JSON.parse(readFileSync(new URL('../../../../LICENSES_CREDITS/history/elephantops-public-contract.json', import.meta.url), 'utf8'));
    expect(observation.version).toBe('0.1.1'); expect(observation.samples).toHaveLength(324);
    for (const row of observation.samples) {
      const pieces = [...kings];
      for (const [side, role, squares] of [['red','cannon',[19,25]],['black','cannon',[64,70]],['red','advisor',[13,5]],['black','advisor',[84,86]],['red','elephant',[2]],['black','elephant',[83]]] as const) {
        for (const square of squares.slice(0, row[side][role])) pieces.push([square,side,role]);
      }
      const p = position(pieces);
      expect(xiangqiInsufficient(p,'red')).toBe(row.redInsufficient);
      expect(xiangqiInsufficient(p,'black')).toBe(row.blackInsufficient);
    }
  });
  it('validates the whole stored game and never exposes a truncated prefix', () => {
    expect(replayXiangqi([{from:27,to:36},{from:54,to:45}]).valid).toBe(true);
    const result=replayXiangqi([{from:27,to:36},{from:54,to:70}]);expect(result).toEqual({valid:false,index:1,code:'move'});expect('position' in result).toBe(false);
    for(const invalid of [null,{},Array(1001).fill({from:0,to:1}),[{from:-1,to:0}],[{from:0.5,to:9}]])expect(replayXiangqi(invalid).valid).toBe(false);
  });
  it('accepts square zero in companion coordinates and uses legal fallback only', () => {
    const p=initialXiangqi();expect(parseXiangqiMove('0,0,0,1',p).move).toEqual({from:0,to:9});
    expect(parseXiangqiMove('9 0 0 1',p).move).toBe(null);const move=chooseXiangqiPracticeMove(p,()=>0);expect(move&&legal(p,move)).toBe(true);
  });
});
