import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadReverieChatDraft,
  loadReverieChatMessages,
  saveReverieChatDraft,
  saveReverieChatMessages,
} from '../reverieChatStorage';

describe('Reverie 主聊天本地存储', () => {
  beforeEach(() => window.localStorage.clear());

  it('立即保存并清除草稿', () => {
    saveReverieChatDraft('还没发出去的话');
    expect(loadReverieChatDraft()).toBe('还没发出去的话');

    saveReverieChatDraft('');
    expect(loadReverieChatDraft()).toBe('');
  });

  it('恢复最近的聊天气泡', () => {
    const messages = [{ id: '1', role: 'user', content: '你好' }];
    saveReverieChatMessages(messages);
    expect(loadReverieChatMessages()).toEqual(messages);
  });

  it('损坏的本地 JSON 不会阻止界面打开', () => {
    window.localStorage.setItem('reverie:dream-room:chat-messages:v1', '{broken');
    expect(loadReverieChatMessages()).toEqual([]);
  });

  it('does not silently truncate conversation history at 500 messages', () => {
    const messages = Array.from({ length: 701 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? 'assistant' : 'user',
      content: `message-${index}`,
    }));
    saveReverieChatMessages(messages);
    expect(loadReverieChatMessages()).toEqual(messages);
  });
});
