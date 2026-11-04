import { describe, expect, it } from 'vitest';
import { initialXiangqi, replayXiangqi } from './xiangqiEngine';
import { xiangqiBoardText } from './xiangqiPrompt';
describe('xiangqi model board input', () => {
  it('preserves all 90 cells, colors, roles and bottom-origin coordinates', () => {
    const text = xiangqiBoardText(initialXiangqi());
    const rows = text.split('\n').filter(line => line.startsWith('y='));
    expect(rows).toHaveLength(10);
    expect(rows.flatMap(line => line.split(' ').slice(1))).toHaveLength(90);
    expect(rows[0]).toBe('y=9 黑车 黑马 黑象 黑士 黑将帅 黑士 黑象 黑马 黑车');
    expect(rows[9]).toBe('y=0 红车 红马 红象 红士 红将帅 红士 红象 红马 红车');
    expect(text).not.toMatch(/[△▲]/);
  });
  it('describes the committed position after a move without changing it', () => {
    const replay = replayXiangqi([{ from: 27, to: 36 }]);
    if (!replay.valid) throw Error('fixture');
    const before = JSON.stringify(replay.position);
    const text = xiangqiBoardText(replay.position);
    expect(text).toContain('y=4 红兵卒 · · · · · · · ·');
    expect(text).toContain('y=3 · · 红兵卒 · 红兵卒 · 红兵卒 · 红兵卒');
    expect(JSON.stringify(replay.position)).toBe(before);
  });
});
