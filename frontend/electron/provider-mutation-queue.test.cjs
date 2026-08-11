'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ProviderMutationQueue } = require('./provider-mutation-queue.cjs');

test('provider mutations are serialized and continue after a rejection', async () => {
  const queue = new ProviderMutationQueue();
  const events = [];
  let releaseFirst;
  const first = queue.enqueue(async () => {
    events.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:fail');
    throw new Error('expected failure');
  });
  const second = queue.enqueue(async () => {
    events.push('second:start');
    return 'second:done';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'second:done');
  assert.deepEqual(events, ['first:start', 'first:fail', 'second:start']);
});
