'use strict';

// Pure projections of producer records. Never opens an input-provided path or
// turns the presence of a process/directory record into an OS verification.
const APPLICATION_SCHEMA = 'reverie.evidence-observations.v1';
const SUMMARY_SCHEMA = 'reverie.evidence-delivery-facts.v1';
const BASIS = 'producer-records-only-no-new-system-inspection';
const BLOCKERS = Object.freeze({
  'risu-worldbook': ['Risu worldbook then optional compression'],
  'hypa-migration': ['Hypa independent replacement and safe summary migration', 'Risu worldbook then optional compression'],
  'elephantops': ['GPL elephantops dependency'],
  'authorization-coverage': ['Contribution/file authorization coverage', 'File/contribution authorization mapping'],
  'chat-video-provenance': ['Python chat-video provenance review'],
  'dependency-asset-notices': ['Retained dependency and asset notice coverage', 'Retained dependencies and assets notice coverage'],
  'windows-runtime-package': ['Windows actual runtime/package validation', 'Windows runtime and package execution'],
  'renderer-timeout-unresolved': ['Original renderer startup timeout cause remains unknown', 'Original first renderer timeout cause unresolved'],
  'packaged-media-success': ['Packaged successful public media download end-to-end remains uncovered'],
});
const owns = (value, name) => Object.hasOwn(value, name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail() { throw Object.assign(new Error('Evidence: invalid bounded producer facts'), { code: 'ERR_EVIDENCE_FACTS' }); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; }
function boolean(value) { if (typeof value !== 'boolean') fail(); return value; }
function nullable(value, validate) { return value === null ? null : validate(value); }
function token(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:+ -]{0,159}$/.test(value)) fail(); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value; }
function commit(value) { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail(); return value; }
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
      || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail();
  return value;
}
function array(value, limit = 200) { if (!Array.isArray(value) || value.length > limit) fail(); return value; }
function optionalBoolean(value, name) { return owns(value, name) ? nullable(value[name], boolean) : null; }
function optionalDigest(value, name) { return value && owns(value, name) ? nullable(value[name], digest) : null; }
function recordPresence(value, name) {
  if (!owns(value, name)) return null;
  if (value[name] === null) return false;
  if (!object(value[name])) fail();
  return true;
}

function projectApplicationFacts(raw) {
  if (!object(raw)) fail();
  const validation = object(raw.validationRevision) ? raw.validationRevision : {};
  if (owns(raw, 'forcedCleanup') && array(raw.forcedCleanup, 100).some(item => typeof item !== 'string' || item.length > 160)) fail();
  const facts = {
    schema: APPLICATION_SCHEMA, basis: BASIS,
    forcedCleanupCount: owns(raw, 'forcedCleanup') ? array(raw.forcedCleanup, 100).length : null,
    producer: {
      validatorSha256: optionalDigest(validation, 'sha256'),
      isolationControllerSha256: optionalDigest(validation.isolationController || validation.isolationModule, 'sha256'),
      nativeHelperSha256: optionalDigest(validation.nativeErrorHelper || validation.nativeProcessHelper, 'sha256'),
    },
    cycles: array(raw.cycles, 100).map(cycle => {
      if (!object(cycle)) fail();
      if (owns(cycle, 'isolationDirectories') && array(cycle.isolationDirectories, 100).some(item => !object(item))) fail();
      return { label: token(cycle.label),
        processIdentityRecorded: recordPresence(cycle, 'processIdentity'),
        isolationDirectoryCount: owns(cycle, 'isolationDirectories')
          ? array(cycle.isolationDirectories, 100).length : null,
        identityVerified: optionalBoolean(cycle, 'identityVerified'),
        isolatedDataVerified: optionalBoolean(cycle, 'isolatedDataVerified') };
    }),
    negativeCaseRecordsAvailable: owns(raw, 'negativeCases'),
    negativeCases: (owns(raw, 'negativeCases') ? array(raw.negativeCases, 100) : []).map(entry => {
      if (!object(entry)) fail();
      return { kind: token(entry.kind), replacementKeyGenerated: optionalBoolean(entry, 'replacementKeyGenerated') };
    }),
  };
  return validateApplicationFacts(facts);
}

function validateApplicationFacts(value) {
  exact(value, ['schema', 'basis', 'forcedCleanupCount', 'producer', 'cycles', 'negativeCaseRecordsAvailable', 'negativeCases']);
  if (value.schema !== APPLICATION_SCHEMA || value.basis !== BASIS) fail();
  exact(value.producer, ['validatorSha256', 'isolationControllerSha256', 'nativeHelperSha256']);
  const producer = Object.fromEntries(Object.entries(value.producer).map(([key, item]) => [key, nullable(item, digest)]));
  const cycles = array(value.cycles, 100).map(item => {
    exact(item, ['label', 'processIdentityRecorded', 'isolationDirectoryCount', 'identityVerified', 'isolatedDataVerified']);
    return { label: token(item.label), processIdentityRecorded: nullable(item.processIdentityRecorded, boolean),
      isolationDirectoryCount: nullable(item.isolationDirectoryCount, integer),
      identityVerified: nullable(item.identityVerified, boolean), isolatedDataVerified: nullable(item.isolatedDataVerified, boolean) };
  });
  if (new Set(cycles.map(item => item.label)).size !== cycles.length) fail();
  const negativeCases = array(value.negativeCases, 100).map(item => {
    exact(item, ['kind', 'replacementKeyGenerated']);
    if (!['vault', 'database', 'missing-vault'].includes(item.kind)) fail();
    return { kind: item.kind, replacementKeyGenerated: nullable(item.replacementKeyGenerated, boolean) };
  });
  if (new Set(negativeCases.map(item => item.kind)).size !== negativeCases.length) fail();
  const available = boolean(value.negativeCaseRecordsAvailable);
  if (!available && negativeCases.length) fail();
  return { schema: APPLICATION_SCHEMA, basis: BASIS, forcedCleanupCount: nullable(value.forcedCleanupCount, integer),
    producer, cycles, negativeCaseRecordsAvailable: available, negativeCases };
}

function projectSummaryFacts(raw) {
  if (!object(raw)) fail();
  let blockers = null;
  if (owns(raw, 'remaining')) {
    const values = array(raw.remaining, 100);
    const known = new Set(Object.values(BLOCKERS).flat());
    if (values.some(value => !known.has(value))) fail();
    blockers = Object.entries(BLOCKERS).filter(([, aliases]) => aliases.some(value => values.includes(value))).map(([id]) => id);
  }
  let checks = null;
  if (owns(raw, 'postBuildChecks')) {
    const input = raw.postBuildChecks;
    if (!object(input)) fail();
    checks = { evidenceTests: integer(input.evidenceTests), passed: boolean(input.passed),
      basis: 'aggregate-declared-separate-post-build-tool-batch',
      runId: owns(input, 'runId') ? token(input.runId) : null,
      executionCommit: owns(input, 'executionCommit') ? commit(input.executionCommit) : null,
      reportSha256: optionalDigest(input, 'reportSha256') };
  }
  return validateSummaryFacts({ schema: SUMMARY_SCHEMA, remainingBlockerIds: blockers,
    postBuildChecks: checks, postBuildChanges: owns(raw, 'postBuildChanges') ? array(raw.postBuildChanges).map(relative) : null,
    interpretation: 'Historical candidate totals and later tool batches are distinct; missing facts stay unknown.' });
}

function validateSummaryFacts(value) {
  exact(value, ['schema', 'remainingBlockerIds', 'postBuildChecks', 'postBuildChanges', 'interpretation']);
  const interpretation = 'Historical candidate totals and later tool batches are distinct; missing facts stay unknown.';
  if (value.schema !== SUMMARY_SCHEMA || value.interpretation !== interpretation) fail();
  const blockers = value.remainingBlockerIds === null ? null : array(value.remainingBlockerIds, 100).map(id => {
    if (!owns(BLOCKERS, id)) fail(); return id;
  });
  if (blockers && new Set(blockers).size !== blockers.length) fail();
  let checks = null;
  if (value.postBuildChecks !== null) {
    exact(value.postBuildChecks, ['evidenceTests', 'passed', 'basis', 'runId', 'executionCommit', 'reportSha256']);
    const check = value.postBuildChecks;
    if (check.basis !== 'aggregate-declared-separate-post-build-tool-batch') fail();
    checks = { evidenceTests: integer(check.evidenceTests), passed: boolean(check.passed), basis: check.basis,
      runId: nullable(check.runId, token), executionCommit: nullable(check.executionCommit, commit),
      reportSha256: nullable(check.reportSha256, digest) };
  }
  const changes = value.postBuildChanges === null ? null : array(value.postBuildChanges).map(relative);
  if (changes && new Set(changes).size !== changes.length) fail();
  return { schema: SUMMARY_SCHEMA, remainingBlockerIds: blockers, postBuildChecks: checks,
    postBuildChanges: changes, interpretation };
}

module.exports = { projectApplicationFacts, validateApplicationFacts, projectSummaryFacts, validateSummaryFacts,
  APPLICATION_SCHEMA, SUMMARY_SCHEMA };
