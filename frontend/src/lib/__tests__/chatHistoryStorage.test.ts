import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatHistoryData, DisplayMessage } from '../chatHistoryStorage';
import type { ChatMessage } from '../llmClient';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const SESSION_PATH = 'char-1/mod-1';

function expectedUrl(file: string): string {
  return `/api/session-data?path=${encodeURIComponent(`${SESSION_PATH}/chat/${file}`)}`;
}

const sampleMessages: DisplayMessage[] = [
  { id: '1', role: 'user', content: 'Hello' },
  { id: '2', role: 'assistant', content: 'Hi there!' },
];

const sampleChatHistory: ChatMessage[] = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there!' },
];

function stubLocalStorage() {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  });
  return storage;
}

function makeSavedData(msgs = sampleMessages, history = sampleChatHistory): ChatHistoryData {
  return { version: 1, savedAt: Date.now(), messages: msgs, chatHistory: history };
}

describe('chatHistoryStorage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  describe('loadChatHistorySync', () => {
    it('returns null', async () => {
      const { loadChatHistorySync } = await import('../chatHistoryStorage');
      expect(loadChatHistorySync(SESSION_PATH)).toBeNull();
    });
  });

  describe('loadChatHistory', () => {
    it('loads from API', async () => {
      const data = makeSavedData();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(data),
      });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(fetchMock).toHaveBeenCalledWith(expectedUrl('chat.json'));
      expect(result).not.toBeNull();
      expect(result!.messages).toEqual(sampleMessages);
    });

    it('returns null when API returns non-ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(result).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(result).toBeNull();
    });

    it('returns null when API is empty', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);
      expect(result).toBeNull();
    });
  });

  describe('saveChatHistory', () => {
    it('POSTs to API with expected payload', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { saveChatHistory } = await import('../chatHistoryStorage');

      await saveChatHistory(SESSION_PATH, sampleMessages, sampleChatHistory);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(expectedUrl('chat.json'));
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.version).toBe(1);
      expect(body.messages).toEqual(sampleMessages);
      expect(body.chatHistory).toEqual(sampleChatHistory);
    });

    it('does not throw when fetch fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { saveChatHistory } = await import('../chatHistoryStorage');

      await expect(
        saveChatHistory(SESSION_PATH, sampleMessages, sampleChatHistory),
      ).resolves.toBeUndefined();
    });
  });

  describe('clearChatHistory', () => {
    it('sends DELETE to API', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { clearChatHistory } = await import('../chatHistoryStorage');

      await clearChatHistory(SESSION_PATH);

      expect(fetchMock).toHaveBeenCalledWith(expectedUrl('chat.json'), { method: 'DELETE' });
    });

    it('does not throw when DELETE fetch fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { clearChatHistory } = await import('../chatHistoryStorage');

      await expect(clearChatHistory(SESSION_PATH)).resolves.toBeUndefined();
    });
  });

  describe('chat draft persistence', () => {
    it('saves drafts synchronously to local storage before file persistence', async () => {
      const storage = stubLocalStorage();
      const { saveChatDraftLocalSync, loadChatDraftSync } = await import('../chatHistoryStorage');

      saveChatDraftLocalSync(SESSION_PATH, 'instant local draft');

      expect(loadChatDraftSync(SESSION_PATH)).toBe('instant local draft');
      expect([...storage.values()]).toContain('instant local draft');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('saves drafts to local storage and local session file', async () => {
      const storage = stubLocalStorage();
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { saveChatDraft, loadChatDraftSync } = await import('../chatHistoryStorage');

      await saveChatDraft(SESSION_PATH, '半句没写完的话');

      expect(loadChatDraftSync(SESSION_PATH)).toBe('半句没写完的话');
      expect([...storage.values()]).toContain('半句没写完的话');
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(expectedUrl('draft.json'));
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body).draft).toBe('半句没写完的话');
    });

    it('loads draft from local file and mirrors it to local storage', async () => {
      const storage = stubLocalStorage();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: 1, savedAt: Date.now(), draft: '本地文件草稿' }),
      });
      const { loadChatDraft, loadChatDraftSync } = await import('../chatHistoryStorage');

      const result = await loadChatDraft(SESSION_PATH);

      expect(result).toBe('本地文件草稿');
      expect(loadChatDraftSync(SESSION_PATH)).toBe('本地文件草稿');
      expect([...storage.values()]).toContain('本地文件草稿');
    });

    it('clears draft from both stores', async () => {
      stubLocalStorage();
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { saveChatDraft, clearChatDraft, loadChatDraftSync } = await import('../chatHistoryStorage');

      await saveChatDraft(SESSION_PATH, '临时草稿');
      fetchMock.mockResolvedValueOnce({ ok: true });
      await clearChatDraft(SESSION_PATH);

      expect(loadChatDraftSync(SESSION_PATH)).toBe('');
      expect(fetchMock).toHaveBeenLastCalledWith(expectedUrl('draft.json'), { method: 'DELETE' });
    });
  });
});
