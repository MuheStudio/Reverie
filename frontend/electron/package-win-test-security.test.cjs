'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertNoTestCode,
  createTestBuildMetadata,
  shouldCopyElectronRuntime,
} = require('../script/package-win-test.cjs');
const { assertLive2DReleaseGate } = require('./live2d-release-gate.cjs');
const installerConfig = require('../electron-builder.config.cjs');

test('portable package filter excludes tests and fixture directories', () => {
  const file = { isDirectory: () => false };
  const directory = { isDirectory: () => true };
  assert.equal(shouldCopyElectronRuntime('avatar-manager.cjs', file), true);
  assert.equal(shouldCopyElectronRuntime('avatar-manager.test.cjs', file), false);
  assert.equal(shouldCopyElectronRuntime('payload.fixture.json', file), false);
  assert.equal(shouldCopyElectronRuntime('fixtures', directory), false);
  assert.equal(shouldCopyElectronRuntime('runtime', directory), true);
});

test('portable package verifier fails if test code reappears in staged runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-package-test-'));
  fs.writeFileSync(path.join(root, 'main.js'), '');
  assert.equal(assertNoTestCode(root), true);
  fs.writeFileSync(path.join(root, 'unexpected.test.cjs'), '');
  assert.throws(() => assertNoTestCode(root), /test code/i);
});

test('test-build metadata is explicit and cannot be mistaken for a release', () => {
  const metadata = createTestBuildMetadata();
  assert.equal(metadata.publishable, false);
  assert.equal(metadata.distribution, 'TEST_ONLY_DO_NOT_RELEASE');
});

test('release package seals Electron entrypoints in integrity-checked ASAR', () => {
  assert.equal(installerConfig.asar, true);
  assert.equal(installerConfig.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(installerConfig.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(installerConfig.electronFuses.runAsNode, false);
  assert.equal(installerConfig.electronFuses.enableNodeOptionsEnvironmentVariable, false);
});

test('an unlicensed Live2D payload cannot pass the shared package gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-package-live2d-'));
  fs.writeFileSync(path.join(root, 'character.moc3'), 'not licensed');
  assert.throws(
    () => assertLive2DReleaseGate({ buildEnabled: '0', scanRoots: [root] }),
    /Unlicensed/i,
  );
});
