'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAC_TEST_APP_ID, validateMacTestBuild, resolveTestUserDataOverride } = require('./test-user-data.cjs');

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
    platform: 'win32',
    isPackaged: true,
    packageRoot,
    requestedPath,
  }), path.resolve(requestedPath));
});

test('release, development, relative, in-package, and unmarked overrides fail closed', () => {
  const packageRoot = testPackage();
  const external = path.join(os.tmpdir(), 'reverie-isolated-user-data');
  assert.throws(() => resolveTestUserDataOverride({
    platform: 'win32', isPackaged: false, packageRoot, requestedPath: external,
  }), /reserved/);
  assert.throws(() => resolveTestUserDataOverride({
    platform: 'win32', isPackaged: true, packageRoot, requestedPath: 'relative-data',
  }), /absolute/);
  assert.throws(() => resolveTestUserDataOverride({
    platform: 'win32', isPackaged: true, packageRoot, requestedPath: path.join(packageRoot, 'data'),
  }), /inside the package/);
  assert.throws(() => resolveTestUserDataOverride({
    platform: 'win32',
    isPackaged: true,
    packageRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-unmarked-')),
    requestedPath: external,
  }), /marker/);
});

function macFixture(t, changes = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-macos-marker-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const packageRoot = path.join(temporary, 'Reverie macOS Test.app');
  const resources = path.join(packageRoot, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const markerPath = path.join(resources, 'TEST-BUILD-DO-NOT-RELEASE.json');
  fs.writeFileSync(markerPath, JSON.stringify({ schema: 'reverie.macos-test-build.v1', publishable: false,
    distribution: 'TEST_ONLY_DO_NOT_RELEASE', platform: 'darwin', arch: 'arm64', appId: MAC_TEST_APP_ID, ...changes }));
  const options = { isPackaged: true, platform: 'darwin', arch: 'arm64', packageRoot,
    requestedPath: path.join(temporary, 'external-data'), readBundleIdentifier: () => MAC_TEST_APP_ID };
  return { temporary, packageRoot, resources, markerPath, options };
}

test('Mac test override requires matching bundle identity and marker', (t) => {
  const f = macFixture(t);
  assert.equal(resolveTestUserDataOverride(f.options), f.options.requestedPath);
  assert.throws(() => resolveTestUserDataOverride({ ...f.options, readBundleIdentifier: () => 'com.muhe.reverie' }), /identity mismatch/);
});

for (const [label, changes] of [
  ['Windows marker', { schema: 'reverie.windows-test-build.v1' }],
  ['release marker', { publishable: true }],
  ['wrong platform', { platform: 'win32' }],
  ['wrong architecture', { arch: 'x64' }],
  ['release app id', { appId: 'com.muhe.reverie' }],
]) {
  test(`Mac override rejects ${label}`, (t) => {
    const f = macFixture(t, changes);
    assert.throws(() => resolveTestUserDataOverride(f.options), /does not authorize/);
  });
}

test('Mac formal build cannot use the test override without a marker', (t) => {
  const f = macFixture(t);
  fs.unlinkSync(f.markerPath);
  assert.equal(validateMacTestBuild(f.packageRoot, { required: false }), null);
  assert.throws(() => resolveTestUserDataOverride(f.options), /marker is missing/);
});

test('Mac override rejects paths inside the app including an external symlink alias', { skip: process.platform === 'win32' }, (t) => {
  const f = macFixture(t);
  assert.throws(() => resolveTestUserDataOverride({ ...f.options, requestedPath: path.join(f.resources, 'data') }), /inside the package/);
  const alias = path.join(f.temporary, 'alias');
  fs.symlinkSync(f.resources, alias);
  assert.throws(() => resolveTestUserDataOverride({ ...f.options, requestedPath: path.join(alias, 'new', 'data') }), /inside the package/);
});

test('Mac override rejects a symlinked test marker', { skip: process.platform === 'win32' }, (t) => {
  const f = macFixture(t);
  const external = path.join(f.temporary, 'marker.json');
  fs.renameSync(f.markerPath, external);
  fs.symlinkSync(external, f.markerPath);
  assert.throws(() => resolveTestUserDataOverride(f.options), /marker is unsafe/);
});

test('Mac identity is read from the actual Info.plist', { skip: process.platform !== 'darwin' }, (t) => {
  const f = macFixture(t);
  fs.writeFileSync(path.join(f.packageRoot, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${MAC_TEST_APP_ID}</string></dict></plist>`);
  const { readBundleIdentifier, ...options } = f.options;
  assert.equal(resolveTestUserDataOverride(options), options.requestedPath);
});
