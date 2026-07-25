import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadReverieChatDraft,
  saveReverieChatDraft,
} from '../reverieChatStorage';

const SESSION = 'persona-one:dream-room';

describe('Reverie emergency chat draft cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('stores a timestamped, session-bound draft and clears it', () => {
    saveReverieChatDraft('not sent yet', SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('not sent yet');
    expect(loadReverieChatDraft('persona-two:dream-room')).toBe('');

    saveReverieChatDraft('', SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('');
  });

  it('does not revive legacy message snapshots as a chat fact source', () => {
    window.localStorage.setItem(
      'reverie:dream-room:chat-messages:v2',
      JSON.stringify([{ role: 'assistant', content: 'stale renderer fact' }]),
    );
    expect(loadReverieChatDraft(SESSION)).toBe('');
  });

  it('rejects malformed, oversized, future-dated, and expired draft envelopes', () => {
    const key = 'reverie:dream-room:chat-draft:v2';
    window.localStorage.setItem(key, '{broken');
    expect(loadReverieChatDraft(SESSION)).toBe('');

    window.localStorage.setItem(key, JSON.stringify({
      schema: 'reverie.chat-draft.v2',
      sessionId: SESSION,
      savedAtUtc: new Date().toISOString(),
      text: 'x'.repeat(20_001),
    }));
    expect(loadReverieChatDraft(SESSION)).toBe('');

    const now = new Date('2026-07-25T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    for (const savedAtUtc of [
      '2026-07-25T00:06:00.000Z',
      '2026-07-17T23:59:59.000Z',
    ]) {
      window.localStorage.setItem(key, JSON.stringify({
        schema: 'reverie.chat-draft.v2',
        sessionId: SESSION,
        savedAtUtc,
        text: 'stale',
      }));
      expect(loadReverieChatDraft(SESSION)).toBe('');
    }
  });
});
