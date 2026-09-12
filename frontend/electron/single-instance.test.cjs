'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { acquireSingleInstance } = require('./single-instance.cjs');

test('a second desktop host is rejected and the existing window is reused', () => {
  let quitCount = 0;
  let listener = null;
  const denied = {
    requestSingleInstanceLock: () => false,
    quit: () => { quitCount += 1; },
    on: () => { throw new Error('must not register when denied'); },
  };
  assert.equal(acquireSingleInstance(denied, () => {}), false);
  assert.equal(quitCount, 1);
  assert.equal(denied.exitCode, 2, 'a denied launch exits with a distinct code');

  let reuseCount = 0;
  const acquired = {
    requestSingleInstanceLock: () => true,
    quit: () => { throw new Error('must not quit when acquired'); },
    on: (event, value) => {
      assert.equal(event, 'second-instance');
      listener = value;
    },
  };
  assert.equal(acquireSingleInstance(acquired, () => { reuseCount += 1; }), true);
  listener();
  assert.equal(reuseCount, 1);
});

test('a redirected launch surfaces a user-visible notice after focusing', () => {
  const calls = [];
  let listener = null;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, value) => { listener = value; },
  };
  acquireSingleInstance(
    app,
    () => { calls.push('focus'); },
    {
      onRedirected: () => {
        calls.push('notice');
        throw new Error('notification backend exploded');
      },
    },
  );
  listener();
  assert.deepEqual(calls, ['focus', 'notice'], 'notice runs after focusing');
});

test('a failing notice callback never breaks the focus path', () => {
  let focusCount = 0;
  let listener = null;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, value) => { listener = value; },
  };
  acquireSingleInstance(
    app,
    () => { focusCount += 1; },
    { onRedirected: () => { throw new Error('boom'); } },
  );
  listener();
  assert.equal(focusCount, 1);
});

test('the notice callback is optional', () => {
  let focusCount = 0;
  let listener = null;
  const app = {
    requestSingleInstanceLock: () => true,
    on: (event, value) => { listener = value; },
  };
  acquireSingleInstance(app, () => { focusCount += 1; });
  listener();
  assert.equal(focusCount, 1);
});
