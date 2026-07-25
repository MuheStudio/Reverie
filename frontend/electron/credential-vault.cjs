'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_SCHEMA = 'reverie.credential-vault.v1';
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_VAULT_BYTES = 256 * 1024;
const SCOPES = new Set(['llm', 'imageGen']);

function vaultError(message, code = 'REVERIE_SECURE_STORAGE_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSecretRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('credential value must be an object');
  }
  const normalized = {};
  for (const field of ['apiKey', 'customHeaders']) {
    const raw = value[field];
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > MAX_SECRET_LENGTH
      || raw.includes('\u0000') || /[\r\n]/.test(raw) && field === 'apiKey') {
      throw new TypeError(`${field} is invalid`);
    }
    if (field === 'customHeaders') {
      const lines = raw.split(/\r?\n/);
      if (lines.length > 32 || lines.some((line) => {
        const separator = line.indexOf(':');
        const name = separator < 0 ? '' : line.slice(0, separator);
        const headerValue = separator < 0 ? '' : line.slice(separator + 1).trim();
        return !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)
          || !headerValue || headerValue.length > 4096
          || /[\r\n\u0000]/.test(headerValue);
      })) {
        throw new TypeError('customHeaders is invalid');
      }
    }
    normalized[field] = raw;
  }
  return normalized;
}

function validateScope(scope) {
  if (!SCOPES.has(scope)) throw new TypeError('credential scope is invalid');
  return scope;
}

class CredentialVault {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('CredentialVault requires storageDir');
    if (!options.safeStorage) throw new TypeError('CredentialVault requires safeStorage');
    this.storageDir = path.resolve(options.storageDir);
    this.vaultPath = path.join(this.storageDir, 'credentials.vault');
    this.safeStorage = options.safeStorage;
    this.fs = options.fs || fs;
    this.corrupted = false;
  }

  isAvailable() {
    try {
      return this.safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  _requireAvailable() {
    if (!this.isAvailable()) {
      throw vaultError(
        'Operating-system credential encryption is unavailable; credentials were not stored',
      );
    }
  }

  _empty() {
    return {
      schema: VAULT_SCHEMA,
      credentials: {
        llm: {},
        imageGen: {},
      },
    };
  }

  _read() {
    this._requireAvailable();
    let encrypted;
    try {
      const stat = this.fs.lstatSync(this.vaultPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_VAULT_BYTES) {
        throw vaultError('The encrypted credential vault is not a safe regular file', 'REVERIE_VAULT_IO');
      }
      const resolved = this.fs.realpathSync(this.vaultPath);
      const normalize = (value) => process.platform === 'win32'
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
      if (normalize(resolved) !== normalize(this.vaultPath)) {
        throw vaultError('The encrypted credential vault path is unsafe', 'REVERIE_VAULT_IO');
      }
      encrypted = this.fs.readFileSync(this.vaultPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.corrupted = false;
        return this._empty();
      }
      throw vaultError('The encrypted credential vault could not be read', 'REVERIE_VAULT_IO');
    }
    try {
      const plaintext = this.safeStorage.decryptString(encrypted);
      const value = JSON.parse(plaintext);
      if (value?.schema !== VAULT_SCHEMA || !value.credentials
        || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) {
        throw new Error('invalid schema');
      }
      const result = this._empty();
      for (const scope of SCOPES) {
        result.credentials[scope] = normalizeSecretRecord(value.credentials[scope] || {});
      }
      this.corrupted = false;
      return result;
    } catch {
      this.corrupted = true;
      throw vaultError(
        'The encrypted credential vault is corrupt or belongs to another OS account',
        'REVERIE_VAULT_CORRUPT',
      );
    }
  }

  _write(value) {
    this._requireAvailable();
    const plaintext = JSON.stringify(value);
    const encrypted = this.safeStorage.encryptString(plaintext);
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1) {
      throw vaultError('Operating-system encryption returned no ciphertext');
    }
    this.fs.mkdirSync(this.storageDir, { recursive: true });
    const temporary = path.join(
      this.storageDir,
      `.credentials.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    let fd;
    try {
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, encrypted);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporary, this.vaultPath);
      this.corrupted = false;
    } catch (error) {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
      try { this.fs.unlinkSync(temporary); } catch {}
      if (String(error?.code || '').startsWith('REVERIE_')) throw error;
      throw vaultError('The encrypted credential vault could not be committed', 'REVERIE_VAULT_IO');
    }
  }

  set(scope, value) {
    validateScope(scope);
    const normalized = normalizeSecretRecord(value);
    if (Object.keys(normalized).length === 0) {
      throw new TypeError('at least one credential value is required');
    }
    const vault = this._read();
    vault.credentials[scope] = {
      ...vault.credentials[scope],
      ...normalized,
    };
    this._write(vault);
    return this.status();
  }

  clear(scope) {
    validateScope(scope);
    let vault;
    let recoveredCorruptVault = false;
    try {
      vault = this._read();
    } catch (error) {
      if (error?.code !== 'REVERIE_VAULT_CORRUPT') throw error;
      // Clearing is an explicit destructive credential action. It is the only
      // operation allowed to recover a vault that can no longer be decrypted.
      vault = this._empty();
      recoveredCorruptVault = true;
    }
    vault.credentials[scope] = {};
    this._write(vault);
    return { ...this.status(), recoveredCorruptVault };
  }

  /**
   * Main-process-only runtime material. Never expose this return value through
   * contextBridge or IPC responses.
   */
  readForRuntime() {
    const vault = this._read();
    const result = {};
    for (const scope of SCOPES) {
      if (Object.keys(vault.credentials[scope]).length > 0) {
        result[scope] = { ...vault.credentials[scope] };
      }
    }
    return result;
  }

  status() {
    const available = this.isAvailable();
    if (!available) {
      return {
        available: false,
        corrupted: this.corrupted,
        llm: { hasApiKey: false, hasCustomHeaders: false },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
      };
    }
    let credentials;
    try {
      credentials = this._read().credentials;
    } catch (error) {
      if (error?.code !== 'REVERIE_VAULT_CORRUPT') throw error;
      return {
        available: true,
        corrupted: true,
        llm: { hasApiKey: false, hasCustomHeaders: false },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
      };
    }
    const publicScope = (scope) => ({
      hasApiKey: typeof credentials[scope]?.apiKey === 'string'
        && credentials[scope].apiKey.length > 0,
      hasCustomHeaders: typeof credentials[scope]?.customHeaders === 'string'
        && credentials[scope].customHeaders.length > 0,
    });
    return {
      available: true,
      corrupted: false,
      llm: publicScope('llm'),
      imageGen: publicScope('imageGen'),
    };
  }
}

module.exports = {
  CredentialVault,
  MAX_SECRET_LENGTH,
  MAX_VAULT_BYTES,
  VAULT_SCHEMA,
  normalizeSecretRecord,
  validateScope,
};
