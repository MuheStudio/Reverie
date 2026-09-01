import { describe, expect, it } from 'vitest';
import { normalizeStickerTags, toStickerAttachmentPayload } from '../stickerPayload';

describe('toStickerAttachmentPayload (strict wire projection)', () => {
  it('projects a display sticker item to the contract shape', () => {
    const item = {
      id: 'col_123',
      text: '猫猫瘫倒',
      emotions: ['joy', 'relax'],
      style_tags: ['用户导入'],
      image_data_url: 'reverie-sticker://asset/abc.png',
      source: 'user',
      favorite_score: 1.3,
      image_path: '',
      last_used: '',
      usage_count: 0,
    };
    const payload = toStickerAttachmentPayload(item);
    expect(payload).toEqual({
      id: 'col_123',
      text: '猫猫瘫倒',
      emotions: ['joy', 'relax'],
      style_tags: ['用户导入'],
      image_data_url: 'reverie-sticker://asset/abc.png',
      source: 'user',
    });
  });

  it('strips every forbidden display-only field', () => {
    const payload = toStickerAttachmentPayload({
      id: 's1',
      text: 'x',
      favorite_score: 0.5,
      image_path: '/tmp/a.png',
      last_used: '2026-08-31',
      usage_count: 3,
      extra: 'nope',
    });
    expect(payload && Object.keys(payload).sort()).toEqual(['id', 'text']);
  });

  it('returns null for items without any wire identity', () => {
    expect(toStickerAttachmentPayload(null)).toBeNull();
    expect(toStickerAttachmentPayload({ favorite_score: 1 })).toBeNull();
    expect(toStickerAttachmentPayload('not-an-object')).toBeNull();
  });

  it('bounds every forwarded field', () => {
    const payload = toStickerAttachmentPayload({
      id: 'i'.repeat(300),
      text: 't'.repeat(600),
      image_data_url: 'd'.repeat(400_000),
      emotions: Array.from({ length: 40 }, (_, i) => `e${i}`),
      source: 's'.repeat(80),
    });
    expect(payload?.id?.length).toBeLessThanOrEqual(128);
    expect(payload?.text?.length).toBeLessThanOrEqual(400);
    expect(payload?.image_data_url?.length).toBeLessThanOrEqual(350_000);
    expect(payload?.emotions?.length).toBeLessThanOrEqual(24);
    expect(payload?.source?.length).toBeLessThanOrEqual(40);
  });

  it('drops non-string list entries and empty optionals', () => {
    const payload = toStickerAttachmentPayload({
      id: 's2',
      emotions: ['joy', 42, null, ''],
      style_tags: [],
    });
    expect(payload?.emotions).toEqual(['joy']);
    expect(payload).not.toHaveProperty('style_tags');
  });

  it('normalizes whitespace and bounds every tag', () => {
    expect(normalizeStickerTags([' joy ', '', 'x'.repeat(100), 42], 8)).toEqual([
      'joy',
      'x'.repeat(80),
    ]);
    expect(toStickerAttachmentPayload({
      id: 's3',
      emotions: [' joy '],
      style_tags: [' 用户导入 '],
    })).toMatchObject({ emotions: ['joy'], style_tags: ['用户导入'] });
  });
});
