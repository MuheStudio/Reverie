/**
 * Model identifiers remain editable: providers can change availability without
 * requiring a Reverie release.
 */
export type LLMProvider =
  | 'openai' | 'anthropic' | 'gemini' | 'grok' | 'deepseek' | 'kimi' | 'glm'
  | 'ollama' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders?: string;
  customProviderName?: string;
}

export interface ProviderModelConfig {
  displayName: string;
  baseUrl: string;
  defaultModel: string;
}

export const LLM_PROVIDER_CONFIGS: Record<LLMProvider, ProviderModelConfig> = {
  openai: {
    displayName: 'ChatGPT（OpenAI）',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
  },
  anthropic: {
    displayName: 'Claude（Anthropic）',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
  },
  gemini: {
    displayName: 'Gemini（Google）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  grok: {
    displayName: 'Grok（xAI）',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
  },
  deepseek: {
    displayName: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
  },
  kimi: {
    displayName: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.7-code',
  },
  glm: {
    displayName: 'Z.AI（GLM）',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.2',
  },
  ollama: {
    displayName: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
  },
  custom: {
    displayName: 'OpenAI 兼容接口（BYOK）',
    baseUrl: '',
    defaultModel: '',
  },
};

export function getDefaultProviderConfig(provider: LLMProvider): Omit<LLMConfig, 'apiKey'> {
  const config = LLM_PROVIDER_CONFIGS[provider];
  return {
    provider,
    baseUrl: config.baseUrl,
    model: config.defaultModel,
  };
}

export function getProviderDisplayName(provider: LLMProvider): string {
  return LLM_PROVIDER_CONFIGS[provider].displayName;
}
