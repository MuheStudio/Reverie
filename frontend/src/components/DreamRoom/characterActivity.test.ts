import { describe, expect, it } from 'vitest';
import { deriveCharacterActivity } from './characterActivity';

const resolve = (
  values: Partial<Parameters<typeof deriveCharacterActivity>[0]> = {},
) => deriveCharacterActivity({
  focusActive: false,
  isTyping: false,
  requestStates: [],
  needsAttention: false,
  ...values,
});

describe('deriveCharacterActivity', () => {
  it('uses the contractual priority order', () => {
    expect(resolve({
      focusActive: true,
      isTyping: true,
      requestStates: ['delivering', 'ready_waiting', 'generating'],
      needsAttention: true,
    })).toBe('focus.loop');
    expect(resolve({
      requestStates: ['delivering', 'ready_waiting', 'generating'],
      needsAttention: true,
    })).toBe('chat.deliver');
    expect(resolve({
      requestStates: ['ready_waiting', 'generating'],
      needsAttention: true,
    })).toBe('chat.ready');
    expect(resolve({
      requestStates: ['queued'],
      needsAttention: true,
    })).toBe('chat.thinking');
    expect(resolve({ needsAttention: true })).toBe('attention');
    expect(resolve()).toBe('idle.default');
  });
});
