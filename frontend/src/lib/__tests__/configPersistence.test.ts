/**
 * Unit tests for configPersistence.ts
 *
 * Covers: loadPersistedConfig, savePersistedConfig, legacy format migration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
  type PublicImageGenConfig,
  type PublicLLMConfig,
} from '../configPersistence';
import type { LLMConfig } from '../llmModels';
import type { ImageGenConfig } from '../imageGenClient';

// ─── Constants ──────────────────────────────────────────────────────────────────

const MOCK_LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
  customHeaders: 'Authorization: backup-canary',
};

const MOCK_IMAGEGEN_CONFIG: ImageGenConfig = {
  provider: 'openai',
  apiKey: 'sk-img-test',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-image-1.5',
  customHeaders: 'X-Api-Key: image-canary',
};

const PUBLIC_LLM_CONFIG: PublicLLMConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-4',
};

const PUBLIC_IMAGEGEN_CONFIG: PublicImageGenConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  model: 'gpt-image-1.5',
};

const MOCK_PERSISTED: PersistedConfig = {
  llm: PUBLIC_LLM_CONFIG,
  imageGen: PUBLIC_IMAGEGEN_CONFIG,
};
const providerGet = vi.fn();
const providerSet = vi.fn();

// ─── Setup / Teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  providerGet.mockReset();
  providerSet.mockReset();
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

// ─── loadPersistedConfig() ──────────────────────────────────────────────────────

describe('loadPersistedConfig()', () => {
  it('returns full config when file has new { llm, imageGen } format', async () => {
    providerGet.mockResolvedValueOnce(MOCK_PERSISTED);

    const result = await loadPersistedConfig();

    expect(result).toEqual({ llm: PUBLIC_LLM_CONFIG, imageGen: PUBLIC_IMAGEGEN_CONFIG });
    expect(JSON.stringify(result)).not.toContain('sk-test');
    expect(JSON.stringify(result)).not.toContain('backup-canary');
    expect(JSON.stringify(result)).not.toContain('image-canary');
  });

  it('returns { llm } only when imageGen is absent', async () => {
    const withoutImageGen = { llm: MOCK_LLM_CONFIG };
    providerGet.mockResolvedValueOnce(withoutImageGen);

    const result = await loadPersistedConfig();

    expect(result?.llm).toEqual(PUBLIC_LLM_CONFIG);
    expect(result?.imageGen).toBeUndefined();
  });

  it('migrates legacy flat LLMConfig format to { llm } wrapper', async () => {
    // Legacy format: flat LLMConfig at top level (has "provider", no "llm" key)
    providerGet.mockResolvedValueOnce(MOCK_LLM_CONFIG);

    const result = await loadPersistedConfig();

    expect(result).toEqual({ llm: PUBLIC_LLM_CONFIG });
    expect(result?.llm.provider).toBe('openai');
    expect(result?.imageGen).toBeUndefined();
  });

  it('returns null when the Electron store has no config', async () => {
    providerGet.mockResolvedValueOnce(null);

    expect(await loadPersistedConfig()).toBeNull();
  });

  it('returns null when the Electron store rejects a corrupt config', async () => {
    providerGet.mockRejectedValueOnce(new Error('corrupt'));

    expect(await loadPersistedConfig()).toBeNull();
  });

  it('returns null when response is not a recognized format', async () => {
    providerGet.mockResolvedValueOnce({ unrelated: 'data' });

    expect(await loadPersistedConfig()).toBeNull();
  });
});

// ─── savePersistedConfig() ──────────────────────────────────────────────────────

describe('savePersistedConfig()', () => {
  it('writes closed-world metadata through the Electron store', async () => {
    providerSet.mockResolvedValueOnce(undefined);
    await savePersistedConfig({
      llm: MOCK_LLM_CONFIG,
      imageGen: MOCK_IMAGEGEN_CONFIG,
    });

    expect(providerSet).toHaveBeenCalledWith({
      llm: {
        provider: PUBLIC_LLM_CONFIG.provider,
        baseUrl: PUBLIC_LLM_CONFIG.baseUrl,
        model: PUBLIC_LLM_CONFIG.model,
      },
      imageGen: {
        provider: PUBLIC_IMAGEGEN_CONFIG.provider,
        baseUrl: PUBLIC_IMAGEGEN_CONFIG.baseUrl,
        model: PUBLIC_IMAGEGEN_CONFIG.model,
      },
    });
  });

  it('never sends credential material to Electron provider metadata', async () => {
    providerSet.mockResolvedValueOnce(undefined);
    await savePersistedConfig({
      llm: MOCK_LLM_CONFIG,
      imageGen: MOCK_IMAGEGEN_CONFIG,
    });

    const body = providerSet.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('sk-test');
    expect(JSON.stringify(body)).not.toContain('backup-canary');
    expect(JSON.stringify(body)).not.toContain('image-canary');
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(JSON.stringify(body)).not.toContain('customHeaders');
  });

  it('omits imageGen when not provided', async () => {
    providerSet.mockResolvedValueOnce(undefined);
    await savePersistedConfig({ llm: MOCK_LLM_CONFIG });

    const body = providerSet.mock.calls[0][0];
    expect(body.llm).toEqual({
      provider: PUBLIC_LLM_CONFIG.provider,
      baseUrl: PUBLIC_LLM_CONFIG.baseUrl,
      model: PUBLIC_LLM_CONFIG.model,
    });
    expect(body.imageGen).toBeUndefined();
  });

  it('propagates authoritative store failure instead of claiming success', async () => {
    providerSet.mockRejectedValueOnce(new Error('disk full'));

    await expect(savePersistedConfig(MOCK_PERSISTED)).rejects.toThrow('disk full');
  });
});
