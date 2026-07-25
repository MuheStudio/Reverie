import { describe, expect, it } from 'vitest';
import {
  buildDiaryMirrorEntry,
  buildTimelineMirrorPost,
  makeLifeEvidenceId,
} from './lifeEvidenceSync';

describe('DreamRoom life evidence sync', () => {
  it('builds stable mirror IDs from backend evidence', () => {
    expect(makeLifeEvidenceId('diary', '2026-03-02')).toBe(
      makeLifeEvidenceId('diary', '2026-03-02'),
    );
    expect(makeLifeEvidenceId('diary', '2026-03-02')).not.toBe(
      makeLifeEvidenceId('timeline', '2026-03-02'),
    );
  });

  it('does not leak locked diary content into the Diary window mirror', () => {
    const entry = buildDiaryMirrorEntry(
      {
        date: '2026-03-02',
        title: '秘密页',
        content: '不该在锁定状态泄露的正文',
        mood: '开心',
        can_peek: false,
      },
      0,
      Date.UTC(2026, 2, 2),
    );

    expect(entry.title).toBe('秘密页');
    expect(entry.mood).toBe('happy');
    expect(entry.content).toContain('仍锁着');
    expect(entry.content).not.toContain('不该在锁定状态泄露');
  });

  it('does not call a peekable metadata-only diary locked', () => {
    const entry = buildDiaryMirrorEntry(
      {
        date: '2026-03-03',
        mood: 'calm',
        can_peek: true,
      },
      0,
      Date.UTC(2026, 2, 3),
    );

    expect(entry.content).toContain('只给了元数据');
    expect(entry.content).not.toContain('仍锁着');
  });

  it('mirrors timeline posts into the Twitter window shape', () => {
    const post = buildTimelineMirrorPost(
      {
        id: 'post-1',
        date: '2026-03-02 21:30',
        content: '今晚月光很好，想把房间灯调暗一点。',
        tags: ['night', 'room'],
      },
      '星野幻月',
      0,
      Date.UTC(2026, 2, 2),
    );

    expect(post.author.name).toBe('星野幻月');
    expect(post.author.username).toBe('@reverie_room');
    expect(post.content).toContain('月光');
    expect(post.comments).toEqual([]);
  });
});
