import { describe, expect, it } from 'vitest';
import {
  appendUniqueProactive,
  mergeHistoryWithLiveProactive,
  proactiveBubbleKey,
} from '../proactiveMessages';

const proactive = (id: string, bubble: number, content: string) => ({
  id: `${id}:${bubble}`,
  source: 'proactive' as const,
  proactive_id: id,
  bubble_index: bubble,
  content,
});

describe('proactive message dedupe', () => {
  it('keys bubbles by stable proactive identity and index', () => {
    expect(proactiveBubbleKey(proactive('proactive_a', 1, 'second'))).toBe('proactive_a:1');
  });

  it('does not append a replayed live event', () => {
    const first = proactive('proactive_a', 0, 'hello');
    expect(appendUniqueProactive([first], [first])).toEqual([first]);
  });

  it('keeps a live proactive bubble missing from a stale history response', () => {
    const ordinary = { id: 'user-1', source: 'user', content: 'hi' };
    const live = proactive('proactive_a', 0, 'hello');
    expect(mergeHistoryWithLiveProactive([ordinary], [live])).toEqual([ordinary, live]);
    expect(mergeHistoryWithLiveProactive([ordinary, live], [live])).toEqual([ordinary, live]);
  });
});
