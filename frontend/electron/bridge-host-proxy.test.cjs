'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  BridgeHostProxy,
  normalizeFrame,
} = require('./bridge-host-proxy.cjs');

test('host proxy exposes only framed stdio and forwards declared typed frames', async () => {
  const broadcasts = [];
  const sent = [];
  const supervisor = Object.assign(new EventEmitter(), {
    transport: 'stdio-framed',
    generation: 3,
    waitUntilReady: async () => ({
      clientId: 'electron_host_123',
      personaId: 'persona',
      personaEpoch: 1,
      personaFingerprint: 'a'.repeat(64),
      runtimeDegraded: false,
      runtimeUnavailable: [],
    }),
    sendBusinessFrame: (frame) => {
      sent.push(frame);
      return { accepted: true };
    },
  });
  const proxy = new BridgeHostProxy({
    supervisor,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  const renderer = await proxy.connect();
  assert.equal(renderer.transport, 'electron-ipc');
  assert.equal(renderer.secret, '');

  supervisor.emit('message', { type: 'emotion:update', payload: { joy: 2 } });
  assert.deepEqual(broadcasts.at(-1), {
    channel: 'bridge:message',
    payload: { type: 'emotion:update', payload: { joy: 2 } },
  });
  proxy.sendFromRenderer({ type: 'emotion:get', payload: {} });
  assert.equal(sent.at(-1).type, 'emotion:get');
  assert.throws(
    () => proxy.sendFromRenderer({ type: 'bridge:auth', payload: {} }),
    /authentication/i,
  );
});

test('production host proxy rejects legacy websocket supervisors', () => {
  assert.throws(
    () => new BridgeHostProxy({
      supervisor: { transport: 'websocket' },
      broadcast: () => {},
    }),
    /framed stdio/i,
  );
});

test('renderer bridge frames reject prototypes, invalid IDs, arrays, and oversized data', () => {
  assert.deepEqual(
    normalizeFrame({ type: 'memory:query', payload: {}, request_id: 'rpc_12345678' }, { renderer: true }),
    { type: 'memory:query', payload: {}, request_id: 'rpc_12345678' },
  );
  assert.throws(() => normalizeFrame({ type: '../bad', payload: {} }, { renderer: true }));
  assert.throws(
    () => normalizeFrame({ type: 'chat:chunk', payload: {} }, { renderer: true }),
    /not declared/i,
  );
  assert.throws(() => normalizeFrame({ type: 'ok', payload: [] }, { renderer: true }));
  assert.throws(() => normalizeFrame({ type: 'ok', payload: {}, request_id: 'x' }, { renderer: true }));
  assert.throws(() => normalizeFrame({
    type: 'memory:query',
    payload: { data: 'x'.repeat(4 * 1024 * 1024) },
  }, { renderer: true }), /large/i);
});
