'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SCHEMA, replaySummaryView } = require('./summary-view-replay.cjs');

test('replay records every failed host assertion without throwing', () => {
  const replay = replaySummaryView({ reports: [], memoryFixture: { events: [] }, modelCalls: [], requests: 0 });
  assert.equal(replay.schema, SCHEMA);
  assert.equal(replay.acceptance, false);
  assert.equal(replay.diagnosticOnly, true);
  assert(replay.failedAssertionCalls > 1, 'replay stopped at the first failure');
  assert.equal(replay.failedAssertionCalls, replay.failures.length);
  assert(replay.failures.every(failure => Number.isInteger(failure.line)), 'failure lost its verifier line');
});

test('replay leaves the formal verifier strict', () => {
  replaySummaryView({});
  const { verifySummaryView } = require('./summary-view-verdicts.cjs');
  assert.throws(() => verifySummaryView({}), assert.AssertionError);
});

test('replay keeps only content-free hints', () => {
  const replay = replaySummaryView({ reports: [{ summaryView: { schema: 'stored text must not be copied' } }] });
  for (const failure of replay.failures)
    for (const side of [failure.actual, failure.expected])
      if (side.type === 'string') assert.deepEqual(Object.keys(side).sort(), ['length', 'type']);
  assert(!JSON.stringify(replay).includes('stored text must not be copied'), 'replay copied a stored string');
});
