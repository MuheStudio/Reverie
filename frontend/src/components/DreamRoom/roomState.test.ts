import { describe, expect, it } from 'vitest';
import {
  ROOM_SHORTCUTS,
  deriveRoomAtmosphere,
  formatDiaryPreview,
  formatEvidenceConnectionLine,
  formatRecentInterest,
  formatRelationshipStage,
  getDiaryPrivacyLine,
  getLatestDiaryEntry,
  getLatestTimelinePost,
  getPersonaDisplayName,
  getPersonaIdentityLine,
  resolveRoomMood,
} from './roomState';

describe('DreamRoom room state', () => {
  it('maps raw emotion labels to original room mood states', () => {
    expect(resolveRoomMood({ current: '开心' }).label).toBe('星屑清晨');
    expect(resolveRoomMood({ current: 'sad' }).label).toBe('雨夜独处');
    expect(resolveRoomMood({ mood: '温暖' }).label).toBe('暖灯陪伴');
    expect(resolveRoomMood({ mood: 'unknown' }).label).toBe('安静月光');
  });

  it('supports all eight core emotions without exposing numeric intensity', () => {
    const expected = {
      joy: '开心',
      calm: '平静',
      excitement: '兴奋',
      sadness: '失落',
      anger: '生气',
      anxiety: '紧张',
      grievance: '委屈',
      touched: '感动',
    } as const;

    Object.entries(expected).forEach(([emotion, label]) => {
      const atmosphere = deriveRoomAtmosphere({ [emotion]: 80 }, true);
      expect(atmosphere.dominantLabel).toBe(label);
      expect(atmosphere.statusLine).not.toMatch(/\d/);
    });
  });

  it('blends coexisting emotions into continuous light and particle values', () => {
    const calm = deriveRoomAtmosphere({ calm: 80 }, true);
    const mixed = deriveRoomAtmosphere({ calm: 80, excitement: 70, sadness: 50 }, true);

    expect(mixed.particleDuration).toBeLessThan(calm.particleDuration);
    expect(mixed.shadowOpacity).toBeGreaterThan(calm.shadowOpacity);
    expect(mixed.sceneBrightness).toBeGreaterThanOrEqual(0.78);
    expect(mixed.sceneBrightness).toBeLessThanOrEqual(1.1);
  });

  it('keeps DreamRoom shortcuts as room objects instead of legacy app ids', () => {
    const chat = ROOM_SHORTCUTS.find((shortcut) => shortcut.id === 'chat');
    const diary = ROOM_SHORTCUTS.find((shortcut) => shortcut.id === 'diary');
    const phone = ROOM_SHORTCUTS.find((shortcut) => shortcut.id === 'phone');

    expect(chat?.target).toBe('chat');
    expect(chat?.label).toBe('聊天');
    expect(diary?.target).toBe('diary');
    expect(diary?.label).toBe('日记');
    expect(phone?.target).toBe('phone');
    expect(phone?.label).toBe('手机');
    expect(ROOM_SHORTCUTS).toHaveLength(3);
    expect(ROOM_SHORTCUTS.every((shortcut) => !('appId' in shortcut))).toBe(true);
  });

  it('formats missing diary data as gentle empty states and never exposes locked content', () => {
    expect(formatDiaryPreview()).toContain('抽屉');
    expect(formatDiaryPreview({ title: '秘密页', content: '不能泄漏', is_locked: true })).not.toContain(
      '不能泄漏',
    );
    expect(getDiaryPrivacyLine({ is_locked: true })).toContain('不显示内容');
  });

  it('derives persona, relationship, and interest copy without exposing raw numbers', () => {
    const persona = {
      name: '星野幻月',
      identity: { title: '核物理学家' },
      age: '19',
      interests: ['明日方舟', '画画'],
    };

    expect(getPersonaDisplayName(persona)).toBe('星野幻月');
    expect(getPersonaIdentityLine(persona)).toContain('核物理学家');
    expect(formatRelationshipStage({ stage: 'close' })).toBe('亲近期');
    expect(formatRelationshipStage({ stage: 'Acquaintance' })).toBe('熟悉');
    expect(formatRecentInterest(persona)).toBe('明日方舟、画画');
    expect(getPersonaIdentityLine({ age: '19' })).toBe('19岁');
  });

  it('orders diary and timeline evidence by valid timestamps', () => {
    const latestDiary = getLatestDiaryEntry([
      { date: '2026-01-01', title: 'older' },
      { date: '2026-03-02', title: 'newer' },
      { date: 'not-a-date', title: 'fallback item' },
    ]);
    const latestPost = getLatestTimelinePost([
      { date: '2026-01-01', content: 'older' },
      { date: '2026-03-02', content: 'newer' },
      { date: 'not-a-date', content: 'fallback item' },
    ]);

    expect(latestDiary?.title).toBe('newer');
    expect(latestPost?.content).toBe('newer');
  });

  it('describes connected and offline evidence without pretending stale data is live', () => {
    expect(
      formatEvidenceConnectionLine({
        diaryCount: 2,
        timelineCount: 3,
        isConnected: true,
      }),
    ).toContain('正在听见房间的实时动静');
    expect(
      formatEvidenceConnectionLine({
        diaryCount: 1,
        timelineCount: 4,
        isConnected: false,
      }),
    ).toContain('离线时保留安全快照');
  });
});
