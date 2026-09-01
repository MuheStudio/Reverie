'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveTestUserDataOverride } = require('./test-user-data.cjs');

function testPackage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-test-package-'));
  fs.writeFileSync(path.join(root, 'TEST-BUILD-DO-NOT-RELEASE.json'), JSON.stringify({
    schema: 'reverie.windows-test-build.v1',
    publishable: false,
    distribution: 'TEST_ONLY_DO_NOT_RELEASE',
  }));
  return root;
}

test('packaged test marker authorizes an external absolute user-data path', () => {
  const packageRoot = testPackage();
  const requestedPath = path.join(os.tmpdir(), 'reverie-isolated-user-data');
  assert.equal(resolveTestUserDataOverride({
    isPackaged: true,
    packageRoot,
    requestedPath,
  }), path.resolve(requestedPath));
});

test('release, development, relative, in-package, and unmarked overrides fail closed', () => {
  const packageRoot = testPackage();
  const external = path.join(os.tmpdir(), 'reverie-isolated-user-data');
  assert.throws(() => resolveTestUserDataOverride({
    isPackaged: false, packageRoot, requestedPath: external,
  }), /reserved/);
  assert.throws(() => resolveTestUserDataOverride({
    isPackaged: true, packageRoot, requestedPath: 'relative-data',
  }), /absolute/);
  assert.throws(() => resolveTestUserDataOverride({
    isPackaged: true, packageRoot, requestedPath: path.join(packageRoot, 'data'),
  }), /inside the package/);
  assert.throws(() => resolveTestUserDataOverride({
    isPackaged: true,
    packageRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unmarked-')),
    requestedPath: external,
  }), /marker/);
});
