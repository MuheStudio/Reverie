'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  BridgeSupervisor,
  secretHash,
  validateReadyPayload,
} = require('./bridge-supervisor.cjs');

function fakeChild(pid = 2468) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  };
  return child;
}

const PERSONA_PROOF = {
  personaId: 'builtin_hoshino_yumetsuki',
  personaEpoch: 1,
  personaFingerprint: 'b'.repeat(64),
  localModeSessionId: null,
};

test('bridge ready record is bound to loopback, PID, digest, and protocol version', () => {
  const secret = 'a'.repeat(43);
  const expected = { pid: 12, secretSha256: secretHash(secret) };
  const valid = {
    schema: 'reverie.bridge.ready.v1',
    host: '127.0.0.1',
    port: 49152,
    pid: 12,
    secretSha256: expected.secretSha256,
    protocolVersion: 2,
    ...PERSONA_PROOF,
  };
  assert.equal(validateReadyPayload(valid, expected).port, 49152);
  assert.throws(() => validateReadyPayload({ ...valid, host: '0.0.0.0' }, expected), /loopback/i);
  assert.throws(() => validateReadyPayload({ ...valid, pid: 13 }, expected), /PID/i);
  assert.throws(() => validateReadyPayload({ ...valid, secretSha256: '0'.repeat(64) }, expected), /digest/i);
});

test('supervisor creates a 32-byte secret, parses random-port ready, and correlates control ack', async () => {
  const child = fakeChild();
  let context;
  const supervisor = new BridgeSupervisor({
    spawnChild(value) { context = value; return child; },
    readyTimeoutMs: 1000,
    controlTimeoutMs: 1000,
  });
  const readyPromise = supervisor.start({ localMode: { active: false, epoch: 0 } });
  assert.match(context.secret, /^[A-Za-z0-9_-]{43}$/);
  child.stdout.write(`REVERIE_BRIDGE_READY ${JSON.stringify({
    schema: 'reverie.bridge.ready.v1',
    host: '127.0.0.1',
    port: 54321,
    pid: child.pid,
    secretSha256: secretHash(context.secret),
    protocolVersion: 2,
    localModeEpoch: 0,
    ...PERSONA_PROOF,
  })}\n`);
  const config = await readyPromise;
  assert.equal(config.url, 'ws://127.0.0.1:54321');
  assert.equal(config.secret, context.secret);

  let stdin = '';
  child.stdin.on('data', (chunk) => { stdin += chunk.toString('utf8'); });
  const controlPromise = supervisor.setLocalMode({ active: true, epoch: 2, sessionId: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(stdin.trim());
  assert.equal(request.schema, 'reverie.bridge.control.v1');
  child.stdout.write(`REVERIE_BRIDGE_CONTROL ${JSON.stringify({
    schema: 'reverie.bridge.control.ack.v1',
    requestId: request.requestId,
    active: true,
    epoch: 2,
    sessionId: 's1',
    ok: true,
  })}\n`);
  assert.equal((await controlPromise).epoch, 2);
  await supervisor.stopAndWait();
  assert.equal(supervisor.child, null);
});

test('supervisor rejects a ready record with the wrong persisted local-mode epoch', async () => {
  const child = fakeChild(3333);
  let context;
  const supervisor = new BridgeSupervisor({
    spawnChild(value) { context = value; return child; },
    readyTimeoutMs: 1000,
  });
  const promise = supervisor.start({ localMode: { active: true, epoch: 9 } });
  child.stdout.write(`REVERIE_BRIDGE_READY ${JSON.stringify({
    schema: 'reverie.bridge.ready.v1',
    host: '127.0.0.1',
    port: 50001,
    pid: child.pid,
    secretSha256: secretHash(context.secret),
    protocolVersion: 2,
    localModeEpoch: 8,
    ...PERSONA_PROOF,
  })}\n`);
  await assert.rejects(promise, /epoch mismatch/i);
});

test('credential and native-backup controls are request-correlated and never return secrets or paths', async () => {
  const child = fakeChild(4444);
  let context;
  const supervisor = new BridgeSupervisor({
    spawnChild(value) { context = value; return child; },
    readyTimeoutMs: 1000,
    controlTimeoutMs: 1000,
  });
  const readyPromise = supervisor.start({ localMode: { active: false, epoch: 0 } });
  child.stdout.write(`REVERIE_BRIDGE_READY ${JSON.stringify({
    schema: 'reverie.bridge.ready.v1',
    host: '127.0.0.1',
    port: 50002,
    pid: child.pid,
    secretSha256: secretHash(context.secret),
    protocolVersion: 2,
    localModeEpoch: 0,
    ...PERSONA_PROOF,
  })}\n`);
  await readyPromise;

  const requests = [];
  let stdin = '';
  child.stdin.on('data', (chunk) => {
    stdin += chunk.toString('utf8');
    let newline;
    while ((newline = stdin.indexOf('\n')) >= 0) {
      requests.push(JSON.parse(stdin.slice(0, newline)));
      stdin = stdin.slice(newline + 1);
    }
  });

  const credentialPromise = supervisor.setCredentials({
    llm: { apiKey: 'private-control-canary' },
    imageGen: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const credentialRequest = requests.shift();
  assert.equal(credentialRequest.type, 'credentials:set');
  child.stdout.write(`REVERIE_BRIDGE_CONTROL ${JSON.stringify({
    schema: 'reverie.bridge.control.ack.v1',
    type: 'credentials:set',
    requestId: credentialRequest.requestId,
    applied: { llm: true, imageGen: false },
    ok: true,
  })}\n`);
  const credentialResult = await credentialPromise;
  assert.deepEqual(credentialResult, { applied: { llm: true, imageGen: false } });
  assert.equal(JSON.stringify(credentialResult).includes('canary'), false);

  const backupPromise = supervisor.backupToFile('C:\\Users\\owner\\backup.json');
  await new Promise((resolve) => setImmediate(resolve));
  const backupRequest = requests.shift();
  assert.equal(backupRequest.type, 'backup:file:export');
  child.stdout.write(`REVERIE_BRIDGE_CONTROL ${JSON.stringify({
    schema: 'reverie.bridge.control.ack.v1',
    type: 'backup:file:export',
    requestId: backupRequest.requestId,
    operation: 'export',
    ok: true,
  })}\n`);
  const backupResult = await backupPromise;
  assert.deepEqual(backupResult, { operation: 'export', completed: true });
  assert.equal(JSON.stringify(backupResult).includes('Users'), false);
  await supervisor.stopAndWait();
});
