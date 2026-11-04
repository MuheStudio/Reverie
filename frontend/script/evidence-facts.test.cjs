'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { projectApplicationFacts, validateApplicationFacts, projectSummaryFacts, validateSummaryFacts } = require('./evidence-facts.cjs');
const hash = 'a'.repeat(64);
function report() {
  return { cycles: [{ label: 'normal-g1-1', processIdentity: { pid: 123, uid: 501, birth: 'PRIVATE_BIRTH', name: '/Users/private/app' },
    isolationDirectories: [{ path: '/Users/private/data', inode: 'PRIVATE_INODE' }] }],
  forcedCleanup: [], negativeCases: [{ kind: 'missing-vault', replacementKeyGenerated: false }],
  validationRevision: { sha256: hash, isolationController: { sha256: hash }, nativeErrorHelper: { sha256: hash } } };
}

test('producer record presence is not silently converted into identity or isolation verification', () => {
  const facts = projectApplicationFacts(report());
  assert.equal(facts.cycles[0].processIdentityRecorded, true);
  assert.equal(facts.cycles[0].isolationDirectoryCount, 1);
  assert.equal(facts.cycles[0].identityVerified, null);
  assert.equal(facts.cycles[0].isolatedDataVerified, null);
  assert.equal(facts.forcedCleanupCount, 0);
  assert.equal(facts.negativeCases[0].replacementKeyGenerated, false);
  assert.deepEqual(validateApplicationFacts(facts), facts);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|\/Users\/|"pid"|"uid"|"birth"|"inode"/);
});
test('missing historical records stay unknown rather than zero or verified', () => {
  const facts = projectApplicationFacts({ cycles: [{ label: 'normal-1' }] });
  assert.equal(facts.forcedCleanupCount, null);
  assert.equal(facts.cycles[0].processIdentityRecorded, null);
  assert.equal(facts.cycles[0].isolationDirectoryCount, null);
  assert.equal(facts.negativeCaseRecordsAvailable, false);
  assert.deepEqual(facts.negativeCases, []);
  assert.equal(facts.producer.isolationControllerSha256, null);
});
test('explicit failed facts and nonzero cleanup are retained for coherent failed reports', () => {
  const raw = report(); raw.forcedCleanup = ['normal-1'];
  Object.assign(raw.cycles[0], { identityVerified: false, isolatedDataVerified: false });
  raw.negativeCases[0].replacementKeyGenerated = true;
  const facts = projectApplicationFacts(raw);
  assert.equal(facts.forcedCleanupCount, 1);
  assert.equal(facts.cycles[0].identityVerified, false);
  assert.equal(facts.cycles[0].isolatedDataVerified, false);
  assert.equal(facts.negativeCases[0].replacementKeyGenerated, true);
});
for (const [name, mutate] of [
  ['string verification', value => { value.cycles[0].identityVerified = 'true'; }],
  ['non-array cleanup', value => { value.forcedCleanup = null; }],
  ['invalid cleanup item', value => { value.forcedCleanup = [{}]; }],
  ['string directory records', value => { value.cycles[0].isolationDirectories = ['RAW_SECRET']; }],
  ['string identity record', value => { value.cycles[0].processIdentity = 'RAW_SECRET'; }],
  ['string replacement key flag', value => { value.negativeCases[0].replacementKeyGenerated = 'false'; }],
  ['unknown negative kind', value => { value.negativeCases[0].kind = 'RAW_SECRET'; }],
]) test(`invalid producer facts reject ${name} without echoing data`, () => {
  const raw = report(); mutate(raw);
  assert.throws(() => projectApplicationFacts(raw), error => error.code === 'ERR_EVIDENCE_FACTS'
    && !error.message.includes('RAW_SECRET'));
});
test('facts derivatives reject private or unregistered fields and impossible counts', () => {
  const facts = projectApplicationFacts(report());
  assert.throws(() => validateApplicationFacts({ ...facts, pid: 123 }));
  for (const count of [-1, 0.5, '0']) assert.throws(() => validateApplicationFacts({ ...facts, forcedCleanupCount: count }));
  facts.cycles.push({ ...facts.cycles[0] });
  assert.throws(() => validateApplicationFacts(facts));
});
test('blockers use fixed identifiers and historical combined Risu task maps to both retained scopes', () => {
  const facts = projectSummaryFacts({ remaining: ['Risu worldbook then optional compression', 'GPL elephantops dependency'] });
  assert.deepEqual(facts.remainingBlockerIds, ['risu-worldbook', 'hypa-migration', 'elephantops']);
  assert.equal(facts.postBuildChecks, null);
  assert.equal(facts.postBuildChanges, null);
  assert.deepEqual(validateSummaryFacts(facts), facts);
  assert.throws(() => projectSummaryFacts({ remaining: ['RAW_SECRET'] }), /invalid bounded/);
});
test('post-build tests stay a distinct producer-declared batch without changing candidate totals', () => {
  const input = { sourceTests: { nodePassed: 637 }, postBuildChecks: { evidenceTests: 46, passed: true, scope: 'RAW_SECRET' },
    postBuildChanges: ['frontend/script/macos-evidence.cjs', 'docs/LICENSE-MIGRATION-STAGE-TWO.md'] };
  const facts = projectSummaryFacts(input);
  assert.equal(facts.postBuildChecks.evidenceTests, 46);
  assert.equal(facts.postBuildChecks.executionCommit, null);
  assert.equal(input.sourceTests.nodePassed, 637);
  assert.doesNotMatch(JSON.stringify(facts), /RAW_SECRET|637/);
  assert.deepEqual(validateSummaryFacts(facts), facts);
});
test('unsafe or duplicate change paths and arbitrary blocker fields are rejected', () => {
  for (const value of ['/Users/private/x', '../x', 'src/../x', 'C:\\private\\x']) {
    assert.throws(() => projectSummaryFacts({ postBuildChanges: [value] }));
  }
  assert.throws(() => projectSummaryFacts({ postBuildChanges: ['src/x', 'src/x'] }));
  const facts = projectSummaryFacts({});
  assert.throws(() => validateSummaryFacts({ ...facts, remainingBlockerIds: ['new-unreviewed-secret'] }));
  assert.throws(() => validateSummaryFacts({ ...facts, rawPostBuildOutput: 'RAW_SECRET' }));
});
