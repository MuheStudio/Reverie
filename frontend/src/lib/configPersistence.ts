/**
 * Public provider metadata persistence.
 *
 * API keys and custom authorization headers are deliberately excluded. In the
 * desktop application they live only in Electron safeStorage and reach Python
 * through the private child-process control pipe.
 */

import type { LLMConfig, LLMProvider } from './llmModels';
import type { ImageGenConfig, ImageGenProvider } from './imageGenClient';

export type PublicLLMConfig = Omit<LLMConfig, 'apiKey' | 'customHeaders'>;
export type PublicImageGenConfig = Omit<ImageGenConfig, 'apiKey' | 'customHeaders'>;

export interface PersistedConfig {
  llm: PublicLLMConfig;
  imageGen?: PublicImageGenConfig;
}

const LLM_PROVIDERS = new Set<LLMProvider>([
  'openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'kimi', 'glm',
  'ollama', 'custom',
]);
const IMAGE_PROVIDERS = new Set<ImageGenProvider>(['openai', 'gemini']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000')) return '';
  return value;
}

export function containsCredentialMaterial(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (typeof value.apiKey === 'string' && value.apiKey.length > 0)
    || (typeof value.customHeaders === 'string' && value.customHeaders.length > 0);
}

export function sanitizeLLMConfig(value: unknown): PublicLLMConfig | null {
  if (!isRecord(value) || !LLM_PROVIDERS.has(value.provider as LLMProvider)) return null;
  const baseUrl = cleanString(value.baseUrl);
  const model = cleanString(value.model, 512);
  if (!baseUrl || !model) return null;
  const customProviderName = cleanString(value.customProviderName, 160);
  return {
    provider: value.provider as LLMProvider,
    baseUrl,
    model,
    ...(customProviderName ? { customProviderName } : {}),
  };
}

export function sanitizeImageGenConfig(value: unknown): PublicImageGenConfig | null {
  if (!isRecord(value) || !IMAGE_PROVIDERS.has(value.provider as ImageGenProvider)) return null;
  const baseUrl = cleanString(value.baseUrl);
  const model = cleanString(value.model, 512);
  if (!baseUrl || !model) return null;
  return {
    provider: value.provider as ImageGenProvider,
    baseUrl,
    model,
  };
}

export function sanitizePersistedConfig(value: unknown): PersistedConfig | null {
  if (!isRecord(value)) return null;
  const llmCandidate = 'llm' in value ? value.llm : value;
  const llm = sanitizeLLMConfig(llmCandidate);
  if (!llm) return null;
  const imageGen = sanitizeImageGenConfig(value.imageGen);
  return {
    llm,
    ...(imageGen ? { imageGen } : {}),
  };
}

/** Read canonical public metadata from the sender-validated Electron store. */
export async function loadPersistedConfig(): Promise<PersistedConfig | null> {
  try {
    const api = globalThis.window?.electronAPI?.providerConfig;
    if (!api?.get) return null;
    return sanitizePersistedConfig(await api.get());
  } catch {
    return null;
  }
}
