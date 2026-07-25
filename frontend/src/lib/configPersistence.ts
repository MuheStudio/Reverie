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
  'openai',
  'custom',
  'anthropic',
  'gemini',
  'grok',
  'deepseek',
  'kimi',
  'z.ai',
  'ollama',
  'llama.cpp',
  'minimax',
  'openrouter',
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

/** Persist a closed-world metadata projection through Electron, never HTTP. */
export async function savePersistedConfig(config: PersistedConfig): Promise<void> {
  const sanitized = sanitizePersistedConfig(config);
  if (!sanitized) throw new TypeError('LLM configuration metadata is invalid');
  const api = globalThis.window?.electronAPI?.providerConfig;
  if (!api?.set) {
    const error = new Error('Authoritative desktop provider settings are unavailable');
    (error as Error & { code?: string }).code = 'REVERIE_DESKTOP_CONFIG_UNAVAILABLE';
    throw error;
  }
  await api.set({
    llm: {
      provider: sanitized.llm.provider,
      baseUrl: sanitized.llm.baseUrl,
      model: sanitized.llm.model,
      ...(sanitized.llm.customProviderName
        ? { customProviderName: sanitized.llm.customProviderName }
        : {}),
    },
    ...(sanitized.imageGen
      ? {
          imageGen: {
            provider: sanitized.imageGen.provider,
            baseUrl: sanitized.imageGen.baseUrl,
            model: sanitized.imageGen.model,
          },
        }
      : {}),
  });
}
