'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveDmgInputs, verifyDmgManifest, createDmgMount, validateVolumeLayout, verifyCopyBinding, validateReportDestination, finalizeDmgAcceptance } = require('./smoke-dmg-macos.cjs');
const { buildInventory, treeManifest, hashFile } = require('./smoke-packaged-macos.cjs');
const APP_NAME = 'Reverie macOS Test.app';
const APP_ID = 'com.muhe.reverie.macos.test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-final-dmg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, APP_NAME);
  const resources = path.join(appRoot, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const files = [{ path: 'src/main.py', sha256: 'a'.repeat(64), bytes: 1 }];
  const candidate = { head: 'synthetic-candidate', files,
    sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  fs.writeFileSync(path.join(resources, 'BUILD-CANDIDATE.json'), JSON.stringify({
    schema: 'reverie.macos-build-candidate.v1', sourceSha256: candidate.sha256, gitHead: candidate.head,
    transport: 'framed-stdio-v4', profile: 'independent-core-local-test', live2dCoreBundled: false,
  }));
  fs.writeFileSync(path.join(resources, 'data.bin'), 'binary');
  const tree = treeManifest(appRoot);
  const appManifestPath = path.join(root, 'macos-build.json');
  const appManifest = { schema: 'reverie.macos-build.v1', architecture: 'arm64', appPath: appRoot,
    startedAt: '2026-09-20T00:00:00Z', completedAt: '2026-09-20T00:01:00Z', timings: [{ name: 'Build', passed: true }],
    runtimeAudit: { ok: true }, appNativeAudit: { ok: true }, signing: { identity: 'ad-hoc', hardenedRuntime: true },
    candidate, bundle: buildInventory(tree) };
  fs.writeFileSync(appManifestPath, JSON.stringify(appManifest));
  const dmgPath = path.join(root, `Reverie-macOS-Test-0.5.5-arm64-${appManifest.bundle.sha256.slice(0, 12)}.dmg`);
  fs.writeFileSync(dmgPath, 'synthetic image payload');
  const manifestPath = path.join(root, 'macos-dmg.json');
  const manifest = { schema: 'reverie.macos-dmg.v1', startedAt: '2026-09-21T00:00:00Z', completedAt: '2026-09-21T00:01:00Z',
    source: { appPath: appRoot, appManifestSha256: hashFile(appManifestPath), sourceSha256: candidate.sha256,
      signedBundleSha256: appManifest.bundle.sha256 }, appManifestPath,
    artifact: { path: dmgPath, sha256: hashFile(dmgPath), bytes: fs.statSync(dmgPath).size },
    app: { name: APP_NAME, appId: APP_ID, version: '0.5.5' },
    signing: { application: 'ad-hoc', dmg: 'unsigned', notarized: false },
    format: 'UDZO', filesystem: 'HFS+', instructionsSha256: 'd'.repeat(64), timings: [{ name: 'Create image', passed: true }] };
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest)); write();
  const inputs = { dmgPath, manifestPath, appManifestPath };
  return { root, appRoot, resources, tree, manifest, appManifestPath, dmgPath, manifestPath, inputs, write,
    verify: () => verifyDmgManifest(inputs) };
}

test('exact final image binds completed DMG manifest and successful application snapshot', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().binding.matched, true);
  assert.equal(f.verify().binding.signedBundleSha256, f.manifest.source.signedBundleSha256);
  fs.rmSync(f.appRoot, { recursive: true });
  assert.equal(f.verify().binding.matched, true, 'Verification must not require old production staging or source .app');
});

test('relocated DMG verifies by content rather than its original artifact path', (t) => {
  const f = fixture(t);
  const moved = path.join(f.root, '移动 空格', '验收镜像.dmg');
  fs.mkdirSync(path.dirname(moved)); fs.copyFileSync(f.dmgPath, moved);
  assert.equal(verifyDmgManifest({ ...f.inputs, dmgPath: moved }).binding.matched, true);
});

for (const [name, mutate] of [
  ['unfinished image', (f) => { delete f.manifest.completedAt; }],
  ['failed build', (f) => { f.manifest.success = false; }],
  ['failed build phase', (f) => { f.manifest.timings[0].passed = false; }],
  ['different application identity', (f) => { f.manifest.app.appId = 'com.example.other'; }],
  ['formal-signature claim', (f) => { f.manifest.signing.application = 'Developer ID'; }],
  ['notarization claim', (f) => { f.manifest.signing.notarized = true; }],
  ['filesystem mismatch', (f) => { f.manifest.filesystem = 'APFS'; }],
  ['format mismatch', (f) => { f.manifest.format = 'UDRW'; }],
  ['source snapshot mismatch', (f) => { f.manifest.source.sourceSha256 = 'b'.repeat(64); }],
  ['signed bundle mismatch', (f) => { f.manifest.source.signedBundleSha256 = 'c'.repeat(64); }],
  ['application manifest changed', (f) => { fs.appendFileSync(f.appManifestPath, ' '); }],
  ['same-length image corruption', (f) => { const bytes = fs.readFileSync(f.dmgPath); bytes[0] ^= 1; fs.writeFileSync(f.dmgPath, bytes); }],
  ['image truncated', (f) => { fs.writeFileSync(f.dmgPath, 'short'); }],
]) test(`rejects ${name} before mounting`, (t) => { const f = fixture(t); mutate(f); f.write(); assert.throws(f.verify); });

test('installed copy must retain all signed bytes and candidate metadata', (t) => {
  const f = fixture(t);
  const copied = path.join(f.root, '安装 目录', APP_NAME);
  fs.cpSync(f.appRoot, copied, { recursive: true });
  const identity = { appRoot: copied, appId: APP_ID, resources: path.join(copied, 'Contents', 'Resources') };
  assert.ok(verifyCopyBinding(identity, f.appManifestPath, f.tree));
  fs.writeFileSync(path.join(identity.resources, 'data.bin'), 'damage');
  assert.throws(() => verifyCopyBinding(identity, f.appManifestPath, f.tree), /copy differs/);
});

test('latest DMG pointer has no fallback to arbitrary previous artifacts', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveDmgInputs([], f.root), /ENOENT/);
  fs.mkdirSync(path.join(f.root, '.package-smoke-macos'));
  fs.writeFileSync(path.join(f.root, '.package-smoke-macos', 'latest-dmg.json'), JSON.stringify({
    dmgPath: f.dmgPath, buildManifest: f.manifestPath, appManifest: f.appManifestPath,
  }));
  assert.deepEqual(resolveDmgInputs([], f.root), f.inputs);
  assert.deepEqual(resolveDmgInputs(['--dmg', f.dmgPath, '--manifest', f.manifestPath], f.root), {
    dmgPath: f.dmgPath, manifestPath: f.manifestPath, appManifestPath: null,
  });
  assert.throws(() => resolveDmgInputs(['--dmg', f.dmgPath], f.root), /requires --manifest/);
  assert.throws(() => resolveDmgInputs(['--dmg', 'relative.dmg'], f.root), /absolute path/);
  assert.throws(() => resolveDmgInputs(['--dmg', f.dmgPath, '--dmg', f.dmgPath, '--manifest', f.manifestPath], f.root), /only once/);
});

function mountFixture(t, behavior = {}) {
  const f = fixture(t);
  const mountPoint = path.join(f.root, '实际 镜像'); fs.mkdirSync(mountPoint);
  let attached = false;
  const calls = [];
  const listImages = () => attached ? [{ 'image-path': f.dmgPath, 'system-entities': behavior.noVolume
    ? [{ 'dev-entry': '/dev/disk991' }] : [{ 'mount-point': mountPoint, 'dev-entry': '/dev/disk991s1' }] }] : [];
  const invoke = (command, args, options) => {
    calls.push({ command, args });
    if (command.endsWith('plutil')) return options.input;
    if (args[0] === 'attach') {
      attached = true;
      if (behavior.attachError) throw new Error('attach failed after creating a mount');
      return JSON.stringify({ 'system-entities': [{ 'mount-point': mountPoint }] });
    }
    if (command.endsWith('diskutil')) return JSON.stringify({ WritableVolume: Boolean(behavior.writable), FilesystemType: behavior.fs || 'hfs', VolumeName: 'Reverie 测试' });
    if (args[0] === 'detach') {
      if (behavior.detachError) throw new Error('busy volume');
      attached = false; return '';
    }
    throw new Error(`Unexpected command ${command} ${args}`);
  };
  return { ...f, mountPoint, calls, mount: createDmgMount(f.dmgPath, mountPoint, { invoke, listImages }) };
}

test('mount lifecycle targets the final image read-only and detaches only its own mount', (t) => {
  const f = mountFixture(t);
  const volume = f.mount.attach(); assert.equal(volume.WritableVolume, false);
  assert.equal(f.mount.mounted, true);
  f.mount.detach(); assert.equal(f.mount.mounted, false);
  assert.ok(f.calls.find((item) => item.args[0] === 'attach').args.includes('-readonly'));
  assert.deepEqual(f.calls.find((item) => item.args[0] === 'detach').args, ['detach', f.mountPoint]);
  assert.deepEqual(f.mount.events.map((item) => item.event), ['mounted-readonly', 'detached']);
});

test('partial attach failure is still recorded and cleaned up', (t) => {
  const f = mountFixture(t, { attachError: true });
  assert.throws(() => f.mount.attach(), /attach failed/);
  assert.equal(f.mount.mounted, true);
  f.mount.detach(); assert.equal(f.mount.mounted, false);
});

test('failed detach keeps mount state so caller preserves scratch and reports failure', (t) => {
  const f = mountFixture(t, { detachError: true });
  f.mount.attach(); assert.throws(() => f.mount.detach(), /busy volume/);
  assert.equal(f.mount.mounted, true);
  assert.ok(!f.calls.some((item) => item.args.includes('-force')));
});

for (const [name, settings, error] of [
  ['writable media', { writable: true }, /writable/],
  ['wrong filesystem', { fs: 'apfs' }, /HFS/],
]) test(`rejects ${name} while retaining mount for cleanup`, (t) => {
  const f = mountFixture(t, settings);
  assert.throws(() => f.mount.attach(), error); assert.equal(f.mount.mounted, true);
  f.mount.detach(); assert.equal(f.mount.mounted, false);
});

test('installer root has exact Applications shortcut and Chinese test instructions', { skip: process.platform === 'win32' ? 'Real POSIX installer symlink layout' : false }, (t) => {
  const f = fixture(t);
  fs.symlinkSync('/Applications', path.join(f.root, 'Applications'));
  fs.writeFileSync(path.join(f.root, '安装说明.txt'), 'Reverie macOS Test：拖到 Applications；本地签名，未公证。');
  fs.writeFileSync(path.join(f.root, '.DS_Store'), 'test Finder layout');
  // Use a separate volume fixture with only allowed root entries.
  const volume = path.join(f.root, '卷'); fs.mkdirSync(volume);
  fs.cpSync(f.appRoot, path.join(volume, APP_NAME), { recursive: true });
  fs.symlinkSync('/Applications', path.join(volume, 'Applications'));
  for (const name of ['安装说明.txt', '.DS_Store']) fs.copyFileSync(path.join(f.root, name), path.join(volume, name));
  assert.equal(validateVolumeLayout(volume).applicationsLink, '/Applications');
  fs.unlinkSync(path.join(volume, 'Applications')); fs.symlinkSync('/tmp', path.join(volume, 'Applications'));
  assert.throws(() => validateVolumeLayout(volume));
});


test('an attached device without a mounted volume is detached after attach failure', (t) => {
  const f = mountFixture(t, { attachError: true, noVolume: true });
  assert.throws(() => f.mount.attach(), /attach failed/);
  assert.equal(f.mount.mounted, true);
  f.mount.detach(); assert.equal(f.mount.mounted, false);
  assert.deepEqual(f.calls.find((item) => item.args[0] === 'detach').args, ['detach', '/dev/disk991']);
});

test('report paths cannot modify an application', (t) => {
  const f = fixture(t);
  assert.throws(() => validateReportDestination(path.join(f.appRoot, 'reports')), /inside an application/);
  assert.doesNotThrow(() => validateReportDestination(path.join(f.root, 'reports')));
});

test('report output symlinks cannot reach an application', { skip: process.platform === 'win32' ? 'Real POSIX link fixture' : false }, (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.appRoot, path.join(f.root, 'linked-output'));
  assert.throws(() => validateReportDestination(path.join(f.root, 'linked-output', 'reports')), /through an application/);
});


test('pre-existing attachment is refused and never added to the cleanup ledger', (t) => {
  const f = fixture(t); const calls = [];
  const mountPoint = path.join(f.root, 'owned-mount');
  const mount = createDmgMount(f.dmgPath, mountPoint, {
    invoke: (...args) => calls.push(args),
    listImages: () => [{ 'image-path': f.dmgPath, 'system-entities': [{ 'mount-point': mountPoint }] }],
  });
  assert.throws(() => mount.attach(), /already attached/);
  assert.equal(mount.mounted, false);
  mount.detach(); assert.deepEqual(calls, []);
});


test('disk-full log/report failures cannot bypass remaining processes, provider close or detach', async () => {
  const calls = []; const report = { passed: true }; let mounted = true;
  const mount = { get mounted() { return mounted; }, detach() { calls.push('detach'); mounted = false; } };
  const finalization = await finalizeDmgAcceptance({
    active: [{ label: 'first', logs: ['first log'] }, { label: 'second', logs: ['second log'] }], session: {},
    mount, runRoot: '/synthetic/scratch', outputRoot: '/synthetic/report', report, started: Date.now(),
    verifyIntegrity: () => calls.push('integrity'),
  }, {
    cleanupApplication: async (running) => calls.push(`stop:${running.label}`),
    closeSession: async () => calls.push('close-provider'),
    writeFile: (file) => { calls.push(`write:${path.basename(file)}`); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    removeScratch: () => calls.push('remove-scratch'), exists: () => false,
  });
  assert.deepEqual(calls, ['stop:second', 'write:second.log', 'stop:first', 'write:first.log',
    'close-provider', 'integrity', 'detach', 'remove-scratch', 'write:report.json']);
  assert.equal(report.passed, false); assert.equal(report.noResidualMounts, true);
  assert.equal(report.noResidualProcesses, true); assert.equal(report.scratchRemoved, true);
  assert.equal(finalization.reportWritten, false);
  assert.deepEqual(finalization.errors.map((item) => item.name), ['log:second', 'log:first', 'final-report-write']);
});

test('process cleanup failure still closes provider and image, and preserves possibly active scratch', async () => {
  const calls = []; const report = { passed: true }; let mounted = true;
  const finalization = await finalizeDmgAcceptance({ active: [{ label: 'app', logs: [] }], session: {},
    mount: { get mounted() { return mounted; }, detach() { calls.push('detach'); mounted = false; } },
    runRoot: '/synthetic/scratch', outputRoot: '/synthetic/report', report, started: Date.now(),
    verifyIntegrity: () => { throw new Error('integrity failed'); },
  }, {
    cleanupApplication: async () => { throw new Error('process still running'); },
    closeSession: async () => calls.push('close-provider'),
    writeFile: (file) => calls.push(`write:${path.basename(file)}`),
    removeScratch: () => calls.push('must-not-remove'), exists: () => true,
  });
  assert.equal(report.noResidualProcesses, false); assert.equal(report.passed, false);
  assert.equal(report.noResidualMounts, true); assert.equal(finalization.reportWritten, true);
  assert.deepEqual(calls, ['write:app.log', 'close-provider', 'detach', 'write:report.json']);
});
