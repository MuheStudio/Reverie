/**
 * Chat History Persistence
 *
 * Persists chat history per session (character × mod) to
 * ~/.openroom/sessions/{charId}/{modId}/chat.json via dev-server API.
 */

import type { ChatMessage } from './llmClient';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  imageUrl?: string;
}

export interface ChatHistoryData {
  version: 1;
  savedAt: number;
  messages: DisplayMessage[];
  chatHistory: ChatMessage[];
  suggestedReplies?: string[];
}

export interface ChatDraftData {
  version: 1;
  savedAt: number;
  draft: string;
}

/** Build session path segment from character and mod IDs */
export function buildSessionPath(charId: string, modId: string): string {
  return `${charId}/${modId}`;
}

const API_PATH = '/api/session-data';
const DRAFT_STORAGE_PREFIX = 'reverie:chat-draft:v1:';

function apiUrl(sessionPath: string, file: string): string {
  return `${API_PATH}?path=${encodeURIComponent(`${sessionPath}/chat/${file}`)}`;
}

function draftStorageKey(sessionPath: string): string {
  return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionPath)}`;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export async function loadChatHistory(sessionPath: string): Promise<ChatHistoryData | null> {
  try {
    const res = await fetch(apiUrl(sessionPath, 'chat.json'));
    if (res.ok) {
      const data: ChatHistoryData = await res.json();
      if (data && data.version === 1) {
        return data;
      }
    }
  } catch {
    // API not available
  }
  return null;
}

/** @deprecated kept for backward compat, always returns null now */
export function loadChatHistorySync(_sessionPath: string): ChatHistoryData | null {
  return null;
}

export async function saveChatHistory(
  sessionPath: string,
  messages: DisplayMessage[],
  chatHistory: ChatMessage[],
  suggestedReplies?: string[],
): Promise<void> {
  const data: ChatHistoryData = {
    version: 1,
    savedAt: Date.now(),
    messages,
    chatHistory,
    suggestedReplies,
  };

  try {
    await fetch(apiUrl(sessionPath, 'chat.json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // Silently ignore
  }
}

export async function clearChatHistory(sessionPath: string): Promise<void> {
  try {
    await fetch(apiUrl(sessionPath, 'chat.json'), { method: 'DELETE' });
  } catch {
    // Silently ignore
  }
}

export function loadChatDraftSync(sessionPath: string): string {
  const storage = getStorage();
  if (!storage) return '';
  try {
    return storage.getItem(draftStorageKey(sessionPath)) ?? '';
  } catch {
    return '';
  }
}

export function saveChatDraftLocalSync(sessionPath: string, draft: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const key = draftStorageKey(sessionPath);
    if (draft) storage.setItem(key, draft);
    else storage.removeItem(key);
  } catch {
    // Browser policy may disable persistent local storage.
  }
}

export async function loadChatDraft(sessionPath: string): Promise<string> {
  try {
    const res = await fetch(apiUrl(sessionPath, 'draft.json'));
    if (res.ok) {
      const data: ChatDraftData = await res.json();
      if (data && data.version === 1 && typeof data.draft === 'string') {
        const storage = getStorage();
        try {
          storage?.setItem(draftStorageKey(sessionPath), data.draft);
        } catch {
          // Local file copy is still the source of truth.
        }
        return data.draft;
      }
    }
  } catch {
    // API not available; fall back to browser storage.
  }
  return loadChatDraftSync(sessionPath);
}

export async function saveChatDraft(sessionPath: string, draft: string): Promise<void> {
  saveChatDraftLocalSync(sessionPath, draft);

  if (!draft) {
    await clearChatDraft(sessionPath);
    return;
  }

  const data: ChatDraftData = {
    version: 1,
    savedAt: Date.now(),
    draft,
  };

  try {
    await fetch(apiUrl(sessionPath, 'draft.json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // localStorage fallback already has the draft.
  }
}

export async function clearChatDraft(sessionPath: string): Promise<void> {
  saveChatDraftLocalSync(sessionPath, '');
  try {
    await fetch(apiUrl(sessionPath, 'draft.json'), { method: 'DELETE' });
  } catch {
    // Silently ignore
  }
}
