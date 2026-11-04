'use strict';

// Portable, data-only traceability validation. It never opens a path supplied by
// an evidence document. Execution and report parsing live in the separate runner.
const crypto = require('node:crypto');
const SCHEMA = 'reverie.test-traceability.v1';
const CANDIDATE = '6b625494f70612a523a96b8b653675c06eb21ddd';
const TEST_FILES = Object.freeze({
  python: ['tests/test_worldbook_engine.py', 'tests/test_worldbook_regex.py',
    'tests/test_worldbook_runtime.py', 'tests/test_persona_runtime_linearization.py'],
  node: ['frontend/script/acceptance-isolation.test.cjs', 'frontend/script/macos-confirm-error.test.cjs'],
  vitest: ['frontend/src/lib/archiveOperationScope.test.ts', 'frontend/src/lib/worldbookDiagnostics.test.ts',
    'frontend/src/hooks/useReverieWS.test.ts', 'frontend/src/components/MvpRoom/MvpBoundary.test.ts'],
  tools: ['frontend/script/macos-evidence.test.cjs', 'frontend/script/evidence-test-map.test.cjs',
    'frontend/script/evidence-facts.test.cjs'],
});
const PRODUCT_FILES = Object.freeze([
  'src/worldbook/__init__.py', 'src/worldbook/engine.py', 'src/worldbook/regex_supervisor.py',
  'src/worldbook/regex_worker.py', 'src/worldbook/runtime.py', 'src/bridge/ws_bridge.py',
  'src/chat/session.py', 'src/mvp_runtime.py', 'src/archive/__init__.py', 'src/archive/store.py',
  'src/chat/proactive.py', 'src/persona/identity.py', 'src/persona/persona_card.py',
  'frontend/script/acceptance-isolation.cjs', 'frontend/script/macos-confirm-error.swift',
  'frontend/script/smoke-packaged-macos.cjs', 'frontend/src/lib/archiveOperationScope.ts',
  'frontend/src/lib/worldbookDiagnostics.ts', 'frontend/src/hooks/useReverieWS.ts',
  'frontend/src/index.tsx', 'frontend/src/hooks/useMvpBridge.ts', 'frontend/src/components/MvpRoom/index.tsx',
  'frontend/src/components/MvpRoom/MvpRoom.module.scss', 'frontend/src/components/MvpRoom/BundledCharacter.tsx',
  'frontend/src/components/AvatarView/Live2DAdapter.tsx', 'frontend/vitest.config.ts', 'frontend/vitest.setup.ts',
  'pytest.ini', 'conftest.py', 'requirements-macos-arm64-dev.lock', 'requirements-macos-arm64.lock', 'frontend/pnpm-lock.yaml',
]);
const TOOL_FILES = Object.freeze(['frontend/script/macos-evidence.cjs', 'frontend/script/evidence-test-map.cjs',
  'frontend/script/run-evidence-targeted.cjs', 'frontend/script/evidence-facts.cjs']);
const REQUIREMENTS = Object.freeze([
  ['regex-negative-errors', 'python', 'tests/test_worldbook_regex.py', 'invalid_participating_regex|catastrophic_negative_auxiliary'],
  ['regex-actual-reap-and-cancel', 'python', 'tests/test_worldbook_regex.py', 'timeout_kills_actual|cancellation_kills|aclose_during|creation_barrier|repeated_cancellation'],
  ['regex-bounds-and-protocol', 'python', 'tests/test_worldbook_regex.py', 'startup_timeout|startup_budget|total_execution|input_limits|encoded_request|invalid_worker_output|missing_worker|cleanup_timeout'],
  ['regex-cross-turn-barrier', 'python', 'tests/test_worldbook_engine.py', 'failed_ended_cleanup|pending_cleanup|live_concurrent|engine_cancellation'],
  ['worldbook-snapshot-integrity', 'python', 'tests/test_worldbook_engine.py', 'snapshot_'],
  ['worldbook-budget-and-recursion', 'python', 'tests/test_worldbook_engine.py', 'budget|recursive|recursion|priority|ties_and_duplicate|separator|scan_depth|always_active'],
  ['worldbook-revision-and-storage', 'python', 'tests/test_worldbook_runtime.py', 'captured_turn|save_disable_delete|corrupt_snapshot|regex_error_is_revision'],
  ['archive-persona-lock', 'python', 'tests/test_worldbook_runtime.py', 'archive_waiting_for_persona_lock'],
  ['persona-result-boundary', 'python', 'tests/test_persona_runtime_linearization.py', 'test_'],
  ['isolation-entry-and-identity', 'node', 'frontend/script/acceptance-isolation.test.cjs', '.'],
  ['native-synthetic-controller', 'node', 'frontend/script/macos-confirm-error.test.cjs', '.'],
  ['archive-async-identity', 'vitest', 'frontend/src/lib/archiveOperationScope.test.ts', '.'],
  ['worldbook-ui-diagnostics', 'vitest', 'frontend/src/lib/worldbookDiagnostics.test.ts', '.'],
  ['bridge-and-ui-boundaries', 'vitest', 'frontend/src/hooks/useReverieWS.test.ts', '.'],
  ['room-boundaries', 'vitest', 'frontend/src/components/MvpRoom/MvpBoundary.test.ts', '.'],
  ['portable-evidence-semantics', 'tools', 'frontend/script/macos-evidence.test.cjs', '.'],
  ['test-traceability-contract', 'tools', 'frontend/script/evidence-test-map.test.cjs', '.'],
  ['producer-facts', 'tools', 'frontend/script/evidence-facts.test.cjs', '.'],
]);
const HISTORICAL_IDS = Object.freeze(['candidate-python-file-results', 'candidate-vitest-batch-results',
  'candidate-node-named-results', 'package-worldbook-seven-scenarios']);
const NON_CLAIMS = Object.freeze(['no-application-launched', 'no-application-rebuilt-or-resigned',
  'not-old-full-regression', 'not-new-package-acceptance', 'hash-binding-not-authentication']);
const CONTROLS = Object.freeze({ dataDirectory: 'fresh-batch-scratch', temporaryDirectory:'fresh-batch-scratch',
  dotenvDisabled:true, pythonNoUserSite:true, modelOffline:true, browserDownloadsDisabled:true,
  pytestAutoloadDisabled:true, pytestPlugins:'repository-conftest-asyncio-shim',
  inheritedPythonOverridesRemoved:true, productionStorageFlagsRemoved:true,
  nativeTargetScope:'synthetic-only', applicationLaunchAllowed:false });
const allFiles = new Set([...Object.values(TEST_FILES).flat(), ...PRODUCT_FILES, ...TOOL_FILES]);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
function fail() { const e = new Error('Invalid controlled test traceability'); e.code = 'ERR_EVIDENCE_COVERAGE'; throw e; }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))) fail();
}
function array(value, maximum = 10000) { if (!Array.isArray(value) || value.length > maximum) fail(); return value; }
function unique(values) { if (new Set(values).size !== values.length) fail(); }
function digest(value) { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value; }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail(); }
function number(value) { if (!Number.isFinite(value) || value < 0) fail(); }
function stamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(); }
function report(value) { exact(value, ['sha256', 'bytes', 'digestKind']); digest(value.sha256); integer(value.bytes);
  if (value.digestKind !== 'raw-machine-report-file-sha256') fail(); }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function caseId(runner, testFile, name) { return `${runner}-${hash(`${testFile}\0${hash(name)}`).slice(0, 24)}`; }
function matchingRequirements(runner, testFile, name) {
  return REQUIREMENTS.filter(([, r, f, pattern]) => r === runner && f === testFile && new RegExp(pattern).test(name)).map(([id]) => id);
}
function validateCoverage(value) {
  exact(value, ['schema', 'candidateCommit', 'generatedAt', 'batches', 'requirements', 'historical', 'nonClaims']);
  if (value.schema !== SCHEMA || value.candidateCommit !== CANDIDATE) fail(); stamp(value.generatedAt);
  if (JSON.stringify(value.nonClaims) !== JSON.stringify(NON_CLAIMS)) fail();
  const allCases = new Map(), batchIds = new Set();
  for (const b of array(value.batches, 20)) {
    exact(b, ['id', 'runner', 'executionCommit', 'sourceBinding', 'controls', 'startedAt', 'finishedAt', 'report', 'cases', 'sources', 'counts', 'granularity']);
    if (JSON.stringify(b.controls) !== JSON.stringify(CONTROLS)) fail();
    if (!Object.hasOwn(TEST_FILES, b.runner) || typeof b.id !== 'string'
      || !new RegExp(`^${b.runner}-[a-f0-9]{16}$`).test(b.id) || batchIds.has(b.id)) fail();
    batchIds.add(b.id); if (!COMMIT.test(b.executionCommit)) fail(); stamp(b.startedAt); stamp(b.finishedAt);
    if (b.finishedAt < b.startedAt || b.granularity !== 'case') fail(); report(b.report);
    const sources = array(b.sources, 100); unique(sources.map(s => s.path));
    for (const s of sources) {
      exact(s, ['path', 'bytes', 'sha256', 'candidateSha256', 'matchesCandidate', 'executionCommitSha256', 'matchesExecutionCommit']);
      if (!allFiles.has(s.path)) fail(); integer(s.bytes); digest(s.sha256);
      if (s.candidateSha256 !== null) digest(s.candidateSha256);
      if (s.matchesCandidate !== (s.candidateSha256 !== null && s.sha256 === s.candidateSha256)) fail();
      if (s.executionCommitSha256 !== null) digest(s.executionCommitSha256);
      if (s.matchesExecutionCommit !== (s.executionCommitSha256 !== null && s.sha256 === s.executionCommitSha256)) fail();
    }
    exact(b.sourceBinding, ['scope', 'worktreeClean', 'selectedFilesStatus', 'changedSourceCount', 'uncommittedSourceCount']);
    const changed = sources.filter(s => s.executionCommitSha256 !== null && !s.matchesExecutionCommit).length;
    const uncommitted = sources.filter(s => s.executionCommitSha256 === null).length;
    if (b.sourceBinding.scope !== 'selected-files-against-execution-commit' || typeof b.sourceBinding.worktreeClean !== 'boolean'
      || b.sourceBinding.changedSourceCount !== changed || b.sourceBinding.uncommittedSourceCount !== uncommitted
      || b.sourceBinding.selectedFilesStatus !== (changed || uncommitted ? 'modified' : 'clean')
      || (b.sourceBinding.worktreeClean && (changed || uncommitted))) fail();
    const sourceNames = new Set(sources.map(s => s.path));
    if ([...TEST_FILES[b.runner], ...PRODUCT_FILES, ...TOOL_FILES].some(p => !sourceNames.has(p))) fail();
    const counts = { passed: 0, failed: 0, skipped: 0 };
    const ids = new Set();
    for (const c of array(b.cases)) {
      exact(c, ['id', 'testFile', 'selector', 'nameSha256', 'result', 'durationMs', 'requirements']);
      if (!new RegExp(`^${b.runner}-[a-f0-9]{24}$`).test(c.id) || ids.has(c.id)
        || !TEST_FILES[b.runner].includes(c.testFile) || !sourceNames.has(c.testFile)
        || !Object.hasOwn(counts, c.result)) fail();
      ids.add(c.id); number(c.durationMs); counts[c.result]++;
      digest(c.nameSha256);
      if (c.id !== `${b.runner}-${hash(`${c.testFile}\0${c.nameSha256}`).slice(0,24)}`) fail();
      if (typeof c.selector !== 'string' || !(b.runner === 'python' ? /^test_[a-zA-Z0-9_]{1,180}$/ : /^case-[0-9]{4,6}$/).test(c.selector)) fail();
      unique(array(c.requirements, 30));
      for (const req of c.requirements) if (!REQUIREMENTS.some(([id,r,f]) => req === id && r === b.runner && f === c.testFile)) fail();
      if (JSON.stringify(c.requirements) !== JSON.stringify(matchingRequirements(b.runner, c.testFile, c.selector))) fail();
      allCases.set(`${b.id}/${c.id}`, c);
    }
    if (TEST_FILES[b.runner].some(p => !b.cases.some(c => c.testFile === p))) fail();
    exact(b.counts, ['passed', 'failed', 'skipped']);
    if (Object.keys(counts).some(k => counts[k] !== b.counts[k])) fail();
  }
  const expected = REQUIREMENTS.filter(([,runner]) => value.batches.some(b => b.runner === runner)).map(([id]) => id);
  unique(array(value.requirements, 30).map(r => r.id));
  if (JSON.stringify([...value.requirements.map(r => r.id)].sort()) !== JSON.stringify([...expected].sort())) fail();
  for (const r of value.requirements) {
    exact(r, ['id', 'evidence', 'result']);
    const expectedEvidence = [...allCases].filter(([,c]) => c.requirements.includes(r.id)).map(([key]) => key).sort();
    unique(array(r.evidence));
    if (!r.evidence.length || JSON.stringify([...r.evidence].sort()) !== JSON.stringify(expectedEvidence)) fail();
    const results = r.evidence.map(key => allCases.get(key)?.result);
    const result = results.includes('failed') ? 'failed' : results.includes('skipped') ? 'with-skips' : 'passed';
    if (r.result !== result) fail();
  }
  unique(array(value.historical, 10).map(h => h.id));
  for (const h of value.historical) {
    exact(h, ['id', 'sourceCommit', 'reportSha256', 'logSha256', 'locator', 'granularity', 'result', 'rerun']);
    if (!HISTORICAL_IDS.includes(h.id) || h.sourceCommit !== CANDIDATE || h.rerun !== false) fail(); digest(h.reportSha256);
    const rules = {
      'candidate-python-file-results': ['source.steps.pytest', 'file'],
      'candidate-vitest-batch-results': ['source.steps.frontend-test.vitest', 'batch'],
      'candidate-node-named-results': ['source.steps.frontend-test.node', 'named-case'],
      'package-worldbook-seven-scenarios': ['application.worldbookContract.steps.0-6', 'scenario'],
    };
    if (h.id === 'package-worldbook-seven-scenarios') { if (h.logSha256 !== null) fail(); } else digest(h.logSha256);
    if (h.locator !== rules[h.id][0] || h.granularity !== rules[h.id][1] || !['passed', 'failed', 'unknown'].includes(h.result)) fail();
  }
  return JSON.parse(JSON.stringify(value));
}
function buildCoverage(batches, historical = []) {
  const requirements = REQUIREMENTS.filter(([,runner]) => batches.some(b => b.runner === runner)).map(([id]) => {
    const found = batches.flatMap(b => b.cases.filter(c => c.requirements.includes(id)).map(c => ({key: `${b.id}/${c.id}`, result: c.result})));
    return { id, evidence: found.map(c => c.key), result: found.some(c => c.result === 'failed') ? 'failed'
      : found.some(c => c.result === 'skipped') ? 'with-skips' : 'passed' };
  });
  return validateCoverage({schema: SCHEMA, candidateCommit: CANDIDATE, generatedAt: new Date().toISOString(),
    batches, requirements, historical, nonClaims: [...NON_CLAIMS]});
}
module.exports = { SCHEMA, CANDIDATE, TEST_FILES, PRODUCT_FILES, TOOL_FILES, REQUIREMENTS, NON_CLAIMS, CONTROLS,
  validateCoverage, buildCoverage, caseId, matchingRequirements, hash };
