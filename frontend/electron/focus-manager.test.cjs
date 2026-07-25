'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FocusManager, SCHEMA } = require('./focus-manager.cjs');

function createClock() {
  let wall = Date.parse('2026-01-01T00:00:00.000Z');
  let monotonic = 10_000;
  const timers = [];
  return {
    now: () => wall,
    monotonicNow: () => monotonic,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    advance(ms) { wall += ms; monotonic += ms; },
    jumpWall(ms) { wall += ms; },
    timers,
  };
}

test('focus duration uses monotonic time, validates bounds, and releases local mode on completion', async () => {
  const clock = createClock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-'));
  const gates = [];
  const effects = [];
  const manager = new FocusManager({
    storageDir: root,
    ...clock,
    enterLocalMode: async (value) => { gates.push(['enter', value]); return value; },
    exitLocalMode: async (value) => { gates.push(['exit', value]); return value; },
    onCompletion: async (effect) => effects.push(effect.id),
  });
  await assert.rejects(() => manager.start({ durationSeconds: 59 }), /between/i);
  await manager.start({ durationSeconds: 60 });
  clock.advance(10_000);
  clock.jumpWall(24 * 60 * 60 * 1000);
  assert.equal(manager.getState().remainingSeconds, 50);
  clock.advance(50_000);
  const activeTimer = clock.timers.findLast((timer) => !timer.cleared);
  activeTimer.callback();
  await manager.operation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getState().phase, 'completed');
  assert.equal(manager.getState().localModeActive, false);
  assert.equal(effects.length, 1);
  assert.deepEqual(gates.map(([name]) => name), ['enter', 'exit']);
});

test('generation prevents a stale timer from completing a resumed session', async () => {
  const clock = createClock();
  const manager = new FocusManager({
    storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-')),
    ...clock,
  });
  await manager.start({ durationSeconds: 60 });
  const stale = clock.timers.at(-1);
  clock.advance(10_000);
  await manager.pause();
  await manager.resume();
  stale.callback();
  await manager.operation;
  assert.equal(manager.getState().phase, 'running');
  assert.equal(manager.getState().remainingSeconds, 50);
});

test('system resume consumes sleep from the persisted deadline even if monotonic time paused', async () => {
  const clock = createClock();
  const exits = [];
  const manager = new FocusManager({
    storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-')),
    ...clock,
    enterLocalMode: async (value) => value,
    exitLocalMode: async (value) => { exits.push(value); return value; },
  });
  await manager.start({ durationSeconds: 60 });
  clock.jumpWall(61_000);
  // The pre-resume monotonic anchor intentionally still sees 60 seconds.
  assert.equal(manager.getState().phase, 'running');
  const state = await manager.reconcileAfterResume();
  assert.equal(state.phase, 'completed');
  assert.equal(state.localModeActive, false);
  assert.equal(exits.length, 1);
});

test('crash during starting is recovered fail-closed and releases the gate once', async () => {
  const clock = createClock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-'));
  fs.writeFileSync(path.join(root, 'focus-state.json'), JSON.stringify({
    schema: SCHEMA,
    phase: 'starting',
    id: 'session-crash',
    generation: 3,
    epoch: 7,
    durationSeconds: 600,
    remainingSeconds: 600,
    startedAtUtc: '2026-01-01T00:00:00.000Z',
    endsAtUtc: null,
    pausedAtUtc: null,
    completedAtUtc: null,
    stoppedAtUtc: null,
    localModeActive: false,
    requiresAudioRearm: false,
    completionEffect: null,
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
  }));
  const exits = [];
  const manager = new FocusManager({
    storageDir: root,
    ...clock,
    exitLocalMode: async (value) => { exits.push(value); return value; },
  });
  await manager.operation;
  assert.equal(manager.getState().phase, 'stopped');
  assert.equal(manager.getState().localModeActive, false);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].epoch, 8);
});

test('claimed completion effect is deterministic and never emitted twice after restart', async () => {
  const clock = createClock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-'));
  const effect = {
    id: 'focus-complete:s1',
    source: 'local_focus',
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    claimedAtUtc: '2026-01-01T00:00:01.000Z',
    deliveredAtUtc: null,
  };
  fs.writeFileSync(path.join(root, 'focus-state.json'), JSON.stringify({
    schema: SCHEMA,
    phase: 'completed',
    id: 's1',
    generation: 1,
    epoch: 2,
    durationSeconds: 60,
    remainingSeconds: 0,
    startedAtUtc: '2025-12-31T23:59:00.000Z',
    endsAtUtc: '2026-01-01T00:00:00.000Z',
    pausedAtUtc: null,
    completedAtUtc: '2026-01-01T00:00:00.000Z',
    stoppedAtUtc: null,
    localModeActive: false,
    requiresAudioRearm: false,
    completionEffect: effect,
    updatedAtUtc: '2026-01-01T00:00:01.000Z',
  }));
  let count = 0;
  const manager = new FocusManager({
    storageDir: root,
    ...clock,
    onCompletion: () => { count += 1; },
  });
  await manager.operation;
  assert.equal(count, 0);
  assert.equal(manager.getState().completionEffect.id, effect.id);
});

test('corrupt primary focus state is quarantined and valid backup is used', () => {
  const clock = createClock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-focus-'));
  fs.writeFileSync(path.join(root, 'focus-state.json'), '{broken');
  fs.writeFileSync(path.join(root, 'focus-state.backup.json'), JSON.stringify({
    schema: SCHEMA,
    phase: 'idle',
    id: null,
    generation: 4,
    epoch: 9,
    durationSeconds: 0,
    remainingSeconds: 0,
    startedAtUtc: null,
    endsAtUtc: null,
    pausedAtUtc: null,
    completedAtUtc: null,
    stoppedAtUtc: null,
    localModeActive: false,
    requiresAudioRearm: false,
    completionEffect: null,
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
  }));
  const manager = new FocusManager({ storageDir: root, ...clock });
  assert.equal(manager.getState().epoch, 9);
  assert.ok(fs.readdirSync(root).some((name) => name.includes('.corrupt-')));
});
