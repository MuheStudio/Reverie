'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProviderConfigStore } = require('./provider-config-store.cjs');

test('provider metadata store persists a closed-world projection without credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-provider-config-'));
  const store = new ProviderConfigStore({ storageDir: root });
  const value = {
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    },
    imageGen: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-image-1',
    },
  };
  assert.deepEqual(store.set(value), value);
  assert.deepEqual(store.get(), value);
  const serialized = fs.readFileSync(path.join(root, 'providers.json'), 'utf8');
  assert.equal(serialized.includes('apiKey'), false);
  assert.equal(serialized.includes('customHeaders'), false);
});

test('provider metadata store rejects credential fields even if a compromised renderer sends them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-provider-config-'));
  const store = new ProviderConfigStore({ storageDir: root });
  assert.throws(() => store.set({
    llm: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: 'must-never-land',
    },
  }), /forbidden field/i);
  assert.equal(fs.existsSync(path.join(root, 'providers.json')), false);
});

test('provider metadata rejects URL credentials, query strings, and fragments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-provider-config-'));
  const store = new ProviderConfigStore({ storageDir: root });
  for (const baseUrl of [
    'https://user:pass@example.com/v1',
    'https://example.com/v1?api_key=secret',
    'https://example.com/v1#secret',
    'file:///tmp/provider',
  ]) {
    assert.throws(() => store.set({
      llm: { provider: 'custom', baseUrl, model: 'model' },
    }), /HTTP\(S\)|invalid/);
  }
  assert.equal(fs.existsSync(path.join(root, 'providers.json')), false);
});
