'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// macOS /var aliases /private/var; fixtures must satisfy the real-directory contract.
const temporaryDirectory = fs.realpathSync(os.tmpdir());

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

function missingKeyFixture(t, platform = 'darwin', overrides = {}) {
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-missing-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const options = { platform, storageDir: path.join(root, 'vault'), existingDataDir: data,
    safeStorage: fakeSafeStorage(), ...overrides };
  return { root, data, options, vault: new StorageKeyVault(options), vaultPath: path.join(root, 'vault', 'database-key.vault') };
}

for (const name of ['history.db', 'kernel.sqlite3', 'memory.sqlite', 'kernel.sqlite3-wal',
  'memory.sqlite-shm', 'history.db-journal', 'history.db.bak']) {
  test(`macOS refuses a new key when ${name} exists without a vault`, (t) => {
    const f = missingKeyFixture(t);
    const directory = path.join(f.data, 'nested', 'runtime');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    const before = name.endsWith('-wal') ? Buffer.alloc(0) : Buffer.from('existing encrypted data');
    fs.writeFileSync(file, before);
    assert.throws(() => f.vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_MISSING' });
    assert.equal(fs.existsSync(f.vaultPath), false);
    assert.deepEqual(fs.readFileSync(file), before);
  });
}

test('macOS creates a first key for new data containing only seed JSON files', (t) => {
  const f = missingKeyFixture(t);
  fs.writeFileSync(path.join(f.data, 'config.json'), '{}');
  fs.mkdirSync(path.join(f.data, 'user'));
  fs.writeFileSync(path.join(f.data, 'user', 'profile.json'), '{}');
  const key = f.vault.getOrCreateKey();
  assert.equal(key.length, STORAGE_KEY_BYTES);
  assert.ok(fs.existsSync(f.vaultPath));
  key.fill(0);
});

test('a valid macOS vault is reused without rescanning existing databases', (t) => {
  const f = missingKeyFixture(t);
  const first = f.vault.getOrCreateKey();
  fs.writeFileSync(path.join(f.data, 'kernel.sqlite3'), 'existing data');
  const original = fs.readFileSync(f.vaultPath);
  const vault = new StorageKeyVault({ ...f.options,
    fs: { ...fs, readdirSync: () => { throw new Error('valid vault must not scan data'); } } });
  const second = vault.getOrCreateKey();
  assert.deepEqual(first, second);
  assert.deepEqual(fs.readFileSync(f.vaultPath), original);
  first.fill(0); second.fill(0);
});

test('Windows keeps its existing missing-vault behavior even if existingDataDir is supplied', (t) => {
  const f = missingKeyFixture(t, 'win32');
  fs.writeFileSync(path.join(f.data, 'kernel.sqlite3'), 'existing data');
  const key = f.vault.getOrCreateKey();
  assert.equal(key.length, STORAGE_KEY_BYTES);
  assert.ok(fs.existsSync(f.vaultPath));
  key.fill(0);
});

test('an unreadable macOS data tree refuses key creation', (t) => {
  const f = missingKeyFixture(t);
  const vault = new StorageKeyVault({ ...f.options, fs: { ...fs, readdirSync: () => {
    throw Object.assign(new Error('access denied'), { code: 'EACCES' });
  } } });
  assert.throws(() => vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_IO' });
  assert.equal(fs.existsSync(f.vaultPath), false);
});

test('a missing or non-directory macOS data root refuses key creation', (t) => {
  const f = missingKeyFixture(t);
  fs.rmdirSync(f.data);
  assert.throws(() => f.vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_IO' });
  fs.writeFileSync(f.data, 'not a directory');
  assert.throws(() => f.vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_IO' });
  assert.equal(fs.existsSync(f.vaultPath), false);
});

test('macOS rejects symlinks anywhere in the data tree before creating a key', { skip: process.platform === 'win32' }, (t) => {
  const f = missingKeyFixture(t);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'kernel.sqlite3'), 'outside database');
  fs.symlinkSync(outside, path.join(f.data, 'redirected'));
  assert.throws(() => f.vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_IO' });
  assert.equal(fs.existsSync(f.vaultPath), false);
  assert.equal(fs.readFileSync(path.join(outside, 'kernel.sqlite3'), 'utf8'), 'outside database');
});

test('database key is generated once and only its protected form reaches disk', () => {
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
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
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
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
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
  const target = path.join(root, 'database-key.vault');
  fs.writeFileSync(target, 'corrupt', { mode: 0o600 });
  const vault = new StorageKeyVault({ storageDir: root, safeStorage: fakeSafeStorage() });
  try {
    assert.throws(() => vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_CORRUPT' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'corrupt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed committed-key verification removes only the newly-created vault', () => {
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
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
    assert.throws(() => vault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_CORRUPT' });
    assert.equal(fs.existsSync(path.join(root, 'database-key.vault')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reset moves a corrupt vault aside and a fresh key is created afterwards', () => {
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
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
    assert.throws(() => corruptVault.getOrCreateKey(), { code: 'REVERIE_STORAGE_KEY_CORRUPT' });

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
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'reverie-storage-key-'));
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
