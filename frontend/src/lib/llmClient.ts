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
  type PublicLLMConfig,
} from './configPersistence';

const CONFIG_KEY = 'webuiapps-llm-config';

export type CredentialStorageMode = 'persistent' | 'session';

export class CredentialWriteError extends Error {
  readonly code: string;
  readonly canUseSessionStorage: boolean;

  constructor(
    message: string,
    code = 'REVERIE_SECURE_STORAGE_UNAVAILABLE',
    canUseSessionStorage = true,
  ) {
    super(message);
    this.name = 'CredentialWriteError';
    this.code = code;
    this.canUseSessionStorage = canUseSessionStorage;
  }
}

export class ProviderTestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = 'ProviderTestError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ProviderTestReceipt {
  receipt: string;
  latencyMs: number;
  model: string;
}

function readLegacyPublicConfig(): PublicLLMConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
    return raw ? sanitizeLLMConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function removeLegacyPublicConfig(): void {
  try {
    globalThis.localStorage?.removeItem(CONFIG_KEY);
  } catch {
    // A blocked legacy cache is inert; it is never used after migration.
  }
}

export async function loadConfig(): Promise<LLMConfig | null> {
  const persisted = await loadPersistedConfig();
  if (persisted?.llm) {
    removeLegacyPublicConfig();
    return { ...persisted.llm, apiKey: '' };
  }

  // One-way migration only. The renderer cache is never a runtime fallback:
  // return the value only after the authoritative Electron store confirms it.
  const legacy = readLegacyPublicConfig();
  if (legacy) {
    try {
      await savePersistedConfig({ llm: legacy });
      removeLegacyPublicConfig();
      return { ...legacy, apiKey: '' };
    } catch {
      return null;
    }
  }
  return null;
}

export async function saveConfig(
  config: LLMConfig,
  imageGenConfig?: import('./imageGenClient').ImageGenConfig | null,
  options: {
    credentialStorage?: CredentialStorageMode;
    testReceipt?: string;
  } = {},
): Promise<void> {
  const publicConfig = sanitizeLLMConfig(config);
  if (!publicConfig) throw new TypeError('LLM configuration metadata is invalid');
  const publicImageConfig = imageGenConfig ? sanitizeImageGenConfig(imageGenConfig) : null;
  if (imageGenConfig) {
    throw new Error('图片生成配置权威通道尚未启用');
  }

  const persisted: import('./configPersistence').PersistedConfig = {
    llm: publicConfig,
  };
  if (publicImageConfig) {
    persisted.imageGen = publicImageConfig;
  }

  const credentialStorage = options.credentialStorage ?? 'persistent';
  const credential = {
    apiKey: config.apiKey.trim(),
    customHeaders: config.customHeaders?.trim(),
    ...(config.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(config.clearCustomHeaders === true ? { clearCustomHeaders: true } : {}),
  };
  const api = globalThis.window?.electronAPI?.providerConfig;
  if (!api?.commit) {
    throw new CredentialWriteError(
      '供应商设置权威通道不可用，配置和密钥均未提交。',
      'REVERIE_DESKTOP_CONFIG_UNAVAILABLE',
      false,
    );
  }
  if (!options.testReceipt) {
    throw new ProviderTestError(
      '请先测试当前 API 设置；只有测试成功且输入未变化时才能保存。',
      'REVERIE_PROVIDER_TEST_REQUIRED',
    );
  }
  const result = await api.commit(
    persisted,
    credential,
    credentialStorage,
    options.testReceipt,
  );
  const status = result.status;
  if (status.writeError) {
    throw new CredentialWriteError(
      status.writeError.message,
      status.writeError.code,
      credentialStorage === 'persistent',
    );
  }
  const hasSubmittedCredential = Boolean(credential.apiKey || credential.customHeaders);
  const confirmed = Boolean(status.llm.hasApiKey || status.llm.hasCustomHeaders);
  if (hasSubmittedCredential && (
    !status.available
    || status.corrupted
    || !confirmed
    || status.bindingMismatch?.llm === true
  )) {
    throw new CredentialWriteError(
      credentialStorage === 'session'
        ? '会话内凭据未与当前供应商端点完成绑定。'
        : 'Windows 安全凭据未与当前供应商端点完成绑定；不会发送旧密钥。',
      status.lastErrorCode || 'REVERIE_CREDENTIAL_WRITE_UNCONFIRMED',
      credentialStorage === 'persistent',
    );
  }
  removeLegacyPublicConfig();
}

export async function testConfig(config: LLMConfig): Promise<ProviderTestReceipt> {
  const publicConfig = sanitizeLLMConfig(config);
  if (!publicConfig) throw new TypeError('LLM configuration metadata is invalid');
  const api = globalThis.window?.electronAPI?.providerConfig;
  if (!api?.test) {
    throw new ProviderTestError(
      '供应商测试权威通道不可用，请完全退出并重新启动 Reverie。',
      'REVERIE_DESKTOP_CONFIG_UNAVAILABLE',
    );
  }
  const result = await api.test({
    llm: publicConfig,
  }, {
    apiKey: config.apiKey.trim(),
    customHeaders: config.customHeaders?.trim(),
    ...(config.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(config.clearCustomHeaders === true ? { clearCustomHeaders: true } : {}),
  });
  if (!result.ok) {
    throw new ProviderTestError(result.message, result.code, result.retryable === true);
  }
  return {
    receipt: result.receipt,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}

export async function clearConfigCredentials(): Promise<void> {
  const api = globalThis.window?.electronAPI?.credentials;
  if (!api?.clear) {
    throw new Error('Secure operating-system credential storage is unavailable');
  }
  await api.clear();
}

export function loadConfigSync(): LLMConfig | null {
  // Authoritative desktop metadata is asynchronous by design. Keeping this
  // compatibility function fail-closed prevents old views from reviving a
  // browser cache as a second source of truth.
  return null;
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
