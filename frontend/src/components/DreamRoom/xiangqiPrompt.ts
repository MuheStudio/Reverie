import type { XiangqiPosition, XiangqiRole } from './xiangqiEngine';

const names: Record<XiangqiRole, string> = {
  king: '将帅', advisor: '士', elephant: '象', horse: '马', chariot: '车', cannon: '炮', pawn: '兵卒',
};

/** Coordinates match the persisted 9*y+x moves and the existing reply parser. */
export function xiangqiBoardText(position: XiangqiPosition): string {
  const lines = ['坐标：x=0…8从左到右，y=0为红方底线，y=9为黑方底线。', '每格显示颜色和棋种，·为空格。', 'x  0 1 2 3 4 5 6 7 8'];
  for (let y = 9; y >= 0; y--) lines.push(`y=${y} ` + Array.from({ length: 9 }, (_, x) => {
    const piece = position.board[9 * y + x];
    return piece ? `${piece.color === 'red' ? '红' : '黑'}${names[piece.role]}` : '·';
  }).join(' '));
  return lines.join('\n');
}
