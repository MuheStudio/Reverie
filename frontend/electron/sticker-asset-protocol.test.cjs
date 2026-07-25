'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStickerAssetUrl } = require('./sticker-asset-protocol.cjs');

const HASH = 'a'.repeat(64);

test('sticker protocol accepts only one content-addressed image filename', () => {
  assert.equal(
    parseStickerAssetUrl(`reverie-sticker://asset/${HASH}.gif`),
    `${HASH}.gif`,
  );
  for (const value of [
    `reverie-sticker://asset/${HASH}.exe`,
    `reverie-sticker://asset/${HASH}.png/extra`,
    'reverie-sticker://evil/asset.png',
    'reverie-sticker://asset/../../secret.png',
    `reverie-sticker://asset/${HASH}.png?x=1`,
  ]) {
    assert.throws(() => parseStickerAssetUrl(value));
  }
});
