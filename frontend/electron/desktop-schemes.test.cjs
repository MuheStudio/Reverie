'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SCHEMES } = require('./desktop-schemes.cjs');

test('desktop schemes are secure/standard/fetch-capable and never bypass CSP', () => {
  assert.deepEqual(
    SCHEMES.map((entry) => entry.scheme).sort(),
    [
      'reverie-app',
      'reverie-avatar',
      'reverie-focus',
      'reverie-live2d-core',
      'reverie-sticker',
    ],
  );
  for (const entry of SCHEMES) {
    assert.equal(entry.privileges.standard, true);
    assert.equal(entry.privileges.secure, true);
    assert.equal(entry.privileges.supportFetchAPI, true);
    assert.equal(entry.privileges.bypassCSP, false);
  }
});
