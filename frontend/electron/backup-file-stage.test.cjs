'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stageNativeBackupSource } = require('./backup-file-stage.cjs');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-backup-stage-'));
}

test('stages immutable private bytes and returns a digest without exposing the source path', async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'selected.json');
  const original = Buffer.from('{"schema":"reverie.full_local_backup.v3"}\n');
  fs.writeFileSync(source, original);

  const staged = await stageNativeBackupSource(source, {
    storageDir: path.join(root, 'private'),
  });
  t.after(() => staged.dispose());

  fs.writeFileSync(source, '{"replaced":true}\n');

  assert.deepEqual(fs.readFileSync(staged.filePath), original);
  assert.equal(staged.fileName, 'selected.json');
  assert.equal(staged.byteLength, original.length);
  assert.equal(staged.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(JSON.stringify(staged).includes(source), false);
});

test('rejects relative paths and files above the configured limit', async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'selected.json');
  fs.writeFileSync(source, '12345');

  await assert.rejects(
    stageNativeBackupSource('selected.json', { storageDir: path.join(root, 'private') }),
    /absolute JSON/,
  );
  await assert.rejects(
    stageNativeBackupSource(source, {
      storageDir: path.join(root, 'private'),
      maxBytes: 4,
    }),
    /size/,
  );
});

test('rejects a symbolic-link source when the platform permits creating one', async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'link.json');
  fs.writeFileSync(target, '{}');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip('symbolic links are unavailable for this test account');
      return;
    }
    throw error;
  }

  await assert.rejects(
    stageNativeBackupSource(link, { storageDir: path.join(root, 'private') }),
    /non-symlink|symbolic link/,
  );
});
