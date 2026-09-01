'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Google nearby checks local mode before endpoint-bound key read and networking', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("handle('places:nearby'");
  const end = source.indexOf("handle('credentials:clear'", start);
  const handler = source.slice(start, end);
  const localMode = handler.indexOf('networkGate?.snapshot?.().active');
  const keyRead = handler.indexOf('credentialVault.readForRuntime');
  const network = handler.indexOf('searchGooglePlaces');

  assert.ok(localMode >= 0 && keyRead > localMode && network > keyRead);
  assert.match(handler, /bindings: \{ googlePlaces: GOOGLE_PLACES_BINDING \}/);
  assert.equal(handler.includes('bridge.requestGoogle'), false);
});

test('provider selection is deterministic Amap-first and never performs fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("handle('places:resolve'");
  const end = source.indexOf("handle('places:nearby'", start);
  const handler = source.slice(start, end);

  assert.match(handler, /configured\.amap \? 'amap' : \(configured\.google \? 'google' : null\)/);
  assert.equal(handler.includes('searchGooglePlaces'), false);
  assert.equal(handler.includes('requestAmapNearby'), false);
});

test('Google Places credentials and results never cross into Python', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const syncStart = source.indexOf('async function syncCredentialVault(');
  const syncEnd = source.indexOf('\nfunction assertNativeBackupPath', syncStart);
  const sync = source.slice(syncStart, syncEnd);
  const deleteGoogle = sync.indexOf('delete runtimeCredentials.googlePlaces;');
  const bridgeCall = sync.indexOf('bridge.setCredentials(runtimeCredentials)');

  assert.ok(deleteGoogle >= 0 && bridgeCall > deleteGoogle);
  assert.equal(source.includes('bridge.requestGoogle'), false);
  assert.equal(source.includes("type: 'google:nearby'"), false);
});
