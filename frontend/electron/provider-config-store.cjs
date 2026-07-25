'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'reverie.provider-config.v1';
const LLM_PROVIDERS = new Set([
  'openai', 'custom', 'anthropic', 'gemini', 'grok', 'deepseek', 'kimi',
  'z.ai', 'ollama', 'llama.cpp', 'minimax', 'openrouter',
]);
const IMAGE_PROVIDERS = new Set(['openai', 'gemini']);

function text(value, label, max = 2048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || value.includes('\u0000')) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function providerUrl(value, label) {
  const raw = text(value, label);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${label} is invalid`); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(`${label} must be an HTTP(S) origin/path without credentials, query, or fragment`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provider config must be an object');
  }
  const llm = value.llm;
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)
    || !LLM_PROVIDERS.has(llm.provider)) {
    throw new TypeError('LLM provider config is invalid');
  }
  if (Object.keys(llm).some((key) => !['provider', 'baseUrl', 'model', 'customProviderName'].includes(key))) {
    throw new TypeError('LLM provider config contains a forbidden field');
  }
  const normalized = {
    schema: SCHEMA,
    llm: {
      provider: llm.provider,
      baseUrl: providerUrl(llm.baseUrl, 'LLM base URL'),
      model: text(llm.model, 'LLM model', 512),
    },
  };
  if (llm.customProviderName) {
    normalized.llm.customProviderName = text(
      llm.customProviderName,
      'custom provider name',
      160,
    );
  }
  if (value.imageGen != null) {
    const image = value.imageGen;
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || !IMAGE_PROVIDERS.has(image.provider)
      || Object.keys(image).some((key) => !['provider', 'baseUrl', 'model'].includes(key))) {
      throw new TypeError('image provider config is invalid');
    }
    normalized.imageGen = {
      provider: image.provider,
      baseUrl: providerUrl(image.baseUrl, 'image base URL'),
      model: text(image.model, 'image model', 512),
    };
  }
  return normalized;
}

function providerBinding(scope, value) {
  const normalized = normalizeProviderConfig(value);
  const config = scope === 'llm' ? normalized.llm : normalized.imageGen;
  if (!config) throw new TypeError(`${scope} provider config is unavailable`);
  const provider = {
    'z.ai': 'glm',
    zai: 'glm',
    claude: 'anthropic',
  }[config.provider] || config.provider;
  return crypto.createHash('sha256').update(
    `${scope}\0${provider}\0${config.baseUrl}`,
    'utf8',
  ).digest('hex');
}

class ProviderConfigStore {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('ProviderConfigStore requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.configPath = path.join(this.storageDir, 'providers.json');
  }

  get() {
    try {
      const stat = fs.lstatSync(this.configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
        throw new Error('invalid provider config file');
      }
      const value = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (value?.schema !== SCHEMA) throw new Error('invalid provider config schema');
      const normalized = normalizeProviderConfig(value);
      delete normalized.schema;
      return normalized;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      const wrapped = new Error('Provider metadata is unavailable or corrupt');
      wrapped.code = 'REVERIE_PROVIDER_CONFIG_CORRUPT';
      throw wrapped;
    }
  }

  set(value) {
    const normalized = normalizeProviderConfig(value);
    fs.mkdirSync(this.storageDir, { recursive: true });
    const temporary = path.join(
      this.storageDir,
      `.providers.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    const backup = path.join(
      this.storageDir,
      `.providers.${process.pid}.${crypto.randomBytes(12).toString('hex')}.backup`,
    );
    let fd;
    let previousMoved = false;
    let committed = false;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (fs.existsSync(this.configPath)) {
        fs.renameSync(this.configPath, backup);
        previousMoved = true;
      }
      fs.renameSync(temporary, this.configPath);
      const readBack = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (readBack?.schema !== SCHEMA) throw new Error('provider config read-back failed');
      committed = true;
      if (previousMoved) fs.unlinkSync(backup);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
      if (previousMoved && !committed) {
        try { fs.unlinkSync(this.configPath); } catch {}
        try { fs.renameSync(backup, this.configPath); } catch {}
      }
      if (committed) {
        try { fs.unlinkSync(backup); } catch {}
      }
    }
    const result = { ...normalized };
    delete result.schema;
    return result;
  }
}

module.exports = {
  LLM_PROVIDERS,
  ProviderConfigStore,
  SCHEMA,
  normalizeProviderConfig,
  providerBinding,
  providerUrl,
};
