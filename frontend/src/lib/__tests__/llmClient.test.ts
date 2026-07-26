/**
 * Unit tests for llmClient.ts
 *
 * Environment: happy-dom (provides localStorage, fetch globals)
 * Mock strategy:
 *   - fetch: vi.fn() via globalThis.fetch per test
 *   - localStorage: happy-dom provides real implementation, cleared in beforeEach
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  loadConfigSync,
  saveConfig,
  testConfig,
  chat,
  type ChatMessage,
  type ToolDef,
} from '../llmClient';
import { getDefaultProviderConfig, type LLMConfig } from '../llmModels';

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'webuiapps-llm-config';

const MOCK_OPENAI_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test-key',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
};

const MOCK_ANTHROPIC_CONFIG: LLMConfig = {
  provider: 'anthropic',
  apiKey: 'ant-test-key',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-6',
};

const PUBLIC_OPENAI_CONFIG: LLMConfig = { ...MOCK_OPENAI_CONFIG, apiKey: '' };
const PUBLIC_ANTHROPIC_CONFIG: LLMConfig = { ...MOCK_ANTHROPIC_CONFIG, apiKey: '' };

const MOCK_MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

const MOCK_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];
const providerGet = vi.fn();
const providerSet = vi.fn();
const providerCommit = vi.fn();
const providerTest = vi.fn();
const TEST_OPTIONS = { testReceipt: 'provider-test-receipt' };

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  providerGet.mockReset();
  providerSet.mockReset();
  providerCommit.mockReset();
  providerTest.mockReset();
  providerGet.mockResolvedValue(null);
  providerSet.mockResolvedValue(undefined);
  providerCommit.mockResolvedValue({
    config: { llm: PUBLIC_OPENAI_CONFIG },
    status: {
      available: true,
      corrupted: false,
      llm: { hasApiKey: true, hasCustomHeaders: false, bindingKnown: true },
      imageGen: { hasApiKey: false, hasCustomHeaders: false },
      runtimeAppliedScopes: { llm: true, imageGen: false },
      bindingMismatch: { llm: false, imageGen: false },
    },
  });
  providerTest.mockResolvedValue({
    ok: true,
    receipt: 'provider-test-receipt',
    expiresAt: '2099-01-01T00:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4',
    latencyMs: 42,
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      providerConfig: {
        get: providerGet,
        set: providerSet,
        test: providerTest,
        commit: providerCommit,
      },
      credentials: {
        set: vi.fn().mockImplementation((scope: 'llm' | 'imageGen') => Promise.resolve({
          available: true,
          corrupted: false,
          llm: { hasApiKey: scope === 'llm', hasCustomHeaders: false },
          imageGen: { hasApiKey: scope === 'imageGen', hasCustomHeaders: false },
          runtimeAppliedScopes: {
            llm: scope === 'llm',
            imageGen: scope === 'imageGen',
          },
        })),
        setSession: vi.fn().mockImplementation((scope: 'llm' | 'imageGen') => Promise.resolve({
          available: true,
          persistentAvailable: false,
          corrupted: false,
          llm: {
            hasApiKey: scope === 'llm',
            hasCustomHeaders: false,
            sessionOnly: scope === 'llm',
          },
          imageGen: {
            hasApiKey: scope === 'imageGen',
            hasCustomHeaders: false,
            sessionOnly: scope === 'imageGen',
          },
        })),
        clear: vi.fn(),
        status: vi.fn(),
        onChanged: vi.fn(() => () => {}),
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDefaultProviderConfig()', () => {
  it('returns correct defaults for openai', () => {
    const cfg = getDefaultProviderConfig('openai');
    expect(cfg.provider).toBe('openai');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-5.4');
    expect('apiKey' in cfg).toBe(false);
  });

  it('returns correct defaults for custom OpenAI-compatible providers', () => {
    const cfg = getDefaultProviderConfig('custom');
    expect(cfg.provider).toBe('custom');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-5.4');
  });

  it('returns correct defaults for anthropic', () => {
    const cfg = getDefaultProviderConfig('anthropic');
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });

  it('returns correct defaults for gemini', () => {
    const cfg = getDefaultProviderConfig('gemini');
    expect(cfg.provider).toBe('gemini');
    expect(cfg.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(cfg.model).toBe('gemini-2.5-pro');
  });

  it('returns correct defaults for grok', () => {
    const cfg = getDefaultProviderConfig('grok');
    expect(cfg.provider).toBe('grok');
    expect(cfg.baseUrl).toBe('https://api.x.ai/v1');
    expect(cfg.model).toBe('grok-4');
  });

  it('returns correct defaults for deepseek', () => {
    const cfg = getDefaultProviderConfig('deepseek');
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.baseUrl).toBe('https://api.deepseek.com');
    expect(cfg.model).toBe('deepseek-v4-flash');
  });

  it('returns correct defaults for ollama', () => {
    const cfg = getDefaultProviderConfig('ollama');
    expect(cfg.provider).toBe('ollama');
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.model).toBe('llama3.1');
  });

  it('returns correct defaults for llama.cpp', () => {
    const cfg = getDefaultProviderConfig('llama.cpp');
    expect(cfg.provider).toBe('llama.cpp');
    expect(cfg.baseUrl).toBe('http://localhost:8080');
    expect(cfg.model).toBe('local-model');
  });

  it('returns correct defaults for minimax', () => {
    const cfg = getDefaultProviderConfig('minimax');
    expect(cfg.provider).toBe('minimax');
    expect(cfg.baseUrl).toBe('https://api.minimax.io/anthropic/v1');
    expect(cfg.model).toBe('MiniMax-M2.5');
  });

  it('returns correct defaults for z.ai', () => {
    const cfg = getDefaultProviderConfig('z.ai');
    expect(cfg.provider).toBe('z.ai');
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(cfg.model).toBe('glm-5.2');
  });

  it('returns correct defaults for kimi', () => {
    const cfg = getDefaultProviderConfig('kimi');
    expect(cfg.provider).toBe('kimi');
    expect(cfg.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(cfg.model).toBe('kimi-k2.7-code');
  });

  it('returns correct defaults for openrouter', () => {
    const cfg = getDefaultProviderConfig('openrouter');
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.model).toBe('minimax/MiniMax-M2.5');
  });

  it('returns consistent values for the same provider', () => {
    const a = getDefaultProviderConfig('openai');
    const b = getDefaultProviderConfig('openai');
    expect(a).toStrictEqual(b);
  });
});

// ─── loadConfigSync() ─────────────────────────────────────────────────────────

describe('loadConfigSync()', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadConfigSync()).toBeNull();
  });

  it('does not revive valid browser metadata as an authoritative config', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_OPENAI_CONFIG));
    expect(loadConfigSync()).toBeNull();
  });

  it('returns null when localStorage contains invalid JSON', () => {
    localStorage.setItem(CONFIG_KEY, 'not-valid-json{{{');
    expect(loadConfigSync()).toBeNull();
  });

  it('returns null when value is empty string', () => {
    localStorage.setItem(CONFIG_KEY, '');
    expect(loadConfigSync()).toBeNull();
  });

  it('does not expose customHeaders from renderer persistence', () => {
    const cfg: LLMConfig = { ...MOCK_OPENAI_CONFIG, customHeaders: 'X-Foo: bar\nX-Baz: qux' };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    expect(loadConfigSync()).toBeNull();
  });

  it('does not use a legacy custom-provider value synchronously', () => {
    const cfg: LLMConfig = { ...MOCK_OPENAI_CONFIG, provider: 'custom', customProviderName: '我的网关' };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    expect(loadConfigSync()).toBeNull();
  });
});

// ─── loadConfig() ─────────────────────────────────────────────────────────────

describe('loadConfig()', () => {
  describe('Scenario A: Electron store returns the new format', () => {
    it('returns LLM metadata from { llm, imageGen } without making a browser copy', async () => {
      providerGet.mockResolvedValueOnce({
        llm: MOCK_OPENAI_CONFIG,
        imageGen: { provider: 'openai', apiKey: 'k', baseUrl: 'u', model: 'm' },
      });

      const result = await loadConfig();

      expect(result).toEqual(PUBLIC_OPENAI_CONFIG);
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled;
    });
  });

  describe('Scenario A2: Electron store returns a legacy flat format', () => {
    it('returns config from legacy flat LLMConfig format', async () => {
      providerGet.mockResolvedValueOnce(MOCK_OPENAI_CONFIG);

      const result = await loadConfig();

      expect(result).toEqual(PUBLIC_OPENAI_CONFIG);
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    });
  });

  describe('Scenario B: Electron store has no file', () => {
    it('migrates legacy browser metadata only after the Electron store confirms it', async () => {
      providerGet.mockResolvedValueOnce(null);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_OPENAI_CONFIG));

      expect(await loadConfig()).toEqual(PUBLIC_OPENAI_CONFIG);
      expect(providerSet).toHaveBeenCalled();
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    });

    it('returns null when the store is empty and localStorage is empty', async () => {
      providerGet.mockResolvedValueOnce(null);

      expect(await loadConfig()).toBeNull();
    });
  });

  describe('Scenario C: Electron store is unavailable or corrupt', () => {
    it('can migrate legacy metadata after an unavailable read when writing succeeds', async () => {
      providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_ANTHROPIC_CONFIG));

      expect(await loadConfig()).toEqual(PUBLIC_ANTHROPIC_CONFIG);
      expect(providerSet).toHaveBeenCalled();
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    });

    it('returns null when the store rejects and localStorage is empty', async () => {
      providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));

      expect(await loadConfig()).toBeNull();
    });

    it('resolves null when both the store and legacy value fail (does not throw)', async () => {
      providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));
      localStorage.setItem(CONFIG_KEY, 'corrupted-json');

      await expect(loadConfig()).resolves.toBeNull();
    });
  });
});

// ─── saveConfig() ─────────────────────────────────────────────────────────────

describe('saveConfig()', () => {
  it('does not claim success when authoritative metadata persistence fails', async () => {
    providerCommit.mockRejectedValueOnce(new Error('disk full'));

    await expect(saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      TEST_OPTIONS,
    )).rejects.toThrow('disk full');

    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('writes closed-world metadata through Electron and never uses HTTP', async () => {
    await saveConfig(MOCK_OPENAI_CONFIG, undefined, TEST_OPTIONS);

    expect(providerCommit).toHaveBeenCalledWith({
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      },
    }, { apiKey: 'sk-test-key', customHeaders: undefined }, 'persistent', 'provider-test-receipt');
  });

  it('includes imageGen when provided', async () => {
    const igConfig = { provider: 'openai' as const, apiKey: 'k', baseUrl: 'u', model: 'm' };
    await saveConfig(MOCK_OPENAI_CONFIG, igConfig, TEST_OPTIONS);

    const body = providerCommit.mock.calls[0][0];
    expect(body.llm).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-4',
    });
    expect(body.imageGen).toEqual({ provider: 'openai', baseUrl: 'u', model: 'm' });
    expect(JSON.stringify(body)).not.toContain('sk-test-key');
    expect(JSON.stringify(body)).not.toContain('"apiKey"');
  });

  it('fails closed when Electron provider persistence is missing', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        credentials: window.electronAPI?.credentials,
      },
    });

    await expect(saveConfig(MOCK_OPENAI_CONFIG)).rejects.toMatchObject({
      code: 'REVERIE_DESKTOP_CONFIG_UNAVAILABLE',
    });
  });

  it('overwrites previous config — latest value wins', async () => {
    await saveConfig(MOCK_OPENAI_CONFIG, undefined, TEST_OPTIONS);
    await saveConfig(MOCK_ANTHROPIC_CONFIG, undefined, TEST_OPTIONS);

    expect(providerCommit.mock.calls.at(-1)?.[0].llm.provider).toBe('anthropic');
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('does not call fetch while saving settings', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    await saveConfig(MOCK_OPENAI_CONFIG, undefined, TEST_OPTIONS);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts an encrypted key while the replaceable backend is still starting', async () => {
    providerCommit.mockResolvedValueOnce({
      config: { llm: PUBLIC_OPENAI_CONFIG },
      status: {
        available: true,
        corrupted: false,
        stored: true,
        runtimeApplied: false,
        runtimePending: true,
        llm: { hasApiKey: true, hasCustomHeaders: false, bindingKnown: true },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
        runtimeAppliedScopes: { llm: false, imageGen: false },
        bindingMismatch: { llm: false, imageGen: false },
      },
    });

    await expect(saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      TEST_OPTIONS,
    )).resolves.toBeUndefined();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('surfaces a stable Windows vault error and allows an explicit session-only retry', async () => {
    providerCommit.mockResolvedValueOnce({
      config: { llm: PUBLIC_OPENAI_CONFIG },
      status: {
        available: true,
        persistentAvailable: true,
        corrupted: false,
        writeError: {
          code: 'REVERIE_OS_ENCRYPTION_FAILED',
          message: 'Windows 安全存储未完成写入；原有密钥未被覆盖。',
        },
        llm: { hasApiKey: false, hasCustomHeaders: false },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
      },
    });

    await expect(saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      TEST_OPTIONS,
    )).rejects.toMatchObject({
      code: 'REVERIE_OS_ENCRYPTION_FAILED',
      canUseSessionStorage: true,
    });

    providerCommit.mockResolvedValueOnce({
      config: { llm: PUBLIC_OPENAI_CONFIG },
      status: {
        available: true,
        persistentAvailable: false,
        corrupted: false,
        llm: { hasApiKey: true, hasCustomHeaders: false, bindingKnown: true },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
        bindingMismatch: { llm: false, imageGen: false },
      },
    });
    await expect(saveConfig(
      MOCK_OPENAI_CONFIG,
      undefined,
      { credentialStorage: 'session', testReceipt: 'provider-test-receipt' },
    )).resolves.toBeUndefined();
    expect(providerCommit).toHaveBeenLastCalledWith(
      expect.objectContaining({ llm: expect.objectContaining({ provider: 'openai' }) }),
      { apiKey: 'sk-test-key', customHeaders: undefined },
      'session',
      'provider-test-receipt',
    );
  });

  it('refuses to save an untested or edited provider draft', async () => {
    await expect(saveConfig(MOCK_OPENAI_CONFIG)).rejects.toMatchObject({
      code: 'REVERIE_PROVIDER_TEST_REQUIRED',
    });
    expect(providerCommit).not.toHaveBeenCalled();
  });
});

describe('testConfig()', () => {
  it('tests through the private desktop authority and returns an opaque receipt', async () => {
    await expect(testConfig(MOCK_OPENAI_CONFIG)).resolves.toMatchObject({
      receipt: 'provider-test-receipt',
      model: 'gpt-4',
      latencyMs: 42,
    });
    expect(providerTest).toHaveBeenCalledWith({
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      },
    }, {
      apiKey: 'sk-test-key',
      customHeaders: undefined,
    });
  });

  it('does not convert a failed probe into a saveable receipt', async () => {
    providerTest.mockResolvedValueOnce({
      ok: false,
      code: 'PROVIDER_UNAUTHORIZED',
      message: 'API 密钥或账户权限未通过验证。',
      retryable: false,
    });
    await expect(testConfig(MOCK_OPENAI_CONFIG)).rejects.toMatchObject({
      code: 'PROVIDER_UNAUTHORIZED',
      retryable: false,
    });
    expect(providerCommit).not.toHaveBeenCalled();
  });
});

// ─── chat() — renderer direct access is permanently disabled ─────────────────

describe('chat() fail-closed boundary', () => {
  it('rejects before any network request is attempted', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(chat(MOCK_MESSAGES, MOCK_TOOLS, MOCK_OPENAI_CONFIG)).rejects.toMatchObject({
      code: 'REVERIE_BACKEND_REQUIRED',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
