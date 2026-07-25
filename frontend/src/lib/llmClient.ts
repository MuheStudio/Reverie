/**
 * Minimal LLM API Client
 * Supports OpenAI-compatible / Anthropic-compatible formats
 */

import type { LLMConfig } from './llmModels';

import {
  loadPersistedConfig,
  sanitizeImageGenConfig,
  sanitizeLLMConfig,
  savePersistedConfig,
} from './configPersistence';

const CONFIG_KEY = 'webuiapps-llm-config';

function writePublicConfig(config: LLMConfig): LLMConfig {
  const sanitized = sanitizeLLMConfig(config);
  if (!sanitized) throw new TypeError('LLM configuration metadata is invalid');
  localStorage.setItem(CONFIG_KEY, JSON.stringify(sanitized));
  return sanitized;
}

async function storeCredential(
  scope: 'llm' | 'imageGen',
  value: { apiKey?: string; customHeaders?: string },
): Promise<void> {
  const nonEmpty = {
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
    ...(value.customHeaders ? { customHeaders: value.customHeaders } : {}),
  };
  if (Object.keys(nonEmpty).length === 0) return;
  const api = globalThis.window?.electronAPI?.credentials;
  if (!api?.set) {
    const error = new Error('Secure operating-system credential storage is unavailable');
    (error as Error & { code?: string }).code = 'REVERIE_SECURE_STORAGE_UNAVAILABLE';
    throw error;
  }
  const status = await api.set(scope, nonEmpty);
  if (!status.available || status.corrupted) {
    throw new Error('Secure credential storage did not confirm the write');
  }
}

export async function loadConfig(): Promise<LLMConfig | null> {
  try {
    const persisted = await loadPersistedConfig();
    if (persisted?.llm) {
      const sanitized = writePublicConfig(persisted.llm);
      return sanitized;
    }
  } catch {
    // API not available (production / network error)
  }

  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const sanitized = raw ? sanitizeLLMConfig(JSON.parse(raw)) : null;
    if (sanitized) localStorage.setItem(CONFIG_KEY, JSON.stringify(sanitized));
    return sanitized;
  } catch {
    return null;
  }
}

export async function saveConfig(
  config: LLMConfig,
  imageGenConfig?: import('./imageGenClient').ImageGenConfig | null,
): Promise<void> {
  const publicConfig = sanitizeLLMConfig(config);
  if (!publicConfig) throw new TypeError('LLM configuration metadata is invalid');
  const publicImageConfig = imageGenConfig ? sanitizeImageGenConfig(imageGenConfig) : null;

  const persisted: import('./configPersistence').PersistedConfig = {
    llm: publicConfig,
  };
  if (publicImageConfig) {
    persisted.imageGen = publicImageConfig;
  }

  await savePersistedConfig(persisted);
  await storeCredential('llm', {
    apiKey: config.apiKey.trim(),
    customHeaders: config.customHeaders?.trim(),
  });
  if (imageGenConfig) {
    await storeCredential('imageGen', {
      apiKey: imageGenConfig.apiKey.trim(),
      customHeaders: imageGenConfig.customHeaders?.trim(),
    });
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(publicConfig));
}

export async function saveConfigMetadata(config: LLMConfig): Promise<void> {
  const publicConfig = sanitizeLLMConfig(config);
  if (!publicConfig) throw new TypeError('LLM configuration metadata is invalid');
  await savePersistedConfig({ llm: publicConfig });
  localStorage.setItem(CONFIG_KEY, JSON.stringify(publicConfig));
}

export async function clearConfigCredentials(): Promise<void> {
  const api = globalThis.window?.electronAPI?.credentials;
  if (!api?.clear) {
    throw new Error('Secure operating-system credential storage is unavailable');
  }
  await api.clear('llm');
}

export function loadConfigSync(): LLMConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const sanitized = raw ? sanitizeLLMConfig(JSON.parse(raw)) : null;
    if (sanitized) localStorage.setItem(CONFIG_KEY, JSON.stringify(sanitized));
    return sanitized;
  } catch {
    return null;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
}

export async function chat(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: LLMConfig,
): Promise<LLMResponse> {
  void messages;
  void tools;
  void config;
  const error = new Error(
    'Direct renderer LLM access is disabled; use the authenticated local bridge',
  );
  (error as Error & { code?: string }).code = 'REVERIE_BACKEND_REQUIRED';
  throw error;
}
