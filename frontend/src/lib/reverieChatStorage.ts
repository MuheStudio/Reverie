const CHAT_DRAFT_KEY = 'reverie:dream-room:chat-draft:v2';
const MAX_DRAFT_LENGTH = 20_000;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface ChatDraftEnvelope {
  schema: 'reverie.chat-draft.v2';
  sessionId: string;
  savedAtUtc: string;
  text: string;
}

function validSessionId(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function removeDraft(): void {
  try {
    window.localStorage.removeItem(CHAT_DRAFT_KEY);
  } catch {
    // A blocked emergency cache is inert.
  }
}

export function loadReverieChatDraft(sessionId: string): string {
  if (!validSessionId(sessionId)) return '';
  try {
    const raw = window.localStorage.getItem(CHAT_DRAFT_KEY);
    if (!raw) return '';
    const value = JSON.parse(raw) as Partial<ChatDraftEnvelope>;
    const savedAt = typeof value.savedAtUtc === 'string'
      ? Date.parse(value.savedAtUtc)
      : Number.NaN;
    if (
      value.schema !== 'reverie.chat-draft.v2'
      || value.sessionId !== sessionId
      || typeof value.text !== 'string'
      || value.text.length > MAX_DRAFT_LENGTH
      || !Number.isFinite(savedAt)
      || savedAt > Date.now() + 5 * 60 * 1000
      || Date.now() - savedAt > MAX_DRAFT_AGE_MS
    ) {
      removeDraft();
      return '';
    }
    return value.text;
  } catch {
    removeDraft();
    return '';
  }
}

export function saveReverieChatDraft(draft: string, sessionId: string): void {
  if (!draft) {
    removeDraft();
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
    window.localStorage.setItem(CHAT_DRAFT_KEY, JSON.stringify(value));
  } catch {
    // Best effort only. The canonical chat ledger never lives here.
  }
}
