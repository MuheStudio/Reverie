'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VoicePackManager, MANIFEST_SCHEMA } = require('./voice-pack-manager.cjs');

const REAL_PACK = path.resolve(__dirname, '..', '..', '..', '..', 'TTS-Neuro');

function temporaryRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `reverie-voice-pack-${name}-`));
}

function pcmWav(seconds = 1, sampleRate = 8000) {
  const dataSize = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function fixture(name) {
  const root = temporaryRoot(name);
  fs.writeFileSync(path.join(root, 'voice.ckpt'), 'checkpoint-not-deserialized');
  fs.writeFileSync(path.join(root, 'voice.pth'), 'checkpoint-not-deserialized');
  fs.writeFileSync(path.join(root, 'reference.wav'), pcmWav());
  fs.writeFileSync(path.join(root, 'reference.txt'), 'A local reference transcript.\n');
  return root;
}

function manager(name) {
  return new VoicePackManager({ storageDir: path.join(temporaryRoot(name), 'app-data') });
}

const confirmation = Object.freeze({
  rightsAttested: true,
  runtimeFamily: 'gpt-sovits',
  runtimeVersion: 'v2',
});

test('imports the local TTS-Neuro pack while ignoring exact macOS metadata subtrees', { timeout: 120000 }, () => {
  assert.equal(fs.existsSync(REAL_PACK), true, `Expected local fixture at ${REAL_PACK}`);
  const packs = manager('real');
  const preview = packs.preview(REAL_PACK);
  assert.equal(preview.wrapperDirectory, 'Neuro-V2-VoicePack');
  assert.deepEqual(new Set(preview.files.map((file) => file.role)), new Set([
    'gptCheckpoint', 'sovitsCheckpoint', 'referenceAudio', 'transcript',
  ]));
  assert.equal(preview.files.some((file) => file.originalName.startsWith('._')), false);

  const imported = packs.commit(preview, confirmation);
  assert.match(imported.id, /^[0-9a-f-]{36}$/i);
  assert.equal(fs.existsSync(path.join(imported.recordPath, `${MANIFEST_SCHEMA}.json`)), true);
  assert.equal(fs.existsSync(path.join(imported.recordPath, 'payload', 'Neuro-e24.ckpt')), true);
  assert.equal(imported.rightsAttestation.scope, 'local-use import');
  assert.equal(JSON.stringify(imported).toLowerCase().includes('redistribut'), false);
  packs.setActive(imported.id);
  assert.equal(packs.list().records.find((pack) => pack.id === imported.id).active, true);
  assert.equal(packs.remove(imported.id), true);
  assert.equal(packs.list().records.length, 0);
});

test('rejects duplicate checkpoint assets', () => {
  const source = fixture('duplicate');
  fs.writeFileSync(path.join(source, 'second.ckpt'), 'duplicate');
  assert.throws(() => manager('duplicate-store').preview(source), /exactly one gptCheckpoint/i);
});

test('rejects executable and script files anywhere in the selected pack', () => {
  const source = fixture('script');
  fs.writeFileSync(path.join(source, 'install.ps1'), 'Write-Host unsafe');
  assert.throws(() => manager('script-store').preview(source), /executable or script/i);
});

test('rejects a corrupt WAV without reading checkpoint formats', () => {
  const source = fixture('wav');
  fs.writeFileSync(path.join(source, 'reference.wav'), Buffer.from('not a RIFF file'));
  assert.throws(() => manager('wav-store').preview(source), /WAV size|RIFF\/WAVE/i);
});

test('rejects source changes between preview and commit and leaves no partial record', () => {
  const source = fixture('race');
  const packs = manager('race-store');
  const preview = packs.preview(source);
  fs.appendFileSync(path.join(source, 'voice.pth'), 'changed');
  assert.throws(() => packs.commit(preview, confirmation), /changed after preview|changed while/i);
  assert.equal(packs.list().records.length, 0);
});

test('requires explicit rights and exact runtime confirmation before copying', () => {
  const source = fixture('confirmation');
  const packs = manager('confirmation-store');
  const preview = packs.preview(source);
  assert.throws(() => packs.commit(preview, {
    rightsAttested: true,
    runtimeFamily: 'gpt-sovits',
    runtimeVersion: 'v1',
  }), /confirmation/i);
  assert.equal(packs.list().records.length, 0);
});

test('rejects same-size checkpoint tampering before activation', () => {
  const source = fixture('tamper');
  const packs = manager('tamper-store');
  const imported = packs.commit(packs.preview(source), confirmation);
  const checkpoint = path.join(imported.recordPath, 'payload', 'voice.pth');
  const original = fs.readFileSync(checkpoint);
  const changed = Buffer.from(original);
  changed[0] ^= 0xff;
  fs.writeFileSync(checkpoint, changed);
  assert.throws(() => packs.setActive(imported.id), /hash mismatch/i);
});

test('rejects a symlink in a pack where the platform permits creating one', (context) => {
  const source = fixture('symlink');
  const target = path.join(source, 'harmless.md');
  fs.writeFileSync(target, 'target');
  try {
    fs.symlinkSync(target, path.join(source, 'linked.md'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      context.skip(`Symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => manager('symlink-store').preview(source), /links are not allowed/i);
});

test('list() skips and reports a damaged record instead of bricking the library', () => {
  const packs = manager('corrupt-list');
  const preview = packs.preview(fixture('corrupt-src'));
  const record = packs.commit(preview.previewId, confirmation);
  fs.writeFileSync(path.join(record.recordPath, `${MANIFEST_SCHEMA}.json`), '{ broken', 'utf8');
  const listing = packs.list();
  assert.equal(listing.records.length, 0);
  assert.equal(listing.corrupt.length, 1);
  assert.equal(listing.corrupt[0].id, record.id);
  assert.equal(typeof listing.corrupt[0].reason, 'string');
  assert.equal(listing.corrupt[0].reason.length > 0, true);
});

test('rejects file names that Windows would silently truncate', () => {
  const root = fixture('trailing-name');
  fs.writeFileSync(path.join(root, 'reference.txt '), 'trailing space\n');
  const packs = manager('trailing-name');
  assert.throws(() => packs.preview(root), /file name is invalid/);
});

test('sweeps stale partial staging directories older than a day', () => {
  const packs = manager('sweep');
  const stale = path.join(packs.partialRoot, '00000000-0000-4000-8000-000000000000.partial');
  fs.mkdirSync(stale, { recursive: true });
  const fresh = path.join(packs.partialRoot, '11111111-1111-4111-8111-111111111111.partial');
  fs.mkdirSync(fresh, { recursive: true });
  const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);
  packs.list();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});
