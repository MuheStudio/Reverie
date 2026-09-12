'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'reverie.provider-config.v1';
const LLM_PROVIDERS = new Set([
  'openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'kimi', 'glm',
  'ollama', 'custom',
]);

function text(value, label, max = 2048) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || value.includes('\u0000')) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function isPrivateOrLinkLocalHostname(hostname) {
  // Loopback (localhost / 127.x / ::1) is allowed — Ollama's default
  // endpoint is http://127.0.0.1:11434. Everything else that is not a public
  // internet address is refused as a SSRF / metadata-exfiltration surface
  // (169.254.169.254 cloud metadata, RFC1918 private nets, link-local).
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.includes(':')) {
    // IPv6 literal: allow only ::1 (loopback), refuse the rest.
    return host !== '::1';
  }
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (literal === '::1') return false;
  const parts = literal.split('.').map((p) => Number(p));
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return false; // loopback allowed
    if (a === 169 && b === 254) return true; // link-local metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0 || a === 100 || a === 198 || a === 203) return true; // reserved-ish
    return false;
  }
  // Non-numeric hostname: allow; DNS rebinding is out of scope for a
  // user-typed provider endpoint on a desktop app.
  return false;
}

function providerUrl(value, label) {
  const raw = text(value, label);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${label} is invalid`); }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(`${label} must be an HTTP(S) origin/path without credentials, query, or fragment`);
  }
  if (isPrivateOrLinkLocalHostname(parsed.hostname)) {
    throw new TypeError(`${label} must point to a public or loopback address`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('provider config must be an object');
  }
  const llm = value.llm;
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) {
    throw new TypeError('LLM provider config is invalid');
  }
  if (Object.keys(llm).some((key) => !['provider', 'baseUrl', 'model', 'customProviderName'].includes(key))) {
    throw new TypeError('LLM provider config contains a forbidden field');
  }
  if (!LLM_PROVIDERS.has(llm.provider)) {
    throw new TypeError('LLM provider config is invalid');
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
  if (Object.keys(value).some((key) => !['schema', 'llm'].includes(key))) {
    throw new TypeError('provider config contains a non-MVP section');
  }
  return normalized;
}

function normalizeRecoveryProviderConfig(value) {
  try {
    return normalizeProviderConfig(value);
  } catch (error) {
    if (value?.llm?.provider !== 'ollama' || value?.llm?.model !== '') throw error;
    const normalized = normalizeProviderConfig({
      ...value,
      llm: { ...value.llm, model: '__unconfigured_ollama__' },
    });
    normalized.llm.model = '';
    return normalized;
  }
}

function providerBinding(scope, value) {
  if (scope !== 'llm') throw new TypeError('only the LLM credential scope is supported');
  // The recovery variant tolerates the shipped unconfigured default
  // (ollama + empty model); the binding hash only covers provider + baseUrl,
  // so the substituted placeholder model cannot change the hash.
  const normalized = normalizeRecoveryProviderConfig(value);
  const config = normalized.llm;
  const provider = config.provider;
  return crypto.createHash('sha256').update(
    `${scope}\0${provider}\0${config.baseUrl}`,
    'utf8',
  ).digest('hex');
}

function sameLlmConnection(left, right) {
  const first = normalizeProviderConfig(left).llm;
  const second = normalizeProviderConfig(right).llm;
  return first.provider === second.provider
    && first.baseUrl === second.baseUrl
    && first.model === second.model;
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
  normalizeRecoveryProviderConfig,
  providerBinding,
  providerUrl,
  sameLlmConnection,
};
