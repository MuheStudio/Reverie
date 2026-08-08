import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeFallbackDraft,
  loadLegacyReverieChatDraft,
  loadReverieChatDraft,
  migrateReverieChatDraft,
  removeReverieChatDraft,
  saveReverieChatDraft,
} from '../reverieChatStorage';

const SESSION = 'persona-one:dream-room';
const OTHER_SESSION = 'persona-two:dream-room';
const FALLBACK = 'mvp-room';

function sessionKey(sessionId: string): string {
  return `reverie:chat-draft:v2:${sessionId}`;
}

describe('Reverie emergency chat draft cache', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('stores a timestamped, session-bound draft and clears it', () => {
    saveReverieChatDraft('not sent yet', SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('not sent yet');
    expect(loadReverieChatDraft(OTHER_SESSION)).toBe('');

    saveReverieChatDraft('', SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('');
  });

  it('keeps per-session drafts isolated under separate keys', () => {
    saveReverieChatDraft('draft A', SESSION);
    saveReverieChatDraft('draft B', OTHER_SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('draft A');
    expect(loadReverieChatDraft(OTHER_SESSION)).toBe('draft B');
  });

  it('does not revive legacy message snapshots as a chat fact source', () => {
    window.localStorage.setItem(
      'reverie:dream-room:chat-messages:v2',
      JSON.stringify([{ role: 'assistant', content: 'stale renderer fact' }]),
    );
    expect(loadReverieChatDraft(SESSION)).toBe('');
  });

  it('rejects malformed, oversized, future-dated, and expired draft envelopes', () => {
    const key = sessionKey(SESSION);
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

  it('migrates the mvp-room fallback draft under the persona id', () => {
    saveReverieChatDraft('typed before persona id was known', FALLBACK);
    const migrated = migrateReverieChatDraft(FALLBACK, SESSION);
    expect(migrated).toBe('typed before persona id was known');
    expect(loadReverieChatDraft(SESSION)).toBe('typed before persona id was known');
    // The fallback slot is consumed so a later persona id does not resurrect it.
    expect(loadReverieChatDraft(FALLBACK)).toBe('');
  });

  it('migration keeps an existing persona draft and never overwrites it', () => {
    saveReverieChatDraft('persona draft wins', SESSION);
    saveReverieChatDraft('older fallback text', FALLBACK);
    const migrated = migrateReverieChatDraft(FALLBACK, SESSION);
    expect(migrated).toBe('persona draft wins');
    expect(loadReverieChatDraft(SESSION)).toBe('persona draft wins');
    expect(loadReverieChatDraft(FALLBACK)).toBe('older fallback text');
  });

  it('loads and upgrades a legacy single-key draft', () => {
    const legacyKey = 'reverie:dream-room:chat-draft:v2';
    window.localStorage.setItem(legacyKey, JSON.stringify({
      schema: 'reverie.chat-draft.v2',
      sessionId: SESSION,
      savedAtUtc: new Date().toISOString(),
      text: 'legacy persona draft',
    }));
    expect(loadLegacyReverieChatDraft(SESSION)).toBe('legacy persona draft');
    expect(loadReverieChatDraft(SESSION)).toBe('legacy persona draft');
    // Upgraded into the per-session key and the legacy slot is consumed.
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
  });

  it('removeReverieChatDraft clears the session key and the legacy slot', () => {
    saveReverieChatDraft('hello', SESSION);
    const legacyKey = 'reverie:dream-room:chat-draft:v2';
    window.localStorage.setItem(legacyKey, JSON.stringify({
      schema: 'reverie.chat-draft.v2',
      sessionId: SESSION,
      savedAtUtc: new Date().toISOString(),
      text: 'legacy',
    }));
    removeReverieChatDraft(SESSION);
    expect(loadReverieChatDraft(SESSION)).toBe('');
    expect(loadLegacyReverieChatDraft(SESSION)).toBe('');
  });

  it('consumeFallbackDraft removes only the fallback slot, not the legacy key', () => {
    saveReverieChatDraft('fallback text', FALLBACK);
    const legacyKey = 'reverie:dream-room:chat-draft:v2';
    window.localStorage.setItem(legacyKey, JSON.stringify({
      schema: 'reverie.chat-draft.v2',
      sessionId: SESSION,
      savedAtUtc: new Date().toISOString(),
      text: 'legacy for another persona',
    }));
    consumeFallbackDraft(FALLBACK);
    expect(loadReverieChatDraft(FALLBACK)).toBe('');
    expect(loadLegacyReverieChatDraft(SESSION)).toBe('legacy for another persona');
  });
});
