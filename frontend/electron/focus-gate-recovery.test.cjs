'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcileFocusNetworkGate } = require('./focus-gate-recovery.cjs');

test('missing Focus module preserves an orphaned active gate instead of reopening networking', () => {
  let disabled = false;
  const state = { active: true, epoch: 7, sessionId: 'focus-crashed' };
  const networkGate = {
    snapshot: () => ({ ...state }),
    disable: () => { disabled = true; throw new Error('must not disable'); },
  };
  const result = reconcileFocusNetworkGate(networkGate, null);
  assert.equal(result.available, false);
  assert.equal(result.gateState.active, true);
  assert.equal(disabled, false);
});

test('inactive Focus state preserves a persisted manual gate for explicit user release', () => {
  let disabled = false;
  const state = { active: true, epoch: 11, sessionId: 'manual-123' };
  const networkGate = {
    snapshot: () => ({ ...state }),
    disable: () => { disabled = true; throw new Error('must not disable'); },
  };
  const focusManager = {
    getState: () => ({ localModeActive: false, epoch: 4, id: null }),
  };

  const result = reconcileFocusNetworkGate(networkGate, focusManager);

  assert.equal(result.available, true);
  assert.deepEqual(result.gateState, state);
  assert.equal(disabled, false);
});

test('inactive Focus state also fails closed for an ambiguous orphaned gate', () => {
  const state = { active: true, epoch: 9, sessionId: 'focus-crashed' };
  const networkGate = {
    snapshot: () => ({ ...state }),
    disable: () => { throw new Error('must not disable an ambiguous gate'); },
  };
  const focusManager = {
    getState: () => ({ localModeActive: false, epoch: 9, id: null }),
  };

  const result = reconcileFocusNetworkGate(networkGate, focusManager);

  assert.equal(result.gateState.active, true);
  assert.equal(result.gateState.epoch, 9);
});
