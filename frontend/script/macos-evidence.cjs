'use strict';

// An evidence derivative, not a recursive copy of a report directory. Every
// exported property has a type-specific allowlist below. No log/data file is
// opened, and paths in the input are never followed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateCoverage } = require('./evidence-test-map.cjs');
const { projectApplicationFacts, validateApplicationFacts, projectSummaryFacts, validateSummaryFacts } = require('./evidence-facts.cjs');

const SCHEMA = 'reverie.portable-evidence.v2';
const LEGACY_SCHEMA = 'reverie.portable-evidence.v1';
const VERIFICATION_SCHEMA = 'reverie.portable-evidence-verification.v2';
const MAX_BYTES = 64 * 1024 * 1024;
const HASH = 'raw-file-bytes-sha256';
const SOURCE_DIGEST = 'ordered-source-inventory-json-sha256';
const BUNDLE_DIGEST = 'ordered-signed-app-inventory-json-sha256';
const SUMMARY_DIGEST = 'redacted-evidence-json-file-sha256';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesFor = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const ERROR_CODES = Object.freeze({
  DOCUMENT: 'ERR_EVIDENCE_DOCUMENT', INTEGRITY: 'ERR_EVIDENCE_INTEGRITY',
  CLAIM: 'ERR_EVIDENCE_CLAIM', BINDING: 'ERR_EVIDENCE_BINDING',
  FILESYSTEM: 'ERR_EVIDENCE_FILESYSTEM', USAGE: 'ERR_EVIDENCE_USAGE',
  FACTS: 'ERR_EVIDENCE_FACTS', COVERAGE: 'ERR_EVIDENCE_COVERAGE',
});
const fail = (message, code = ERROR_CODES.DOCUMENT) => {
  const error = new Error(`Evidence: ${message}`);
  error.code = code;
  throw error;
};
function failureResult(error) {
  const trusted = Object.values(ERROR_CODES).includes(error?.code);
  const code = trusted ? error.code : ERROR_CODES.FILESYSTEM;
  const message = trusted ? error.message : 'Evidence: filesystem operation failed';
  return { schema: VERIFICATION_SCHEMA, valid: false, integrity: 'not-established',
    claimConsistency: code === ERROR_CODES.CLAIM ? 'failed' : 'not-established',
    acceptance: {}, error: { code, message } };
}
function checkedOperation(fn) {
  try { return fn(); } catch (error) {
    const result = failureResult(error);
    const safe = new Error(result.error.message);
    safe.code = result.error.code;
    safe.result = result;
    throw safe;
  }
}
const parseJson = (bytes) => {
  try { return JSON.parse(bytes); } catch { return fail('invalid JSON document'); }
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('unregistered or missing object field');
}
const bool = (v) => typeof v === 'boolean' ? v : fail('expected boolean');
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail('expected non-negative finite number');
const integer = (v) => Number.isSafeInteger(v) && v >= 0 ? v : fail('expected non-negative integer');
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail('invalid SHA-256');
const commit = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v) ? v : fail('invalid commit');
const token = (v) => typeof v === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:+ -]{0,159}$/.test(v) ? v : fail('invalid public identifier');
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(v) ? v : fail('invalid timestamp');
const choice = (...values) => (v) => values.includes(v) ? v : fail('invalid enumerated value');
const nullable = (fn) => (v) => v === null ? null : fn(v);
const list = (fn, max = 20000) => (value) => {
  if (!Array.isArray(value) || value.length > max) fail('invalid or oversized array');
  return value.map(fn);
};
const fields = (schema, required = []) => (value) => {
  if (!object(value)) fail('expected object');
  const output = {};
  for (const name of required) if (!Object.hasOwn(value, name)) fail(`missing field ${name}`);
  for (const [name, fn] of Object.entries(schema)) if (Object.hasOwn(value, name)) {
    try { output[name] = fn(value[name]); } catch (error) {
      if (Object.values(ERROR_CODES).includes(error.code)) { error.message = `${name}: ${error.message}`; throw error; }
      throw error;
    }
  }
  return output;
};

function relativePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value || value.includes('\\')
    || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some((p) => p === '' || p === '.' || p === '..')) fail('expected canonical relative path');
  return value;
}
function publicLink(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\')
    || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) fail('invalid relative inventory link');
  return value;
}
function inventory(value, kind) {
  const seen = new Set();
  return list((entry) => {
    if (!object(entry)) fail('invalid inventory entry');
    const p = relativePath(entry.path);
    if (seen.has(p)) fail('duplicate inventory path');
    seen.add(p);
    if (kind === 'bundle' && Object.hasOwn(entry, 'symlink')) {
      const target = publicLink(entry.symlink);
      relativePath(path.posix.normalize(path.posix.join(path.posix.dirname(p), target)));
      return { path: p, symlink: target };
    }
    // Keep the original key order: the builder hashes JSON.stringify(files).
    return kind === 'source'
      ? { path: p, sha256: digest(entry.sha256), bytes: integer(entry.bytes) }
      : { path: p, bytes: integer(entry.bytes), sha256: digest(entry.sha256) };
  })(value);
}

const stageName = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.,:+ ()-]{0,199}$/.test(v) ? v : fail('invalid stage identifier');
const timing = fields({ name: stageName, elapsedMs: number, durationMs: number, durationSeconds: number, passed: bool });
const versions = fields({ platform: token, architecture: token, python: token, pythonBuild: token, node: token, uv: token, pnpm: token,
  development: fields({ pytest: token, hypothesis: token, playwright: token, 'pytest-playwright': token, textual: token, pyyaml: token }) });
const locks = fields({ 'requirements-macos-arm64.lock': digest, 'requirements-macos-arm64-dev.lock': digest,
  'frontend/pnpm-lock.yaml': digest, 'config/macos-toolchain.json': digest });
const sourceReport = fields({ schema: token, startedAt: timestamp, finishedAt: timestamp, mode: token, status: token, toolchain: versions, locks,
  steps: list(fields({ name: token, status: token, exitCode: nullable(integer), signal: nullable(token), timedOut: bool,
    startedAt: timestamp, durationSeconds: number })) }, ['schema', 'status', 'steps']);
const policy = fields({ schema: token, scope: token, passed: bool, retiredSourceNames: list(token), requiredMediaModules: list(token),
  legacyHostReferenceAbsent: bool, legacyWorldbookImportsAbsent: bool, requiredWorldbookModules: list(token),
  inventories: list(fields({ path: relativePath, sourceTreeCommit: commit, sha256: digest, selectedBodies: integer })),
  scan: fields({ roots: list(relativePath), filesExamined: integer, hashesChecked: integer }) });
const nativeFile = fields({ path: relativePath, size: integer, sha256: digest, architectures: list(choice('arm64', 'x86_64')),
  fileType: token });
const runtimeProbe = fields({ pythonVersion: token, architecture: token, prefixMatchesRuntime: bool, basePrefixMatchesRuntime: bool,
  venv: bool, packages: list(fields({ name: token, version: token, location: relativePath,
    licenseExpression: nullable(token), licenseFiles: list(relativePath) })), imports: list(token),
  storage: list(fields({ sqlcipherVersion: token, sqliteVecVersion: token, nearestRowId: integer, mode: token })),
  networkGuard: token, plaintextReadRejected: bool });
const appAudit = fields({ schema: token, architecture: token, inventoryStage: token, mainExecutable: relativePath,
  nativeFiles: list(nativeFile), signatures: list(fields({ path: (v) => v === '.' ? '.' : relativePath(v), kind: token, verified: bool,
    identifier: token, cdHash: (v) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v) ? v : fail('invalid code-directory hash'),
    signatureKind: choice('adhoc', 'developer-id') })), entireBundleSignatureVerified: bool, applicationUnchanged: bool, ok: bool });
const buildReport = fields({ schema: token, startedAt: timestamp, completedAt: timestamp, architecture: token,
  candidate: fields({ head: commit, branch: (v) => relativePath(v), dirty: bool, sha256: digest }, ['head', 'sha256']),
  locks, sourceMigration: fields({ source: policy, staged: policy }),
  runtimeAudit: fields({ schema: token, architecture: token, nativeFiles: list(nativeFile), probe: runtimeProbe, runtimeUnchanged: bool, ok: bool }),
  appNativeAudit: appAudit,
  signing: fields({ identity: choice('-', 'adhoc', 'ad-hoc'), hardenedRuntime: bool, formalDistribution: bool, notarized: bool, crossVersionKeychainValidated: bool }),
  timings: list(timing), bundle: fields({ sha256: digest }, ['sha256']) }, ['schema', 'candidate', 'bundle']);
const packageReport = fields({ schema: token, passed: bool, codeCommit: commit, sourceSha256: digest, signedBundleSha256: digest,
  asarSha256: digest, source: policy, finalPayload: policy, modules: list(fields({ name: token, sha256: digest, bytes: integer })),
  rootLicenseUnchanged: bool, noticeMatchesSource: bool, remainingRisuPresent: bool, remainingHypaPresent: bool }, ['schema', 'passed', 'codeCommit', 'sourceSha256', 'signedBundleSha256']);

const helperResult = fields({ actionSucceeded: bool, appId: token, dialogTextVerified: bool, elapsedMs: number });
const confirmation = fields({ available: bool, attempted: bool, sha256: digest, sourceBytes: integer, elapsedMs: number,
  exitCode: nullable(integer), signal: nullable(token), result: helperResult, scratchRemoved: bool });
const validationRevision = fields({ script: relativePath, sha256: digest, commit,
  nativeErrorHelper: fields({ script: relativePath, sha256: digest }),
  nativeProcessHelper: fields({ script: relativePath, sha256: digest }),
  isolationModule: fields({ script: relativePath, sha256: digest }),
  isolationController: fields({ script: relativePath, sha256: digest }) });
const WORLDBOOK_STEPS = Object.freeze([
  'saved content A', 'next turn uses saved B', 'disabled entry omitted', 'deleted book omitted',
  'regex timeout isolates one entry', 'saved regex repair applies next turn', 'benign archive retained for restarts',
]);
function worldbookIdentity(value) {
  const result = fields({ revision: integer, checksum: digest, bookSha256: digest, entryCount: integer, noModelCall: bool },
    ['revision', 'checksum', 'bookSha256'])(value);
  if (Object.hasOwn(value, 'entryIds')) {
    if (!Array.isArray(value.entryIds) || value.entryIds.length > 10000) fail('invalid worldbook entry identity count');
    result.entryCount = value.entryIds.length;
  }
  return result;
}
const worldbookContract = fields({ passed: bool, originalRevision: integer,
  steps: list(fields({ name: choice(...WORLDBOOK_STEPS), revision: integer, actualModelPromptChecked: bool }), WORLDBOOK_STEPS.length),
  workers: fields({ spawned: integer, timeoutRecorded: bool, allReaped: bool, externalInterpreter: bool }),
  visibleWarning: bool, repairClearsWarning: bool, preservedForRestartChecks: bool, mutationsLimitedToIsolatedArchive: bool,
  finalArchive: worldbookIdentity });
const cycle = fields({ label: token, readyMs: number, protocolVersion: integer, surface: fields({ require: token, frozen: bool, platform: token }),
  startupStages: list(timing), normalQuit: bool, modelCalls: integer, protectedKeyStable: bool, encryptedDatabase: bool,
  worldbookRestored: worldbookIdentity,
  // Contents, message IDs, PIDs and paths are intentionally absent. Equality
  // across cycles is exported separately as a derived Boolean, never text.
  identityVerified: bool, isolatedDataVerified: bool });
const applicationReport = fields({ passed: bool, runId: token, completedAt: timestamp, elapsedMs: number,
  stage: stageName, stageElapsedMs: number,
  startupSampling: fields({ groups: choice(1, 2), cyclesPerGroup: choice(3), freshProfiles: choice(1, 2), automaticRetry: choice(false), systemCachesCleared: choice(false) }),
  startupGroups: list(fields({ group: integer, cycles: list(cycle), worldbookContract }), 2),
  cycles: list(cycle), negativeCases: list(fields({ kind: token, fixtureBytes: integer, diagnostic: token,
    durableHashesUnchanged: bool, authenticated: bool, nativeFatalConfirmation: confirmation, exitCode: nullable(integer), elapsedMs: number })),
  stages: list(timing), validationRevision,
  buildBinding: fields({ manifestSha256: digest, sourceSha256: digest, signedBundleSha256: digest, buildCompletedAt: timestamp, appId: token, matched: bool }),
  security: fields({ asarSha256: digest, signatureVerified: bool,
    fuses: fields({ RunAsNode: bool, EnableCookieEncryption: bool, EnableNodeOptionsEnvironmentVariable: bool,
      EnableNodeCliInspectArguments: bool, EnableEmbeddedAsarIntegrityValidation: bool, OnlyLoadAppFromAsar: bool, GrantFileProtocolExtraPrivileges: bool }) }),
  readOnly: fields({ writeRejected: bool }),
  appNativeAudit: fields({ ok: bool, applicationUnchanged: bool, nativeFileCount: integer, signatureCount: integer, loaderContextCount: integer }),
  runtimeAudit: fields({ ok: bool, runtimeUnchanged: bool, nativeFileCount: integer }),
  pythonProbe: fields({ version: list(integer, 3), cipherVersion: token }),
  keychain: fields({ metadataVerified: bool, secretExported: choice(false) }),
  mediaContract: fields({ passed: bool, defaultDisabled: bool, realDomDiscovery: bool, privateSourceAndSegmentsRejected: bool,
    noDeniedRequestsSent: bool, localModeRejected: bool, temporaryFilesAbsent: bool }),
  worldbookContract,
  applicationDiagnostics: list(fields({ label: token, startupStages: list(timing), exitCode: nullable(integer), signal: nullable(token) })),
  bundleHashBefore: digest, bundleHashAfter: digest, bundleUnchanged: bool,
  detachAttempts: list(fields({ attempt: integer, elapsedMs: number, passed: bool })),
  noResidualMounts: bool, noResidualProcesses: bool, scratchRemoved: bool }, ['passed', 'cycles']);
const DEVIATIONS = Object.freeze({
  'startup-timeout': 'Initial renderer discovery timed out. Cause unresolved; later success does not establish a fix.',
  'media-contract-failure': 'Preload rejected multiline HLS; product was repaired and a new candidate built.',
  'native-ui-diagnostic-relaunch': 'Diagnostic UI automation relaunched an exited app and touched the default test data directory. Isolation was violated; that run is excluded from acceptance.',
  'owned-scratch-cleanup': 'Owned scratch and mounts were subsequently removed after process and mount checks; no force detach.',
  'runtime-copy-permission-mismatch': 'The first candidate stopped at strict audit because copying changed runtime file modes from 0666 to 0644. Exact-mode copying was repaired and a new candidate built; the earlier candidate was preserved.',
  'windows-worldbook-layout-updated': 'The source layout gate still required the retired worldbook tree. It was updated to require the five replacement modules with tests; this does not constitute Windows execution.',
  'evidence-fixture-shared-array': 'The evidence test fixture shared an array between expected and restored records. Independent deep copies corrected the fixture; rejection assertions were unchanged.',
});
const deviationReport = (value) => ({ ...fields({ schema: token, recordedOn: timestamp })(value),
  events: list((event) => {
    const kind = choice(...Object.keys(DEVIATIONS))(event.kind);
    return { kind, statement: DEVIATIONS[kind] };
  })(value.events) });
const sourceTests = fields({ pytestPassed: integer, pytestExistingXfail: integer, pytestExistingWarning: integer, nodePassed: integer,
  nodeSkipped: integer, vitestPassed: integer, typescript: token, vite: token, desktopCore: token });
const summaryReport = fields({ schema: token, completedAt: timestamp, head: commit, branch: relativePath, localOnly: bool, pushed: bool,
  rootLicenseChanged: bool, preferredLicense: choice('Apache-2.0'), alternative: choice('MIT'), dualLicense: choice(false),
  firstBatchFunctionalAcceptance: token, allOperationalConstraintsMet: bool, dataIsolationDeviationRecorded: bool,
  worldbookFunctionalAcceptance: choice('passed', 'failed', 'not-run', 'pending', 'with-reservations'),
  automationIsolationAcceptance: choice('passed', 'failed', 'not-run', 'pending', 'with-reservations'),
  sourceTests, retainedDmg: fields({ sha256: digest }) });
const SUPPORT = 'Confirmed direct user statement; coverage of third-party rights and other contributions remains separate.';
const SCOPE = 'Portable redacted evidence derivative; not proof that all GPL obligations are resolved or a new runtime validation.';
const KEYCHAIN_SCOPE = 'Current OS user and same signed candidate only; no cross-user, cross-version or cross-signature claim.';

function equalMessages(cycles) {
  const messages = cycles.map((entry) => entry.recoveredMessages);
  if (!messages.length || !messages.every((rows) => Array.isArray(rows) && rows.length > 0
    && rows.every((row) => object(row) && typeof row.id === 'string' && row.id.length > 0
      && typeof row.role === 'string' && row.role.length > 0 && typeof row.content === 'string')
    && new Set(rows.map((row) => row.id)).size === rows.length)) return null;
  const snapshot = (rows) => JSON.stringify(rows.map(({ id, role, content }) => ({ id, role, content })));
  const first = snapshot(messages[0]);
  return messages.every((rows) => snapshot(rows) === first);
}
function sanitizeApplication(report) {
  const result = applicationReport(report);
  result.observations = projectApplicationFacts(report);
  const grouped = Array.isArray(report.startupGroups) && report.startupGroups.length > 0;
  result.recoveredMessagesAndIdsEqualAcrossCycles = grouped ? null : equalMessages(report.cycles);
  result.profileRecovery = grouped ? report.startupGroups.map((group) => ({
    group: integer(group.group), cycles: group.cycles.length, recoveredMessagesAndIdsEqual: equalMessages(group.cycles),
  })) : [];
  result.keychainScope = KEYCHAIN_SCOPE;
  result.successfulProductionMediaTransferCovered = false;
  validateSampling(result);
  validateWorldbookEvidence(result);
  return result;
}
function validateSampling(report) {
  if (report.startupGroups) {
    if (report.startupGroups.some((group, index) => group.group !== index + 1)) fail('startup group identity mismatch', ERROR_CODES.CLAIM);
    if (!isDeepStrictEqual(report.startupGroups.flatMap((group) => group.cycles), report.cycles)) fail('flattened startup sampling mismatch');
  }
  if (report.startupGroups?.length) {
    if (report.profileRecovery?.length !== report.startupGroups.length
      || report.profileRecovery.some((row, index) => row.group !== report.startupGroups[index].group
        || row.cycles !== report.startupGroups[index].cycles.length)) fail('profile recovery group mismatch', ERROR_CODES.CLAIM);
  } else if (report.profileRecovery?.length) fail('profile recovery lacks startup groups', ERROR_CODES.CLAIM);
  if (!report.startupSampling) return;
  const { groups, cyclesPerGroup, freshProfiles } = report.startupSampling;
  if (groups !== freshProfiles || !Array.isArray(report.startupGroups)
    || report.startupGroups.length > groups) fail('startup sampling group mismatch');
  if (report.passed && (report.startupGroups.length !== groups || report.cycles.length !== groups * cyclesPerGroup)) fail('successful startup sampling is incomplete');
  for (let index = 0; index < report.startupGroups.length; index++) {
    const group = report.startupGroups[index];
    if (group.group !== index + 1 || group.cycles.length > cyclesPerGroup || (report.passed && group.cycles.length !== cyclesPerGroup)) fail('startup sampling cycle mismatch');
  }
  if (!isDeepStrictEqual(report.startupGroups.flatMap((group) => group.cycles), report.cycles)) fail('flattened startup sampling mismatch');
}
function validateWorldbookEvidence(report, required = false) {
  const claimFail = (message) => fail(message, ERROR_CODES.CLAIM);
  if (required && report.passed !== true) claimFail('passed worldbook declaration conflicts with application status');
  if (!report.passed) return;
  const groups = report.startupGroups?.length ? report.startupGroups : [{ cycles: report.cycles, worldbookContract: report.worldbookContract }];
  for (const group of groups) {
    const contract = group.worldbookContract;
    if (!contract) {
      if (required) claimFail('passed worldbook declaration is missing worldbook contract');
      continue;
    }
    if (group.cycles.length !== 3) claimFail('successful worldbook contract requires three cycles and two restorations');
    if (group.cycles.some((cycle) => cycle.normalQuit !== true)) claimFail('worldbook restart lacks normal quit evidence');
    const recovered = report.startupGroups?.length
      ? report.profileRecovery?.find((row) => row.group === group.group)?.recoveredMessagesAndIdsEqual
      : report.recoveredMessagesAndIdsEqualAcrossCycles;
    if (recovered !== true) claimFail('worldbook restart message identity is not established');
    if (contract.passed !== true || !Number.isSafeInteger(contract.workers?.spawned) || contract.workers.spawned < 2
      || contract.workers?.timeoutRecorded !== true || contract.workers?.allReaped !== true || contract.workers?.externalInterpreter !== false
      || contract.visibleWarning !== true || contract.repairClearsWarning !== true
      || contract.preservedForRestartChecks !== true || contract.mutationsLimitedToIsolatedArchive !== true) claimFail('successful worldbook contract lacks required safety evidence');
    if (!isDeepStrictEqual(contract.steps?.map((step) => step.name), WORLDBOOK_STEPS)
      || contract.steps.some((step) => step.actualModelPromptChecked !== true)
      || contract.steps.at(-1).revision !== contract.finalArchive?.revision) claimFail('worldbook prompt checks do not match final archive');
    if (!Number.isSafeInteger(contract.originalRevision)
      || contract.steps.some((step, index) => step.revision !== contract.originalRevision + index + 1)) claimFail('worldbook scenario revision sequence mismatch');
    const expected = contract.finalArchive;
    if (!Number.isSafeInteger(expected?.entryCount)) claimFail('worldbook final entry count is missing');
    for (const cycle of group.cycles.slice(1)) {
      const restored = cycle.worldbookRestored;
      if (!restored || restored.noModelCall !== true || ['revision', 'checksum', 'bookSha256', 'entryCount'].some((key) => restored[key] !== expected[key])) claimFail('worldbook restart identity mismatch');
      // Historical reports may lack a counter. Keep that fact unknown; when
      // supplied, it must agree with the restoration's no-call assertion.
      if (cycle.modelCalls !== undefined && cycle.modelCalls !== 0) claimFail('worldbook restoration conflicts with recorded model calls');
    }
  }
  if (report.worldbookContract && report.startupGroups?.length
    && !isDeepStrictEqual(report.worldbookContract, report.startupGroups.at(-1).worldbookContract)) claimFail('worldbook top-level and final-group evidence mismatch');
}
function validateBindings(reports, origins, bundle) {
  const { build, packageAudit } = reports;
  const bindingFail = (message) => fail(message, ERROR_CODES.BINDING);
  if (build.candidate.head !== packageAudit.codeCommit || build.candidate.sha256 !== packageAudit.sourceSha256
    || build.bundle.sha256 !== packageAudit.signedBundleSha256) bindingFail('code/build/package identity mismatch');
  const asarRows = bundle.filter((row) => row.path === 'Contents/Resources/app.asar');
  const asarRequired = packageAudit.passed === true || [reports.application, reports.startupSampling].some((report) => report?.passed === true);
  if (asarRows.length > 1 || (asarRows.length === 1 && Object.hasOwn(asarRows[0], 'symlink'))
    || (asarRequired && asarRows.length !== 1)) bindingFail('ASAR inventory must contain exactly one regular file');
  const inventoryAsar = asarRows[0]?.sha256;
  const suppliedAsars = [packageAudit.asarSha256, inventoryAsar];
  if (packageAudit.passed && !packageAudit.asarSha256) bindingFail('successful package audit is missing ASAR identity');
  for (const report of [reports.application, reports.startupSampling].filter(Boolean)) {
    const binding = report.buildBinding;
    if (report.passed && (!binding || !binding.manifestSha256 || binding.matched !== true
      || !binding.sourceSha256 || !binding.signedBundleSha256)) bindingFail('successful application is missing build manifest identity');
    if (binding) {
      if (binding.sourceSha256 !== undefined && build.candidate.sha256 !== binding.sourceSha256
        || binding.signedBundleSha256 !== undefined && build.bundle.sha256 !== binding.signedBundleSha256
        || binding.manifestSha256 !== undefined && origins.build.sha256 !== binding.manifestSha256
        || binding.buildCompletedAt !== undefined && build.completedAt !== undefined && binding.buildCompletedAt !== build.completedAt) bindingFail('application/build manifest identity mismatch');
    }
    if (report.bundleUnchanged === true && report.bundleHashBefore !== undefined && report.bundleHashAfter !== undefined
      && report.bundleHashBefore !== report.bundleHashAfter) bindingFail('application before/after bundle identity mismatch');
    if (report.passed && !report.security?.asarSha256) bindingFail('successful application is missing ASAR identity');
    suppliedAsars.push(report.security?.asarSha256);
  }
  const present = suppliedAsars.filter((value) => value !== undefined);
  if (present.length > 0 && (inventoryAsar === undefined || present.some((value) => value !== present[0]))) bindingFail('ASAR identity mismatch');
}
function validateClaims(summary, reports) {
  validateWorldbookEvidence(reports.application, summary.worldbookFunctionalAcceptance === 'passed');
  if (summary.firstBatchFunctionalAcceptance === 'passed' && reports.application.passed !== true) fail('passed first-batch declaration conflicts with application status', ERROR_CODES.CLAIM);
  // The optional sampling report owns its own isolation run. It is never folded
  // into the application report or allowed to replace worldbook evidence.
  const isolation = reports.startupSampling || reports.application;
  if (summary.automationIsolationAcceptance === 'passed' && isolation.passed !== true) fail('passed isolation declaration conflicts with sampling status', ERROR_CODES.CLAIM);
  if (summary.automationIsolationAcceptance === 'passed') {
    const groups = isolation.startupGroups?.length ? isolation.startupGroups : [{ cycles: isolation.cycles }];
    if (groups.some((group) => group.cycles.length !== 3 || group.cycles.some((cycle) => cycle.normalQuit !== true))) fail('passed isolation requires three normal cycles in every declared group', ERROR_CODES.CLAIM);
  }
  for (const report of [reports.application, reports.startupSampling].filter(Boolean)) {
    validateFactBindings(report);
    if (report.passed && ['noResidualProcesses', 'noResidualMounts', 'scratchRemoved', 'bundleUnchanged'].some((name) => report[name] === false)) fail('passed application conflicts with cleanup failure', ERROR_CODES.CLAIM);
    if (report.passed && report.observations?.forcedCleanupCount > 0) fail('passed application conflicts with forced cleanup', ERROR_CODES.CLAIM);
    if (report.passed && report.observations?.negativeCases.some((item) => item.kind === 'missing-vault' && item.replacementKeyGenerated === true)) fail('passed application conflicts with replacement key generation', ERROR_CODES.CLAIM);
    if (report.passed && report.negativeCases?.some((item) => item.authenticated === true
      || item.durableHashesUnchanged === false)) fail('passed application conflicts with storage refusal evidence', ERROR_CODES.CLAIM);
    if (report.passed && report.cycles.some((cycle) => cycle.encryptedDatabase === false
      || cycle.protectedKeyStable === false)) fail('passed application conflicts with cycle storage protection', ERROR_CODES.CLAIM);
    if (report.passed && report.security?.signatureVerified === false) fail('passed application conflicts with signature verification failure', ERROR_CODES.CLAIM);
  }
  if (summary.automationIsolationAcceptance === 'passed' && isolation.cycles.some((cycle) =>
    cycle.identityVerified === false || cycle.isolatedDataVerified === false)) fail('passed isolation conflicts with explicit cycle verification failure', ERROR_CODES.CLAIM);
  const acceptance = {};
  for (const [name, key] of [['worldbook', 'worldbookFunctionalAcceptance'], ['automationIsolation', 'automationIsolationAcceptance'],
    ['firstBatch', 'firstBatchFunctionalAcceptance']]) if (summary[key] !== undefined) acceptance[name] = summary[key];
  acceptance.application = reports.application.passed ? 'passed' : 'failed';
  if (reports.startupSampling) acceptance.startupSampling = reports.startupSampling.passed ? 'passed' : 'failed';
  return acceptance;
}
function validateFactBindings(report) {
  const facts = report.observations;
  if (!facts) return; // Original v1 facts remain unknown.
  if (facts.cycles.length !== report.cycles.length || facts.cycles.some((item, index) => item.label !== report.cycles[index].label
    || item.identityVerified !== (report.cycles[index].identityVerified ?? null)
    || item.isolatedDataVerified !== (report.cycles[index].isolatedDataVerified ?? null))) fail('producer cycle observation mismatch', ERROR_CODES.BINDING);
  if (facts.negativeCaseRecordsAvailable !== Object.hasOwn(report, 'negativeCases')
    || !isDeepStrictEqual(facts.negativeCases.map((item) => item.kind), (report.negativeCases || []).map((item) => item.kind))) fail('producer negative-case observation mismatch', ERROR_CODES.BINDING);
  const revision = report.validationRevision || {};
  const expected = { validatorSha256: revision.sha256 ?? null,
    isolationControllerSha256: (revision.isolationController || revision.isolationModule)?.sha256 ?? null,
    nativeHelperSha256: (revision.nativeErrorHelper || revision.nativeProcessHelper)?.sha256 ?? null };
  if (!isDeepStrictEqual(facts.producer, expected)) fail('producer validator observation mismatch', ERROR_CODES.BINDING);
}
function validateCoverageBindings(coverage, reports, source, origins) {
  if (!coverage) return;
  if (coverage.candidateCommit !== reports.build.candidate.head) fail('test traceability candidate mismatch', ERROR_CODES.BINDING);
  for (const historical of coverage.historical) {
    const original = historical.id === 'package-worldbook-seven-scenarios' ? origins.application : origins.source;
    if (historical.reportSha256 !== original.sha256) fail('historical traceability raw report mismatch', ERROR_CODES.BINDING);
    if (historical.result === 'unknown') continue;
    if (historical.id === 'package-worldbook-seven-scenarios') {
      if (historical.result === 'passed') validateWorldbookEvidence(reports.application, true);
      else if (reports.application.passed === true && reports.application.worldbookContract?.passed === true) fail('historical worldbook result conflicts with application evidence', ERROR_CODES.CLAIM);
    } else {
      const stage = historical.id === 'candidate-python-file-results' ? 'pytest' : 'frontend-test';
      const matches = reports.source.steps.filter((step) => step.name === stage);
      if (matches.length !== 1) fail('historical test result lacks a unique source stage', ERROR_CODES.CLAIM);
      const step = matches[0];
      const stagePassed = step.status === 'passed' && step.exitCode === 0 && step.timedOut !== true && !step.signal;
      // frontend-test combines Node and Vitest. A failed aggregate does not
      // identify which runner failed or whether the later runner executed.
      const observed = stagePassed ? 'passed' : stage === 'frontend-test' ? 'unknown'
        : step.status === 'failed' || step.timedOut === true || (Number.isInteger(step.exitCode) && step.exitCode !== 0) || step.signal ? 'failed' : 'unknown';
      if (historical.result !== observed) fail(observed === 'unknown'
        ? 'historical subrunner result is unsupported by the aggregate source stage'
        : 'historical test result conflicts with source stage', ERROR_CODES.CLAIM);
    }
  }
  const candidate = new Map(source.map((entry) => [entry.path, entry.sha256]));
  for (const batch of coverage.batches) for (const entry of batch.sources) {
    if ((candidate.get(entry.path) ?? null) !== entry.candidateSha256) fail('test traceability source inventory mismatch', ERROR_CODES.BINDING);
  }
}
function sanitizeAggregation(input) {
  if (!object(input) || !object(input.evidence)) fail('missing evidence aggregation');
  const schemas = { source: sourceReport, build: buildReport, packageAudit: packageReport, application: sanitizeApplication, deviation: deviationReport };
  if (Object.hasOwn(input.evidence, 'startupSampling')) schemas.startupSampling = sanitizeApplication;
  const reports = {}, origins = {};
  for (const [key, schema] of Object.entries(schemas)) {
    const entry = input.evidence[key];
    if (!object(entry) || !object(entry.report)) fail(`missing ${key} report`);
    reports[key] = schema(entry.report);
    origins[key] = { sha256: digest(entry.sha256), digestKind: HASH, verification: 'declared-in-input-aggregation-not-recomputed',
      embeddedReportSha256: sha256(JSON.stringify(entry.report)), embeddedDigestKind: 'embedded-report-json-stringify-sha256' };
  }
  const source = inventory(input.evidence.build.report.candidate.files, 'source');
  const bundle = inventory(input.evidence.build.report.bundle.files, 'bundle');
  if (sha256(JSON.stringify(source)) !== reports.build.candidate.sha256) fail('source inventory digest mismatch');
  if (sha256(JSON.stringify(bundle)) !== reports.build.bundle.sha256) fail('signed app inventory digest mismatch');
  reports.build.candidate.digestKind = SOURCE_DIGEST;
  reports.build.candidate.inventory = 'source-inventory.json';
  reports.build.bundle.digestKind = BUNDLE_DIGEST;
  reports.build.bundle.inventory = 'signed-app-inventory.json';
  reports.packageAudit.sourceDigestKind = SOURCE_DIGEST;
  reports.packageAudit.signedBundleDigestKind = BUNDLE_DIGEST;
  const summary = summaryReport(input);
  summary.deliveryFacts = projectSummaryFacts(input);
  validateBindings(reports, origins, bundle);
  validateClaims(summary, reports);
  summary.identityRoles = { registrationCommit: input.head, applicationCodeCommit: reports.build.candidate.head,
    validatorScriptSha256: reports.application.validationRevision?.sha256 || null };
  summary.authorHandoverAndMigrationSupport = SUPPORT;
  summary.licenseSwitchReady = false;
  summary.scope = SCOPE;
  const output = { 'summary.json': summary, 'source-inventory.json': source, 'signed-app-inventory.json': bundle };
  if (Object.hasOwn(input, 'testTraceability')) {
    output['test-traceability.json'] = validateCoverage(input.testTraceability);
    validateCoverageBindings(output['test-traceability.json'], reports, source, origins);
  }
  for (const [name, report] of Object.entries(reports)) output[`${name}.json`] = report;
  return { output, origins };
}

function checkedFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('input is not a bounded regular file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail('input changed while opening');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== stat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('input changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function directoryIdentity(dirname) {
  const stat = fs.lstatSync(dirname);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('bundle path must be a real directory');
  return { dev: stat.dev, ino: stat.ino };
}
function sameDirectory(dirname, expected) {
  const actual = directoryIdentity(dirname);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail('bundle directory replaced');
}

const NAMES = Object.freeze(['application.json', 'build.json', 'deviation.json', 'packageAudit.json', 'signed-app-inventory.json', 'source-inventory.json', 'source.json', 'summary.json']);
const OPTIONAL_NAMES = Object.freeze(['startupSampling.json', 'test-traceability.json']);

function validateDerivative(name, value, schema = SCHEMA) {
  let expected;
  if (name === 'test-traceability.json' && schema === SCHEMA) expected = validateCoverage(value);
  if (name === 'source.json') expected = sourceReport(value);
  if (name === 'build.json') {
    expected = buildReport(value);
    expected.candidate.digestKind = SOURCE_DIGEST;
    expected.candidate.inventory = 'source-inventory.json';
    expected.bundle.digestKind = BUNDLE_DIGEST;
    expected.bundle.inventory = 'signed-app-inventory.json';
  }
  if (name === 'packageAudit.json') expected = { ...packageReport(value), sourceDigestKind: SOURCE_DIGEST, signedBundleDigestKind: BUNDLE_DIGEST };
  if (name === 'application.json' || name === 'startupSampling.json') expected = { ...applicationReport(value),
    recoveredMessagesAndIdsEqualAcrossCycles: nullable(bool)(value.recoveredMessagesAndIdsEqualAcrossCycles),
    profileRecovery: list(fields({ group: integer, cycles: integer, recoveredMessagesAndIdsEqual: nullable(bool) }, ['group', 'cycles', 'recoveredMessagesAndIdsEqual']), 2)(value.profileRecovery),
    keychainScope: KEYCHAIN_SCOPE, successfulProductionMediaTransferCovered: false };
  if (name === 'deviation.json') expected = deviationReport(value);
  if (name === 'summary.json') expected = { ...summaryReport(value),
    identityRoles: fields({ registrationCommit: commit, applicationCodeCommit: commit, validatorScriptSha256: nullable(digest) },
      ['registrationCommit', 'applicationCodeCommit', 'validatorScriptSha256'])(value.identityRoles),
    authorHandoverAndMigrationSupport: SUPPORT, licenseSwitchReady: false, scope: SCOPE };
  if (schema === SCHEMA && ['application.json', 'startupSampling.json'].includes(name)) expected.observations = validateApplicationFacts(value.observations);
  if (schema === SCHEMA && name === 'summary.json') expected.deliveryFacts = validateSummaryFacts(value.deliveryFacts);
  if (name === 'source-inventory.json') expected = inventory(value, 'source');
  if (name === 'signed-app-inventory.json') expected = inventory(value, 'bundle');
  if (!expected || !isDeepStrictEqual(expected, value)) fail('unregistered or altered derivative field');
  if (name === 'application.json' || name === 'startupSampling.json') {
    validateSampling(value);
    validateWorldbookEvidence(value);
  }
}

function verifyBundleInternal(dirname) {
  const root = path.resolve(dirname), identity = directoryIdentity(root);
  const manifestBytes = checkedFile(path.join(root, 'manifest.json'));
  const manifest = parseJson(manifestBytes);
  if (!manifestBytes.equals(bytesFor(manifest))) fail('manifest is not canonical exported JSON');
  exactKeys(manifest, ['schema', 'createdAt', 'aggregation', 'publication', 'redaction', 'files']);
  exactKeys(manifest.aggregation, ['sha256', 'bytes', 'digestKind']);
  if (![SCHEMA, LEGACY_SCHEMA].includes(manifest.schema) || !Array.isArray(manifest.files)
    || manifest.files.length < NAMES.length || manifest.files.length > NAMES.length + OPTIONAL_NAMES.length) fail('unsupported or incomplete bundle manifest');
  const optionalNames = manifest.schema === LEGACY_SCHEMA ? ['startupSampling.json'] : OPTIONAL_NAMES;
  timestamp(manifest.createdAt);
  digest(manifest.aggregation?.sha256);
  integer(manifest.aggregation?.bytes);
  if (manifest.aggregation.digestKind !== HASH || manifest.publication !== 'exclusive-directory-and-atomic-completion-manifest'
    || manifest.redaction !== 'fixed-field-structural-allowlists-no-log-data-or-secret-file-reads') fail('invalid manifest policy');
  const registeredNames = manifest.files.map((entry) => relativePath(entry.path));
  if (new Set(registeredNames).size !== registeredNames.length) fail('duplicate file registration');
  if (NAMES.some((name) => !registeredNames.includes(name))) fail('missing required report');
  const expected = new Set([...registeredNames, 'manifest.json']);
  const actual = fs.readdirSync(root);
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) fail('unregistered or missing bundle file');
  const decoded = {}, origins = {}, seen = new Set();
  for (const entry of manifest.files) {
    const name = relativePath(entry.path);
    exactKeys(entry, ['path', 'bytes', 'sha256', 'digestKind', ...(Object.hasOwn(entry, 'originalReport') ? ['originalReport'] : [])]);
    if (![...NAMES, ...optionalNames].includes(name) || seen.has(name) || entry.digestKind !== SUMMARY_DIGEST) fail('invalid manifest file registration');
    seen.add(name);
    const bytes = checkedFile(path.join(root, name));
    if (integer(entry.bytes) !== bytes.length || digest(entry.sha256) !== sha256(bytes)) fail('file size or digest mismatch');
    decoded[name] = parseJson(bytes);
    if (!bytes.equals(bytesFor(decoded[name]))) fail('derivative is not canonical exported JSON');
    validateDerivative(name, decoded[name], manifest.schema);
    const isReport = ['source.json', 'build.json', 'packageAudit.json', 'application.json', 'deviation.json', 'startupSampling.json'].includes(name);
    if (isReport !== Boolean(entry.originalReport)) fail('missing or unexpected original-report identity');
    if (isReport) {
      exactKeys(entry.originalReport, ['sha256', 'digestKind', 'verification', 'embeddedReportSha256', 'embeddedDigestKind']);
      digest(entry.originalReport.sha256);
      origins[name.replace(/\.json$/, '')] = entry.originalReport;
      if (entry.originalReport.digestKind !== HASH || entry.originalReport.verification !== 'declared-in-input-aggregation-not-recomputed') fail('invalid original-report identity');
      digest(entry.originalReport.embeddedReportSha256);
      if (entry.originalReport.embeddedDigestKind !== 'embedded-report-json-stringify-sha256') fail('invalid embedded report digest');
    }
  }
  for (const name of ['source-inventory.json', 'signed-app-inventory.json']) {
    const rows = inventory(decoded[name], name.startsWith('source') ? 'source' : 'bundle');
    const binding = name.startsWith('source') ? decoded['build.json'].candidate : decoded['build.json'].bundle;
    if (sha256(JSON.stringify(rows)) !== binding.sha256 || binding.inventory !== name
      || binding.digestKind !== (name.startsWith('source') ? SOURCE_DIGEST : BUNDLE_DIGEST)) fail('inventory identity mismatch');
  }
  const reports = { source: decoded['source.json'], build: decoded['build.json'], packageAudit: decoded['packageAudit.json'], application: decoded['application.json'], startupSampling: decoded['startupSampling.json'] };
  validateBindings(reports, origins, decoded['signed-app-inventory.json']);
  const acceptance = validateClaims(decoded['summary.json'], reports);
  validateCoverageBindings(decoded['test-traceability.json'], reports, decoded['source-inventory.json'], origins);
  const roles = decoded['summary.json'].identityRoles;
  if (roles.registrationCommit !== decoded['summary.json'].head || roles.applicationCodeCommit !== decoded['build.json'].candidate.head
    || roles.validatorScriptSha256 !== (decoded['application.json'].validationRevision?.sha256 || null)) fail('identity role mismatch');
  sameDirectory(root, identity);
  return { schema: VERIFICATION_SCHEMA, bundleSchema: manifest.schema, valid: true, integrity: 'passed', claimConsistency: 'passed', acceptance,
    producerObservations: { application: reports.application.observations ?? null, startupSampling: reports.startupSampling?.observations ?? null },
    deliveryFacts: decoded['summary.json'].deliveryFacts ?? null, files: seen.size,
    manifestSha256: sha256(manifestBytes), digestKind: HASH,
    sourceInventoryEntries: decoded['source-inventory.json'].length, signedAppInventoryEntries: decoded['signed-app-inventory.json'].length,
    scope: 'Integrity of the portable derivative and its internal bindings. This is not authentication, original-report recovery, or application re-execution.' };
}

function exportBundleInternal(inputPath, outputPath) {
  const inputBytes = checkedFile(path.resolve(inputPath));
  const { output, origins } = sanitizeAggregation(parseJson(inputBytes));
  const out = path.resolve(outputPath), parent = path.dirname(out);
  directoryIdentity(parent);
  // Reserve a new directory exclusively. Publish manifest.json last using an
  // atomic hard link: incomplete exports can never be accepted. rename() alone
  // would replace an empty unknown output directory on POSIX.
  try { fs.mkdirSync(out, { mode: 0o700 }); } catch (error) {
    if (error.code === 'EEXIST') fail('output conflict; existing paths are never overwritten');
    throw error;
  }
  const identity = directoryIdentity(out), owned = [];
  try {
    const entries = [];
    for (const name of [...NAMES, ...OPTIONAL_NAMES.filter((key) => Object.hasOwn(output, key))]) {
      sameDirectory(out, identity);
      const bytes = bytesFor(output[name]), filename = path.join(out, name);
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
      owned.push({ name, ...fs.lstatSync(filename) });
      const key = name.replace(/\.json$/, '');
      entries.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), digestKind: SUMMARY_DIGEST,
        ...(origins[key] ? { originalReport: origins[key] } : {}) });
    }
    const manifest = { schema: SCHEMA, createdAt: new Date().toISOString(),
      aggregation: { sha256: sha256(inputBytes), bytes: inputBytes.length, digestKind: HASH },
      publication: 'exclusive-directory-and-atomic-completion-manifest',
      redaction: 'fixed-field-structural-allowlists-no-log-data-or-secret-file-reads',
      files: entries };
    sameDirectory(out, identity);
    const temporary = path.join(out, '.manifest-pending');
    fs.writeFileSync(temporary, bytesFor(manifest), { flag: 'wx', mode: 0o600 });
    owned.push({ name: '.manifest-pending', ...fs.lstatSync(temporary) });
    fs.linkSync(temporary, path.join(out, 'manifest.json'));
    owned.push({ name: 'manifest.json', ...fs.lstatSync(temporary) });
    fs.unlinkSync(temporary);
    return verifyBundle(out);
  } catch (error) {
    try {
      sameDirectory(out, identity);
      for (const item of owned) {
        const filename = path.join(out, item.name);
        let stat; try { stat = fs.lstatSync(filename); } catch { continue; }
        if (stat.dev === item.dev && stat.ino === item.ino) fs.unlinkSync(filename);
      }
      fs.rmdirSync(out); // Fails safely if an unknown file appeared.
    } catch { /* Preserve unknown/replaced output, never recursively remove it. */ }
    throw error;
  }
}

function verifyBundle(dirname) { return checkedOperation(() => verifyBundleInternal(dirname)); }
function exportBundle(inputPath, outputPath) { return checkedOperation(() => exportBundleInternal(inputPath, outputPath)); }

function main(args) {
  const [action, ...rest] = args;
  if (action === 'export' && rest.length === 4 && rest[0] === '--input' && rest[2] === '--out') return exportBundle(rest[1], rest[3]);
  if (action === 'verify' && rest.length === 2 && rest[0] === '--bundle') return verifyBundle(rest[1]);
  fail('usage: export --input aggregation.json --out NEW_DIRECTORY | verify --bundle DIRECTORY', ERROR_CODES.USAGE);
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify(error.result || failureResult(error), null, 2)}\n`); process.exitCode = 1;
  }
}
module.exports = { exportBundle, verifyBundle, sanitizeAggregation, relativePath, inventory, SCHEMA, SOURCE_DIGEST, BUNDLE_DIGEST, ERROR_CODES, VERIFICATION_SCHEMA };
