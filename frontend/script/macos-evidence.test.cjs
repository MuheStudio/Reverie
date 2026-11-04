'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportBundle, verifyBundle, sanitizeAggregation, relativePath } = require('./macos-evidence.cjs');

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const commit = 'a'.repeat(40), otherCommit = 'b'.repeat(40), digest = 'c'.repeat(64);
function fixture() {
  const sourceFiles = [{ path: 'src/main.py', sha256: digest, bytes: 12 }];
  const bundleFiles = [{ path: 'Contents/MacOS/Test', bytes: 23, sha256: digest },
    { path: 'Contents/Resources/app.asar', bytes: 42, sha256: digest }];
  const sourceSha256 = hash(JSON.stringify(sourceFiles)), bundleSha256 = hash(JSON.stringify(bundleFiles));
  const report = (value) => ({ path: '/Users/private/not-opened/secret.json', sha256: digest, report: value });
  return {
    schema: 'reverie.license-migration-first-batch.v1', completedAt: '2026-10-05T00:00:00.000Z', head: otherCommit,
    branch: 'codex/offline-license-migration', localOnly: true, pushed: false, rootLicenseChanged: false,
    preferredLicense: 'Apache-2.0', alternative: 'MIT', dualLicense: false,
    firstBatchFunctionalAcceptance: 'passed', allOperationalConstraintsMet: false, dataIsolationDeviationRecorded: true,
    sourceTests: { pytestPassed: 957, pytestExistingXfail: 1, pytestExistingWarning: 1, nodePassed: 549, nodeSkipped: 0, vitestPassed: 262 },
    evidence: {
      source: report({ schema: 'reverie.macos.check.v1', status: 'passed', steps: [{ name: 'pytest', status: 'passed', exitCode: 0,
        log: '/Users/private/secret.log', command: ['--token', 'RAW_SECRET'] }], projectRoot: '/Users/private/project' }),
      build: report({ schema: 'reverie.macos-build.v1', candidate: { head: commit, branch: 'codex/test', dirty: false, sha256: sourceSha256, files: sourceFiles },
        bundle: { sha256: bundleSha256, files: bundleFiles }, appPath: '/Users/private/Test.app', signature: 'RAW_SECRET',
        signing: { identity: 'ad-hoc', formalDistribution: false, notarized: false } }),
      packageAudit: report({ schema: 'reverie.migration-final-package-audit.v1', passed: true, codeCommit: commit,
        sourceSha256, signedBundleSha256: bundleSha256, asarSha256: digest, rootLicenseUnchanged: true, remainingRisuPresent: true }),
      application: report({ passed: true, cycles: [1, 2, 3].map((i) => ({ label: `normal-${i}`, readyMs: 100,
        normalQuit: true, encryptedDatabase: true, recoveredMessages: [{ id: 'PRIVATE_ID', role: 'user', content: 'RAW_SECRET' }] })),
        validationRevision: { script: 'frontend/script/smoke-packaged-macos.cjs', sha256: digest },
        buildBinding: { manifestSha256: digest, sourceSha256, signedBundleSha256: bundleSha256, matched: true },
        security: { asarSha256: digest },
        pythonProbe: { version: [3, 12, 14], executable: '/Users/private/python' },
        keychain: { secretExported: false, metadataVerified: true, output: 'RAW_SECRET' },
        chat: { messages: ['RAW_SECRET'] }, applicationDiagnostics: [{ label: 'normal-1', stderr: 'RAW_SECRET', error: 'RAW_SECRET', stack: 'RAW_SECRET' }],
        error: 'RAW_SECRET', stdout: 'RAW_SECRET', noResidualProcesses: true }),
      deviation: report({ schema: 'reverie.migration-diagnostic-deviation.v1', recordedOn: '2026-10-05', events: [
        { kind: 'startup-timeout', cause: 'RAW_SECRET' }, { kind: 'native-ui-diagnostic-relaunch', details: '/Users/private/default' },
      ] }),
      unexpected: report({ keychain: 'RAW_SECRET' }),
    },
  };
}
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-evidence-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'aggregation.json'), out = path.join(root, 'evidence');
  fs.writeFileSync(input, JSON.stringify(fixture()));
  return { root, input, out };
}
function rewriteRegistered(out, name, change) {
  const file = path.join(out, name), value = JSON.parse(fs.readFileSync(file));
  change(value);
  fs.writeFileSync(file, json(value));
  const manifestPath = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const entry = manifest.files.find((x) => x.path === name), bytes = fs.readFileSync(file);
  entry.bytes = bytes.length;
  entry.sha256 = hash(bytes);
  fs.writeFileSync(manifestPath, json(manifest));
}

test('exports only approved structures and verifies after relocation without original reports', (t) => {
  const { root, input, out } = workspace(t);
  assert.equal(exportBundle(input, out).valid, true);
  fs.unlinkSync(input);
  const relocated = path.join(root, '搬移 空格');
  fs.renameSync(out, relocated);
  assert.equal(verifyBundle(relocated).valid, true);
  const text = fs.readdirSync(relocated).map((name) => fs.readFileSync(path.join(relocated, name), 'utf8')).join('\n');
  assert.doesNotMatch(text, /RAW_SECRET|PRIVATE_ID|\/Users\/|keychain.*output|command.*token/);
  const app = JSON.parse(fs.readFileSync(path.join(relocated, 'application.json')));
  assert.equal(app.recoveredMessagesAndIdsEqualAcrossCycles, true);
  const summary = JSON.parse(fs.readFileSync(path.join(relocated, 'summary.json')));
  assert.equal(summary.identityRoles.registrationCommit, otherCommit);
  assert.equal(summary.identityRoles.applicationCodeCommit, commit);
  assert.equal(summary.allOperationalConstraintsMet, false);
  assert.equal(summary.sourceTests.pytestExistingXfail, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(relocated, 'manifest.json')));
  const appEntry = manifest.files.find((entry) => entry.path === 'application.json');
  assert.equal(appEntry.originalReport.sha256, digest);
  assert.notEqual(appEntry.sha256, digest);
  assert.equal(appEntry.originalReport.verification, 'declared-in-input-aggregation-not-recomputed');
});

test('keeps source and signed-app inventory digests independently reproducible', () => {
  const { output } = sanitizeAggregation(fixture());
  assert.equal(hash(JSON.stringify(output['source-inventory.json'])), output['build.json'].candidate.sha256);
  assert.equal(hash(JSON.stringify(output['signed-app-inventory.json'])), output['build.json'].bundle.sha256);
  assert.equal(output['build.json'].bundle.digestKind, 'ordered-signed-app-inventory-json-sha256');
});

for (const kind of ['file', 'empty-directory', 'populated-directory']) {
  test(`never overwrites an existing ${kind} output`, (t) => {
    const { input, out } = workspace(t);
    if (kind === 'file') fs.writeFileSync(out, 'sentinel');
    else { fs.mkdirSync(out); if (kind === 'populated-directory') fs.writeFileSync(path.join(out, 'sentinel'), 'unchanged'); }
    assert.throws(() => exportBundle(input, out), /output conflict/);
    if (kind === 'file') assert.equal(fs.readFileSync(out, 'utf8'), 'sentinel');
    if (kind === 'populated-directory') assert.equal(fs.readFileSync(path.join(out, 'sentinel'), 'utf8'), 'unchanged');
  });
}

test('rejects tampering and missing files', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  fs.appendFileSync(path.join(out, 'source.json'), ' ');
  assert.throws(() => verifyBundle(out), /size or digest mismatch/);
  fs.unlinkSync(path.join(out, 'source.json'));
  assert.throws(() => verifyBundle(out), /missing bundle file/);
});

for (const unknown of ['unknown.json', '.DS_Store', 'unregistered-dir']) {
  test(`rejects unregistered ${unknown}`, (t) => {
    const { input, out } = workspace(t); exportBundle(input, out);
    if (unknown.endsWith('-dir')) fs.mkdirSync(path.join(out, unknown)); else fs.writeFileSync(path.join(out, unknown), 'sentinel');
    assert.throws(() => verifyBundle(out), /unregistered/);
  });
}

for (const invalid of ['../escape', '/absolute', 'a/../b', 'a//b', 'C:\\escape', 'a\\b', './source.json', 'a\u0000b']) {
  test(`rejects non-canonical relative path ${JSON.stringify(invalid)}`, () => assert.throws(() => relativePath(invalid), /relative path/));
}

test('rejects path traversal even if manifest and derivative checksums are updated', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const name = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(name));
  manifest.files[0].path = '../application.json';
  fs.writeFileSync(name, json(manifest));
  assert.throws(() => verifyBundle(out), /relative path/);
});

test('rejects duplicate registrations', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const name = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(name));
  manifest.files[1] = manifest.files[0];
  fs.writeFileSync(name, json(manifest));
  assert.throws(() => verifyBundle(out), /registration/);
});

test('rejects unregistered derivative fields despite refreshed file digest', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (value) => { value.rawKeychain = 'secret'; });
  assert.throws(() => verifyBundle(out), /unregistered or altered derivative/);
});

test('rejects missing original report identity despite preserved derivative digest', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const name = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(name));
  delete manifest.files.find((entry) => entry.path === 'application.json').originalReport;
  fs.writeFileSync(name, json(manifest));
  assert.throws(() => verifyBundle(out), /original-report identity/);
});

test('rejects source inventory mismatch and cross-candidate report mixture before output creation', (t) => {
  const { input, out } = workspace(t), a = fixture();
  a.evidence.build.report.candidate.files[0].bytes += 1;
  fs.writeFileSync(input, JSON.stringify(a));
  assert.throws(() => exportBundle(input, out), /source inventory digest mismatch/);
  assert.equal(fs.existsSync(out), false);
  const b = fixture(); b.evidence.packageAudit.report.codeCommit = otherCommit;
  assert.throws(() => sanitizeAggregation(b), /identity mismatch/);
});

test('rejects escaping links in inventory metadata without following them', () => {
  const value = fixture();
  value.evidence.build.report.bundle.files = [{ path: 'Contents/link', symlink: '../../outside' }];
  value.evidence.build.report.bundle.sha256 = hash(JSON.stringify(value.evidence.build.report.bundle.files));
  value.evidence.packageAudit.report.signedBundleSha256 = value.evidence.build.report.bundle.sha256;
  value.evidence.application.report.buildBinding.signedBundleSha256 = value.evidence.build.report.bundle.sha256;
  assert.throws(() => sanitizeAggregation(value), /relative path/);
});

test('accepts contained inventory links without materializing any link', () => {
  const value = fixture();
  value.evidence.build.report.bundle.files.push({ path: 'Contents/Resources/link', symlink: '../MacOS/Test' });
  value.evidence.build.report.bundle.sha256 = hash(JSON.stringify(value.evidence.build.report.bundle.files));
  value.evidence.packageAudit.report.signedBundleSha256 = value.evidence.build.report.bundle.sha256;
  value.evidence.application.report.buildBinding.signedBundleSha256 = value.evidence.build.report.bundle.sha256;
  assert.equal(sanitizeAggregation(value).output['signed-app-inventory.json'][2].symlink, '../MacOS/Test');
});

test('reports differing restored IDs without exporting IDs or message text', () => {
  const value = fixture(); value.evidence.application.report.cycles[1].recoveredMessages[0].id = 'DIFFERENT_ID';
  assert.equal(sanitizeAggregation(value).output['application.json'].recoveredMessagesAndIdsEqualAcrossCycles, false);
});

for (const location of ['input', 'bundle-file', 'bundle-root']) {
  test(`rejects ${location} symlinks`, { skip: process.platform === 'win32' ? 'POSIX symlink adversarial scenario' : false }, (t) => {
    const { root, input, out } = workspace(t);
    if (location === 'input') {
      const link = path.join(root, 'input-link'); fs.symlinkSync(input, link);
      assert.throws(() => exportBundle(link, out), /regular file/);
    } else {
      exportBundle(input, out);
      if (location === 'bundle-root') {
        const link = path.join(root, 'linked-bundle'); fs.symlinkSync(out, link);
        assert.throws(() => verifyBundle(link), /real directory/);
      } else {
        const original = path.join(out, 'source.json'), outside = path.join(root, 'outside.json');
        fs.renameSync(original, outside); fs.symlinkSync(outside, original);
        assert.throws(() => verifyBundle(out), /regular file/);
      }
    }
  });
}

test('rejects arbitrary diagnostic kinds instead of copying narrative or inventing conclusions', () => {
  const value = fixture(); value.evidence.deviation.report.events.push({ kind: 'unknown-new-event', details: 'secret' });
  assert.throws(() => sanitizeAggregation(value), /enumerated value/);
});

test('bundle verifier has no requirement for the application, repository or original logs', (t) => {
  const { input, out } = workspace(t);
  exportBundle(input, out);
  const build = JSON.parse(fs.readFileSync(path.join(out, 'build.json')));
  assert.equal(Object.hasOwn(build, 'appPath'), false);
  assert.equal(Object.hasOwn(build, 'signature'), false);
  assert.equal(verifyBundle(out).scope.includes('not authentication'), true);
});

test('rejects unknown manifest fields even with canonical JSON', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const name = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(name));
  manifest.extraSecret = 'unexpected';
  fs.writeFileSync(name, json(manifest));
  assert.throws(() => verifyBundle(out), /unregistered or missing object field/);
});

test('rejects duplicate JSON keys that a plain parser would silently discard', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const name = path.join(out, 'manifest.json'), text = fs.readFileSync(name, 'utf8');
  fs.writeFileSync(name, text.replace('{\n', '{\n  "schema": "hidden duplicate value",\n'));
  assert.throws(() => verifyBundle(out), /canonical exported JSON/);
});

test('an interrupted publication is not a valid bundle and removes only its owned files', (t) => {
  const { input, out } = workspace(t);
  const originalLink = fs.linkSync;
  fs.linkSync = (source, target) => {
    fs.writeFileSync(path.join(out, 'unknown-sentinel'), 'preserve me');
    const error = new Error('synthetic publication failure'); error.code = 'EIO'; throw error;
  };
  try { assert.throws(() => exportBundle(input, out), (error) => error.code === 'ERR_EVIDENCE_FILESYSTEM'); }
  finally { fs.linkSync = originalLink; }
  assert.deepEqual(fs.readdirSync(out), ['unknown-sentinel']);
  assert.equal(fs.readFileSync(path.join(out, 'unknown-sentinel'), 'utf8'), 'preserve me');
  assert.throws(() => verifyBundle(out));
});

test('an output created during publication is never overwritten', (t) => {
  const { input, out } = workspace(t);
  const originalLink = fs.linkSync;
  fs.linkSync = (source, target) => {
    fs.writeFileSync(target, 'unknown manifest', { flag: 'wx' });
    return originalLink(source, target);
  };
  try { assert.throws(() => exportBundle(input, out), (error) => error.code === 'ERR_EVIDENCE_FILESYSTEM'); }
  finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'), 'unknown manifest');
  assert.deepEqual(fs.readdirSync(out), ['manifest.json']);
});

test('exports two independent startup groups without conflating their message identities', (t) => {
  const { input, out } = workspace(t), data = fixture();
  const sample = structuredClone(data.evidence.application);
  sample.report.startupSampling = { groups: 2, cyclesPerGroup: 3, freshProfiles: 2, automaticRetry: false, systemCachesCleared: false,
    negativeCases: 'once using final group' };
  sample.report.validationRevision.isolationController = { script: 'frontend/script/acceptance-isolation.cjs', sha256: digest };
  sample.report.startupGroups = [1, 2].map((group) => ({ group, userData: `/Users/private/profile${group}`, cycles: [1, 2, 3].map((i) => ({
    label: `g${group}-${i}`, readyMs: i * 100, normalQuit: true, processIdentity: { pid: 123, birth: 'PRIVATE_BIRTH', name: '/Users/private/app' },
    isolationDirectories: [{ path: '/Users/private/profile', uid: 501, inode: 'PRIVATE_INODE' }],
    recoveredMessages: [{ id: `PRIVATE_ID_${group}`, role: 'user', content: `RAW_SECRET_${group}` }],
  })) }));
  sample.report.cycles = sample.report.startupGroups.flatMap((group) => group.cycles);
  data.evidence.startupSampling = sample;
  fs.writeFileSync(input, JSON.stringify(data));
  assert.equal(exportBundle(input, out).files, 9);
  const result = JSON.parse(fs.readFileSync(path.join(out, 'startupSampling.json')));
  assert.equal(result.recoveredMessagesAndIdsEqualAcrossCycles, null);
  assert.deepEqual(result.profileRecovery, [1, 2].map((group) => ({ group, cycles: 3, recoveredMessagesAndIdsEqual: true })));
  assert.deepEqual(result.startupGroups.map((group) => group.cycles.map((cycle) => cycle.readyMs)), [[100, 200, 300], [100, 200, 300]]);
  assert.equal(result.validationRevision.isolationController.sha256, digest);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|RAW_SECRET|\/Users\//);
  assert.equal(verifyBundle(out).valid, true);
  data.evidence.startupSampling.report.cycles.pop();
  assert.throws(() => sanitizeAggregation(data), /successful startup sampling is incomplete|flattened startup sampling mismatch/);
});

test('preserves a failed partial startup sample without arbitrary error strings', () => {
  const data = fixture(), sample = structuredClone(data.evidence.application);
  sample.report.passed = false;
  sample.report.startupSampling = { groups: 2, cyclesPerGroup: 3, freshProfiles: 2, automaticRetry: false, systemCachesCleared: false };
  sample.report.cycles = [];
  sample.report.startupGroups = [{ group: 1, cycles: [] }];
  sample.report.stage = 'Normal cycle g1-1: packaged startup and V4 authentication';
  data.evidence.startupSampling = sample;
  const result = sanitizeAggregation(data).output['startupSampling.json'];
  assert.equal(result.passed, false);
  assert.equal(result.stage, sample.report.stage);
  assert.equal(result.profileRecovery[0].recoveredMessagesAndIdsEqual, null);
  assert.equal(Object.hasOwn(result, 'error'), false);
});

test('malformed aggregation does not echo its private contents', (t) => {
  const { input, out } = workspace(t);
  fs.writeFileSync(input, '{"key": RAW_SECRET}');
  assert.throws(() => exportBundle(input, out), (error) => error.message === 'Evidence: invalid JSON document');
  assert.equal(fs.existsSync(out), false);
});

function worldbookFixture() {
  const input = fixture();
  delete input.firstBatchFunctionalAcceptance;
  input.worldbookFunctionalAcceptance = 'passed';
  input.automationIsolationAcceptance = 'passed';
  const app = input.evidence.application.report;
  const finalArchive = { personaId: 'PRIVATE_PERSONA', revision: 8, checksum: 'd'.repeat(64),
    bookId: 'PRIVATE_BOOK', entryIds: ['PRIVATE_ENTRY'], bookSha256: 'e'.repeat(64) };
  const names = ['saved content A', 'next turn uses saved B', 'disabled entry omitted', 'deleted book omitted',
    'regex timeout isolates one entry', 'saved regex repair applies next turn', 'benign archive retained for restarts'];
  const contract = { passed: true, originalRevision: 1, finalArchive, steps: names.map((name, index) => ({
    name, revision: index + 2, included: ['RAW_SECRET_MARKER'], excluded: ['RAW_SECRET_PATTERN'], actualModelPromptChecked: true,
  })), timeoutDiagnostic: { persona_id: 'PRIVATE_PERSONA', request_id: 'PRIVATE_REQUEST', entries: [{ pattern: 'RAW_SECRET_PATTERN' }] },
  workers: { spawned: 3, timeoutRecorded: true, allReaped: true, externalInterpreter: false, pids: ['PRIVATE_PID'] },
  visibleWarning: true, repairClearsWarning: true, preservedForRestartChecks: true, mutationsLimitedToIsolatedArchive: true };
  app.cycles[1].worldbookRestored = { ...structuredClone(finalArchive), noModelCall: true };
  app.cycles[2].worldbookRestored = { ...structuredClone(finalArchive), noModelCall: true };
  app.startupSampling = { groups: 1, cyclesPerGroup: 3, freshProfiles: 1, automaticRetry: false, systemCachesCleared: false };
  app.startupGroups = [{ group: 1, userData: '/Users/private/test', cycles: app.cycles, worldbookContract: contract }];
  app.worldbookContract = contract;
  const policy = { schema: 'reverie.source-migration-policy.v1', passed: true, legacyWorldbookImportsAbsent: true,
    requiredWorldbookModules: ['__init__.py', 'engine.py', 'regex_supervisor.py', 'regex_worker.py', 'runtime.py'] };
  input.evidence.build.report.sourceMigration = { source: policy, staged: policy };
  input.evidence.packageAudit.report.source = policy;
  input.evidence.packageAudit.report.finalPayload = policy;
  input.evidence.packageAudit.report.remainingHypaPresent = true;
  input.evidence.packageAudit.report.modules = [{ name: 'worldbook-engine.py', bytes: 44, sha256: digest }];
  return input;
}

test('phase B export retains bounded worldbook checks and restart hashes, not identities or patterns', (t) => {
  const { input, out } = workspace(t);
  fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
  assert.equal(exportBundle(input, out).valid, true);
  const app = JSON.parse(fs.readFileSync(path.join(out, 'application.json')));
  assert.equal(app.worldbookContract.steps.length, 7);
  assert.equal(app.worldbookContract.steps[4].actualModelPromptChecked, true);
  assert.deepEqual(app.worldbookContract.workers, { spawned: 3, timeoutRecorded: true, allReaped: true, externalInterpreter: false });
  assert.deepEqual(app.worldbookContract.finalArchive, { revision: 8, checksum: 'd'.repeat(64), bookSha256: 'e'.repeat(64), entryCount: 1 });
  assert.equal(app.cycles[1].worldbookRestored.entryCount, 1);
  assert.equal(app.cycles[2].worldbookRestored.noModelCall, true);
  assert.deepEqual(app.startupGroups[0].worldbookContract, app.worldbookContract);
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'packageAudit.json')));
  assert.equal(pkg.remainingHypaPresent, true);
  assert.equal(pkg.finalPayload.legacyWorldbookImportsAbsent, true);
  assert.equal(pkg.source.requiredWorldbookModules.length, 5);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json')));
  assert.equal(summary.worldbookFunctionalAcceptance, 'passed');
  assert.equal(summary.automationIsolationAcceptance, 'passed');
  assert.equal(summary.allOperationalConstraintsMet, false);
  assert.equal(summary.dataIsolationDeviationRecorded, true);
  const text = fs.readdirSync(out).map((name) => fs.readFileSync(path.join(out, name), 'utf8')).join('\n');
  assert.doesNotMatch(text, /PRIVATE_|RAW_SECRET|\/Users\/|"entryIds"|"timeoutDiagnostic"/);
  assert.equal(verifyBundle(out).valid, true);
});

test('worldbook successful evidence cannot bind restored state to another archive', () => {
  for (const change of [
    (x) => { x.revision++; },
    (x) => { x.checksum = 'f'.repeat(64); },
    (x) => { x.bookSha256 = 'f'.repeat(64); },
    (x) => { x.entryIds.push('another-entry'); },
    (x) => { x.noModelCall = false; },
  ]) {
    const value = worldbookFixture(); change(value.evidence.application.report.cycles[2].worldbookRestored);
    assert.throws(() => sanitizeAggregation(value), /worldbook restart identity mismatch/);
  }
});

test('portable verifier checks worldbook restart binding despite recalculated report digest', (t) => {
  const { input, out } = workspace(t);
  fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
  exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (app) => {
    app.cycles[2].worldbookRestored.checksum = 'f'.repeat(64);
    app.startupGroups[0].cycles[2].worldbookRestored.checksum = 'f'.repeat(64);
  });
  assert.throws(() => verifyBundle(out), /worldbook restart identity mismatch/);
});

test('successful worldbook evidence requires observed timeout, cleanup and bundled interpreter', () => {
  for (const change of [
    (x) => { x.workers.spawned = 1; },
    (x) => { x.workers.timeoutRecorded = false; },
    (x) => { x.workers.allReaped = false; },
    (x) => { x.workers.externalInterpreter = true; },
    (x) => { x.visibleWarning = false; },
    (x) => { x.repairClearsWarning = false; },
  ]) {
    const value = worldbookFixture(); change(value.evidence.application.report.worldbookContract);
    assert.throws(() => sanitizeAggregation(value), /worldbook contract lacks required safety evidence/);
  }
});

test('successful worldbook evidence requires actual prompt checks and a matching last revision', () => {
  for (const change of [
    (x) => { x.steps[0].actualModelPromptChecked = false; },
    (x) => { x.steps.pop(); },
    (x) => { x.steps.at(-1).revision = 99; },
  ]) {
    const value = worldbookFixture(); change(value.evidence.application.report.worldbookContract);
    assert.throws(() => sanitizeAggregation(value), /worldbook prompt checks do not match/);
  }
});

test('failed partial worldbook evidence remains failed without inventing completed acceptance', () => {
  const value = worldbookFixture(), app = value.evidence.application.report;
  value.worldbookFunctionalAcceptance = 'failed';
  value.automationIsolationAcceptance = 'failed';
  app.passed = false;
  app.worldbookContract.passed = false;
  app.worldbookContract.workers.allReaped = false;
  app.worldbookContract.steps.splice(4);
  const exported = sanitizeAggregation(value).output['application.json'];
  assert.equal(exported.passed, false);
  assert.equal(exported.worldbookContract.passed, false);
  assert.equal(exported.worldbookContract.steps.length, 4);
  assert.equal(exported.worldbookContract.workers.allReaped, false);
});

for (const [kind, expected] of [
  ['runtime-copy-permission-mismatch', /Exact-mode copying was repaired.*earlier candidate was preserved/],
  ['windows-worldbook-layout-updated', /five replacement modules.*does not constitute Windows execution/],
  ['evidence-fixture-shared-array', /Independent deep copies.*rejection assertions were unchanged/],
]) {
  test(`exports fixed phase B deviation statement for ${kind} without freeform input`, (t) => {
    const { input, out } = workspace(t), value = fixture();
    value.evidence.deviation.report.events.push({ kind, details: 'RAW_SECRET_DETAIL /Users/private/path',
      error: 'RAW_SECRET_ERROR', stack: 'RAW_SECRET_STACK' });
    fs.writeFileSync(input, JSON.stringify(value));
    exportBundle(input, out);
    const exported = JSON.parse(fs.readFileSync(path.join(out, 'deviation.json')));
    assert.match(exported.events.at(-1).statement, expected);
    assert.equal(exported.events.some((event) => event.kind === 'native-ui-diagnostic-relaunch'), true);
    assert.doesNotMatch(JSON.stringify(exported), /RAW_SECRET|\/Users\/|"error"|"stack"|"details"/);
    assert.equal(verifyBundle(out).valid, true);
  });
}

// These are semantic counterexamples from the independent review, not a check
// against the historical verifier hash. Recalculate each derivative identity so
// rejection cannot be attributed merely to byte corruption.
function changeManifestSchema(out, schema) {
  const file = path.join(out, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.schema = schema;
  fs.writeFileSync(file, json(manifest));
  if (schema === 'reverie.portable-evidence.v1') {
    for (const name of ['application.json', 'startupSampling.json']) if (fs.existsSync(path.join(out, name))) {
      rewriteRegistered(out, name, (report) => { delete report.observations; });
    }
    rewriteRegistered(out, 'summary.json', (report) => { delete report.deliveryFacts; });
  }
}

// Follow-up review R1/R2: these fixtures contain the actual facts whose
// relationships are checked. Missing legacy facts are tested separately.
function reviewedSafetyFixture(reportName) {
  const data = worldbookFixture(), app = data.evidence.application.report;
  app.cycles.forEach((cycle, index) => {
    cycle.modelCalls = index === 0 ? 1 : 0;
    cycle.protectedKeyStable = true;
    cycle.encryptedDatabase = true;
  });
  app.negativeCases = ['vault', 'database', 'missing-vault'].map(kind => ({
    kind, authenticated: false, durableHashesUnchanged: true,
  }));
  app.security.signatureVerified = true;
  if (reportName === 'startupSampling') data.evidence.startupSampling = structuredClone(data.evidence.application);
  return data;
}
function changeReviewCycles(report, change) {
  // A JSON round trip separates grouped and flattened records. Mutate both so
  // rejection cannot come merely from a flattened sampling mismatch.
  report.cycles.forEach(change);
  for (const group of report.startupGroups || []) group.cycles.forEach(change);
}
const REVIEWED_SAFETY_FAILURES = [
  ['R1 restoration no-call counter', (app) => changeReviewCycles(app, cycle => {
    if (cycle.worldbookRestored) cycle.modelCalls = 1;
  })],
  ['R2 missing-vault authentication', app => { app.negativeCases.find(item => item.kind === 'missing-vault').authenticated = true; }],
  ['R2 database durable bytes', app => { app.negativeCases.find(item => item.kind === 'database').durableHashesUnchanged = false; }],
  ['R2 cycle encryption', app => changeReviewCycles(app, (cycle, index) => { if (index === 0) cycle.encryptedDatabase = false; })],
  ['R2 cycle protected key', app => changeReviewCycles(app, (cycle, index) => { if (index === 0) cycle.protectedKeyStable = false; })],
  ['R2 signature verification', app => { app.security.signatureVerified = false; }],
];
function assertReviewedClaimRejected(operation) {
  assert.throws(operation, error => {
    assert.equal(error.code, 'ERR_EVIDENCE_CLAIM');
    assert.equal(error.result.valid, false);
    assert.equal(error.result.claimConsistency, 'failed');
    assert.deepEqual(error.result.acceptance, {});
    assert.doesNotMatch(JSON.stringify(error.result), /PRIVATE_|RAW_SECRET|\/Users\//);
    return true;
  });
}
for (const reportName of ['application', 'startupSampling']) {
  for (const [name, mutate] of REVIEWED_SAFETY_FAILURES) {
    test(`${reportName}: export rejects reviewed ${name}`, (t) => {
      const { input, out } = workspace(t), data = reviewedSafetyFixture(reportName);
      mutate(data.evidence[reportName].report);
      fs.writeFileSync(input, JSON.stringify(data));
      assertReviewedClaimRejected(() => exportBundle(input, out));
      assert.equal(fs.existsSync(out), false);
    });
    for (const schema of ['reverie.portable-evidence.v1', 'reverie.portable-evidence.v2']) {
      test(`${reportName}: ${schema} rejects reviewed ${name} after rehash`, (t) => {
        const { input, out } = workspace(t);
        fs.writeFileSync(input, JSON.stringify(reviewedSafetyFixture(reportName)));
        exportBundle(input, out);
        changeManifestSchema(out, schema);
        assert.equal(verifyBundle(out).valid, true);
        rewriteRegistered(out, `${reportName}.json`, mutate);
        assertReviewedClaimRejected(() => verifyBundle(out));
      });
    }
    test(`${reportName}: reviewed ${name} can be recorded as a coherent failure`, (t) => {
      const { input, out } = workspace(t), data = reviewedSafetyFixture(reportName);
      const app = data.evidence[reportName].report;
      mutate(app);
      app.passed = false;
      app.worldbookContract.passed = false;
      for (const group of app.startupGroups) group.worldbookContract.passed = false;
      if (name.startsWith('R1')) changeReviewCycles(app, cycle => {
        if (cycle.worldbookRestored) cycle.worldbookRestored.noModelCall = false;
      });
      if (reportName === 'application') data.worldbookFunctionalAcceptance = 'failed';
      data.automationIsolationAcceptance = 'failed';
      fs.writeFileSync(input, JSON.stringify(data));
      const result = exportBundle(input, out);
      assert.equal(result.valid, true);
      assert.equal(result.acceptance[reportName], 'failed');
      for (const schema of ['reverie.portable-evidence.v2', 'reverie.portable-evidence.v1']) {
        changeManifestSchema(out, schema);
        const before = fs.readFileSync(path.join(out, `${reportName}.json`));
        assert.equal(verifyBundle(out).acceptance[reportName], 'failed');
        assert.deepEqual(fs.readFileSync(path.join(out, `${reportName}.json`)), before);
      }
    });
  }
  test(`${reportName}: missing reviewed legacy facts stay absent in export and v1/v2 readback`, (t) => {
    const { input, out } = workspace(t), data = reviewedSafetyFixture(reportName);
    const app = data.evidence[reportName].report;
    changeReviewCycles(app, cycle => {
      delete cycle.modelCalls;
      delete cycle.encryptedDatabase;
      delete cycle.protectedKeyStable;
    });
    for (const item of app.negativeCases) {
      delete item.authenticated;
      delete item.durableHashesUnchanged;
    }
    delete app.security.signatureVerified;
    fs.writeFileSync(input, JSON.stringify(data));
    assert.equal(exportBundle(input, out).valid, true);
    for (const schema of ['reverie.portable-evidence.v2', 'reverie.portable-evidence.v1']) {
      changeManifestSchema(out, schema);
      const filename = path.join(out, `${reportName}.json`), before = fs.readFileSync(filename);
      assert.equal(verifyBundle(out).valid, true);
      assert.deepEqual(fs.readFileSync(filename), before);
      const exported = JSON.parse(before);
      assert.equal(Object.hasOwn(exported.security, 'signatureVerified'), false);
      for (const cycle of [...exported.cycles, ...exported.startupGroups.flatMap(group => group.cycles)]) {
        for (const field of ['modelCalls', 'encryptedDatabase', 'protectedKeyStable']) assert.equal(Object.hasOwn(cycle, field), false);
      }
      for (const item of exported.negativeCases) {
        assert.equal(Object.hasOwn(item, 'authenticated'), false);
        assert.equal(Object.hasOwn(item, 'durableHashesUnchanged'), false);
      }
    }
  });
}

for (const kind of ['vault', 'database', 'missing-vault']) {
  for (const [field, value] of [['authenticated', true], ['durableHashesUnchanged', false]]) {
    test(`all storage refusal kinds reject explicit ${kind} ${field} failure`, (t) => {
      const { input, out } = workspace(t), data = reviewedSafetyFixture('application');
      data.evidence.application.report.negativeCases.find(item => item.kind === kind)[field] = value;
      fs.writeFileSync(input, JSON.stringify(data));
      assertReviewedClaimRejected(() => exportBundle(input, out));
    });
  }
}

for (const schema of ['reverie.portable-evidence.v1', 'reverie.portable-evidence.v2']) {
  for (const [name, code, mutation] of [
    ['missing worldbook contracts despite passed summary', 'ERR_EVIDENCE_CLAIM', (app) => {
      delete app.worldbookContract;
      for (const group of app.startupGroups || []) delete group.worldbookContract;
    }],
    ['raw build report manifest binding mismatch', 'ERR_EVIDENCE_BINDING', (app) => { app.buildBinding.manifestSha256 = '0'.repeat(64); }],
    ['application ASAR binding mismatch', 'ERR_EVIDENCE_BINDING', (app) => { app.security.asarSha256 = '0'.repeat(64); }],
  ]) {
    test(`${schema}: rejects reviewed ${name} after rehash`, (t) => {
      const { input, out } = workspace(t);
      fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
      exportBundle(input, out);
      changeManifestSchema(out, schema);
      assert.equal(verifyBundle(out).valid, true);
      rewriteRegistered(out, 'application.json', mutation);
      assert.throws(() => verifyBundle(out), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.result.schema, 'reverie.portable-evidence-verification.v2');
        assert.equal(error.result.valid, false);
        assert.equal(error.result.error.code, code);
        assert.equal(Object.hasOwn(error.result, 'passed'), false);
        return true;
      });
    });
  }
}

test('v2 verification reports acceptance separately from evidence validity', (t) => {
  const { input, out } = workspace(t);
  const data = worldbookFixture();
  data.worldbookFunctionalAcceptance = 'failed';
  data.automationIsolationAcceptance = 'not-run';
  const app = data.evidence.application.report;
  app.passed = false;
  app.cycles = [];
  delete app.worldbookContract;
  delete app.startupGroups;
  delete app.startupSampling;
  delete app.buildBinding;
  delete app.security;
  fs.writeFileSync(input, JSON.stringify(data));
  const result = exportBundle(input, out);
  assert.equal(result.schema, 'reverie.portable-evidence-verification.v2');
  assert.equal(result.bundleSchema, 'reverie.portable-evidence.v2');
  assert.equal(result.valid, true);
  assert.equal(Object.hasOwn(result, 'passed'), false);
  assert.deepEqual(result.acceptance, { worldbook: 'failed', automationIsolation: 'not-run', application: 'failed' });
});

for (const status of ['failed', 'not-run', 'pending', 'with-reservations']) {
  test(`preserves honest ${status} worldbook summary with incomplete failure evidence`, (t) => {
    const { input, out } = workspace(t), data = worldbookFixture();
    data.worldbookFunctionalAcceptance = status;
    data.automationIsolationAcceptance = status;
    data.evidence.application.report.passed = false;
    data.evidence.application.report.worldbookContract.passed = false;
    data.evidence.application.report.worldbookContract.steps.splice(2);
    fs.writeFileSync(input, JSON.stringify(data));
    const result = exportBundle(input, out);
    assert.equal(result.valid, true);
    assert.equal(result.acceptance.worldbook, status);
    assert.equal(result.acceptance.application, 'failed');
  });
}

test('refuses an application failure hidden behind passed worldbook and isolation claims', (t) => {
  const { input, out } = workspace(t), data = worldbookFixture();
  data.evidence.application.report.passed = false;
  assert.throws(() => sanitizeAggregation(data), /passed worldbook declaration conflicts/);
  data.worldbookFunctionalAcceptance = 'failed';
  assert.throws(() => sanitizeAggregation(data), /passed isolation declaration conflicts/);
  fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
  exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (app) => { app.passed = false; });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_CLAIM');
});

for (const count of [0, 1, 2]) {
  test(`worldbook pass requires three cycles, not ${count}`, () => {
    const data = worldbookFixture(), app = data.evidence.application.report;
    delete app.startupSampling;
    delete app.startupGroups;
    app.cycles = app.cycles.slice(0, count);
    assert.throws(() => sanitizeAggregation(data), /three cycles and two restorations/);
  });
}

test('passed worldbook contract cannot silently omit a declared group or its restored state', () => {
  const data = worldbookFixture(), app = data.evidence.application.report;
  app.startupSampling.groups = 2;
  app.startupSampling.freshProfiles = 2;
  assert.throws(() => sanitizeAggregation(data), /sampling is incomplete/);
  const group2 = structuredClone(app.startupGroups[0]);
  group2.group = 2;
  group2.cycles.forEach((cycle, index) => { cycle.label = `second-${index}`; });
  app.startupGroups.push(group2);
  app.cycles = app.startupGroups.flatMap((group) => group.cycles);
  delete group2.worldbookContract;
  assert.throws(() => sanitizeAggregation(data), /worldbook top-level and final-group|missing worldbook contract/);
});

test('worldbook revision progression must represent all seven observed archive revisions', () => {
  const data = worldbookFixture();
  data.evidence.application.report.worldbookContract.steps[2].revision = 6;
  assert.throws(() => sanitizeAggregation(data), /revision sequence mismatch/);
});

for (const field of ['manifestSha256', 'sourceSha256', 'signedBundleSha256']) {
  test(`a provided ${field} binding is enforced even for early failed applications`, () => {
    const data = fixture(), app = data.evidence.application.report;
    app.passed = false;
    app.cycles = [];
    app.buildBinding[field] = '0'.repeat(64);
    assert.throws(() => sanitizeAggregation(data), /application\/build manifest identity mismatch/);
  });
}

test('startup sampling must bind its own raw manifest rather than borrowing application identity', (t) => {
  const { input, out } = workspace(t), data = fixture();
  data.evidence.startupSampling = structuredClone(data.evidence.application);
  data.evidence.startupSampling.report.buildBinding.manifestSha256 = '0'.repeat(64);
  assert.throws(() => sanitizeAggregation(data), /application\/build manifest identity mismatch/);
  data.evidence.startupSampling.report.buildBinding.manifestSha256 = digest;
  fs.writeFileSync(input, JSON.stringify(data));
  exportBundle(input, out);
  rewriteRegistered(out, 'startupSampling.json', (app) => { app.buildBinding.manifestSha256 = '0'.repeat(64); });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_BINDING');
});

test('manifest binding is the original raw file hash, not its derivative or embedded JSON digest', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json')));
  const build = manifest.files.find((entry) => entry.path === 'build.json');
  for (const wrong of [build.sha256, build.originalReport.embeddedReportSha256]) {
    assert.notEqual(wrong, build.originalReport.sha256);
    rewriteRegistered(out, 'application.json', (app) => { app.buildBinding.manifestSha256 = wrong; });
    assert.throws(() => verifyBundle(out), /application\/build manifest identity mismatch/);
  }
});

for (const location of ['package', 'application', 'sampling']) {
  test(`rejects conflicting ${location} ASAR even in failed reports`, () => {
    const data = fixture();
    data.evidence.packageAudit.report.passed = false;
    data.evidence.application.report.passed = false;
    data.evidence.startupSampling = structuredClone(data.evidence.application);
    if (location === 'package') data.evidence.packageAudit.report.asarSha256 = '0'.repeat(64);
    else data.evidence[location === 'sampling' ? 'startupSampling' : 'application'].report.security.asarSha256 = '0'.repeat(64);
    assert.throws(() => sanitizeAggregation(data), /ASAR identity mismatch/);
  });
}

function rebindBundle(data) {
  const next = hash(JSON.stringify(data.evidence.build.report.bundle.files));
  data.evidence.build.report.bundle.sha256 = next;
  data.evidence.packageAudit.report.signedBundleSha256 = next;
  data.evidence.application.report.buildBinding.signedBundleSha256 = next;
}
for (const invalid of ['missing', 'duplicate', 'symlink', 'different-case', 'wrong-digest']) {
  test(`ASAR inventory rejects ${invalid} entry despite coherent bundle rehash`, () => {
    const data = fixture(), rows = data.evidence.build.report.bundle.files;
    if (invalid === 'missing') rows.pop();
    if (invalid === 'duplicate') rows.push(structuredClone(rows[1]));
    if (invalid === 'symlink') rows[1] = { path: 'Contents/Resources/app.asar', symlink: '../MacOS/Test' };
    if (invalid === 'different-case') rows[1].path = 'Contents/Resources/App.asar';
    if (invalid === 'wrong-digest') rows[1].sha256 = '0'.repeat(64);
    rebindBundle(data);
    assert.throws(() => sanitizeAggregation(data), /ASAR|duplicate inventory path/);
  });
}

test('early failed reports may omit all unexecuted ASAR checks without inventing equality', (t) => {
  const { input, out } = workspace(t), data = fixture();
  data.firstBatchFunctionalAcceptance = 'failed';
  data.evidence.packageAudit.report.passed = false;
  delete data.evidence.packageAudit.report.asarSha256;
  data.evidence.application.report.passed = false;
  data.evidence.application.report.cycles = [];
  delete data.evidence.application.report.security;
  data.evidence.build.report.bundle.files.pop();
  rebindBundle(data);
  delete data.evidence.application.report.buildBinding;
  fs.writeFileSync(input, JSON.stringify(data));
  const result = exportBundle(input, out);
  assert.equal(result.valid, true);
  const app = JSON.parse(fs.readFileSync(path.join(out, 'application.json')));
  assert.equal(Object.hasOwn(app, 'security'), false);
  assert.equal(Object.hasOwn(app, 'buildBinding'), false);
});

test('ASAR derivative inventory mutation remains rejected after every advertised inventory hash is recomputed', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  let changed;
  rewriteRegistered(out, 'signed-app-inventory.json', (rows) => { rows[1].sha256 = '0'.repeat(64); changed = hash(JSON.stringify(rows)); });
  rewriteRegistered(out, 'build.json', (build) => { build.bundle.sha256 = changed; });
  rewriteRegistered(out, 'packageAudit.json', (pkg) => { pkg.signedBundleSha256 = changed; });
  rewriteRegistered(out, 'application.json', (app) => { app.buildBinding.signedBundleSha256 = changed; });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_BINDING' && /ASAR/.test(error.message));
});

test('CLI keeps 0/1 exits and emits redacted structured failure', (t) => {
  const { input, out, root } = workspace(t);
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, 'macos-evidence.cjs');
  const success = spawnSync(process.execPath, [script, 'export', '--input', input, '--out', out], { encoding: 'utf8' });
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).valid, true);
  const invalid = spawnSync(process.execPath, [script, 'verify', '--bundle', path.join(root, 'PRIVATE_SECRET_MISSING')], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  const failure = JSON.parse(invalid.stderr);
  assert.equal(failure.valid, false);
  assert.equal(failure.error.code, 'ERR_EVIDENCE_FILESYSTEM');
  assert.doesNotMatch(invalid.stderr, /PRIVATE_SECRET|\/Users\/|reverie-evidence-test/);
  const usage = spawnSync(process.execPath, [script, 'PRIVATE_SECRET_ARG'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.equal(JSON.parse(usage.stderr).error.code, 'ERR_EVIDENCE_USAGE');
  assert.doesNotMatch(usage.stderr, /PRIVATE_SECRET_ARG/);
});

function withCoverage(data = fixture()) {
  const { CANDIDATE, buildCoverage } = require('./evidence-test-map.cjs');
  data.evidence.build.report.candidate.head = CANDIDATE;
  data.evidence.packageAudit.report.codeCommit = CANDIDATE;
  data.testTraceability = buildCoverage([]);
  return data;
}

test('optional controlled traceability is exported and revalidated as a separate v2 file', (t) => {
  const { input, out } = workspace(t), data = withCoverage();
  fs.writeFileSync(input, JSON.stringify(data));
  assert.equal(exportBundle(input, out).files, 9);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'test-traceability.json'))), data.testTraceability);
  rewriteRegistered(out, 'test-traceability.json', (coverage) => { coverage.privateLog = 'SECRET'; });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_COVERAGE');
});

test('traceability may not bind to a different application candidate', () => {
  const data = fixture();
  data.testTraceability = require('./evidence-test-map.cjs').buildCoverage([]);
  assert.throws(() => sanitizeAggregation(data), /test traceability candidate mismatch/);
});

test('legacy v1 does not silently acquire new traceability files', (t) => {
  const { input, out } = workspace(t);
  fs.writeFileSync(input, JSON.stringify(withCoverage()));
  exportBundle(input, out);
  changeManifestSchema(out, 'reverie.portable-evidence.v1');
  assert.throws(() => verifyBundle(out), /invalid manifest file registration/);
});

test('v2 exports producer observations without inventing identity or isolation verification', (t) => {
  const { input, out } = workspace(t), data = fixture(), app = data.evidence.application.report;
  app.forcedCleanup = [];
  app.negativeCases = [{ kind: 'missing-vault', replacementKeyGenerated: false, sensitive: 'RAW_SECRET' }];
  app.cycles[0].processIdentity = { pid: 12345, executable: '/Users/private/SECRET' };
  app.cycles[0].isolationDirectories = [{ path: '/Users/private/SECRET', uid: 501, inode: 123456 }];
  fs.writeFileSync(input, JSON.stringify(data));
  exportBundle(input, out);
  const observed = JSON.parse(fs.readFileSync(path.join(out, 'application.json'))).observations;
  assert.equal(observed.forcedCleanupCount, 0);
  assert.deepEqual(observed.negativeCases, [{ kind: 'missing-vault', replacementKeyGenerated: false }]);
  assert.deepEqual(observed.cycles[0], { label: 'normal-1', processIdentityRecorded: true,
    isolationDirectoryCount: 1, identityVerified: null, isolatedDataVerified: null });
  assert.equal(observed.cycles[1].processIdentityRecorded, null);
  assert.equal(observed.cycles[1].isolationDirectoryCount, null);
  assert.doesNotMatch(JSON.stringify(observed), /RAW_SECRET|PRIVATE|\/Users\/|12345|123456/);
});

test('missing cleanup and key facts remain unknown instead of zero or false', () => {
  const data = fixture();
  data.evidence.application.report.negativeCases = [{ kind: 'missing-vault' }];
  const observed = sanitizeAggregation(data).output['application.json'].observations;
  assert.equal(observed.forcedCleanupCount, null);
  assert.equal(observed.negativeCases[0].replacementKeyGenerated, null);
});

for (const item of ['cleanup', 'replacement-key', 'identity', 'isolation']) {
  test(`known ${item} failure cannot coexist with a passed isolation application claim`, (t) => {
    const { input, out } = workspace(t), data = worldbookFixture(), app = data.evidence.application.report;
    if (item === 'cleanup') app.forcedCleanup = ['PRIVATE_PROCESS_FORCED_CLEANUP'];
    if (item === 'replacement-key') app.negativeCases = [{ kind: 'missing-vault', replacementKeyGenerated: true }];
    if (item === 'identity') app.cycles[0].identityVerified = false;
    if (item === 'isolation') app.cycles[0].isolatedDataVerified = false;
    fs.writeFileSync(input, JSON.stringify(data));
    assert.throws(() => exportBundle(input, out), (error) => error.code === 'ERR_EVIDENCE_CLAIM');
    assert.equal(fs.existsSync(out), false);
  });
}

for (const field of ['label', 'producer', 'negative-kind', 'count']) {
  test(`rejects rehashed producer observation ${field} mismatch`, (t) => {
    const { input, out } = workspace(t); exportBundle(input, out);
    rewriteRegistered(out, 'application.json', (app) => {
      if (field === 'label') app.observations.cycles[0].label = 'unrelated-cycle';
      if (field === 'producer') app.observations.producer.validatorSha256 = '0'.repeat(64);
      if (field === 'negative-kind') {
        app.observations.negativeCases = [{ kind: 'vault', replacementKeyGenerated: null }];
        app.observations.negativeCaseRecordsAvailable = true;
      }
      if (field === 'count') app.observations.cycles.pop();
    });
    assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_BINDING');
  });
}

test('a rehashed forced-cleanup assertion is checked by the portable reader', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (app) => { app.observations.forcedCleanupCount = 1; });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_CLAIM');
});

test('legacy v1 allows no observations and does not infer new producer facts', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  changeManifestSchema(out, 'reverie.portable-evidence.v1');
  const before = fs.readFileSync(path.join(out, 'application.json'));
  assert.equal(verifyBundle(out).valid, true);
  assert.deepEqual(fs.readFileSync(path.join(out, 'application.json')), before);
  assert.equal(Object.hasOwn(JSON.parse(before), 'observations'), false);
  rewriteRegistered(out, 'application.json', (app) => { app.observations = {}; });
  assert.throws(() => verifyBundle(out), /unregistered or altered derivative/);
});

test('v2 requires typed producer facts instead of accepting omitted facts from a v1-shaped derivative', (t) => {
  const { input, out } = workspace(t); exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (app) => { delete app.observations; });
  assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_FACTS');
});

test('worldbook restart recovery count and message identity may not be weakened after rehash', (t) => {
  const { input, out } = workspace(t);
  fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
  exportBundle(input, out);
  rewriteRegistered(out, 'application.json', (app) => { app.profileRecovery[0].cycles = 1; });
  assert.throws(() => verifyBundle(out), /profile recovery group mismatch/);
  rewriteRegistered(out, 'application.json', (app) => { app.profileRecovery[0].cycles = 3; app.profileRecovery[0].recoveredMessagesAndIdsEqual = false; });
  assert.throws(() => verifyBundle(out), /worldbook restart message identity is not established/);
});

test('relocated verifier and its fixed helper files independently read a bundle', (t) => {
  const { input, out, root } = workspace(t); exportBundle(input, out);
  fs.unlinkSync(input);
  const portable = path.join(root, '中文 portable-tools');
  fs.mkdirSync(portable);
  for (const [from, to] of [['macos-evidence.cjs', 'verify-evidence.cjs'], ['evidence-facts.cjs', 'evidence-facts.cjs'],
    ['evidence-test-map.cjs', 'evidence-test-map.cjs']]) fs.copyFileSync(path.join(__dirname, from), path.join(portable, to));
  const run = require('node:child_process').spawnSync(process.execPath, [path.join(portable, 'verify-evidence.cjs'), 'verify', '--bundle', out], {
    encoding: 'utf8', cwd: portable,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

for (const row of [{}, { id: 'PRIVATE_ID' }, { id: 'PRIVATE_ID', role: 'user' }, { id: '', role: 'user', content: '' }]) {
  test(`incomplete recovery records cannot establish message identity (${Object.keys(row).join('-') || 'empty'})`, () => {
    const ordinary = fixture();
    ordinary.evidence.application.report.cycles.forEach(cycle => { cycle.recoveredMessages = [structuredClone(row)]; });
    assert.equal(sanitizeAggregation(ordinary).output['application.json'].recoveredMessagesAndIdsEqualAcrossCycles, null);
    const worldbook = worldbookFixture();
    worldbook.evidence.application.report.cycles.forEach(cycle => { cycle.recoveredMessages = [structuredClone(row)]; });
    assert.throws(() => sanitizeAggregation(worldbook), /worldbook restart message identity is not established/);
  });
}

test('duplicate recovered IDs cannot establish complete message identity', () => {
  const data = worldbookFixture();
  data.evidence.application.report.cycles.forEach(cycle => { cycle.recoveredMessages.push(structuredClone(cycle.recoveredMessages[0])); });
  assert.throws(() => sanitizeAggregation(data), /worldbook restart message identity is not established/);
});

test('worldbook group cycles stay bound to the application even without optional sampling metadata', () => {
  const data = worldbookFixture(), app = data.evidence.application.report;
  delete app.startupSampling;
  app.cycles = [];
  assert.throws(() => sanitizeAggregation(data), /flattened startup sampling mismatch/);
});

for (const count of [0, 1, 2]) {
  test(`passed isolation cannot rely on ${count} cycles after deleting the worldbook claim`, () => {
    const data = worldbookFixture(), app = data.evidence.application.report;
    data.worldbookFunctionalAcceptance = 'not-run';
    delete app.worldbookContract;
    delete app.startupGroups;
    delete app.startupSampling;
    app.cycles = app.cycles.slice(0, count);
    assert.throws(() => sanitizeAggregation(data), /passed isolation requires three normal cycles/);
  });
}

for (const field of ['noResidualProcesses', 'noResidualMounts', 'scratchRemoved', 'bundleUnchanged']) {
  test(`explicit ${field} failure contradicts a passed application`, (t) => {
    const data = worldbookFixture(), app = data.evidence.application.report;
    app[field] = false;
    assert.throws(() => sanitizeAggregation(data), /passed application conflicts with cleanup failure/);
    const { input, out } = workspace(t);
    fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
    exportBundle(input, out);
    rewriteRegistered(out, 'application.json', (report) => { report[field] = false; });
    assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_CLAIM');
  });
}

test('passed isolation requires normal quit proof while absent OS identity flags stay unknown', () => {
  const data = worldbookFixture(), app = data.evidence.application.report;
  data.worldbookFunctionalAcceptance = 'not-run';
  delete app.worldbookContract;
  delete app.startupGroups;
  delete app.startupSampling;
  assert.equal(sanitizeAggregation(data).output['application.json'].observations.cycles[0].identityVerified, null);
  app.cycles[0].normalQuit = false;
  assert.throws(() => sanitizeAggregation(data), /passed isolation requires three normal cycles/);
});

function addHistorical(data, id, result) {
  const { buildCoverage, CANDIDATE } = require('./evidence-test-map.cjs');
  const packageScope = id === 'package-worldbook-seven-scenarios';
  data.testTraceability = buildCoverage([], [{ id, sourceCommit: CANDIDATE, reportSha256: digest,
    logSha256: packageScope ? null : digest,
    locator: packageScope ? 'application.worldbookContract.steps.0-6' : 'source.steps.pytest',
    granularity: packageScope ? 'scenario' : 'file', result, rerun: false }]);
  return data;
}

test('historical passed Python mapping requires the referenced stage to have passed', (t) => {
  const { input, out } = workspace(t), data = addHistorical(withCoverage(), 'candidate-python-file-results', 'passed');
  fs.writeFileSync(input, JSON.stringify(data));
  exportBundle(input, out);
  rewriteRegistered(out, 'source.json', (source) => { source.status = 'failed'; source.steps[0].status = 'failed'; source.steps[0].exitCode = 1; });
  assert.throws(() => verifyBundle(out), /historical test result conflicts with source stage/);
  data.evidence.source.report.steps[0].status = 'failed';
  data.evidence.source.report.steps[0].exitCode = 1;
  assert.throws(() => sanitizeAggregation(data), /historical test result conflicts with source stage/);
});

test('historical missing source stage must remain unknown rather than passed', () => {
  const data = addHistorical(withCoverage(), 'candidate-python-file-results', 'passed');
  data.evidence.source.report.steps = [];
  assert.throws(() => sanitizeAggregation(data), /historical test result lacks a unique source stage/);
  data.testTraceability.historical[0].result = 'unknown';
  assert.equal(sanitizeAggregation(data).output['test-traceability.json'].historical[0].result, 'unknown');
});

test('historical worldbook passed cannot survive a coherent failed app with missing contract', () => {
  const data = addHistorical(withCoverage(worldbookFixture()), 'package-worldbook-seven-scenarios', 'passed');
  assert.equal(sanitizeAggregation(data).output['test-traceability.json'].historical[0].result, 'passed');
  data.worldbookFunctionalAcceptance = 'failed';
  data.automationIsolationAcceptance = 'failed';
  data.evidence.application.report.passed = false;
  delete data.evidence.application.report.worldbookContract;
  delete data.evidence.application.report.startupGroups;
  delete data.evidence.application.report.startupSampling;
  assert.throws(() => sanitizeAggregation(data), /passed worldbook declaration conflicts with application status/);
  data.testTraceability.historical[0].result = 'failed';
  assert.equal(sanitizeAggregation(data).output['test-traceability.json'].historical[0].result, 'failed');
});

for (const schema of ['reverie.portable-evidence.v1', 'reverie.portable-evidence.v2']) {
  for (const field of ['identityVerified', 'isolatedDataVerified']) {
    test(`${schema}: explicit ${field} false contradicts isolation pass`, (t) => {
      const { input, out } = workspace(t);
      fs.writeFileSync(input, JSON.stringify(worldbookFixture()));
      exportBundle(input, out);
      changeManifestSchema(out, schema);
      rewriteRegistered(out, 'application.json', (app) => {
        app.cycles[0][field] = false;
        app.startupGroups[0].cycles[0][field] = false;
        if (schema.endsWith('.v2')) app.observations.cycles[0][field] = false;
      });
      assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_CLAIM');
    });
  }
}

for (const [id, locator, granularity] of [
  ['candidate-node-named-results', 'source.steps.frontend-test.node', 'named-case'],
  ['candidate-vitest-batch-results', 'source.steps.frontend-test.vitest', 'batch'],
]) {
  test(`failed combined frontend stage leaves ${id} unknown without separate runner evidence`, (t) => {
    const { input, out } = workspace(t), data = withCoverage();
    data.evidence.source.report.status = 'failed';
    data.evidence.source.report.steps.push({ name: 'frontend-test', status: 'failed', exitCode: 1 });
    const { buildCoverage, CANDIDATE } = require('./evidence-test-map.cjs');
    data.testTraceability = buildCoverage([], [{ id, sourceCommit: CANDIDATE, reportSha256: digest,
      logSha256: digest, locator, granularity, result: 'unknown', rerun: false }]);
    fs.writeFileSync(input, JSON.stringify(data));
    assert.equal(exportBundle(input, out).valid, true);
    const exportedSource = JSON.parse(fs.readFileSync(path.join(out, 'source.json')));
    assert.equal(exportedSource.status, 'failed');
    assert.equal(exportedSource.steps.at(-1).status, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'test-traceability.json'))).historical[0].result, 'unknown');
    for (const unsupported of ['passed', 'failed']) {
      data.testTraceability.historical[0].result = unsupported;
      assert.throws(() => sanitizeAggregation(data), (error) => error.code === 'ERR_EVIDENCE_CLAIM'
        && /unsupported by the aggregate/.test(error.message));
      rewriteRegistered(out, 'test-traceability.json', (coverage) => { coverage.historical[0].result = unsupported; });
      assert.throws(() => verifyBundle(out), (error) => error.code === 'ERR_EVIDENCE_CLAIM'
        && /unsupported by the aggregate/.test(error.message));
    }
  });
}
