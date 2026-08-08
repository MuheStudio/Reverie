const LEGACY_CHAT_DRAFT_KEY = 'reverie:dream-room:chat-draft:v2';
const MAX_DRAFT_LENGTH = 20_000;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface ChatDraftEnvelope {
  schema: 'reverie.chat-draft.v2';
  sessionId: string;
  savedAtUtc: string;
  text: string;
}

function draftKey(sessionId: string): string {
  return `reverie:chat-draft:v2:${sessionId}`;
}

function validSessionId(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function removeDraftAt(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A blocked emergency cache is inert.
  }
}

function readDraft(key: string, expectedSessionId: string): string {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return '';
    const value = JSON.parse(raw) as Partial<ChatDraftEnvelope>;
    const savedAt = typeof value.savedAtUtc === 'string'
      ? Date.parse(value.savedAtUtc)
      : Number.NaN;
    if (
      value.schema !== 'reverie.chat-draft.v2'
      || value.sessionId !== expectedSessionId
      || typeof value.text !== 'string'
      || value.text.length > MAX_DRAFT_LENGTH
      || !Number.isFinite(savedAt)
      || savedAt > Date.now() + 5 * 60 * 1000
      || Date.now() - savedAt > MAX_DRAFT_AGE_MS
    ) {
      removeDraftAt(key);
      return '';
    }
    return value.text;
  } catch {
    removeDraftAt(key);
    return '';
  }
}

export function loadReverieChatDraft(sessionId: string): string {
  if (!validSessionId(sessionId)) return '';
  const current = readDraft(draftKey(sessionId), sessionId);
  if (current) return current;
  // Backward compatibility: the pre-session-key drafts lived under one legacy
  // key with the persona id stored in the envelope's sessionId field. A legacy
  // draft that belongs to a different session is left untouched; it may belong
  // to another persona that has not loaded yet.
  try {
    const raw = window.localStorage.getItem(LEGACY_CHAT_DRAFT_KEY);
    if (!raw) return '';
    const value = JSON.parse(raw) as Partial<ChatDraftEnvelope>;
    const savedAt = typeof value.savedAtUtc === 'string'
      ? Date.parse(value.savedAtUtc)
      : Number.NaN;
    const text = typeof value.text === 'string' ? value.text : '';
    const valid = value.schema === 'reverie.chat-draft.v2'
      && value.sessionId === sessionId
      && text.length > 0
      && text.length <= MAX_DRAFT_LENGTH
      && Number.isFinite(savedAt)
      && savedAt <= Date.now() + 5 * 60 * 1000
      && Date.now() - savedAt <= MAX_DRAFT_AGE_MS;
    if (!valid) return '';
    saveReverieChatDraft(text, sessionId);
    removeDraftAt(LEGACY_CHAT_DRAFT_KEY);
    return text;
  } catch {
    return '';
  }
}

export function saveReverieChatDraft(draft: string, sessionId: string): void {
  if (!draft) {
    removeReverieChatDraft(sessionId);
    return;
  }
  if (!validSessionId(sessionId) || draft.length > MAX_DRAFT_LENGTH) return;
  const value: ChatDraftEnvelope = {
    schema: 'reverie.chat-draft.v2',
    sessionId,
    savedAtUtc: new Date().toISOString(),
    text: draft,
  };
  try {
    window.localStorage.setItem(draftKey(sessionId), JSON.stringify(value));
  } catch {
    // Best effort only. The canonical chat ledger never lives here.
  }
}

export function removeReverieChatDraft(sessionId: string): void {
  if (!validSessionId(sessionId)) return;
  removeDraftAt(draftKey(sessionId));
  // Clearing a draft is an explicit user action: the historical single-slot
  // key must not resurrect it through the legacy fallback read.
  removeDraftAt(LEGACY_CHAT_DRAFT_KEY);
}

export function consumeFallbackDraft(sessionId: string): void {
  // Migration-only removal: drops the fallback slot without touching the
  // legacy key, whose draft may still belong to another persona that has not
  // loaded yet.
  if (!validSessionId(sessionId)) return;
  removeDraftAt(draftKey(sessionId));
}

export function migrateReverieChatDraft(fromSessionId: string, toSessionId: string): string {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId)) return '';
  if (fromSessionId === toSessionId) return '';
  const existing = loadReverieChatDraft(toSessionId);
  if (existing) return existing;
  const legacy = readDraft(LEGACY_CHAT_DRAFT_KEY, fromSessionId);
  const source = legacy || loadReverieChatDraft(fromSessionId);
  if (!source) return '';
  saveReverieChatDraft(source, toSessionId);
  removeDraftAt(draftKey(fromSessionId));
  removeDraftAt(LEGACY_CHAT_DRAFT_KEY);
  return source;
}

export function loadLegacyReverieChatDraft(sessionId: string): string {
  if (!validSessionId(sessionId)) return '';
  return readDraft(LEGACY_CHAT_DRAFT_KEY, sessionId);
}
