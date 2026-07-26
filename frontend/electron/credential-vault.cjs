'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAULT_SCHEMA = 'reverie.credential-vault.v2';
const LEGACY_VAULT_SCHEMA = 'reverie.credential-vault.v1';
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

function normalizeBinding(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError('credential binding is invalid');
  }
  return value.toLowerCase();
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
    this.sessionCredentials = this._empty().credentials;
    this.sessionBindings = this._empty().bindings;
    this.lastErrorCode = '';
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
      bindings: {
        llm: null,
        imageGen: null,
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
      if (![VAULT_SCHEMA, LEGACY_VAULT_SCHEMA].includes(value?.schema) || !value.credentials
        || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) {
        throw new Error('invalid schema');
      }
      const result = this._empty();
      for (const scope of SCOPES) {
        result.credentials[scope] = normalizeSecretRecord(value.credentials[scope] || {});
        result.bindings[scope] = value.schema === VAULT_SCHEMA
          ? normalizeBinding(value.bindings?.[scope])
          : null;
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
    let encrypted;
    try {
      encrypted = this.safeStorage.encryptString(plaintext);
    } catch (error) {
      this.lastErrorCode = 'REVERIE_OS_ENCRYPTION_FAILED';
      throw vaultError(
        'Windows could not encrypt the credential; the previous credential was preserved',
        'REVERIE_OS_ENCRYPTION_FAILED',
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1) {
      this.lastErrorCode = 'REVERIE_OS_ENCRYPTION_FAILED';
      throw vaultError(
        'Operating-system encryption returned no ciphertext',
        'REVERIE_OS_ENCRYPTION_FAILED',
      );
    }
    try {
      const verified = JSON.parse(this.safeStorage.decryptString(encrypted));
      if (verified?.schema !== VAULT_SCHEMA) throw new Error('schema mismatch');
    } catch {
      this.lastErrorCode = 'REVERIE_OS_ENCRYPTION_VERIFY_FAILED';
      throw vaultError(
        'Windows encrypted credential verification failed; nothing was replaced',
        'REVERIE_OS_ENCRYPTION_VERIFY_FAILED',
      );
    }
    this.fs.mkdirSync(this.storageDir, { recursive: true });
    const temporary = path.join(
      this.storageDir,
      `.credentials.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    const backup = path.join(
      this.storageDir,
      `.credentials.${process.pid}.${crypto.randomBytes(12).toString('hex')}.backup`,
    );
    let fd;
    let previousMoved = false;
    try {
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, encrypted);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      if (this.fs.existsSync(this.vaultPath)) {
        this.fs.renameSync(this.vaultPath, backup);
        previousMoved = true;
      }
      this.fs.renameSync(temporary, this.vaultPath);
      try {
        const committed = this.fs.readFileSync(this.vaultPath);
        const verified = JSON.parse(this.safeStorage.decryptString(committed));
        if (verified?.schema !== VAULT_SCHEMA) throw new Error('schema mismatch');
      } catch {
        throw vaultError(
          'Committed credential verification failed',
          'REVERIE_OS_ENCRYPTION_VERIFY_FAILED',
        );
      }
      if (previousMoved) this.fs.unlinkSync(backup);
      this.corrupted = false;
      this.lastErrorCode = '';
    } catch (error) {
      if (fd !== undefined) {
        try { this.fs.closeSync(fd); } catch {}
      }
      try { this.fs.unlinkSync(temporary); } catch {}
      if (previousMoved) {
        try { this.fs.unlinkSync(this.vaultPath); } catch {}
        try { this.fs.renameSync(backup, this.vaultPath); } catch {}
      }
      if (String(error?.code || '').startsWith('REVERIE_')) throw error;
      this.lastErrorCode = 'REVERIE_VAULT_IO';
      throw vaultError('The encrypted credential vault could not be committed', 'REVERIE_VAULT_IO');
    }
  }

  set(scope, value, options = {}) {
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
    if ('binding' in options) {
      vault.bindings[scope] = normalizeBinding(options.binding);
    }
    this._write(vault);
    return this.status();
  }

  setSession(scope, value, options = {}) {
    validateScope(scope);
    const normalized = normalizeSecretRecord(value);
    if (Object.keys(normalized).length === 0) {
      throw new TypeError('at least one credential value is required');
    }
    this.sessionCredentials[scope] = {
      ...this.sessionCredentials[scope],
      ...normalized,
    };
    if ('binding' in options) {
      this.sessionBindings[scope] = normalizeBinding(options.binding);
    }
    return this.status();
  }

  /**
   * Main-process-only rollback material for a multi-store provider commit.
   * The returned secret record must never cross IPC.
   */
  snapshotScope(scope) {
    validateScope(scope);
    let persistent = null;
    if (this.isAvailable()) {
      const vault = this._read();
      persistent = {
        credential: { ...vault.credentials[scope] },
        binding: vault.bindings[scope],
      };
    }
    return {
      persistent,
      sessionCredential: { ...this.sessionCredentials[scope] },
      sessionBinding: this.sessionBindings[scope],
    };
  }

  restoreScope(scope, snapshot) {
    validateScope(scope);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('credential rollback snapshot is invalid');
    }
    this.sessionCredentials[scope] = normalizeSecretRecord(
      snapshot.sessionCredential || {},
    );
    this.sessionBindings[scope] = normalizeBinding(snapshot.sessionBinding);
    if (snapshot.persistent) {
      const vault = this._read();
      vault.credentials[scope] = normalizeSecretRecord(
        snapshot.persistent.credential || {},
      );
      vault.bindings[scope] = normalizeBinding(snapshot.persistent.binding);
      this._write(vault);
    }
    return this.status();
  }

  clear(scope) {
    validateScope(scope);
    this.sessionCredentials[scope] = {};
    this.sessionBindings[scope] = null;
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
    vault.bindings[scope] = null;
    this._write(vault);
    return { ...this.status(), recoveredCorruptVault };
  }

  /**
   * Main-process-only runtime material. Never expose this return value through
   * contextBridge or IPC responses.
   */
  readForRuntime(options = {}) {
    let vault = this._empty();
    try {
      vault = this._read();
    } catch (error) {
      if (!Object.values(this.sessionCredentials).some(
        (record) => Object.keys(record).length > 0,
      )) throw error;
    }
    const result = {};
    for (const scope of SCOPES) {
      const expectedBinding = normalizeBinding(options.bindings?.[scope]);
      const persistentMatches = !expectedBinding
        || vault.bindings[scope] === expectedBinding;
      const sessionMatches = !expectedBinding
        || this.sessionBindings[scope] === expectedBinding;
      const merged = {
        ...(persistentMatches ? vault.credentials[scope] : {}),
        ...(sessionMatches ? this.sessionCredentials[scope] : {}),
      };
      if (Object.keys(merged).length > 0) {
        result[scope] = merged;
      }
    }
    return result;
  }

  status() {
    const persistentAvailable = this.isAvailable();
    if (!persistentAvailable) {
      const sessionScope = (scope) => ({
        hasApiKey: Boolean(this.sessionCredentials[scope]?.apiKey),
        hasCustomHeaders: Boolean(this.sessionCredentials[scope]?.customHeaders),
        sessionOnly: Object.keys(this.sessionCredentials[scope] || {}).length > 0,
        bindingKnown: Boolean(this.sessionBindings[scope]),
      });
      return {
        available: Object.values(this.sessionCredentials).some(
          (record) => Object.keys(record).length > 0,
        ),
        persistentAvailable: false,
        corrupted: this.corrupted,
        lastErrorCode: this.lastErrorCode || 'REVERIE_SECURE_STORAGE_UNAVAILABLE',
        llm: sessionScope('llm'),
        imageGen: sessionScope('imageGen'),
      };
    }
    let vault;
    try {
      vault = this._read();
    } catch (error) {
      this.lastErrorCode = String(error?.code || 'REVERIE_VAULT_IO');
      const sessionScope = (scope) => ({
        hasApiKey: Boolean(this.sessionCredentials[scope]?.apiKey),
        hasCustomHeaders: Boolean(this.sessionCredentials[scope]?.customHeaders),
        sessionOnly: Object.keys(this.sessionCredentials[scope] || {}).length > 0,
        bindingKnown: Boolean(this.sessionBindings[scope]),
      });
      return {
        available: Object.values(this.sessionCredentials).some(
          (record) => Object.keys(record).length > 0,
        ),
        persistentAvailable: true,
        corrupted: error?.code === 'REVERIE_VAULT_CORRUPT',
        lastErrorCode: this.lastErrorCode,
        llm: sessionScope('llm'),
        imageGen: sessionScope('imageGen'),
      };
    }
    const publicScope = (scope) => ({
      hasApiKey: Boolean(
        this.sessionCredentials[scope]?.apiKey || vault.credentials[scope]?.apiKey,
      ),
      hasCustomHeaders: Boolean(
        this.sessionCredentials[scope]?.customHeaders || vault.credentials[scope]?.customHeaders,
      ),
      sessionOnly: Object.keys(this.sessionCredentials[scope] || {}).length > 0,
      bindingKnown: Boolean(this.sessionBindings[scope] || vault.bindings[scope]),
    });
    return {
      available: true,
      persistentAvailable: true,
      corrupted: false,
      lastErrorCode: this.lastErrorCode,
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
  LEGACY_VAULT_SCHEMA,
  normalizeBinding,
  normalizeSecretRecord,
  validateScope,
};
