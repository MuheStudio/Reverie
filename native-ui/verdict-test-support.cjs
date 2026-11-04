'use strict';
const assert = require('node:assert/strict');

// Diagnostic-only labels. They neither evaluate nor replace verdict conditions.
function contextStrings(context) {
  assert(context && typeof context === 'object' && !Array.isArray(context), 'Rejection context must be an object');
  const out = {};
  for (const key of Object.keys(context).sort()) {
    const value = context[key];
    assert(/^[A-Za-z][A-Za-z0-9_]*$/.test(key), 'Invalid rejection context key');
    assert(['string', 'number', 'boolean'].includes(typeof value) &&
      (typeof value !== 'number' || Number.isFinite(value)), 'Invalid rejection context value');
    out[key] = String(value);
  }
  return out;
}
function verdictReason(id, context = {}, detail = '') {
  assert(typeof id === 'string' && /^[A-Z][A-Z0-9_]*$/.test(id), 'Invalid rejection identifier');
  assert(context && typeof context === 'object' && !Array.isArray(context), 'Rejection context must be an object');
  const fields = {};
  for (const key of Object.keys(context).sort()) {
    assert(/^[A-Za-z][A-Za-z0-9_]*$/.test(key), 'Invalid rejection context key');
    const value = context[key];
    // Invalid evidence must still reach its original guard. Missing diagnostic
    // values are labelled, never coerced to a valid ID, number or success flag.
    fields[key] = value === null ? 'null' :
      ['string','number','boolean','undefined'].includes(typeof value) ? String(value) : 'invalid-' + typeof value;
  }
  return '[' + id + ']' + Object.keys(fields).map(key => '[' + key + '=' + encodeURIComponent(fields[key]) + ']').join('') +
    (detail ? ' ' + String(detail) : '');
}
function rejectionIdentity(error) {
  if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION') return null;
  const message = String(error.message), first = /^\[([A-Z][A-Z0-9_]*)\]/.exec(message);
  if (!first) return null;
  const context = {}; let rest = message.slice(first[0].length);
  while (rest.startsWith('[')) {
    const match = /^\[([A-Za-z][A-Za-z0-9_]*)=([^\]]*)\]/.exec(rest);
    if (!match || Object.hasOwn(context, match[1])) return null;
    try { context[match[1]] = decodeURIComponent(match[2]); } catch { return null; }
    rest = rest.slice(match[0].length);
  }
  if (rest && !/^\s/.test(rest)) return null;
  return { reason: first[1], context };
}
function synchronousResult(result, phase) {
  if (result && typeof result.then === 'function') throw new TypeError('Negative fixtures require a synchronous ' + phase);
  return result;
}
function checkedCall(verify, value) {
  const result = synchronousResult(verify(value), 'verifier');
  if (result === false || (result && typeof result === 'object' && Object.hasOwn(result, 'passed') && result.passed !== true))
    throw new Error('Verifier returned non-success without a tagged rejection');
  return result;
}
function invalidBaseline(id, error) {
  const failure = new assert.AssertionError({actual: error, expected: 'valid pristine fixture', operator: 'baseline',
    message: verdictReason('NEGATIVE_BASELINE_INVALID', {mutation: id}, 'Pristine fixture failed before mutation')});
  failure.cause = error;
  return failure;
}

// Every call owns a fresh baseline. File factories must allocate a new temporary
// file set; their dispose callback runs even if baseline validation or mutation
// fails. No validator or mutator exception is interpreted outside its phase.
function assertRejectedMutation({id, makeFixture, verify, mutate, expectedReason, expectedContext = {}, kind = 'value', dispose}) {
  assert(typeof id === 'string' && /^[A-Za-z0-9_.:-]+$/.test(id), 'A literal mutation ID is required');
  assert(typeof makeFixture === 'function' && typeof verify === 'function' && typeof mutate === 'function', 'Mutation callbacks missing');
  assert(kind === 'value' || kind === 'files', 'Unknown mutation fixture kind');
  assert(kind !== 'files' || typeof dispose === 'function', 'File fixture cleanup is required');
  verdictReason(expectedReason, expectedContext); // Validate the declared expectation, never learn it from an error.
  const expected = {reason: expectedReason, context: contextStrings(expectedContext)};
  let base;
  try {
    base = synchronousResult(makeFixture(), 'factory');
    try { checkedCall(verify, base); } catch (error) { throw invalidBaseline(id, error); }
    let changed = base;
    if (kind === 'value') {
      try {
        changed = JSON.parse(JSON.stringify(base));
        checkedCall(verify, changed);
      } catch (error) { throw invalidBaseline(id, error); }
    }
    synchronousResult(mutate(changed), 'mutator'); // Deliberately outside the expected-rejection catch.
    let rejected = false, caught;
    try { checkedCall(verify, changed); } catch (error) { rejected = true; caught = error; }
    assert(rejected, verdictReason('NEGATIVE_NOT_REJECTED', {mutation: id}, 'Mutation was accepted'));
    const actual = rejectionIdentity(caught);
    assert.deepEqual(actual, expected, verdictReason('NEGATIVE_REJECTION_MISMATCH', {mutation: id},
      'Wrong rejection: expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
    return {id, expectedReason, expectedContext: expected.context, rejected: true};
  } finally {
    if (dispose && base !== undefined) synchronousResult(dispose(base), 'disposer');
  }
}
module.exports = {verdictReason, rejectionIdentity, assertRejectedMutation};
