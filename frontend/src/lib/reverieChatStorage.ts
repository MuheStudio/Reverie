const CHAT_MESSAGES_KEY = 'reverie:dream-room:chat-messages:v2';
const LEGACY_CHAT_MESSAGES_KEY = 'reverie:dream-room:chat-messages:v1';
const CHAT_DRAFT_KEY = 'reverie:dream-room:chat-draft:v1';

export function loadReverieChatMessages<T>(): T[] {
  try {
    const raw = window.localStorage.getItem(CHAT_MESSAGES_KEY)
      ?? window.localStorage.getItem(LEGACY_CHAT_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveReverieChatMessages(messages: unknown[]): void {
  try {
    // Never discard older conversation records merely because a newer one was
    // appended. Storage exhaustion fails atomically and preserves the prior
    // complete snapshot.
    window.localStorage.setItem(CHAT_MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    // Local storage may be disabled or full; the in-memory chat still works.
  }
}

export function loadReverieChatDraft(): string {
  try {
    return window.localStorage.getItem(CHAT_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveReverieChatDraft(draft: string): void {
  try {
    if (draft) window.localStorage.setItem(CHAT_DRAFT_KEY, draft);
    else window.localStorage.removeItem(CHAT_DRAFT_KEY);
  } catch {
    // Best effort for restricted browser/Electron storage policies.
  }
}
