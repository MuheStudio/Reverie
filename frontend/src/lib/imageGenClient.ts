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

import {
  loadPersistedConfig,
  sanitizeImageGenConfig,
} from './configPersistence';

const CONFIG_KEY = 'webuiapps-imagegen-config';

function removeLegacyPublicConfig(): void {
  try {
    globalThis.localStorage?.removeItem(CONFIG_KEY);
  } catch {
    // The legacy cache is never consulted as a runtime fallback.
  }
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
 * Load image-generation metadata from the sender-validated Electron store.
 * The renderer cache is never a runtime fallback: without the authoritative
 * write channel there is no way to confirm a legacy cached value, so it is
 * dropped instead of trusted.
 */
export async function loadImageGenConfig(): Promise<ImageGenConfig | null> {
  const persisted = await loadPersistedConfig();
  if (persisted?.imageGen) {
    removeLegacyPublicConfig();
    return { ...persisted.imageGen, apiKey: '' };
  }

  removeLegacyPublicConfig();
  return null;
}

/** Compatibility boundary: browser storage is never authoritative. */
export function loadImageGenConfigSync(): ImageGenConfig | null {
  return null;
}

export async function saveImageGenConfig(config: ImageGenConfig): Promise<void> {
  const publicConfig = sanitizeImageGenConfig(config);
  if (!publicConfig) {
    throw new TypeError('Image-generation configuration metadata is invalid');
  }
  throw new Error('图片生成配置权威通道尚未启用');
  removeLegacyPublicConfig();
}

export async function clearImageGenCredentials(): Promise<void> {
  throw new Error('图片生成凭据安全通道尚未启用');
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
