import { describe, expect, it } from 'vitest';
import { sanitizeChatEvent, sanitizeStickerList } from './petStageContract';

describe('pet stage renderer contract', () => {
  it('accepts only known, well-shaped chat events', () => {
    expect(sanitizeChatEvent({ type: 'chunk', text: 'hello' })).toEqual({ type: 'chunk', text: 'hello' });
    expect(sanitizeChatEvent({ type: 'chat:done', payload: { messages: ['a', 4, 'b'] } })).toEqual({
      type: 'done',
      text: 'ab',
      messages: ['a', 'b'],
    });
    expect(sanitizeChatEvent({ type: 'typing', typing: 'yes' })).toBeNull();
    expect(sanitizeChatEvent({ type: 'bridge:auth', payload: { secret: 'nope' } })).toBeNull();
    expect(sanitizeChatEvent('malformed')).toBeNull();
  });

  it('carries split bubbles through the done event for sequential playback', () => {
    const result = sanitizeChatEvent({
      type: 'chat:done',
      payload: { messages: ['在的', '怎么啦？', '   ', 42] },
    });
    expect(result).toEqual({
      type: 'done',
      text: '在的怎么啦？',
      messages: ['在的', '怎么啦？'],
    });
    const single = sanitizeChatEvent({ type: 'chat:done', payload: { messages: ['只有一条'] } });
    expect(single).toEqual({ type: 'done', text: '只有一条', messages: ['只有一条'] });
    const capped = sanitizeChatEvent({
      type: 'chat:done',
      payload: { messages: Array.from({ length: 20 }, (_, index) => `泡${index}`) },
    });
    expect(capped && 'messages' in capped ? capped.messages?.length : 0).toBe(16);
  });

  it('bounds text received from the pet API', () => {
    const result = sanitizeChatEvent({ type: 'chunk', text: 'x'.repeat(20_000) });
    expect(result?.type).toBe('chunk');
    expect(result && 'text' in result ? result.text.length : 0).toBe(12_000);
  });

  it('drops invalid stickers and unsafe image URLs', () => {
    expect(sanitizeStickerList({
      items: [
        { id: 'one', name: 'One', imageUrl: 'https://example.test/one.png' },
        { id: 'two', label: 'Two', imageUrl: 'file:///private/two.png' },
        { label: 'missing id' },
      ],
    })).toEqual([
      { id: 'one', label: 'One', imageUrl: 'https://example.test/one.png' },
      { id: 'two', label: 'Two' },
    ]);
  });

  it('maps the real StickerItem.to_dict() shape (image_data_url) to a renderable image', () => {
    // Shape mirrors src/stickers/__init__.py StickerItem.to_dict(): collected
    // stickers carry a reverie-sticker:// asset URL, pasted ones a data URL.
    const protocolSticker = {
      id: 'a1', text: '你好', emotions: ['happy'], source: 'default',
      usage_count: 3, last_used: '', image_path: '',
      image_data_url: 'reverie-sticker://asset/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png',
      style_tags: [], favorite_score: 0,
    };
    const dataUrlSticker = {
      ...protocolSticker,
      id: 'b2',
      image_data_url: `data:image/png;base64,${'A'.repeat(64)}`,
    };
    const list = sanitizeStickerList({ items: [protocolSticker, dataUrlSticker] });
    expect(list[0]).toEqual({
      id: 'a1',
      label: '你好',
      imageUrl: 'reverie-sticker://asset/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png',
    });
    expect(list[1]?.imageUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects oversized data URLs and non-local protocols from to_dict-shaped records', () => {
    const oversized = sanitizeStickerList({
      items: [{ id: 'big', image_data_url: `data:image/png;base64,${'A'.repeat(6_000_001)}` }],
    });
    expect(oversized).toEqual([{ id: 'big', label: '贴纸' }]);
    const remote = sanitizeStickerList({
      items: [{ id: 'rem', image_data_url: 'http://cdn.example.test/x.png' }],
    });
    expect(remote).toEqual([{ id: 'rem', label: '贴纸' }]);
  });
});
