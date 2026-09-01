'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  FrameDecoder,
  FramedBridgeSupervisor,
  encodeFrame,
  validateReady,
} = require('./framed-bridge-supervisor.cjs');
const { secretHash } = require('./bridge-supervisor.cjs');

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

test('Windows launcher PID differences retain the secret-bound authority proof', () => {
  const ready = {
    kind: 'ready',
    schema: 'reverie.bridge.stdio.ready.v4',
    transport: 'stdio-framed',
    pid: 9002,
    secretSha256: secretHash('owner-secret'),
    protocolVersion: 4,
    localModeEpoch: 0,
    localModeSessionId: null,
    personaId: 'persona',
    personaEpoch: 1,
    personaFingerprint: 'a'.repeat(64),
  };
  const expected = {
    pid: 9001,
    secretSha256: secretHash('owner-secret'),
    localModeEpoch: 0,
    localModeSessionId: null,
  };
  assert.throws(() => validateReady(ready, expected), /PID mismatch/);
  assert.equal(
    validateReady(ready, { ...expected, allowPidMismatch: true }).bridgePid,
    9002,
  );
  assert.throws(
    () => validateReady(
      { ...ready, secretSha256: secretHash('attacker-secret') },
      { ...expected, allowPidMismatch: true },
    ),
    /secret digest/i,
  );
});

test('frame decoder handles fragmented and coalesced frames and rejects oversized lengths', () => {
  const values = [];
  const decoder = new FrameDecoder((value) => values.push(value));
  const joined = Buffer.concat([encodeFrame({ one: 1 }), encodeFrame({ two: 2 })]);
  decoder.push(joined.subarray(0, 3));
  decoder.push(joined.subarray(3));
  assert.deepEqual(values, [{ one: 1 }, { two: 2 }]);
  assert.throws(() => {
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(0xffffffff);
    decoder.push(bad);
  }, /length/i);
});

test('framed supervisor correlates private controls and business events without a port', async () => {
  const child = fakeChild();
  let context;
  const supervisor = new FramedBridgeSupervisor({
    spawnChild(value) { context = value; return child; },
    readyTimeoutMs: 1000,
    controlTimeoutMs: 1000,
  });
  const ready = supervisor.start({
    localMode: { active: false, epoch: 0, sessionId: null },
  });
  child.stdout.write(encodeFrame({
    kind: 'ready',
    schema: 'reverie.bridge.stdio.ready.v4',
    transport: 'stdio-framed',
    pid: child.pid,
    secretSha256: secretHash(context.secret),
    protocolVersion: 4,
    localModeEpoch: 0,
    localModeSessionId: null,
    personaId: 'persona',
    personaEpoch: 1,
    personaFingerprint: 'a'.repeat(64),
  }));
  const config = await ready;
  assert.equal(config.transport, 'stdio-framed');
  assert.equal(JSON.stringify(config).includes('secret'), false);

  const sent = [];
  const input = new FrameDecoder((value) => sent.push(value));
  child.stdin.on('data', (chunk) => input.push(chunk));
  const control = supervisor.setCredentials({ llm: { apiKey: 'canary' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].kind, 'control');
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'credentials:set',
    requestId: sent[0].requestId,
    applied: { llm: true, imageGen: false },
    ok: true,
  }));
  assert.deepEqual(await control, { applied: { llm: true, imageGen: false } });

  const amapControl = supervisor.requestAmapNearby({
    api_key: 'amap-canary', latitude: 39.9, longitude: 116.4,
    radius_m: 1200, place_types: ['cafe'],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const amapFrame = sent.at(-1);
  assert.equal(amapFrame.type, 'amap:nearby');
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'amap:nearby',
    requestId: amapFrame.requestId,
    ok: true,
    success: false,
    code: 'quota',
    items: [],
  }));
  assert.deepEqual(await amapControl, {
    ok: false, code: 'quota', items: [], provider: 'Amap',
  });

  const providerRead = supervisor.getProviderConfig();
  await new Promise((resolve) => setImmediate(resolve));
  const getFrame = sent.at(-1);
  assert.equal(getFrame.type, 'provider:get');
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'provider:get',
    requestId: getFrame.requestId,
    llm: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      base_url: 'https://api.deepseek.com',
      has_api_key: true,
      model_epoch: 3,
    },
    ok: true,
  }));
  assert.deepEqual(await providerRead, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    hasApiKey: true,
    modelEpoch: 3,
  });

  const providerWrite = supervisor.configureProvider({
    provider: 'openai',
    model: 'gpt-5.4',
    base_url: 'https://api.openai.com/v1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const configureFrame = sent.at(-1);
  assert.equal(configureFrame.type, 'provider:configure');
  assert.deepEqual(configureFrame.llm, {
    provider: 'openai',
    model: 'gpt-5.4',
    base_url: 'https://api.openai.com/v1',
  });
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'provider:configure',
    requestId: configureFrame.requestId,
    llm: {
      provider: 'openai',
      model: 'gpt-5.4',
      base_url: 'https://api.openai.com/v1',
      has_api_key: false,
      model_epoch: 4,
    },
    optional_ai_consents_revoked: true,
    cancelled_optional_ai_tasks: 2,
    ok: true,
  }));
  assert.deepEqual(await providerWrite, {
    provider: 'openai',
    model: 'gpt-5.4',
    baseUrl: 'https://api.openai.com/v1',
    hasApiKey: false,
    modelEpoch: 4,
    optionalAiConsentsRevoked: true,
    cancelledOptionalAiTasks: 2,
  });

  const providerTest = supervisor.testProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com',
  }, { apiKey: 'private-canary' });
  await new Promise((resolve) => setImmediate(resolve));
  const testFrame = sent.at(-1);
  assert.equal(testFrame.type, 'provider:test');
  assert.equal(testFrame.credential.apiKey, 'private-canary');
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'provider:test',
    requestId: testFrame.requestId,
    provider: 'deepseek',
    model: 'deepseek-chat',
    latency_ms: 321,
    finish_reason: 'stop',
    ok: true,
  }));
  assert.deepEqual(await providerTest, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    latencyMs: 321,
    finishReason: 'stop',
  });

  const failedProviderTest = supervisor.testProvider({
    provider: 'openai',
    model: 'gpt-test',
    base_url: 'https://api.openai.com/v1',
  }, { apiKey: 'private-canary' });
  await new Promise((resolve) => setImmediate(resolve));
  const failedFrame = sent.at(-1);
  child.stdout.write(encodeFrame({
    kind: 'control_result',
    schema: 'reverie.bridge.stdio.control.v4',
    type: 'provider:test',
    requestId: failedFrame.requestId,
    ok: false,
    code: 'PROVIDER_TIMEOUT',
    error: 'The requested local control operation was rejected',
    retryable: true,
  }));
  await assert.rejects(failedProviderTest, (error) => (
    error.code === 'PROVIDER_TIMEOUT' && error.retryable === true
  ));

  supervisor.sendBusinessFrame({
    type: 'memory:query',
    payload: {
      query: 'blueberries',
      expected_persona_id: 'renderer-forgery',
    },
    request_id: 'rpc_memory_query_01',
  });
  const command = sent.at(-1);
  assert.equal(command.kind, 'renderer_command');
  assert.equal(command.schema, 'reverie.command.v4');
  assert.equal(command.envelope.protocol_version, 4);
  assert.equal(command.envelope.command, 'memory:query');
  assert.deepEqual(command.envelope.persona, {
    persona_id: 'persona',
    epoch: 1,
    fingerprint: 'a'.repeat(64),
  });
  assert.equal(command.envelope.payload.expected_persona_id, undefined);

  supervisor.sendBusinessFrame({
    type: 'immersion:nearby',
    payload: {
      latitude: 31.2304,
      longitude: 121.4737,
      radius_m: 1200,
      place_types: ['restaurant', 'shop', 'cafe', 'supermarket', 'park'],
    },
    request_id: 'rpc_immersion_nearby_01',
  });
  const immersionCommand = sent.at(-1);
  assert.equal(immersionCommand.kind, 'renderer_command');
  assert.equal(immersionCommand.schema, 'reverie.command.v4');
  assert.equal(immersionCommand.envelope.command, 'immersion:nearby');
  assert.deepEqual(immersionCommand.envelope.payload, {
    latitude: 31.2304,
    longitude: 121.4737,
    radius_m: 1200,
    place_types: ['restaurant', 'shop', 'cafe', 'supermarket', 'park'],
  });
  assert.equal(immersionCommand.envelope.payload.accuracy_m, undefined);
  assert.throws(
    () => supervisor.sendBusinessFrame({ type: 'local_mode:set', payload: {} }),
    /not declared/i,
  );

  const event = new Promise((resolve) => supervisor.once('message', resolve));
  child.stdout.write(encodeFrame({
    kind: 'event',
    frame: { type: 'emotion:update', payload: { joy: 2 } },
  }));
  assert.deepEqual(await event, { type: 'emotion:update', payload: { joy: 2 } });
});

function handshakeSupervisor(child) {
  let context;
  const supervisor = new FramedBridgeSupervisor({
    spawnChild(value) { context = value; return child; },
    readyTimeoutMs: 1000,
    controlTimeoutMs: 1000,
  });
  const ready = supervisor.start({
    localMode: { active: false, epoch: 0, sessionId: null },
  });
  child.stdout.write(encodeFrame({
    kind: 'ready',
    schema: 'reverie.bridge.stdio.ready.v4',
    transport: 'stdio-framed',
    pid: child.pid,
    secretSha256: secretHash(context.secret),
    protocolVersion: 4,
    localModeEpoch: 0,
    localModeSessionId: null,
    personaId: 'persona',
    personaEpoch: 1,
    personaFingerprint: 'a'.repeat(64),
  }));
  return { supervisor, ready };
}

test('bridge death mid-write surfaces as an exit event, not an uncaught stdin error', async () => {
  const child = fakeChild();
  const { supervisor, ready } = handshakeSupervisor(child);
  const config = await ready;
  assert.equal(config.transport, 'stdio-framed');

  const exitPromise = new Promise((resolve) => supervisor.once('exit', resolve));
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  child.stdin.emit('error', epipe);
  const error = await exitPromise;
  assert.equal(error.code, 'EPIPE');
});

test('synchronous stdin write failure tears the bridge down and rethrows to the caller', async () => {
  const child = fakeChild();
  const { supervisor, ready } = handshakeSupervisor(child);
  await ready;

  const exitPromise = new Promise((resolve) => supervisor.once('exit', resolve));
  child.stdin.write = () => {
    throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' });
  };
  assert.throws(
    () => supervisor.sendBusinessFrame({ type: 'memory:query', payload: { query: 'x' } }),
    /write after end/,
  );
  const error = await exitPromise;
  assert.equal(error.code, 'ERR_STREAM_DESTROYED');
});

test('a fatal_error reply kills the bridge but still surfaces an exit event for host restart', async () => {
  const child = fakeChild();
  const { supervisor, ready } = handshakeSupervisor(child);
  await ready;

  const exitPromise = new Promise((resolve) => supervisor.once('exit', resolve));
  child.stdout.write(encodeFrame({
    kind: 'fatal_error',
    schema: 'reverie.bridge.stdio.control.v4',
    code: 'REVERIE_COMMAND_REJECTED',
    error: 'The private bridge rejected an invalid command',
  }));
  const error = await exitPromise;
  assert.match(String(error.message), /rejected an invalid command/);
  assert.equal(supervisor.ready, null);
  assert.equal(supervisor.child, null);
});

test('validateReady forwards model epoch and persona restart signals with safe defaults', () => {
  const base = {
    kind: 'ready',
    schema: 'reverie.bridge.stdio.ready.v4',
    transport: 'stdio-framed',
    pid: 9003,
    secretSha256: secretHash('owner-secret'),
    protocolVersion: 4,
    localModeEpoch: 0,
    localModeSessionId: null,
    personaId: 'persona',
    personaEpoch: 1,
    personaFingerprint: 'a'.repeat(64),
  };
  const expected = {
    pid: 9003,
    secretSha256: secretHash('owner-secret'),
    localModeEpoch: 0,
    localModeSessionId: null,
  };
  const configured = validateReady({ ...base, modelEpoch: 7, personaRestartRequired: true }, expected);
  assert.equal(configured.modelEpoch, 7);
  assert.equal(configured.personaRestartRequired, true);
  const legacy = validateReady(base, expected);
  assert.equal(legacy.modelEpoch, 0);
  assert.equal(legacy.personaRestartRequired, false);
});
