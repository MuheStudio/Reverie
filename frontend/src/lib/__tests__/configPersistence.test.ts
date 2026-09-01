/**
 * Unit tests for configPersistence.ts
 *
 * Covers: loadPersistedConfig, legacy format migration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadPersistedConfig,
  type PersistedConfig,
  type PublicImageGenConfig,
  type PublicLLMConfig,
} from '../configPersistence';
import type { LLMConfig } from '../llmModels';

// ─── Constants ──────────────────────────────────────────────────────────────────

const MOCK_LLM_CONFIG: LLMConfig = {
  provider: 'custom',
  apiKey: 'sk-test',
  baseUrl: 'https://gateway.example.test/v1',
  model: 'gateway-model',
  customHeaders: 'Authorization: backup-canary',
};

const PUBLIC_LLM_CONFIG: PublicLLMConfig = {
  provider: 'custom',
  baseUrl: 'https://gateway.example.test/v1',
  model: 'gateway-model',
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

// ─── Setup / Teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  providerGet.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      providerConfig: {
        get: providerGet,
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
    expect(result?.llm.provider).toBe('custom');
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
