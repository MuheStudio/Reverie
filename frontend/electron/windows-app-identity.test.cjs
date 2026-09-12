'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEVELOPMENT_APP_USER_MODEL_ID,
  FORMAL_APP_USER_MODEL_ID,
  TEST_BUILD_MARKER,
  readDistributionMetadata,
  resolveAppUserModelId,
  shouldSetFormalAppUserModelId,
} = require('./windows-app-identity.cjs');

function makePackage(metadata) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-identity-'));
  const resourcesPath = path.join(packageRoot, 'resources');
  fs.mkdirSync(resourcesPath);
  if (metadata !== undefined) {
    fs.writeFileSync(path.join(packageRoot, TEST_BUILD_MARKER), JSON.stringify(metadata));
  }
  return resourcesPath;
}

const testMetadata = {
  schema: 'reverie.windows-test-build.v1',
  publishable: false,
  distribution: 'TEST_ONLY_DO_NOT_RELEASE',
};

test('formal Windows identity remains stable for installed and development builds', () => {
  assert.equal(FORMAL_APP_USER_MODEL_ID, 'studio.muhe.reverie');
  assert.equal(DEVELOPMENT_APP_USER_MODEL_ID, 'studio.muhe.reverie.dev');
  assert.equal(shouldSetFormalAppUserModelId({
    platform: 'win32', isPackaged: true, resourcesPath: makePackage(),
  }), true);
  assert.equal(shouldSetFormalAppUserModelId({
    platform: 'win32', isPackaged: false, resourcesPath: makePackage(testMetadata),
  }), false);
  assert.equal(shouldSetFormalAppUserModelId({
    platform: 'linux', isPackaged: true, resourcesPath: makePackage(),
  }), false);
  assert.equal(resolveAppUserModelId({
    platform: 'win32', isPackaged: true, resourcesPath: makePackage(),
  }), FORMAL_APP_USER_MODEL_ID);
  assert.equal(resolveAppUserModelId({
    platform: 'win32', isPackaged: false, resourcesPath: makePackage(),
  }), DEVELOPMENT_APP_USER_MODEL_ID);
});

test('validated portable test marker suppresses the formal installed identity', () => {
  const resourcesPath = makePackage(testMetadata);
  assert.deepEqual(readDistributionMetadata(resourcesPath), testMetadata);
  assert.equal(shouldSetFormalAppUserModelId({
    platform: 'win32', isPackaged: true, resourcesPath,
  }), false);
});

test('malformed or broad package markers cannot suppress installed identity', () => {
  for (const metadata of [
    { ...testMetadata, schema: 'other' },
    { ...testMetadata, publishable: true },
    { ...testMetadata, distribution: 'portable' },
  ]) {
    const resourcesPath = makePackage(metadata);
    assert.equal(readDistributionMetadata(resourcesPath), null);
    assert.equal(shouldSetFormalAppUserModelId({
      platform: 'win32', isPackaged: true, resourcesPath,
    }), true);
  }
});
