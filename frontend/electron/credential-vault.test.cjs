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

  assert.deepEqual(status.llm, { hasApiKey: true, hasCustomHeaders: true });
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
