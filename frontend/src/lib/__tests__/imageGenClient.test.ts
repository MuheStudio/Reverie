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
  provider: 'custom',
  apiKey: 'sk-llm',
  baseUrl: 'https://gateway.example.test/v1',
  model: 'gateway-model',
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

  it('does not revive browser metadata as authoritative', () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));
    expect(loadImageGenConfigSync()).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    localStorage.setItem(CONFIG_KEY, 'bad-json');
    expect(loadImageGenConfigSync()).toBeNull();
  });
});

describe('loadImageGenConfig()', () => {
  it('loads imageGen from the Electron store without making a browser copy', async () => {
    providerGet.mockResolvedValueOnce({ llm: MOCK_LLM_CONFIG, imageGen: MOCK_IG_CONFIG });

    const result = await loadImageGenConfig();

    expect(result).toEqual(PUBLIC_IG_CONFIG);
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('returns null when Electron metadata contains only LLM settings', async () => {
    providerGet.mockResolvedValueOnce({ llm: MOCK_LLM_CONFIG });

    const result = await loadImageGenConfig();

    // No imageGen in file → falls through to localStorage
    expect(result).toBeNull();
  });

  it('drops legacy image metadata when no authoritative LLM record is available', async () => {
    providerGet.mockRejectedValueOnce(new Error('Provider store unavailable'));
    localStorage.setItem(CONFIG_KEY, JSON.stringify(MOCK_IG_CONFIG));

    const result = await loadImageGenConfig();

    expect(result).toBeNull();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
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
  it.each([
    MOCK_IG_CONFIG,
    PUBLIC_IG_CONFIG,
  ])('fails before persistence while the image authority is unavailable', async (config) => {
    providerGet.mockResolvedValueOnce({ llm: MOCK_LLM_CONFIG });
    await expect(saveImageGenConfig(config)).rejects.toThrow(
      '图片生成配置权威通道尚未启用',
    );
    expect(providerSet).not.toHaveBeenCalled();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
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
