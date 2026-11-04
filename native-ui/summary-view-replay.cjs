'use strict';
// Diagnostic-only replay of the summary host verdict over saved run output.
// The formal verifier is loaded unchanged; only inside this replay its strict
// assert is swapped for a recorder that logs each failure and continues, so one
// saved run lists every host assertion that fails instead of only the first.
// The result is never an acceptance verdict and never rewrites the evidence.
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const strict = require('node:assert/strict');

const VERDICTS = path.join(__dirname, 'summary-view-verdicts.cjs');
const SCHEMA = 'reverie.summary-view-host-replay.v1';
const MAX_FAILURES = 200;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Only bounded, content-free hints are kept: numbers, booleans, null, digests
// and sizes. Strings and structures that could carry stored text are omitted.
function hint(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return { type: value === null ? 'null' : typeof value, value };
  if (typeof value === 'string') return HEX64.test(value) ? { type: 'digest', value } : { type: 'string', length: value.length };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  return { type: value === undefined ? 'undefined' : typeof value };
}

function verdictLine(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const match = line.match(/summary-view-verdicts\.cjs:(\d+):\d+/);
    if (match) return Number(match[1]);
  }
  return null;
}

function recorder(state) {
  const capture = (operator, call) => {
    state.calls += 1;
    try { call(); } catch (error) {
      if (!(error instanceof strict.AssertionError)) throw error;
      state.failedCalls += 1;
      if (state.failures.length < MAX_FAILURES)
        state.failures.push({ order: state.calls, line: verdictLine(new Error().stack), operator,
          message: String(error.message).split('\n')[0], actual: hint(error.actual), expected: hint(error.expected) });
      else state.truncated = true;
    }
  };
  const assert = (value, message) => capture('ok', () => strict(value, message));
  for (const name of Object.keys(strict)) {
    if (typeof strict[name] !== 'function' || name === 'AssertionError') continue;
    assert[name] = (...args) => capture(name, () => strict[name](...args));
  }
  assert.AssertionError = strict.AssertionError;
  assert.strict = assert;
  return assert;
}

function loadRecordingVerifier(state) {
  const load = Module._load;
  delete require.cache[VERDICTS];
  Module._load = function patched(request, parent, ...rest) {
    if (parent?.filename === VERDICTS && (request === 'node:assert/strict' || request === 'assert/strict'))
      return recorder(state);
    return load.call(this, request, parent, ...rest);
  };
  try { return require(VERDICTS); } finally {
    Module._load = load;
    delete require.cache[VERDICTS];
  }
}

function replaySummaryView(result) {
  const state = { calls: 0, failedCalls: 0, failures: [], truncated: false };
  const { verifySummaryView } = loadRecordingVerifier(state);
  let returned = false, aborted = null;
  try { verifySummaryView(result); returned = true; } catch (error) {
    aborted = { line: verdictLine(error.stack), name: error.name, message: String(error.message).split('\n')[0] };
  }
  return { schema: SCHEMA, acceptance: false, diagnosticOnly: true,
    verifierSha256: sha256(fs.readFileSync(VERDICTS)), assertionCalls: state.calls,
    failedAssertionCalls: state.failedCalls, failures: state.failures, failuresTruncated: state.truncated,
    distinctFailedLines: [...new Set(state.failures.map(failure => failure.line))],
    reachedVerdictReturn: returned, aborted };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node summary-view-replay.cjs <saved summary.json> <new output.json>');
    process.exit(2);
  }
  if (fs.existsSync(output)) {
    console.error(`refusing to overwrite ${output}`);
    process.exit(2);
  }
  const bytes = fs.readFileSync(input);
  const replay = { ...replaySummaryView(JSON.parse(bytes.toString('utf8'))),
    input: { file: path.basename(input), sha256: sha256(bytes) } };
  fs.writeFileSync(output, `${JSON.stringify(replay, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ failedAssertionCalls: replay.failedAssertionCalls,
    distinctFailedLines: replay.distinctFailedLines, reachedVerdictReturn: replay.reachedVerdictReturn,
    aborted: replay.aborted }));
}

module.exports = { SCHEMA, replaySummaryView };
