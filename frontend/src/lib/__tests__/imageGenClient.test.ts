/**
 * Unit tests for imageGenClient.ts — config loading/saving
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadImageGenConfig,
  loadImageGenConfigSync,
  saveImageGenConfig,
  generateImage,
  getDefaultImageGenConfig,
  type ImageGenConfig,
} from '../imageGenClient';

const CONFIG_KEY = 'webuiapps-imagegen-config';

const MOCK_IG_CONFIG: ImageGenConfig = {
  provider: 'openai',
  apiKey: 'sk-img-test',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-image-1.5',
};
const PUBLIC_IG_CONFIG: ImageGenConfig = { ...MOCK_IG_CONFIG, apiKey: '' };

const MOCK_LLM_CONFIG = {
  provider: 'openai',
  apiKey: 'sk-llm',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
};
const providerGet = vi.fn();
const providerSet = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  providerGet.mockReset();
  providerSet.mockReset();
  providerGet.mockResolvedValue(null);
  providerSet.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      providerConfig: {
        get: providerGet,
        set: providerSet,
      },
      credentials: {
        set: vi.fn().mockResolvedValue({
          available: true,
          corrupted: false,
          llm: { hasApiKey: false, hasCustomHeaders: false },
          imageGen: { hasApiKey: true, hasCustomHeaders: false },
          runtimeAppliedScopes: { llm: true, imageGen: false },
        }),
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDefaultImageGenConfig()', () => {
  it('returns correct defaults for openai', () => {
    const cfg = getDefaultImageGenConfig('openai');
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-image-1.5');
  });

  it('returns correct defaults for gemini', () => {
    const cfg = getDefaultImageGenConfig('gemini');
    expect(cfg.provider).toBe('gemini');
    expect(cfg.baseUrl).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('loadImageGenConfigSync()', () => {
  it('returns null when localStorage is empty', () => {
    expect(loadImageGenConfigSync()).toBeNull();
  });

  it('returns parsed config from localStorage', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));
    expect(loadImageGenConfigSync()).toEqual(PUBLIC_IG_CONFIG);
    expect(localStorage.getItem(CONFIG_KEY)).not.toContain('sk-img-test');
  });

  it('returns null on invalid JSON', () => {
    localStorage.setItem(CONFIG_KEY, 'bad-json');
    expect(loadImageGenConfigSync()).toBeNull();
  });
});

describe('loadImageGenConfig()', () => {
  it('loads imageGen from the Electron store and syncs its safe projection', async () => {
    providerGet.mockResolvedValueOnce({ llm: MOCK_LLM_CONFIG, imageGen: MOCK_IG_CONFIG });

    const result = await loadImageGenConfig();

    expect(result).toEqual(PUBLIC_IG_CONFIG);
    expect(localStorage.getItem(CONFIG_KEY)).toBe(JSON.stringify(PUBLIC_IG_CONFIG));
  });

  it('returns null when Electron metadata contains only LLM settings', async () => {
    providerGet.mockResolvedValueOnce({ llm: MOCK_LLM_CONFIG });

    const result = await loadImageGenConfig();

    // No imageGen in file → falls through to localStorage
    expect(result).toBeNull();
  });

  it('falls back to localStorage when the Electron store is unavailable', async () => {
    providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));

    const result = await loadImageGenConfig();

    expect(result).toEqual(PUBLIC_IG_CONFIG);
  });

  it('returns null when both Electron metadata and localStorage have nothing', async () => {
    providerGet.mockResolvedValueOnce(null);

    expect(await loadImageGenConfig()).toBeNull();
  });

  it('handles legacy flat LLMConfig metadata (no imageGen) gracefully', async () => {
    // Legacy file has flat LLMConfig → no imageGen field
    providerGet.mockResolvedValueOnce(MOCK_LLM_CONFIG);

    const result = await loadImageGenConfig();

    // Legacy format has no imageGen → should fall through to localStorage
    expect(result).toBeNull();
  });
});

describe('saveImageGenConfig()', () => {
  it('writes only public metadata and sends the key to the secure vault', async () => {
    await saveImageGenConfig(MOCK_IG_CONFIG);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual(PUBLIC_IG_CONFIG);
    expect(window.electronAPI?.credentials?.set).toHaveBeenCalledWith('imageGen', {
      apiKey: 'sk-img-test',
    });
  });
});

describe('generateImage() fail-closed boundary', () => {
  it('rejects before any renderer network request is attempted', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    await expect(generateImage('portrait', MOCK_IG_CONFIG)).rejects.toMatchObject({
      code: 'REVERIE_BACKEND_REQUIRED',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
