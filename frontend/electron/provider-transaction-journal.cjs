'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  normalizeProviderConfig,
  normalizeRecoveryProviderConfig,
} = require('./provider-config-store.cjs');

const SCHEMA = 'reverie.provider-transaction.v1';

class ProviderTransactionJournal {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('ProviderTransactionJournal requires storageDir');
    this.fs = options.fs || fs;
    this.storageDir = path.resolve(options.storageDir);
    this.filePath = path.join(this.storageDir, 'pending.json');
  }

  write(value) {
    const record = this._normalize(value);
    this.fs.mkdirSync(this.storageDir, { recursive: true });
    const temporary = path.join(
      this.storageDir,
      `.pending.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    let fd;
    try {
      fd = this.fs.openSync(temporary, 'wx', 0o600);
      this.fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = undefined;
      this.fs.renameSync(temporary, this.filePath);
    } finally {
      if (fd !== undefined) try { this.fs.closeSync(fd); } catch {}
      try { this.fs.unlinkSync(temporary); } catch {}
    }
    return record;
  }

  read() {
    try {
      const stat = this.fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
        throw new Error('unsafe provider transaction journal');
      }
      return this._normalize(JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      const wrapped = new Error('Provider transaction recovery journal is corrupt');
      wrapped.code = 'REVERIE_PROVIDER_TRANSACTION_CORRUPT';
      throw wrapped;
    }
  }

  clear() {
    try { this.fs.unlinkSync(this.filePath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  _normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== SCHEMA
      || !/^[a-f0-9-]{36}$/i.test(String(value.id || ''))
      || value.phase !== 'prepared'
      || !['preserve', 'replace', 'clear'].includes(value.credentialAction)) {
      throw new TypeError('provider transaction journal is invalid');
    }
    return {
      schema: SCHEMA,
      id: String(value.id).toLowerCase(),
      phase: value.phase,
      credentialAction: value.credentialAction,
      credentialTransactionId: normalizeTransactionId(value.credentialTransactionId),
      newBinding: normalizeBinding(value.newBinding),
      oldConfig: normalizeRecoveryProviderConfig(value.oldConfig),
      newConfig: normalizeProviderConfig(value.newConfig),
    };
  }
}

function isFactoryProviderConfig(value) {
  try {
    const llm = normalizeRecoveryProviderConfig(value).llm;
    return llm.provider === 'ollama' && llm.model === '';
  } catch {
    return false;
  }
}

function recoveryAction(transaction, currentConfig, snapshot) {
  const current = normalizeRecoveryProviderConfig(currentConfig);
  if (sameConnection(current, transaction.oldConfig)) return 'discard';
  if (!sameConnection(current, transaction.newConfig)) {
    // The live config moved on after this journal entry was written, so the
    // entry is stale. Writing transaction.oldConfig back here used to
    // overwrite NEWER user state — observed in the field as a saved API key
    // "degrading" to the factory ollama default. Keep the current config and
    // just drop the journal. The only rollback still justified: the live
    // config is the factory default while the journal recorded a real user
    // config, i.e. the settings file was reset underneath us.
    if (isFactoryProviderConfig(current) && !isFactoryProviderConfig(transaction.oldConfig)) {
      return 'rollback';
    }
    return 'discard';
  }
  if (transaction.credentialAction === 'preserve') return 'complete';
  // The destination already committed; a credential transaction that never
  // landed must NOT roll the destination back. Keeping the new config and
  // surfacing the missing key is the honest recovery — the renderer shows the
  // unconfigured state instead of silently resurrecting the old destination.
  if (transaction.credentialAction === 'replace') return 'complete';
  // 'clear' shares its connection with the old config, so a half-completed
  // clear never justifies moving the destination back either.
  return 'complete';
}

function normalizeTransactionId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw new TypeError('provider transaction credential ID is invalid');
  }
  return value.toLowerCase();
}

function sameConnection(left, right) {
  const first = normalizeRecoveryProviderConfig(left).llm;
  const second = normalizeRecoveryProviderConfig(right).llm;
  return first.provider === second.provider
    && first.baseUrl === second.baseUrl
    && first.model === second.model;
}

function normalizeBinding(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new TypeError('provider transaction binding is invalid');
  }
  return value.toLowerCase();
}

module.exports = { ProviderTransactionJournal, SCHEMA, recoveryAction };
