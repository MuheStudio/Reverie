'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { enterLocalModeWithDegradedBridge } = require('./focus-local-mode-transition.cjs');

function gateHarness() {
  const state = { active: false, epoch: 0, sessionId: null };
  let disableCalls = 0;
  return {
    state,
    get disableCalls() { return disableCalls; },
    networkGate: {
      enable({ epoch, sessionId }) {
        Object.assign(state, { active: true, epoch, sessionId });
        return { ...state };
      },
      disable() {
        disableCalls += 1;
        Object.assign(state, { active: false });
      },
    },
  };
}

test('companion timer starts behind the host gate while Python is unavailable', async () => {
  const gate = gateHarness();
  let starts = 0;
  let stops = 0;
  const result = await enterLocalModeWithDegradedBridge({
    networkGate: gate.networkGate,
    bridge: { child: {}, ready: null },
    epoch: 7,
    sessionId: 'companion-1',
    stopBridge: async () => { stops += 1; },
    startBridge: () => { starts += 1; },
  });
  assert.equal(result.bridgeAcknowledged, false);
  assert.equal(gate.state.active, true);
  assert.equal(gate.disableCalls, 0);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
});

test('an inconsistent bridge is killed but can never reopen the host gate', async () => {
  const gate = gateHarness();
  let failures = 0;
  const result = await enterLocalModeWithDegradedBridge({
    networkGate: gate.networkGate,
    bridge: {
      child: {},
      ready: {},
      setLocalMode: async () => ({ active: false, epoch: 1 }),
    },
    epoch: 8,
    sessionId: 'companion-2',
    stopBridge: async () => {},
    startBridge: () => {},
    onBridgeFailure: () => { failures += 1; },
  });
  assert.equal(result.bridgeAcknowledged, false);
  assert.equal(gate.state.active, true);
  assert.equal(gate.disableCalls, 0);
  assert.equal(failures, 1);
});

test('an authenticated acknowledgement reports the fully synchronized state', async () => {
  const gate = gateHarness();
  const result = await enterLocalModeWithDegradedBridge({
    networkGate: gate.networkGate,
    bridge: {
      child: {},
      ready: {},
      setLocalMode: async ({ epoch, sessionId }) => ({ active: true, epoch, sessionId }),
    },
    epoch: 9,
    sessionId: 'companion-3',
  });
  assert.equal(result.bridgeAcknowledged, true);
  assert.equal(gate.state.active, true);
  assert.equal(gate.disableCalls, 0);
});
