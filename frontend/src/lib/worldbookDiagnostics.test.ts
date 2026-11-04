import { describe, expect, it } from 'vitest';
import {
  acceptWorldbookArchiveResult, coerceWorldbookDiagnostics, initialWorldbookDiagnostics, selectWorldbookPersona,
  worldbookEntryWarnings, worldbookNotice,
} from './worldbookDiagnostics';

function envelope(revision = 4, persona = 'p1') {
  return { persona_id: persona, revision, request_id: 'chat_12345678', truncated: 0, entries: [{
    persona_id: persona, revision, request_id: 'chat_12345678', book_id: 'book1', entry_id: 'duplicate-entry',
    book_index: 0, entry_index: 0, code: 'invalid_regex',
  }] };
}
function response(revision = 4, persona = 'p1') {
  return { ok: true, persona_id: persona, revision, world_book_diagnostics: envelope(revision, persona) };
}
function withWarning() { return acceptWorldbookArchiveResult(initialWorldbookDiagnostics('p1'), 'p1', response()); }

describe('worldbook code-only metadata', () => {
  it('starts empty without storing any content or settings', () => {
    expect(initialWorldbookDiagnostics()).toEqual({ personaId: null, revision: 0, diagnostics: null });
    expect(worldbookNotice(initialWorldbookDiagnostics())).toBe('');
  });

  it('projects known bounded fields and never returns untrusted text', () => {
    const input = envelope();
    const value = coerceWorldbookDiagnostics({ ...input, error: 'PRIVATE_TEXT', entries: input.entries.map((entry) => ({
      ...entry, pattern: 'PRIVATE_PATTERN', content: '<script>PRIVATE_TEXT</script>', stack: 'PRIVATE_STACK',
    })) });
    expect(value).toEqual(input);
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE_|<script>/);
    expect(worldbookNotice(withWarning())).toContain('正则表达式无效');
    expect(worldbookNotice(withWarning())).not.toContain('invalid_regex');
  });

  it.each(['injected_code', '__proto__', 'constructor', '<b>oops</b>', 'x'.repeat(10_000)])('does not render unknown code %s', (code) => {
    const input = envelope(); input.entries[0].code = code;
    expect(coerceWorldbookDiagnostics(input)?.entries).toEqual([]);
  });

  it('rejects oversized envelopes and identifiers before state mutation', () => {
    const input = envelope();
    expect(coerceWorldbookDiagnostics({ ...input, entries: Array(201).fill(input.entries[0]) })).toBeNull();
    expect(coerceWorldbookDiagnostics({ ...input, persona_id: 'x'.repeat(161) })).toBeNull();
    expect(coerceWorldbookDiagnostics({ ...input, request_id: 'x'.repeat(129) })).toBeNull();
    expect(coerceWorldbookDiagnostics({ ...input, truncated: 1_000_001 })).toBeNull();
    expect(coerceWorldbookDiagnostics({ ...input, truncated: -1 })).toBeNull();
    expect(coerceWorldbookDiagnostics({ ...input, revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });

  it('discards entry evidence with another persona, revision or request', () => {
    for (const patch of [{ persona_id: 'p2' }, { revision: 3 }, { request_id: 'old_request' }]) {
      const input = envelope(); Object.assign(input.entries[0], patch);
      expect(coerceWorldbookDiagnostics(input)?.entries).toEqual([]);
    }
  });

  it('keeps duplicate entry IDs separate by both book and entry ordinal', () => {
    const input = response();
    input.world_book_diagnostics.entries.push({ ...input.world_book_diagnostics.entries[0], entry_index: 1, code: 'regex_timeout' });
    input.world_book_diagnostics.entries.push({ ...input.world_book_diagnostics.entries[0], book_index: 1, code: 'regex_budget_exhausted' });
    const state = acceptWorldbookArchiveResult(initialWorldbookDiagnostics('p1'), 'p1', input);
    expect(worldbookEntryWarnings(state, 'book1', 0, 'duplicate-entry', 0)).toEqual(['正则表达式无效，本轮未使用此条目。']);
    expect(worldbookEntryWarnings(state, 'book1', 0, 'duplicate-entry', 1)).toEqual(['正则匹配超时，本轮未使用此条目。']);
    expect(worldbookEntryWarnings(state, 'book1', 1, 'duplicate-entry', 0)).toEqual(['本轮正则处理预算已用完，未使用此条目。']);
    expect(worldbookEntryWarnings(state, 'another-book', 0, 'duplicate-entry', 0)).toEqual([]);
  });

  it('deduplicates repeated evidence without merging separate entries', () => {
    const input = envelope(); input.entries.push({ ...input.entries[0] }, { ...input.entries[0], entry_index: 1 });
    expect(coerceWorldbookDiagnostics(input)?.entries).toHaveLength(2);
  });

  it('accepts negative ordinals only for explicitly scoped notices', () => {
    const input = envelope();
    Object.assign(input.entries[0], { code: 'snapshot_unavailable', book_id: '', entry_id: '', book_index: -1, entry_index: -1 });
    expect(coerceWorldbookDiagnostics(input)?.entries).toHaveLength(1);
    input.entries[0].code = 'regex_worker_unavailable';
    expect(coerceWorldbookDiagnostics(input)?.entries).toHaveLength(1);
    input.entries[0].code = 'regex_timeout';
    expect(coerceWorldbookDiagnostics(input)?.entries).toEqual([]);
    Object.assign(input.entries[0], { code: 'recursion_text_limit', book_id: 'book1', book_index: 0 });
    expect(coerceWorldbookDiagnostics(input)?.entries).toHaveLength(1);
    input.entries[0].code = 'invalid_regex';
    expect(coerceWorldbookDiagnostics(input)?.entries).toEqual([]);
    Object.assign(input.entries[0], { code: 'snapshot_unavailable', entry_id: 'not-empty' });
    expect(coerceWorldbookDiagnostics(input)?.entries).toEqual([]);
  });

  it('explains truncation with fixed text', () => {
    const payload = response(); payload.world_book_diagnostics.truncated = 9;
    expect(worldbookNotice(acceptWorldbookArchiveResult(initialWorldbookDiagnostics('p1'), 'p1', payload))).toContain('部分诊断未展开');
  });
});

describe('worldbook diagnostic revision and persona reducer', () => {
  it('ignores an older response after a newer committed revision', () => {
    const saved = acceptWorldbookArchiveResult(withWarning(), 'p1', { ok: true, persona_id: 'p1', revision: 5 });
    expect(saved.diagnostics).toBeNull();
    expect(acceptWorldbookArchiveResult(saved, 'p1', response(4))).toBe(saved);
  });

  it('clears a repaired entry on successful save metadata, then evaluates the next turn independently', () => {
    const repaired = response(5); repaired.world_book_diagnostics.entries = [];
    const saved = acceptWorldbookArchiveResult(withWarning(), 'p1', repaired);
    expect(worldbookNotice(saved)).toBe('');
    const retried = acceptWorldbookArchiveResult(saved, 'p1', response(5));
    expect(worldbookNotice(retried)).toContain('正则表达式无效');
  });

  it('cannot clear or rewrite warnings through a failed save with a new revision', () => {
    const state = withWarning();
    expect(acceptWorldbookArchiveResult(state, 'p1', { ...response(5), ok: false })).toBe(state);
  });

  it('ignores both outer and inner persona mismatches', () => {
    const state = withWarning();
    expect(acceptWorldbookArchiveResult(state, 'p1', response(4, 'p2'))).toBe(state);
    expect(acceptWorldbookArchiveResult(state, 'p1', { ...response(4), world_book_diagnostics: envelope(4, 'p2') })).toBe(state);
  });

  it('clears on persona switch and never adopts a delayed previous-persona warning', () => {
    const selected = selectWorldbookPersona(withWarning(), 'p2');
    expect(selected).toEqual(initialWorldbookDiagnostics('p2'));
    expect(acceptWorldbookArchiveResult(selected, 'p2', response())).toBe(selected);
    expect(selectWorldbookPersona(selected, 'p2')).toBe(selected);
    expect(selectWorldbookPersona(selected, null)).toEqual(initialWorldbookDiagnostics());
  });

  it('requires a matching archive revision and rejects malformed or unscoped payloads', () => {
    const state = withWarning();
    expect(acceptWorldbookArchiveResult(state, 'p1', { ...response(), world_book_diagnostics: envelope(9) })).toBe(state);
    for (const bad of [null, [], {}, { ...response(), persona_id: undefined }, { ...response(), revision: NaN }]) {
      expect(acceptWorldbookArchiveResult(state, 'p1', bad)).toBe(state);
    }
  });

  it('accepts a bounded snapshot failure at the known revision without chat failure state', () => {
    const payload = response(); payload.ok = false;
    Object.assign(payload.world_book_diagnostics.entries[0], { code: 'snapshot_unavailable', book_id: '', entry_id: '', book_index: -1, entry_index: -1 });
    const result = acceptWorldbookArchiveResult(withWarning(), 'p1', payload);
    expect(worldbookNotice(result)).toContain('本轮未注入世界书');
    expect(Object.keys(result)).toEqual(['personaId', 'revision', 'diagnostics']);
  });

  it('missing optional metadata does not clear the same-revision last result', () => {
    const state = withWarning();
    expect(acceptWorldbookArchiveResult(state, 'p1', { ok: true, persona_id: 'p1', revision: 4 })).toBe(state);
  });
});
