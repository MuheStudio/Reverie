'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FocusSoundManager, validateSoundMagic } = require('./focus-sound-manager.cjs');
const {
  installFocusSoundProtocol,
  parseByteRange,
  parseSoundUrl,
} = require('./focus-sound-protocol.cjs');

function mp3Bytes() {
  return Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    Buffer.alloc(256, 0x42),
  ]);
}

test('focus sound manager imports by magic, exposes only opaque URLs, and verifies integrity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-sound-'));
  const source = path.join(root, 'Rain.mp3');
  fs.writeFileSync(source, mp3Bytes());
  const manager = new FocusSoundManager({ storageDir: path.join(root, 'library') });
  const record = manager.import(source);
  assert.match(record.id, /^[0-9a-f-]{36}$/i);
  assert.equal(record.name, 'Rain');
  assert.equal(record.url, `reverie-focus://sound/${record.id}`);
  assert.equal(JSON.stringify(record).includes(root), false);
  assert.deepEqual(manager.list().records, [record]);
  const opened = manager.open(record.id);
  assert.equal(opened.mimeType, 'audio/mpeg');
  fs.closeSync(opened.fd);

  const wrong = path.join(root, 'renamed.wav');
  fs.writeFileSync(wrong, mp3Bytes());
  assert.throws(() => manager.import(wrong), /extension|format/i);
  assert.equal(manager.list().records.length, 1);
});

test('focus sound URL and byte-range parser reject traversal and malformed ranges', () => {
  assert.deepEqual(
    parseSoundUrl('reverie-focus://sound/1234'),
    { id: '1234' },
  );
  assert.throws(() => parseSoundUrl('reverie-focus://sound/1234/extra'), /exactly/i);
  assert.throws(() => parseSoundUrl('reverie-focus://evil/1234'), /Invalid/i);
  assert.deepEqual(parseByteRange('bytes=5-9', 20), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-4', 20), { start: 16, end: 19 });
  assert.throws(() => parseByteRange('bytes=20-21', 20), /range/i);
});

test('focus sound protocol supports closed-origin streaming ranges without revealing a file path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-sound-'));
  const source = path.join(root, 'Bell.mp3');
  fs.writeFileSync(source, mp3Bytes());
  const manager = new FocusSoundManager({ storageDir: path.join(root, 'library') });
  const record = manager.import(source);
  let handler = null;
  const protocol = {
    handle(_scheme, value) { handler = value; },
    unhandle() { handler = null; },
  };
  const uninstall = installFocusSoundProtocol(protocol, manager, {
    allowedOrigins: ['reverie-app://app'],
  });
  const response = await handler(new Request(record.url, {
    headers: {
      Origin: 'reverie-app://app',
      Range: 'bytes=0-3',
    },
  }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'reverie-app://app');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp3Bytes().subarray(0, 4));
  uninstall();
  assert.equal(handler, null);
});

test('audio magic validation refuses header-only format confusion', () => {
  assert.equal(validateSoundMagic(mp3Bytes(), 'mp3', mp3Bytes().length), 'mp3');
  assert.throws(() => validateSoundMagic(mp3Bytes(), 'wav', mp3Bytes().length), /match/i);
});
