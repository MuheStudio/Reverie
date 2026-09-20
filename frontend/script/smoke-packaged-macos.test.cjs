'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildInventory, treeManifest, verifySuccessfulBuild, resolvePackageInputs } = require('./smoke-packaged-macos.cjs');

function fixture(t, { withSymlink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-build-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'Reverie macOS Test.app');
  const resources = path.join(appRoot, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const candidate = { head: 'synthetic-test-commit', files: [{ path: 'src/main.py', sha256: 'a'.repeat(64), bytes: 1 }] };
  candidate.sha256 = crypto.createHash('sha256').update(JSON.stringify(candidate.files)).digest('hex');
  const embedded = { schema: 'reverie.macos-build-candidate.v1', sourceSha256: candidate.sha256,
    gitHead: candidate.head, transport: 'framed-stdio-v4', profile: 'independent-core-local-test', live2dCoreBundled: false };
  fs.writeFileSync(path.join(resources, 'BUILD-CANDIDATE.json'), JSON.stringify(embedded));
  fs.writeFileSync(path.join(resources, 'payload.bin'), 'abc');
  fs.writeFileSync(path.join(resources, 'other.bin'), 'xyz');
  if (withSymlink) fs.symlinkSync('payload.bin', path.join(resources, 'alias'));
  const manifestPath = path.join(root, 'macos-build.json');
  const manifest = { schema: 'reverie.macos-build.v1', architecture: 'arm64', appPath: appRoot,
    startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
    timings: [{ name: 'Build', passed: true }], runtimeAudit: { ok: true }, appNativeAudit: { ok: true },
    signing: { identity: 'ad-hoc', hardenedRuntime: true }, candidate,
    bundle: buildInventory(treeManifest(appRoot)) };
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  write();
  const identity = { appRoot, resources, appId: 'com.muhe.reverie.macos.test' };
  return { root, appRoot, resources, candidate, embedded, manifestPath, manifest, identity, write,
    verify: () => verifySuccessfulBuild(identity, manifestPath, treeManifest(appRoot)) };
}

test('accepts only the exact successful bundle, including when relocated', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().matched, true);
  const moved = path.join(f.root, '仓库外 目录', 'Renamed Test.app');
  fs.cpSync(f.appRoot, moved, { recursive: true, verbatimSymlinks: true });
  const identity = { ...f.identity, appRoot: moved, resources: path.join(moved, 'Contents', 'Resources') };
  assert.equal(verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)).sourceSha256, f.candidate.sha256);
});

test('rejects an app left by a failed build with no successful manifest', (t) => {
  const f = fixture(t); fs.unlinkSync(f.manifestPath);
  assert.throws(f.verify, /ENOENT/);
});

for (const [label, change] of [
  ['unfinished manifest', (m) => { delete m.completedAt; }],
  ['failed phase', (m) => { m.timings[0].passed = false; }],
  ['failed result', (m) => { m.success = false; }],
  ['failed runtime audit', (m) => { m.runtimeAudit.ok = false; }],
  ['failed whole-app audit', (m) => { m.appNativeAudit.ok = false; }],
  ['source inventory digest mismatch', (m) => { m.candidate.sha256 = 'b'.repeat(64); }],
  ['signed bundle digest mismatch', (m) => { m.bundle.sha256 = 'b'.repeat(64); }],
]) {
  test(`rejects ${label}`, (t) => { const f = fixture(t); change(f.manifest); f.write(); assert.throws(f.verify); });
}

test('rejects a different embedded source candidate even with a self-consistent build manifest', (t) => {
  const f = fixture(t);
  f.embedded.sourceSha256 = 'c'.repeat(64);
  fs.writeFileSync(path.join(f.resources, 'BUILD-CANDIDATE.json'), JSON.stringify(f.embedded));
  assert.throws(f.verify, /different source candidate/);
});

for (const [label, mutate] of [
  ['changed bytes with unchanged length', (f) => fs.writeFileSync(path.join(f.resources, 'payload.bin'), 'def')],
  ['changed file length', (f) => fs.appendFileSync(path.join(f.resources, 'payload.bin'), 'more')],
  ['unexpected file', (f) => fs.writeFileSync(path.join(f.resources, 'unexpected'), 'new')],
  ['missing file', (f) => fs.unlinkSync(path.join(f.resources, 'other.bin'))],
]) {
  test(`rejects stale build inventory: ${label}`, (t) => {
    const f = fixture(t); mutate(f); assert.throws(f.verify, /differ from the successful signed build/);
  });
}

test('preserves POSIX symlinks on relocation and rejects a changed target', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t, { withSymlink: true });
  assert.equal(f.verify().matched, true);
  const moved = path.join(f.root, '仓库外 链接目录', 'Renamed Test.app');
  fs.cpSync(f.appRoot, moved, { recursive: true, verbatimSymlinks: true });
  const identity = { ...f.identity, appRoot: moved, resources: path.join(moved, 'Contents', 'Resources') };
  assert.equal(verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)).matched, true);
  const alias = path.join(identity.resources, 'alias');
  assert.equal(fs.readlinkSync(alias), 'payload.bin');
  fs.unlinkSync(alias);
  fs.symlinkSync('other.bin', alias);
  assert.throws(() => verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)),
    /differ from the successful signed build/);
});

test('rejects a different application identity', (t) => {
  const f = fixture(t); f.identity.appId = 'example.unrelated'; assert.throws(f.verify);
});

test('default input uses the successful package pointer outside Documents', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.package-smoke-macos'));
  const latest = { appPath: path.resolve('/Users/example/Library/Developer/Reverie/LocalBuilds/test/mac-arm64/Reverie macOS Test.app'),
    buildManifest: path.join(f.root, 'release-macos', 'macos-build.json') };
  fs.writeFileSync(path.join(f.root, '.package-smoke-macos', 'latest-package.json'), JSON.stringify(latest));
  assert.deepEqual(resolvePackageInputs([], f.root), { appPath: latest.appPath, manifestPath: latest.buildManifest });
  assert.deepEqual(resolvePackageInputs(['--manifest', f.manifestPath], f.root), { appPath: latest.appPath, manifestPath: f.manifestPath });
});

test('missing latest pointer does not fall back to a leftover Documents app', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'release-macos', 'mac-arm64', 'Reverie macOS Test.app'), { recursive: true });
  assert.throws(() => resolvePackageInputs([], f.root), /ENOENT/);
});

test('explicit relocated app binds the repo manifest or an explicit manifest', (t) => {
  const f = fixture(t);
  const relocated = path.join(f.root, '含空格 目录', 'Reverie macOS Test.app');
  assert.deepEqual(resolvePackageInputs(['--app', relocated], f.root), {
    appPath: relocated, manifestPath: path.join(f.root, 'release-macos', 'macos-build.json'),
  });
  assert.deepEqual(resolvePackageInputs(['--app', relocated, '--manifest', f.manifestPath], f.root), {
    appPath: relocated, manifestPath: f.manifestPath,
  });
});

test('relative or incomplete latest package pointers are rejected', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.package-smoke-macos'));
  const pointer = path.join(f.root, '.package-smoke-macos', 'latest-package.json');
  fs.writeFileSync(pointer, JSON.stringify({ appPath: 'old/Test.app', buildManifest: f.manifestPath }));
  assert.throws(() => resolvePackageInputs([], f.root), /absolute app path/);
  fs.writeFileSync(pointer, JSON.stringify({ appPath: f.appRoot }));
  assert.throws(() => resolvePackageInputs([], f.root), /absolute build manifest/);
});
