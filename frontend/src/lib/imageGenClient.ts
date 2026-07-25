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
  savePersistedConfig,
  type PublicImageGenConfig,
} from './configPersistence';

const CONFIG_KEY = 'webuiapps-imagegen-config';

function readLegacyPublicConfig(): PublicImageGenConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
    return raw ? sanitizeImageGenConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

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
 * A legacy browser value is accepted only for a one-way confirmed migration.
 */
export async function loadImageGenConfig(): Promise<ImageGenConfig | null> {
  const persisted = await loadPersistedConfig();
  if (persisted?.imageGen) {
    removeLegacyPublicConfig();
    return { ...persisted.imageGen, apiKey: '' };
  }

  const legacy = readLegacyPublicConfig();
  if (legacy && persisted?.llm) {
    try {
      await savePersistedConfig({ llm: persisted.llm, imageGen: legacy });
      removeLegacyPublicConfig();
      return { ...legacy, apiKey: '' };
    } catch {
      return null;
    }
  }
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
  const apiKey = config.apiKey.trim();
  const customHeaders = config.customHeaders?.trim();
  const persisted = await loadPersistedConfig();
  if (!persisted?.llm) {
    throw new Error('请先保存主聊天模型配置，再保存图片生成配置');
  }
  await savePersistedConfig({ llm: persisted.llm, imageGen: publicConfig });
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
  removeLegacyPublicConfig();
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
