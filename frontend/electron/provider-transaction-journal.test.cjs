'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  ProviderTransactionJournal,
  SCHEMA,
  recoveryAction,
} = require('./provider-transaction-journal.cjs');

const config = (provider, baseUrl) => ({ llm: { provider, baseUrl, model: 'model' } });

test('provider transaction journal persists only public recovery metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-provider-transaction-'));
  const journal = new ProviderTransactionJournal({ storageDir: root });
  journal.write({
    schema: SCHEMA,
    id: '12345678-1234-1234-1234-123456789abc',
    phase: 'prepared',
    credentialAction: 'replace',
    credentialTransactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newBinding: 'a'.repeat(64),
    oldConfig: config('ollama', 'http://localhost:11434/v1'),
    newConfig: config('deepseek', 'https://api.deepseek.com'),
  });

  const serialized = fs.readFileSync(path.join(root, 'pending.json'), 'utf8');
  assert.doesNotMatch(serialized, /apiKey|customHeaders|secret/i);
  assert.equal(journal.read().newConfig.llm.provider, 'deepseek');
  journal.clear();
  assert.equal(journal.read(), null);
});

test('provider transaction journal rejects corrupt and secret-bearing records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-provider-transaction-'));
  const journal = new ProviderTransactionJournal({ storageDir: root });
  assert.throws(() => journal.write({
    schema: SCHEMA,
    id: '12345678-1234-1234-1234-123456789abc',
    phase: 'prepared',
    credentialAction: 'replace',
    credentialTransactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newBinding: 'a'.repeat(64),
    oldConfig: config('ollama', 'http://localhost:11434/v1'),
    newConfig: { ...config('custom', 'https://example.com/v1'), apiKey: 'secret' },
  }), /non-MVP section/);
});

test('crash recovery preserves either the complete old or complete new tuple', () => {
  const oldConfig = config('ollama', 'http://localhost:11434/v1');
  const newConfig = config('deepseek', 'https://api.deepseek.com');
  const binding = 'a'.repeat(64);
  const transaction = {
    schema: SCHEMA,
    id: '12345678-1234-1234-1234-123456789abc',
    phase: 'prepared',
    credentialAction: 'replace',
    credentialTransactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newBinding: binding,
    oldConfig,
    newConfig,
  };
  assert.equal(recoveryAction(transaction, oldConfig, {}), 'discard');
  assert.equal(recoveryAction(transaction, newConfig, {
    persistent: {
      binding: binding,
      transactionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      credential: { apiKey: 'old' },
    },
  }), 'rollback');
  assert.equal(recoveryAction(transaction, newConfig, {
    persistent: {
      binding,
      transactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      credential: { apiKey: 'new' },
    },
  }), 'complete');
  assert.equal(recoveryAction(
    { ...transaction, credentialAction: 'preserve', newBinding: null },
    newConfig,
    {},
  ), 'complete');
});
