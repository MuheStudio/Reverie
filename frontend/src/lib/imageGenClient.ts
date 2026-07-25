/**
 * Image Generation API Client
 * Supports OpenAI (DALL-E) and Gemini formats
 */

export type ImageGenProvider = 'openai' | 'gemini';

export interface ImageGenConfig {
  provider: ImageGenProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
}

export interface ImageGenResult {
  base64: string;
  mimeType: string;
}

import { loadPersistedConfig, sanitizeImageGenConfig } from './configPersistence';

const CONFIG_KEY = 'webuiapps-imagegen-config';

function writePublicConfig(config: ImageGenConfig): ImageGenConfig {
  const sanitized = sanitizeImageGenConfig(config);
  if (!sanitized) throw new TypeError('Image-generation configuration metadata is invalid');
  localStorage.setItem(CONFIG_KEY, JSON.stringify(sanitized));
  return sanitized;
}

const DEFAULT_CONFIGS: Record<ImageGenProvider, Omit<ImageGenConfig, 'apiKey'>> = {
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-image-1.5',
  },
  gemini: {
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.1-flash-image-preview',
  },
};

export function getDefaultImageGenConfig(
  provider: ImageGenProvider,
): Omit<ImageGenConfig, 'apiKey'> {
  return DEFAULT_CONFIGS[provider];
}

/**
 * Load image gen config — priority: local file (~/.openroom/config.json) > localStorage.
 * Falls back gracefully if the dev server API is unavailable.
 */
export async function loadImageGenConfig(): Promise<ImageGenConfig | null> {
  // 1. Try local file via dev-server API
  try {
    const persisted = await loadPersistedConfig();
    if (persisted?.imageGen) {
      const sanitized = writePublicConfig(persisted.imageGen);
      return sanitized;
    }
  } catch {
    // API not available — fall through
  }

  // 2. Fall back to localStorage
  return loadImageGenConfigSync();
}

/** Synchronous read from localStorage cache. */
export function loadImageGenConfigSync(): ImageGenConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const sanitized = raw ? sanitizeImageGenConfig(JSON.parse(raw)) : null;
    if (sanitized) localStorage.setItem(CONFIG_KEY, JSON.stringify(sanitized));
    return sanitized;
  } catch {
    return null;
  }
}

export async function saveImageGenConfig(config: ImageGenConfig): Promise<void> {
  const publicConfig = sanitizeImageGenConfig(config);
  if (!publicConfig) {
    throw new TypeError('Image-generation configuration metadata is invalid');
  }
  const apiKey = config.apiKey.trim();
  const customHeaders = config.customHeaders?.trim();
  if (apiKey || customHeaders) {
    const api = globalThis.window?.electronAPI?.credentials;
    if (!api?.set) {
      throw new Error('Secure operating-system credential storage is unavailable');
    }
    const status = await api.set('imageGen', {
      ...(apiKey ? { apiKey } : {}),
      ...(customHeaders ? { customHeaders } : {}),
    });
    if (!status.available || status.corrupted) {
      throw new Error('Secure credential storage did not confirm the write');
    }
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(publicConfig));
}

export async function clearImageGenCredentials(): Promise<void> {
  const api = globalThis.window?.electronAPI?.credentials;
  if (!api?.clear) throw new Error('Secure operating-system credential storage is unavailable');
  await api.clear('imageGen');
}

export async function generateImage(
  prompt: string,
  config: ImageGenConfig,
): Promise<ImageGenResult> {
  void prompt;
  void config;
  const error = new Error(
    'Direct renderer image generation is disabled; use the authenticated local bridge',
  );
  (error as Error & { code?: string }).code = 'REVERIE_BACKEND_REQUIRED';
  throw error;
}
