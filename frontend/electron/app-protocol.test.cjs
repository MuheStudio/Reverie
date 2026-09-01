'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MIME, parseBundleUrl, PRODUCTION_CSP } = require('./app-protocol.cjs');

test('application protocol maps only bundle paths and rejects traversal encodings', () => {
  assert.deepEqual(parseBundleUrl('reverie-app://app/index.html#/dream'), ['index.html']);
  assert.deepEqual(parseBundleUrl('reverie-app://app/assets/app.js'), ['assets', 'app.js']);
  assert.throws(() => parseBundleUrl('reverie-app://evil/index.html'), /Invalid/i);
  assert.throws(() => parseBundleUrl('reverie-app://app/a%2Fb.js'), /separator/i);
  assert.throws(() => parseBundleUrl('reverie-app://app/%2e%2e/secret'), /Unsafe|Invalid|Dot/i);
  assert.throws(() => parseBundleUrl('reverie-app://app/C:/secret'), /Unsafe/i);
});

test('production renderer CSP blocks network transports and allows registered asset protocols', () => {
  assert.doesNotMatch(PRODUCTION_CSP, /ws:/);
  assert.doesNotMatch(PRODUCTION_CSP, /http:/);
  assert.match(PRODUCTION_CSP, /reverie-avatar:/);
  assert.match(PRODUCTION_CSP, /reverie-focus:/);
  assert.match(PRODUCTION_CSP, /reverie-sticker:/);
  assert.doesNotMatch(PRODUCTION_CSP, /file:/);
  assert.doesNotMatch(PRODUCTION_CSP, /https:/);
  assert.doesNotMatch(PRODUCTION_CSP, /script-src[^;]*unsafe-inline/);
});

test('bundled audio assets are served (focus soundscape must not 404 into pink-noise fallback)', () => {
  assert.equal(MIME['.ogg'], 'audio/ogg');
  assert.equal(MIME['.wav'], 'audio/wav');
  assert.equal(MIME['.mp3'], 'audio/mpeg');
});
