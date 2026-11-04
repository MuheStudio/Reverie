'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ⚠️ Electron safeStorage sync APIs (encryptString/decryptString) are slated
// for removal in a future major (electron/electron#53662). Still supported on
// Electron 42; migrate to encryptStringAsync/decryptStringAsync together with
// credential-vault.cjs at the next Electron upgrade (see P2-3 in
// 对抗式审查与修复计划-2026-09-09.md).
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
    this.platform = options.platform || process.platform;
    this.existingDataDir = this.platform === 'darwin' && options.existingDataDir
      ? path.resolve(options.existingDataDir) : null;
    this.fs = options.fs || fs;
  }

  _requireEncryption() {
    let available = false;
    try {
      available = this.safeStorage.isEncryptionAvailable() === true;
    } catch {}
    if (!available) {
      throw storageKeyError(
        this.platform === 'darwin'
          ? 'macOS Keychain encryption is unavailable; database startup was refused'
          : 'Windows user-bound encryption is unavailable; database startup was refused',
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
        this.platform === 'darwin'
          ? 'The encrypted database key could not be decrypted with macOS Keychain'
          : 'The encrypted database key is corrupt or belongs to another Windows user',
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

  _assertNoDatabaseBeforeNewKey() {
    if (!this.existingDataDir) return;
    const pending = [this.existingDataDir];
    try {
      const rootStat = this.fs.lstatSync(this.existingDataDir);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe data directory');
      while (pending.length) {
        const current = pending.pop();
        const stat = this.fs.lstatSync(current);
        if (stat.isSymbolicLink() || normalizedPath(this.fs.realpathSync(current)) !== normalizedPath(current)) {
          throw new Error('redirected data path');
        }
        if (stat.isDirectory()) {
          this.fs.accessSync(current, fs.constants.R_OK | fs.constants.X_OK);
          for (const name of this.fs.readdirSync(current)) pending.push(path.join(current, name));
        } else if (stat.isFile()) {
          // Sidecars and backup suffixes are evidence of an existing database
          // even if the main file is absent or empty. Never mint a replacement
          // identity over such data merely because the vault was deleted.
          if (/\.(?:db|sqlite|sqlite3)(?:[-.].*)?$/i.test(path.basename(current))) {
            throw storageKeyError(
              'The database key is missing while existing database data remains; startup was refused',
              'REVERIE_STORAGE_KEY_MISSING',
            );
          }
        } else throw new Error('unsupported data file type');
      }
    } catch (error) {
      if (error?.code === 'REVERIE_STORAGE_KEY_MISSING') throw error;
      throw storageKeyError(
        'Existing data could not be safely checked before creating a database key',
        'REVERIE_STORAGE_KEY_IO',
      );
    }
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
        this.platform === 'darwin'
          ? 'macOS Keychain could not safely encrypt the database key'
          : 'Windows could not safely encrypt the database key',
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
    this._assertNoDatabaseBeforeNewKey();
    const created = crypto.randomBytes(STORAGE_KEY_BYTES);
    try {
      this._commit(created);
      return Buffer.from(created);
    } finally {
      created.fill(0);
    }
  }

  /**
   * Explicit destructive escape hatch — the counterpart of CredentialVault
   * clear(). This is the only operation allowed to move a vault that can no
   * longer be decrypted, and it must only run after the user has been warned
   * that the existing encrypted database will become permanently unreadable.
   * The old vault file is renamed aside (never silently deleted) so the
   * original ciphertext stays on disk; the next getOrCreateKey() creates a
   * fresh key.
   */
  reset({ reason = 'user_requested' } = {}) {
    this._ensureSafeStorageDirectory();
    let recoveredCorruptVault = false;
    try {
      const existing = this._readExisting();
      if (existing) existing.fill(0);
    } catch (error) {
      const code = String(error?.code || '');
      if (code !== 'REVERIE_STORAGE_KEY_CORRUPT' && code !== 'REVERIE_STORAGE_KEY_IO') {
        throw error;
      }
      recoveredCorruptVault = true;
    }
    const nonce = crypto.randomBytes(6).toString('hex');
    const supersededPath = path.join(
      this.storageDir,
      `.database-key.superseded.${Date.now()}.${nonce}`,
    );
    try {
      const stat = this.fs.lstatSync(this.vaultPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw storageKeyError('The database key vault is unsafe', 'REVERIE_STORAGE_KEY_IO');
      }
      if (normalizedPath(this.fs.realpathSync(this.vaultPath)) !== normalizedPath(this.vaultPath)) {
        throw storageKeyError('The database key vault is unsafe', 'REVERIE_STORAGE_KEY_IO');
      }
      this.fs.renameSync(this.vaultPath, supersededPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { reset: true, recoveredCorruptVault, supersededPath: null, reason };
      }
      if (String(error?.code || '').startsWith('REVERIE_')) throw error;
      throw storageKeyError('The database key vault could not be reset', 'REVERIE_STORAGE_KEY_IO');
    }
    return { reset: true, recoveredCorruptVault, supersededPath, reason };
  }
}

module.exports = {
  MAX_VAULT_BYTES,
  STORAGE_KEY_BYTES,
  STORAGE_KEY_SCHEMA,
  StorageKeyVault,
};
