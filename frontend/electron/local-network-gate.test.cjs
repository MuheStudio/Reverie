'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  LocalNetworkGate,
  isLoopbackHostname,
  parseRemoteUrl,
} = require('./local-network-gate.cjs');

test('loopback parsing does not accept suffix tricks or credential tricks', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(isLoopbackHostname('localhost.evil.invalid'), false);
  assert.equal(parseRemoteUrl('https://localhost.evil.invalid/').isLoopback, false);
  assert.equal(parseRemoteUrl('file:///tmp/a').isNetwork, false);
});

test('gate persists before acknowledgement and blocks Chromium and Node remote requests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-gate-'));
  let beforeRequest;
  const fakeSession = {
    webRequest: {
      onBeforeRequest(_filter, listener) { beforeRequest = listener; },
    },
  };
  const fakeGlobal = {
    fetch: async () => ({ ok: true }),
  };
  const gate = new LocalNetworkGate({ storageDir: root });
  gate.install(fakeSession);
  gate.installNodeGuards(fakeGlobal);
  gate.enable({ epoch: 1, sessionId: 's1' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'local-network-gate.json'))).active, true);
  assert.throws(() => gate.assertAllowed('https://example.com'), /disabled/i);
  assert.doesNotThrow(() => gate.assertAllowed('http://127.0.0.1:1234'));
  assert.throws(() => fakeGlobal.fetch('https://example.com'), /disabled/i);
  let decision;
  beforeRequest({ url: 'wss://example.com/socket' }, (value) => { decision = value; });
  assert.deepEqual(decision, { cancel: true });
  gate.disable({ epoch: 2, sessionId: 's1' });
  assert.doesNotThrow(() => gate.assertAllowed('https://example.com'));
  gate.dispose();
});
