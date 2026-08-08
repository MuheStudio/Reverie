'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STORAGE_KEY_SCHEMA = 'reverie.storage-key.v1';
const STORAGE_KEY_BYTES = 32;
const MAX_VAULT_BYTES = 64 * 1024;

function storageKeyError(message, code = 'REVERIE_STORAGE_KEY_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

class StorageKeyVault {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('StorageKeyVault requires storageDir');
    if (!options.safeStorage) throw new TypeError('StorageKeyVault requires safeStorage');
    this.storageDir = path.resolve(options.storageDir);
    this.vaultPath = path.join(this.storageDir, 'database-key.vault');
    this.safeStorage = options.safeStorage;
    this.fs = options.fs || fs;
  }

  _requireEncryption() {
    let available = false;
    try {
      available = this.safeStorage.isEncryptionAvailable() === true;
    } catch {}
    if (!available) {
      throw storageKeyError(
        'Windows user-bound encryption is unavailable; database startup was refused',
      );
    }
  }

  _ensureSafeStorageDirectory() {
    this.fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    let stat;
    try {
      stat = this.fs.lstatSync(this.storageDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
      if (normalizedPath(this.fs.realpathSync(this.storageDir))
        !== normalizedPath(this.storageDir)) {
        throw new Error('redirected directory');
      }
    } catch {
      throw storageKeyError(
        'The database key directory is unsafe',
        'REVERIE_STORAGE_KEY_IO',
      );
    }
  }

  _decode(encrypted) {
    let value;
    try {
      value = JSON.parse(this.safeStorage.decryptString(encrypted));
    } catch {
      throw storageKeyError(
        'The encrypted database key is corrupt or belongs to another Windows user',
        'REVERIE_STORAGE_KEY_CORRUPT',
      );
    }
    if (value?.schema !== STORAGE_KEY_SCHEMA
      || typeof value.keyHex !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.keyHex)) {
      throw storageKeyError(
        'The encrypted database key has an invalid schema',
        'REVERIE_STORAGE_KEY_CORRUPT',
      );
    }
    return Buffer.from(value.keyHex, 'hex');
  }

  _readExisting() {
    let stat;
    try {
      stat = this.fs.lstatSync(this.vaultPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw storageKeyError('The database key could not be inspected', 'REVERIE_STORAGE_KEY_IO');
    }
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.size < 1 || stat.size > MAX_VAULT_BYTES) {
      throw storageKeyError('The database key vault is unsafe', 'REVERIE_STORAGE_KEY_IO');
    }
    try {
      if (normalizedPath(this.fs.realpathSync(this.vaultPath))
        !== normalizedPath(this.vaultPath)) {
        throw new Error('redirected file');
      }
      return this._decode(this.fs.readFileSync(this.vaultPath));
    } catch (error) {
      if (String(error?.code || '').startsWith('REVERIE_')) throw error;
      throw storageKeyError('The database key could not be read', 'REVERIE_STORAGE_KEY_IO');
    }
  }

  _commit(key) {
    const plaintext = JSON.stringify({
      schema: STORAGE_KEY_SCHEMA,
      keyHex: key.toString('hex'),
    });
    let encrypted;
    try {
      encrypted = this.safeStorage.encryptString(plaintext);
      if (!Buffer.isBuffer(encrypted) || encrypted.length < 1
        || encrypted.length > MAX_VAULT_BYTES) {
        throw new Error('invalid ciphertext');
      }
      const verified = this._decode(encrypted);
      const matches = crypto.timingSafeEqual(verified, key);
      verified.fill(0);
      if (!matches) throw new Error('round-trip mismatch');
    } catch {
      throw storageKeyError(
        'Windows could not safely encrypt the database key',
        'REVERIE_STORAGE_KEY_ENCRYPT_FAILED',
      );
    }

    const nonce = crypto.randomBytes(12).toString('hex');
    const temporary = path.join(this.storageDir, `.database-key.${process.pid}.${nonce}.tmp`);
    let descriptor;
    let linked = false;
    try {
      descriptor = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(descriptor, encrypted);
      this.fs.fsyncSync(descriptor);
      this.fs.closeSync(descriptor);
      descriptor = undefined;
      // First creation only: an existing vault is never silently replaced.
      this.fs.linkSync(temporary, this.vaultPath);
      linked = true;
      this.fs.unlinkSync(temporary);
      const committed = this._readExisting();
      const matches = committed && crypto.timingSafeEqual(committed, key);
      committed?.fill(0);
      if (!matches) throw new Error('committed key mismatch');
    } catch (error) {
      if (descriptor !== undefined) {
        try { this.fs.closeSync(descriptor); } catch {}
      }
      try { this.fs.unlinkSync(temporary); } catch {}
      if (linked) {
        try { this.fs.unlinkSync(this.vaultPath); } catch {}
      }
      if (error?.code === 'EEXIST') {
        throw storageKeyError(
          'The database key was created concurrently; startup must retry',
          'REVERIE_STORAGE_KEY_RACE',
        );
      }
      if (String(error?.code || '').startsWith('REVERIE_')) throw error;
      throw storageKeyError('The database key could not be committed', 'REVERIE_STORAGE_KEY_IO');
    } finally {
      encrypted.fill(0);
    }
  }

  /**
   * Return a fresh main-process-only copy. The caller must zero it after
   * writing the one-shot child bootstrap pipe.
   */
  getOrCreateKey() {
    this._requireEncryption();
    this._ensureSafeStorageDirectory();
    const existing = this._readExisting();
    if (existing) return existing;
    const created = crypto.randomBytes(STORAGE_KEY_BYTES);
    try {
      this._commit(created);
      return Buffer.from(created);
    } finally {
      created.fill(0);
    }
  }
}

module.exports = {
  MAX_VAULT_BYTES,
  STORAGE_KEY_BYTES,
  STORAGE_KEY_SCHEMA,
  StorageKeyVault,
};
