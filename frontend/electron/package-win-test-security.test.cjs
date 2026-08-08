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
const {
  PYTHON_RUNTIME,
  assertProductionPayload,
  shouldCopyProductionPythonSource,
} = require('../script/production-runtime.cjs');

test('portable package filter excludes tests and fixture directories', () => {
  const file = { isDirectory: () => false };
  const directory = { isDirectory: () => true };
  assert.equal(shouldCopyElectronRuntime('avatar-manager.cjs', file), true);
  assert.equal(shouldCopyElectronRuntime('avatar-manager.test.cjs', file), false);
  assert.equal(shouldCopyElectronRuntime('bridge-supervisor.cjs', file), false);
  assert.equal(shouldCopyElectronRuntime('framed-bridge-supervisor.cjs', file), true);
  assert.equal(shouldCopyElectronRuntime('protocol-v4.generated.cjs', file), true);
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

test('release resources use a verified portable runtime and never the development venv', () => {
  const resources = installerConfig.extraResources.map((entry) => ({
    from: path.normalize(entry.from),
    to: path.normalize(entry.to),
  }));
  assert.equal(resources.some((entry) => entry.to === 'venv'), false);
  assert.equal(resources.some((entry) => entry.to === 'SOURCE_CODE'), false);
  assert.equal(resources.some((entry) => entry.to === 'python'), true);
  assert.equal(PYTHON_RUNTIME.version, '3.12.10');
  assert.match(PYTHON_RUNTIME.sha256, /^[a-f0-9]{64}$/);
});

test('production Python filter removes test trees without a stale reference-project rule', () => {
  const root = path.join('C:', 'reverie', 'src');
  const file = { isDirectory: () => false };
  const directory = { isDirectory: () => true };
  assert.equal(
    shouldCopyProductionPythonSource(path.join(root, 'chat', 'session.py'), file, root),
    true,
  );
  assert.equal(
    shouldCopyProductionPythonSource(path.join(root, 'neko_core'), directory, root),
    true,
  );
  assert.equal(
    shouldCopyProductionPythonSource(path.join(root, 'tests', 'test_chat.py'), file, root),
    false,
  );
});

test('production payload audit rejects a reintroduced virtual environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-production-audit-'));
  fs.mkdirSync(path.join(root, 'python'), { recursive: true });
  fs.writeFileSync(path.join(root, 'python', 'python.exe'), 'runtime');
  assert.equal(assertProductionPayload(root), true);
  fs.mkdirSync(path.join(root, 'venv'));
  assert.throws(() => assertProductionPayload(root), /forbidden|virtual environment/i);
});

test('an unlicensed Live2D payload cannot pass the shared package gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-package-live2d-'));
  fs.writeFileSync(path.join(root, 'character.moc3'), 'not licensed');
  assert.throws(
    () => assertLive2DReleaseGate({ buildEnabled: '0', scanRoots: [root] }),
    /Unlicensed/i,
  );
});
