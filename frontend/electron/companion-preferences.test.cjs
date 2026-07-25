'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CompanionPreferencesStore,
  DEFAULTS,
} = require('./companion-preferences.cjs');

test('companion preferences have host-owned defaults and persist a closed schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-companion-prefs-'));
  const store = new CompanionPreferencesStore({ storageDir: root });
  assert.deepEqual(store.get(), DEFAULTS);
  const value = { sound: 'wind', volume: 0.375, autoStart: false };
  assert.deepEqual(store.set(value), value);
  assert.deepEqual(store.get(), value);
});

test('companion preferences reject injected fields, invalid custom IDs, and corrupt files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-companion-prefs-'));
  const store = new CompanionPreferencesStore({ storageDir: root });
  assert.throws(() => store.set({
    sound: 'rain',
    volume: 0.2,
    autoStart: true,
    apiKey: 'never',
  }), /invalid/i);
  assert.throws(() => store.set({
    sound: 'custom:../../escape',
    volume: 0.2,
    autoStart: true,
  }), /sound/i);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'preferences.json'), '{broken', 'utf8');
  assert.throws(() => store.get(), (error) => (
    error.code === 'REVERIE_COMPANION_PREFERENCES_CORRUPT'
  ));
});
