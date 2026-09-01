'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  STORAGE_KEY_BYTES,
  StorageKeyVault,
} = require('./storage-key-vault.cjs');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8');
    },
    decryptString(value) {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('protected:')) throw new Error('not protected');
      return Buffer.from(text.slice('protected:'.length), 'base64').toString('utf8');
    },
  };
}

test('database key is generated once and only its protected form reaches disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const vault = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  const first = vault.getOrCreateKey();
  const second = vault.getOrCreateKey();
  try {
    assert.equal(first.length, STORAGE_KEY_BYTES);
    assert.deepEqual(first, second);
    const disk = fs.readFileSync(path.join(root, 'database-key.vault'));
    assert.equal(disk.includes(Buffer.from(first.toString('hex'), 'utf8')), false);
    assert.match(disk.toString('utf8'), /^protected:/);
  } finally {
    first.fill(0);
    second.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable OS encryption refuses startup without a plaintext fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const vault = new StorageKeyVault({
    storageDir: root,
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('must not run'); },
    },
  });
  try {
    assert.throws(() => vault.getOrCreateKey(), /encryption is unavailable/i);
    assert.equal(fs.existsSync(path.join(root, 'database-key.vault')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt protected key is never overwritten with a new identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const target = path.join(root, 'database-key.vault');
  fs.writeFileSync(target, 'corrupt', { mode: 0o600 });
  const vault = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  try {
    assert.throws(() => vault.getOrCreateKey(), /corrupt|belongs/i);
    assert.equal(fs.readFileSync(target, 'utf8'), 'corrupt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed committed-key verification removes only the newly-created vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const protectedStorage = fakeSafeStorage();
  let decryptions = 0;
  const safeStorage = {
    ...protectedStorage,
    decryptString(value) {
      decryptions += 1;
      if (decryptions > 1) throw new Error('simulated read-back failure');
      return protectedStorage.decryptString(value);
    },
  };
  const vault = new StorageKeyVault({ storageDir: root, safeStorage });
  try {
    assert.throws(() => vault.getOrCreateKey(), /corrupt|committed/i);
    assert.equal(fs.existsSync(path.join(root, 'database-key.vault')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reset moves a corrupt vault aside and a fresh key is created afterwards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const vault = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  try {
    const first = vault.getOrCreateKey();
    first.fill(0);
    // Simulate a DPAPI master-key change: the stored ciphertext no longer decrypts.
    const corruptVault = new StorageKeyVault({
      storageDir: root,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
        decryptString: () => { throw new Error('hash mismatch'); },
      },
    });
    assert.throws(() => corruptVault.getOrCreateKey(), /corrupt or belongs to another Windows user/);

    const result = corruptVault.reset({ reason: 'corrupt_vault_user_reset' });
    assert.equal(result.reset, true);
    assert.equal(result.recoveredCorruptVault, true);
    assert.ok(result.supersededPath, 'the old ciphertext must be preserved on disk');
    assert.equal(fs.existsSync(result.supersededPath), true);

    const recovered = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
    const fresh = recovered.getOrCreateKey();
    try {
      assert.equal(fresh.length, STORAGE_KEY_BYTES);
      assert.equal(fs.existsSync(path.join(root, 'database-key.vault')), true);
    } finally {
      fresh.fill(0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reset on a missing vault succeeds without touching other files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-storage-key-'));
  const vault = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  try {
    const result = vault.reset();
    assert.equal(result.reset, true);
    assert.equal(result.supersededPath, null);
    assert.equal(fs.readdirSync(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
