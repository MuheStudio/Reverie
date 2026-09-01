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
  // The destination already committed but the credential write never landed
  // (killed between configure and vault set). The config must survive — only
  // the key needs re-entry, so this is never a destination rollback.
  assert.equal(recoveryAction(transaction, newConfig, {
    persistent: {
      binding: binding,
      transactionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      credential: { apiKey: 'old' },
    },
  }), 'complete');
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

test('a stale journal never overwrites newer user state', () => {
  const oldConfig = config('ollama', 'http://localhost:11434/v1');
  const newConfig = config('deepseek', 'https://api.deepseek.com');
  const transaction = {
    schema: SCHEMA,
    id: '12345678-1234-1234-1234-123456789abc',
    phase: 'prepared',
    credentialAction: 'replace',
    credentialTransactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newBinding: 'a'.repeat(64),
    oldConfig,
    newConfig,
  };
  // The user changed the provider again after this journal entry was written;
  // rolling back would clobber the newer choice with the old one.
  const newerUserConfig = config('glm', 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(recoveryAction(transaction, newerUserConfig, {}), 'discard');
  // Even a stale journal may still rescue the last-known destination when the
  // live config was reset to the factory default underneath us — but only
  // when the journal recorded a real user config.
  const glmOld = config('glm', 'https://open.bigmodel.cn/api/paas/v4');
  const resetTransaction = { ...transaction, oldConfig: glmOld };
  assert.equal(recoveryAction(resetTransaction, {
    llm: { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
  }, {}), 'rollback');
  // …but only when there IS a real user config to restore.
  const factoryOld = {
    llm: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
  };
  const factoryCurrent = {
    llm: { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
  };
  const factoryTransaction = {
    schema: SCHEMA,
    id: '12345678-1234-1234-1234-123456789abc',
    phase: 'prepared',
    credentialAction: 'replace',
    credentialTransactionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    newBinding: 'a'.repeat(64),
    oldConfig: factoryOld,
    newConfig,
  };
  assert.equal(recoveryAction(factoryTransaction, factoryCurrent, {}), 'discard');
});
