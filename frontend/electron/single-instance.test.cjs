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
