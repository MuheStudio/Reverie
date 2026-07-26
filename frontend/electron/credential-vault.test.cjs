'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CredentialVault } = require('./credential-vault.cjs');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0xaa),
    decryptString: (value) => {
      return Buffer.from(value).map((byte) => byte ^ 0xaa).toString('utf8');
    },
  };
}

test('credential vault stores only OS-encrypted bytes and exposes status without plaintext', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  const status = vault.set('llm', {
    apiKey: 'sk-canary-never-plaintext',
    customHeaders: 'Authorization: second-canary',
  });

  assert.deepEqual(status.llm, {
    hasApiKey: true,
    hasCustomHeaders: true,
    sessionOnly: false,
    bindingKnown: false,
  });
  assert.equal(JSON.stringify(status).includes('canary'), false);
  const raw = fs.readFileSync(path.join(root, 'credentials.vault'));
  assert.equal(raw.includes(Buffer.from('sk-canary-never-plaintext')), false);
  assert.deepEqual(vault.readForRuntime().llm, {
    apiKey: 'sk-canary-never-plaintext',
    customHeaders: 'Authorization: second-canary',
  });
});

test('credential vault has no plaintext fallback when OS encryption is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage(false) });
  assert.equal(vault.status().available, false);
  assert.throws(
    () => vault.set('llm', { apiKey: 'must-not-land' }),
    (error) => error?.code === 'REVERIE_SECURE_STORAGE_UNAVAILABLE',
  );
  assert.equal(fs.existsSync(path.join(root, 'credentials.vault')), false);
});

test('explicit session-only credentials work without OS encryption and never touch disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage(false) });
  const status = vault.setSession('llm', { apiKey: 'session-secret' });

  assert.equal(status.available, true);
  assert.equal(status.persistentAvailable, false);
  assert.equal(status.llm.sessionOnly, true);
  assert.deepEqual(vault.readForRuntime().llm, { apiKey: 'session-secret' });
  assert.equal(fs.existsSync(path.join(root, 'credentials.vault')), false);
});

test('Windows encryption failure preserves an existing credential and returns a stable code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const safeStorage = fakeSafeStorage();
  const vault = new CredentialVault({ storageDir: root, safeStorage });
  vault.set('llm', { apiKey: 'old-secret' });
  const oldBytes = fs.readFileSync(path.join(root, 'credentials.vault'));
  safeStorage.encryptString = () => {
    const error = new Error('The requested local operation could not be completed');
    error.code = 'UNKNOWN_WINDOWS_ERROR';
    throw error;
  };

  assert.throws(
    () => vault.set('llm', { apiKey: 'new-secret' }),
    (error) => error?.code === 'REVERIE_OS_ENCRYPTION_FAILED',
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'credentials.vault')), oldBytes);
  assert.equal(vault.status().lastErrorCode, 'REVERIE_OS_ENCRYPTION_FAILED');
});

test('ciphertext read-back mismatch is rejected before replacing the old vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const safeStorage = fakeSafeStorage();
  const vault = new CredentialVault({ storageDir: root, safeStorage });
  vault.set('llm', { apiKey: 'old-secret' });
  const oldBytes = fs.readFileSync(path.join(root, 'credentials.vault'));
  safeStorage.decryptString = () => '{"schema":"wrong"}';

  assert.throws(
    () => vault.set('llm', { apiKey: 'new-secret' }),
    (error) => error?.code === 'REVERIE_VAULT_CORRUPT'
      || error?.code === 'REVERIE_OS_ENCRYPTION_VERIFY_FAILED',
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'credentials.vault')), oldBytes);
});

test('credential vault fails closed on corrupt ciphertext and never silently replaces it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'credentials.vault');
  fs.writeFileSync(target, 'not-a-valid-cipher');
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage() });

  assert.equal(vault.status().corrupted, true);
  assert.throws(
    () => vault.set('llm', { apiKey: 'replacement' }),
    (error) => error?.code === 'REVERIE_VAULT_CORRUPT',
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'not-a-valid-cipher');
  assert.equal(vault.clear('llm').recoveredCorruptVault, true);
  assert.equal(vault.status().corrupted, false);
});

test('credential vault rejects symlinks, oversized secrets, and header injection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  assert.throws(() => vault.set('llm', { apiKey: `x\r\nInjected: yes` }), /invalid/);
  assert.throws(() => vault.set('llm', {
    customHeaders: 'X-Test: safe\r\n Injected: yes',
  }), /invalid/);

  if (process.platform !== 'win32') {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'ciphertext');
    fs.symlinkSync(target, path.join(root, 'credentials.vault'));
    assert.throws(() => vault.readForRuntime(), /regular file|read/);
  }
});

test('provider-bound credentials never cross an endpoint boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-binding-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  const deepseekBinding = 'a'.repeat(64);
  const openaiBinding = 'b'.repeat(64);
  vault.set('llm', { apiKey: 'deepseek-only' }, { binding: deepseekBinding });

  assert.deepEqual(
    vault.readForRuntime({ bindings: { llm: deepseekBinding } }).llm,
    { apiKey: 'deepseek-only' },
  );
  assert.equal(
    vault.readForRuntime({ bindings: { llm: openaiBinding } }).llm,
    undefined,
  );
  assert.equal(vault.status().llm.bindingKnown, true);
});

test('legacy unbound vaults remain readable but fail closed when an endpoint binding is required', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-legacy-'));
  const safeStorage = fakeSafeStorage();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'credentials.vault'),
    safeStorage.encryptString(JSON.stringify({
      schema: 'reverie.credential-vault.v1',
      credentials: { llm: { apiKey: 'legacy-key' }, imageGen: {} },
    })),
  );
  const vault = new CredentialVault({ storageDir: root, safeStorage });
  assert.deepEqual(vault.readForRuntime().llm, { apiKey: 'legacy-key' });
  assert.equal(
    vault.readForRuntime({ bindings: { llm: 'c'.repeat(64) } }).llm,
    undefined,
  );
  assert.equal(vault.status().llm.bindingKnown, false);
});

test('provider commit rollback restores exactly one credential scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vault-rollback-'));
  const vault = new CredentialVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  const oldBinding = 'd'.repeat(64);
  const newBinding = 'e'.repeat(64);
  vault.set('llm', { apiKey: 'old-llm' }, { binding: oldBinding });
  vault.set('imageGen', { apiKey: 'keep-image' }, { binding: 'f'.repeat(64) });
  vault.setSession('llm', { customHeaders: 'X-Session: old' }, { binding: oldBinding });
  const snapshot = vault.snapshotScope('llm');

  vault.set('llm', { apiKey: 'new-llm' }, { binding: newBinding });
  vault.setSession('llm', { customHeaders: 'X-Session: new' }, { binding: newBinding });
  vault.restoreScope('llm', snapshot);

  assert.deepEqual(vault.readForRuntime({ bindings: { llm: oldBinding } }).llm, {
    apiKey: 'old-llm',
    customHeaders: 'X-Session: old',
  });
  assert.equal(
    vault.readForRuntime({ bindings: { llm: newBinding } }).llm,
    undefined,
  );
  assert.deepEqual(vault.readForRuntime().imageGen, { apiKey: 'keep-image' });
});
