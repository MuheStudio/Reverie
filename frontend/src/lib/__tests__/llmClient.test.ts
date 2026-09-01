/**
 * Unit tests for llmClient.ts
 *
 * Environment: happy-dom (provides localStorage, fetch globals)
 * Mock strategy:
 *   - fetch: vi.fn() via globalThis.fetch per test
 *   - localStorage: happy-dom provides real implementation, cleared in beforeEach
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';import {
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
  provider: 'custom',
  apiKey: 'sk-test-key',
  baseUrl: 'https://gateway.example.test/v1',
  model: 'gateway-model',
};

const MOCK_ANTHROPIC_CONFIG: LLMConfig = {
  provider: 'ollama',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1',
  model: 'installed-model',
};

const PUBLIC_OPENAI_CONFIG: LLMConfig = { ...MOCK_OPENAI_CONFIG, apiKey: '' };

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
    provider: 'custom',
    model: 'gateway-model',
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
  it('requires users to supply the endpoint and model for a custom gateway', () => {
    const cfg = getDefaultProviderConfig('custom');
    expect(cfg.provider).toBe('custom');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.model).toBe('');
  });

  it('pins Ollama to loopback without guessing an installed model', () => {
    const cfg = getDefaultProviderConfig('ollama');
    expect(cfg.provider).toBe('ollama');
    expect(cfg.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.model).toBe('');
    expect('apiKey' in cfg).toBe(false);
  });

  it('returns consistent values for the same provider', () => {
    const a = getDefaultProviderConfig('ollama');
    const b = getDefaultProviderConfig('ollama');
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
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      const result = await loadConfig();

      expect(result).toEqual(PUBLIC_OPENAI_CONFIG);
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
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
    it('drops legacy browser metadata instead of trusting it', async () => {
      providerGet.mockResolvedValueOnce(null);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_OPENAI_CONFIG));

      expect(await loadConfig()).toBeNull();
      expect(providerSet).not.toHaveBeenCalled();
      expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    });

    it('returns null when the store is empty and localStorage is empty', async () => {
      providerGet.mockResolvedValueOnce(null);

      expect(await loadConfig()).toBeNull();
    });
  });

  describe('Scenario C: Electron store is unavailable or corrupt', () => {
    it('drops legacy metadata when the authoritative read fails, without a write', async () => {
      providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_ANTHROPIC_CONFIG));

      expect(await loadConfig()).toBeNull();
      expect(providerSet).not.toHaveBeenCalled();
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
        provider: 'custom',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gateway-model',
      },
    }, { apiKey: 'sk-test-key', customHeaders: undefined }, 'persistent', 'provider-test-receipt');
  });

  it('forwards explicit per-field credential deletion intent', async () => {
    await saveConfig({
      ...MOCK_OPENAI_CONFIG,
      clearApiKey: true,
      clearCustomHeaders: true,
    }, undefined, TEST_OPTIONS);

    expect(providerCommit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        clearApiKey: true,
        clearCustomHeaders: true,
      }),
      'persistent',
      'provider-test-receipt',
    );
  });

  it('rejects image generation metadata before committing partial settings', async () => {
    const igConfig = { provider: 'openai' as const, apiKey: 'k', baseUrl: 'u', model: 'm' };
    await expect(saveConfig(MOCK_OPENAI_CONFIG, igConfig, TEST_OPTIONS)).rejects.toThrow(
      '图片生成配置权威通道尚未启用',
    );
    expect(providerCommit).not.toHaveBeenCalled();
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

    expect(providerCommit.mock.calls.at(-1)?.[0].llm.provider).toBe('ollama');
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
      expect.objectContaining({ llm: expect.objectContaining({ provider: 'custom' }) }),
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
      model: 'gateway-model',
      latencyMs: 42,
    });
    expect(providerTest).toHaveBeenCalledWith({
      llm: {
        provider: 'custom',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gateway-model',
      },
    }, {
      apiKey: 'sk-test-key',
      customHeaders: undefined,
    });
  });

  it('binds explicit credential deletion intent into the test receipt', async () => {
    await testConfig({
      ...MOCK_OPENAI_CONFIG,
      clearApiKey: true,
      clearCustomHeaders: true,
    });

    expect(providerTest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        clearApiKey: true,
        clearCustomHeaders: true,
      }),
    );
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

  it('preserves retryability from the desktop authority', async () => {
    providerTest.mockResolvedValueOnce({
      ok: false,
      code: 'REVERIE_BRIDGE_NOT_READY',
      message: '聊天后端正在启动，请稍后再测试。',
      retryable: true,
    });
    await expect(testConfig(MOCK_OPENAI_CONFIG)).rejects.toMatchObject({
      code: 'REVERIE_BRIDGE_NOT_READY',
      retryable: true,
    });
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
