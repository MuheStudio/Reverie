/**
 * Unit tests for providerConfigSync.ts
 *
 * Covers: mergeSavedDraft field-level touched protection, retry schedule
 * sanity. The retry loop itself is exercised through the panels; these tests
 * pin the pure merge semantics that guard user input from being clobbered.
 */

import { describe, it, expect } from 'vitest';
import {
  credentialStorageModeFromStatus,
  mergeSavedDraft,
  PROVIDER_CONFIG_RETRY_DELAYS_MS,
  SAVED_PROVIDER_FIELDS,
} from '../providerConfigSync';

type Draft = {
  provider: string;
  baseUrl: string;
  model: string;
  customProviderName: string;
  apiKey: string;
};

const BASE_DRAFT: Draft = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  model: '',
  customProviderName: '',
  apiKey: '',
};

describe('mergeSavedDraft()', () => {
  it('fills untouched fields from the saved snapshot', () => {
    const merged = mergeSavedDraft(
      BASE_DRAFT,
      { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
      new Set(),
    );

    expect(merged).toEqual({
      ...BASE_DRAFT,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
  });

  it('never overwrites fields the user has touched', () => {
    const merged = mergeSavedDraft(
      { ...BASE_DRAFT, model: 'my-model' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      new Set(['model']),
    );

    expect(merged.model).toBe('my-model');
    expect(merged.provider).toBe('deepseek');
  });

  it('leaves credential fields untouched by design', () => {
    const draft: Draft = { ...BASE_DRAFT, apiKey: 'sk-user-key' };
    const merged = mergeSavedDraft(
      draft,
      { provider: 'deepseek' },
      new Set(),
    );

    expect(merged.apiKey).toBe('sk-user-key');
  });

  it('skips empty saved values instead of blanking the draft', () => {
    const merged = mergeSavedDraft(
      { ...BASE_DRAFT, model: 'my-model' },
      { model: '', customProviderName: '  ' },
      new Set(),
    );

    expect(merged.model).toBe('my-model');
  });

  it('returns the same object reference when nothing changes', () => {
    const saved = { ...BASE_DRAFT };
    expect(mergeSavedDraft(BASE_DRAFT, saved, new Set())).toBe(BASE_DRAFT);
    expect(mergeSavedDraft(BASE_DRAFT, null, new Set())).toBe(BASE_DRAFT);
    expect(mergeSavedDraft(BASE_DRAFT, undefined, new Set())).toBe(BASE_DRAFT);
  });

  it('ignores non-string saved values', () => {
    const merged = mergeSavedDraft(
      BASE_DRAFT,
      { model: 42 as unknown as string },
      new Set(),
    );

    expect(merged.model).toBe('');
  });

  it('treats whitespace-only saved values as empty', () => {
    const merged = mergeSavedDraft(
      { ...BASE_DRAFT, provider: 'ollama' },
      { provider: '   ' },
      new Set(),
    );

    expect(merged.provider).toBe('ollama');
  });
});

describe('PROVIDER_CONFIG_RETRY_DELAYS_MS', () => {
  it('stays bounded and ascending so a stalled bridge cannot spin forever', () => {
    expect(PROVIDER_CONFIG_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(PROVIDER_CONFIG_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(8);
    let previous = 0;
    for (const delay of PROVIDER_CONFIG_RETRY_DELAYS_MS) {
      expect(delay).toBeGreaterThan(previous);
      expect(delay).toBeLessThanOrEqual(60_000);
      previous = delay;
    }
  });

  it('keeps the field list aligned with the merge contract', () => {
    expect([...SAVED_PROVIDER_FIELDS]).toEqual([
      'provider',
      'baseUrl',
      'model',
      'customProviderName',
    ]);
  });
});

describe('credentialStorageModeFromStatus()', () => {
  it('restores persistent mode after restart when the vault has a durable credential', () => {
    expect(credentialStorageModeFromStatus({
      available: true,
      persistentAvailable: true,
      corrupted: false,
      llm: { hasApiKey: true, hasCustomHeaders: false, sessionOnly: false },
    })).toBe('persistent');
  });

  it('restores session mode and falls back when DPAPI is unavailable', () => {
    expect(credentialStorageModeFromStatus({
      available: true,
      persistentAvailable: true,
      corrupted: false,
      llm: { hasApiKey: true, hasCustomHeaders: false, sessionOnly: true },
    })).toBe('session');
    expect(credentialStorageModeFromStatus({
      available: false,
      persistentAvailable: false,
      corrupted: false,
      llm: { hasApiKey: false, hasCustomHeaders: false },
    })).toBe('session');
  });

  it('defaults to persistent mode before any credential has been committed', () => {
    expect(credentialStorageModeFromStatus({
      available: true,
      persistentAvailable: true,
      corrupted: false,
      llm: { hasApiKey: false, hasCustomHeaders: false },
    })).toBe('persistent');
  });
});
