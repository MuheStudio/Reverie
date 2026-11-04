'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createConfig, parseInputs, hashFile, verifyExisting, buildEnvironment, runCommand } = require('./package-macos-dmg.cjs');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie dmg policy '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function existingOutput(t) {
  const root = fixture(t);
  const paths = { dmg: path.join(root, 'Test-arm64.dmg'), manifest: path.join(root, 'Test-arm64.json'),
    checksum: path.join(root, 'Test-arm64.dmg.sha256') };
  const bytes = Buffer.from('synthetic image bytes for output-binding tests');
  const expected = { source: { appPath: path.join(root, 'Accepted Test.app'), appManifestSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64), signedBundleSha256: 'c'.repeat(64) },
    buildInputs: { 'script/package-macos-dmg.sh': 'd'.repeat(64), 'docs/MACOS-INSTALL.txt': 'e'.repeat(64) } };
  const manifest = { schema: 'reverie.macos-dmg.v1', startedAt: '2026-09-21T00:00:00Z',
    completedAt: '2026-09-21T00:01:00Z', timings: [{ name: 'Verify final image', passed: true }],
    source: { ...expected.source }, buildInputs: { ...expected.buildInputs },
    artifact: { path: paths.dmg, bytes: bytes.length, sha256: digest(bytes) } };
  fs.writeFileSync(paths.dmg, bytes);
  fs.writeFileSync(paths.checksum, `${manifest.artifact.sha256}  ${path.basename(paths.dmg)}\n`);
  const write = () => fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
  write();
  return { root, paths, manifest, expected, bytes, write, verify: () => verifyExisting(paths, expected) };
}

test('DMG configuration uses only the accepted arm64 app with no signing, publishing or inherited hooks', (t) => {
  const root = fixture(t);
  const app = path.join(root, 'Reverie macOS Test.app'), instructions = path.join(root, '安装说明.txt');
  const metadata = path.join(root, 'metadata'), output = path.join(root, 'output');
  const config = createConfig({ metadata, output, app, instructions, version: '0.5.5',
    artifactName: 'Reverie-macOS-Test-0.5.5-arm64-123456789abc.dmg', volumeName: 'Reverie macOS Test 0.5.5 arm64' });
  assert.equal(config.extends, null);
  assert.equal(config.appId, 'com.muhe.reverie.macos.test');
  assert.equal(config.productName, 'Reverie macOS Test');
  assert.equal(config.electronVersion, require('electron/package.json').version);
  assert.equal(config.publish, null);
  assert.equal(config.npmRebuild, false);
  assert.deepEqual(config.directories, { app: metadata, output });
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.gatekeeperAssess, false);
  assert.equal(config.mac.minimumSystemVersion, '14.0');
  for (const scope of [config, config.mac, config.dmg]) {
    for (const hook of ['beforeBuild', 'beforePack', 'afterPack', 'afterSign', 'afterAllArtifactBuild',
      'artifactBuildStarted', 'artifactBuildCompleted', 'effectiveOptionComputed', 'sign', 'signAndEditExecutable']) {
      if (scope === config.dmg && hook === 'sign') continue;
      assert.equal(Object.hasOwn(scope, hook), false, `Unexpected executable build hook: ${hook}`);
    }
  }
  assert.equal(config.dmg.sign, false);
  assert.equal(config.dmg.writeUpdateInfo, false);
  assert.equal(config.dmg.format, 'UDZO');
  assert.equal(config.dmg.filesystem, 'HFS+');
  assert.equal(config.dmg.artifactName, 'Reverie-macOS-Test-0.5.5-arm64-123456789abc.dmg');
  assert.equal(config.dmg.title, 'Reverie macOS Test 0.5.5 arm64');
  assert.equal(config.dmg.backgroundColor, '#F5F6F7');
  assert.deepEqual(config.dmg.window, { width: 640, height: 420 });
  assert.deepEqual(config.dmg.contents, [
    { x: 160, y: 170, type: 'file', path: app, name: 'Reverie macOS Test.app' },
    { x: 480, y: 170, type: 'link', path: '/Applications', name: 'Applications' },
    { x: 320, y: 250, type: 'file', path: instructions, name: '安装说明.txt' },
  ]);
});

test('explicit package inputs preserve spaces and Chinese paths without selecting a different app', (t) => {
  const root = fixture(t);
  const appPath = path.join(root, '中文 目录', 'Reverie macOS Test.app');
  const manifestPath = path.join(root, 'app-build.json'), outputDirectory = path.join(root, 'dmg 输出');
  assert.deepEqual(parseInputs(['--app', appPath, '--manifest', manifestPath, '--out', outputDirectory]),
    { appPath, manifestPath, outputDirectory });
});

for (const [label, args] of [
  ['unknown option', ['--publish', 'always']],
  ['missing value', ['--app']],
  ['relative path', ['--out', 'relative']],
  ['duplicate option', ['--app', path.resolve('one.app'), '--app', path.resolve('two.app')]],
]) {
  test(`package input parser refuses ${label}`, () => assert.throws(() => parseInputs(args)));
}

test('build environment excludes signing credentials, custom tools and mirror overrides', (t) => {
  const inherited = { CSC_LINK: 'test-signing-key', CSC_KEY_PASSWORD: 'test-password', CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    APPLE_ID: 'test-apple-account', GH_TOKEN: 'test-token', GITHUB_TOKEN: 'test-token', SENTRY_AUTH_TOKEN: 'test-token',
    CUSTOM_DMGBUILD_PATH: '/untrusted/dmgbuild', ELECTRON_MIRROR: 'https://invalid.example',
    ELECTRON_CUSTOM_DIR: 'untrusted', ELECTRON_BUILDER_BINARIES_MIRROR: 'https://invalid.example',
    npm_config_electron_mirror: 'https://invalid.example', PYTHONPATH: '/untrusted', VIRTUAL_ENV: '/untrusted',
    DYLD_INSERT_LIBRARIES: '/untrusted.dylib', NODE_OPTIONS: '--require=/untrusted' };
  const previous = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  try {
    const root = fixture(t), environment = buildEnvironment(root);
    for (const key of Object.keys(inherited)) {
      assert.equal(environment[key], key === 'CSC_IDENTITY_AUTO_DISCOVERY' ? 'false' : undefined, key);
    }
    assert.equal(environment.TMPDIR, path.join(root, 'tmp'));
    assert.equal(environment.TMP, environment.TMPDIR);
    assert.equal(environment.TEMP, environment.TMPDIR);
    assert.equal(environment.LANG, 'en_US.UTF-8');
    assert.equal(environment.LC_ALL, 'en_US.UTF-8');
    assert.ok(path.isAbsolute(environment.ELECTRON_BUILDER_CACHE));
    assert.equal(process.env.CSC_IDENTITY_AUTO_DISCOVERY, 'true', 'Builder must not mutate the parent environment');
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('hashFile reads exact bytes including a multi-buffer file and empty file', (t) => {
  const root = fixture(t), file = path.join(root, 'image.dmg');
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 0xa5);
  bytes[1024 * 1024] = 0x5a;
  fs.writeFileSync(file, bytes);
  assert.equal(hashFile(file), digest(bytes));
  fs.writeFileSync(file, '');
  assert.equal(hashFile(file), digest(''));
});

test('hashFile refuses non-file inputs', (t) => {
  const root = fixture(t);
  assert.throws(() => hashFile(root), /Expected regular input file/);
  assert.throws(() => hashFile(path.join(root, 'absent')), { code: 'ENOENT' });
});

test('hashFile refuses a symlink even when it points to a valid file', { skip: process.platform === 'win32' }, (t) => {
  const root = fixture(t), file = path.join(root, 'image.dmg'), link = path.join(root, 'alias.dmg');
  fs.writeFileSync(file, 'image'); fs.symlinkSync(file, link);
  assert.throws(() => hashFile(link), /Expected regular input file/);
});

test('hashFile refuses a FileProvider-style premature EOF instead of hashing incomplete input', (t) => {
  const root = fixture(t), file = path.join(root, 'image.dmg');
  fs.writeFileSync(file, 'the file has bytes');
  t.mock.method(fs, 'readSync', () => 0);
  assert.throws(() => hashFile(file), /Incomplete or changing input/);
});

test('hashFile rejects a same-length file that changes while being read', (t) => {
  const root = fixture(t), file = path.join(root, 'image.dmg');
  fs.writeFileSync(file, 'before');
  const modifiedAt = new Date(fs.statSync(file).mtimeMs + 5000), read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed) { changed = true; fs.writeFileSync(file, 'after!'); fs.utimesSync(file, modifiedAt, modifiedAt); }
    return count;
  });
  assert.throws(() => hashFile(file), /Incomplete or changing input/);
});

test('no existing output permits a fresh build without creating any artifact', (t) => {
  const root = fixture(t);
  const paths = { dmg: path.join(root, 'image.dmg'), manifest: path.join(root, 'image.json'), checksum: path.join(root, 'image.sha256') };
  assert.equal(verifyExisting(paths, {}), null);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('an exact complete output is reusable without changing any file', (t) => {
  const f = existingOutput(t);
  const before = Object.fromEntries(Object.entries(f.paths).map(([name, file]) => [name, fs.readFileSync(file)]));
  assert.deepEqual(f.verify(), f.manifest);
  for (const [name, file] of Object.entries(f.paths)) assert.deepEqual(fs.readFileSync(file), before[name]);
});

for (const name of ['dmg', 'manifest', 'checksum']) {
  test(`partial output missing ${name} is refused without replacing remaining files`, (t) => {
    const f = existingOutput(t);
    fs.unlinkSync(f.paths[name]);
    assert.throws(f.verify, /Incomplete or conflicting DMG output/);
    assert.equal(fs.existsSync(f.paths[name]), false);
    assert.equal(fs.readdirSync(f.root).length, 2);
  });
}

for (const [label, mutate] of [
  ['different app source', (f) => { f.manifest.source.signedBundleSha256 = '0'.repeat(64); }],
  ['different app manifest', (f) => { f.manifest.source.appManifestSha256 = '0'.repeat(64); }],
  ['different packaging input', (f) => { f.manifest.buildInputs['docs/MACOS-INSTALL.txt'] = '0'.repeat(64); }],
  ['incomplete build', (f) => { delete f.manifest.completedAt; }],
  ['failed build phase', (f) => { f.manifest.timings[0].passed = false; }],
  ['no recorded phase', (f) => { f.manifest.timings = []; }],
  ['wrong schema', (f) => { f.manifest.schema = 'unrecognized'; }],
  ['different output path', (f) => { f.manifest.artifact.path = path.join(f.root, 'other.dmg'); }],
  ['wrong byte count', (f) => { f.manifest.artifact.bytes += 1; }],
]) {
  test(`existing output rejects ${label}`, (t) => {
    const f = existingOutput(t); mutate(f); f.write(); assert.throws(f.verify);
    assert.deepEqual(fs.readFileSync(f.paths.dmg), f.bytes);
  });
}

test('same-size DMG content corruption is rejected by its hash', (t) => {
  const f = existingOutput(t), changed = Buffer.from(f.bytes); changed[0] ^= 0xff;
  fs.writeFileSync(f.paths.dmg, changed);
  assert.equal(changed.length, f.manifest.artifact.bytes);
  assert.throws(f.verify, /Existing DMG checksum mismatch/);
  assert.deepEqual(fs.readFileSync(f.paths.dmg), changed);
});

test('a checksum sidecar for another artifact is refused', (t) => {
  const f = existingOutput(t);
  fs.writeFileSync(f.paths.checksum, `${f.manifest.artifact.sha256}  other.dmg\n`);
  assert.throws(f.verify);
});

test('an existing output symlink is refused even if target bytes are valid', { skip: process.platform === 'win32' }, (t) => {
  const f = existingOutput(t), target = path.join(f.root, 'external-image');
  fs.renameSync(f.paths.dmg, target); fs.symlinkSync(target, f.paths.dmg);
  assert.throws(f.verify);
  assert.deepEqual(fs.readFileSync(target), f.bytes);
});

test('timed-out build command terminates its own parent and grandchild even when both ignore SIGTERM', {
  skip: process.platform === 'win32' ? 'POSIX private process-group cleanup' : false,
  timeout: 12_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie dmg process-group '));
  const pidFile = path.join(root, 'owned-pids.json'), eventsFile = path.join(root, 'events.txt');
  const token = crypto.randomUUID();
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const owned = () => {
    const value = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(value.token, token);
    for (const pid of [value.parent, value.grandchild]) assert.ok(Number.isSafeInteger(pid) && pid > 1);
    return value;
  };
  t.after(async () => {
    // Only PIDs written by this unique fixture can be considered for teardown.
    // This fallback prevents a failing cleanup regression from leaking workers.
    if (fs.existsSync(pidFile)) {
      const pids = owned();
      if (alive(pids.parent) || alive(pids.grandchild)) {
        try { process.kill(-pids.parent, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        const deadline = Date.now() + 2000;
        while ((alive(pids.parent) || alive(pids.grandchild)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const grandchildCode = `
    const fs = require('node:fs');
    const events = process.argv[1];
    process.on('SIGTERM', () => fs.appendFileSync(events, 'grandchild:SIGTERM\\n'));
    fs.appendFileSync(events, 'grandchild:ready\\n');
    setInterval(() => {}, 1000);
  `;
  const parentCode = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [pidFile, events, token, grandchildCode] = process.argv.slice(1);
    process.on('SIGTERM', () => fs.appendFileSync(events, 'parent:SIGTERM\\n'));
    const child = spawn(process.execPath, ['-e', grandchildCode, events], { stdio: 'inherit' });
    fs.writeFileSync(pidFile, JSON.stringify({ token, parent: process.pid, grandchild: child.pid }));
    fs.appendFileSync(events, 'parent:ready\\n');
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', parentCode, pidFile, eventsFile, token, grandchildCode],
    { cwd: root, timeout: 800 }), /failed \(timeout\)/);
  const events = fs.readFileSync(eventsFile, 'utf8');
  for (const role of ['parent', 'grandchild']) {
    assert.ok(events.includes(`${role}:ready\n`), `${role} must start before the timeout`);
    assert.ok(events.includes(`${role}:SIGTERM\n`), `${role} must receive and ignore graceful termination`);
  }
  assert.ok(Date.now() - started >= 3500, 'Both workers must survive SIGTERM until the bounded SIGKILL escalation');
  const pids = owned(), deadline = Date.now() + 2000;
  while ((alive(pids.parent) || alive(pids.grandchild)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive(pids.parent), false, 'Timed-out parent survived cleanup');
  assert.equal(alive(pids.grandchild), false, 'Timed-out grandchild survived cleanup');
});
