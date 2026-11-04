'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runForcedCleanup } = require('./forced-cleanup.cjs');

test('normal cleanup reports explicit false and skips instances without root identity', () => {
  const unowned = {}, owned = { rootIdentity: {} }, inspected = [];
  const result = runForcedCleanup([unowned, owned], {
    remainingProcesses(running) { inspected.push(running); return []; },
    signalOwned() { assert.fail('No target may receive a signal'); }
  });
  assert.deepEqual(inspected, [owned]);
  assert.deepEqual(result, {
    forcedCleanup: false, forcedCleanupTargets: 0, forcedCleanupSignalsSent: 0,
    forcedCleanupIdentityChanged: 0, forcedCleanupErrors: []
  });
});

test('residual targets receive one guarded SIGKILL each in descending pid order per instance', () => {
  const first = { rootIdentity: {} }, second = { rootIdentity: {} };
  const targets = new Map([
    [first, Object.freeze([{ pid: 21 }, { pid: 23 }, { pid: 22 }])],
    [second, Object.freeze([{ pid: 41 }, { pid: 40 }])]
  ]);
  const calls = [];
  const result = runForcedCleanup([first, second], {
    remainingProcesses(running) { return targets.get(running); },
    signalOwned(running, target, signal) { calls.push([running, target, signal]); return true; }
  });
  assert.deepEqual(calls, [
    [first, targets.get(first)[1], 'SIGKILL'],
    [first, targets.get(first)[2], 'SIGKILL'],
    [first, targets.get(first)[0], 'SIGKILL'],
    [second, targets.get(second)[0], 'SIGKILL'],
    [second, targets.get(second)[1], 'SIGKILL']
  ]);
  assert.deepEqual(result, {
    forcedCleanup: true, forcedCleanupTargets: 5, forcedCleanupSignalsSent: 5,
    forcedCleanupIdentityChanged: 0, forcedCleanupErrors: []
  });
});

test('identity changes count as found targets without counting a signal sent', () => {
  const running = { rootIdentity: {} }, target = { pid: 99 }, calls = [];
  const result = runForcedCleanup([running], {
    remainingProcesses() { return [target]; },
    signalOwned(...args) { calls.push(args); return false; }
  });
  assert.deepEqual(calls, [[running, target, 'SIGKILL']]);
  assert.deepEqual(result, {
    forcedCleanup: true, forcedCleanupTargets: 1, forcedCleanupSignalsSent: 0,
    forcedCleanupIdentityChanged: 1, forcedCleanupErrors: []
  });
});

test('cleanup errors are bounded and do not prevent later targets or instances', () => {
  const unavailable = { rootIdentity: {} }, first = { rootIdentity: {} }, last = { rootIdentity: {} };
  const targets = Array.from({ length: 12 }, (_, i) => ({ pid: i + 1 }));
  const inspected = [], calls = [];
  const result = runForcedCleanup([unavailable, first, {}, last], {
    remainingProcesses(running) {
      inspected.push(running);
      if (running === unavailable) throw new Error('Cannot inspect owned processes');
      return running === first ? targets : [{ pid: 30 }];
    },
    signalOwned(running, target, signal) {
      calls.push([running, target.pid, signal]);
      if (running === first && target.pid > 1) throw new Error('x'.repeat(1000));
      return true;
    }
  });
  assert.deepEqual(inspected, [unavailable, first, last]);
  assert.deepEqual(calls, [
    ...targets.slice().reverse().map(target => [first, target.pid, 'SIGKILL']),
    [last, 30, 'SIGKILL']
  ]);
  assert.equal(result.forcedCleanup, true);
  assert.equal(result.forcedCleanupTargets, 13);
  assert.equal(result.forcedCleanupSignalsSent, 2);
  assert.equal(result.forcedCleanupIdentityChanged, 0);
  assert.equal(result.forcedCleanupErrors.length, 8);
  assert.equal(result.forcedCleanupErrors[0], 'remainingProcesses: Cannot inspect owned processes');
  assert(result.forcedCleanupErrors.slice(1).every(message => message.length === 240 && message.startsWith('signalOwned: ')));

  const observationFailure = runForcedCleanup([unavailable], {
    remainingProcesses() { throw new Error('Cannot inspect owned processes'); },
    signalOwned() { assert.fail('Observation failure must not authorize a signal'); }
  });
  assert.deepEqual(observationFailure, {
    forcedCleanup: false, forcedCleanupTargets: 0, forcedCleanupSignalsSent: 0,
    forcedCleanupIdentityChanged: 0,
    forcedCleanupErrors: ['remainingProcesses: Cannot inspect owned processes']
  });
});
