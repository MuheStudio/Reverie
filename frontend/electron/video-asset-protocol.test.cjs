'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseVideoAssetUrl, parseRange } = require('./video-asset-protocol.cjs');

const HASH = 'a'.repeat(64);

test('video protocol accepts only one content-addressed mp4/webm filename', () => {
  assert.equal(
    parseVideoAssetUrl(`reverie-video://asset/${HASH}.mp4`),
    `${HASH}.mp4`,
  );
  assert.equal(
    parseVideoAssetUrl(`reverie-video://asset/${HASH}.webm`),
    `${HASH}.webm`,
  );
  for (const value of [
    `reverie-video://asset/${HASH}.exe`,
    `reverie-video://asset/${HASH}.mp4/extra`,
    'reverie-video://evil/asset.mp4',
    `reverie-video://asset/../../secret.mp4`,
    `reverie-video://asset/${HASH}.mp4?x=1`,
    `reverie-video://asset/${HASH}.png`,
  ]) {
    assert.throws(() => parseVideoAssetUrl(value));
  }
});

test('range parser returns a satisfiable single range or null', () => {
  const size = 1000;
  assert.deepEqual(parseRange('bytes=0-499', size), { start: 0, end: 499 });
  assert.deepEqual(parseRange('bytes=500-', size), { start: 500, end: 999 });
  // Suffix range: last 100 bytes.
  assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 });
  // End clamps to size-1.
  assert.deepEqual(parseRange('bytes=0-5000', size), { start: 0, end: 999 });
  // No/invalid range -> null (serve whole file).
  assert.equal(parseRange(null, size), null);
  assert.equal(parseRange('bytes=abc', size), null);
  assert.equal(parseRange('bytes=1000-1001', size), null); // start >= size
  assert.equal(parseRange('bytes=500-400', size), null); // end < start
  // Multi-range is not supported -> null.
  assert.equal(parseRange('bytes=0-1,2-3', size), null);
});
