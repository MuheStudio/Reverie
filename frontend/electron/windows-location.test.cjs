'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  WindowsLocationProvider,
  validateResult,
} = require('./windows-location.cjs');

function fakeChild({ output = '', code = 0, delay = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('close', null);
  queueMicrotask(() => {
    if (delay > 0) {
      setTimeout(() => {
        if (output) child.stdout.emit('data', Buffer.from(output));
        child.emit('close', code);
      }, delay);
    } else {
      if (output) child.stdout.emit('data', Buffer.from(output));
      child.emit('close', code);
    }
  });
  return child;
}

test('validates and normalizes a WinRT coordinate result', () => {
  assert.deepEqual(validateResult({
    ok: true,
    status: 'Ready',
    latitude: 31.23,
    longitude: 121.47,
    accuracy: 42,
    timestamp: '2026-07-25T12:00:00+08:00',
  }), {
    ok: true,
    code: 'REVERIE_LOCATION_OK',
    status: 'Ready',
    latitude: 31.23,
    longitude: 121.47,
    accuracy: 42,
    timestamp: '2026-07-25T04:00:00.000Z',
    source: 'windows-winrt',
  });
});

test('rejects malformed, out-of-range, and unknown native output', () => {
  assert.equal(validateResult({ ok: true, latitude: 100, longitude: 0, accuracy: 1 }).ok, false);
  assert.equal(validateResult({ ok: false, code: 'UNTRUSTED_CODE' }).code, 'REVERIE_LOCATION_NATIVE_FAILURE');
});

test('returns typed permission denial without leaking native error text', async () => {
  const provider = new WindowsLocationProvider({
    platform: 'win32',
    spawnImpl: () => fakeChild({
      output: JSON.stringify({
        ok: false,
        code: 'REVERIE_LOCATION_PERMISSION_DENIED',
        status: 'Denied',
        nativeMessage: 'private machine detail',
      }),
    }),
  });
  const result = await provider.requestCurrent();
  assert.deepEqual(result, {
    ok: false,
    code: 'REVERIE_LOCATION_PERMISSION_DENIED',
    status: 'Denied',
    source: 'windows-winrt',
  });
});

test('coalesces duplicate requests and terminates a hung native adapter', async () => {
  let spawns = 0;
  const provider = new WindowsLocationProvider({
    platform: 'win32',
    timeoutMs: 10,
    spawnImpl: () => {
      spawns += 1;
      return fakeChild({ delay: 100 });
    },
  });
  const first = provider.requestCurrent();
  const second = provider.requestCurrent();
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.code, 'REVERIE_LOCATION_TIMEOUT');
  assert.equal(spawns, 1);
});
