'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const records = require('./build-record.cjs');

// All filesystem fixtures, fake executables and application bytes are local to
// one temporary isolation root. Only codesign and host spawning are replaced;
// source digests, copies, Git export and runtime verification use real files.
function processFixture(scratch) {
  const value = new EventEmitter();
  value.env = { ...process.env, REVERIE_DATA_DIR: path.join(scratch, 'data'),
    TMPDIR: path.join(scratch, 'tmp'), NODE_OPTIONS: '--untrusted', PYTHONPATH: '/untrusted', VIRTUAL_ENV: '/untrusted' };
  value.getuid = () => process.getuid();
  value.pid = process.pid;
  value.argv = [];
  value.output = { stdout: [], stderr: [] };
  value.stdout = { write: bytes => value.output.stdout.push(Buffer.from(bytes)) };
  value.stderr = { write: bytes => value.output.stderr.push(Buffer.from(bytes)) };
  return value;
}
function loadRuntime(fakeProcess, spawnImpl, signatureCalls) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const value = { exports: {} };
    cache.set(filename, value);
    const requireFixture = name => {
      if (name === 'node:child_process') return {
        execFileSync(command, args, options) {
          if (command === '/usr/bin/codesign') {
            signatureCalls.push(args);
            if (signatureCalls.failure) throw signatureCalls.failure;
            return Buffer.alloc(0);
          }
          return execFileSync(command, args, options);
        },
        spawn: spawnImpl || (() => { throw Error('Unexpected host spawn'); }),
      };
      if (name === './build-record.cjs') return load(path.join(__dirname, 'build-record.cjs'));
      return require(name);
    };
    const wrapped = new vm.Script('(function(exports, require, module, __filename, __dirname, process) {\n'
      + fs.readFileSync(filename, 'utf8') + '\n})', { filename }).runInThisContext();
    wrapped(value.exports, requireFixture, value, filename, path.dirname(filename), fakeProcess);
    return value.exports;
  }
  return load(path.join(__dirname, 'preview-runtime.cjs'));
}
function fixture(t, options = {}) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-local-preview-test-'));
  fs.chmodSync(scratch, 0o700);
  fs.mkdirSync(path.join(scratch, 'tmp'), { mode: 0o700 });
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'project');
  fs.mkdirSync(root, { mode: 0o700 });
  function put(relative, bytes, mode = 0o600) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode });
    return file;
  }
  function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
  put('.gitignore', '.tools/\n.venv/\n');
  put('src/main.py', 'print("frozen backend")\n');
  put('native-ui/avatar-host.cjs', '"use strict";\n');
  put('frontend/electron/avatar-manager.cjs', 'module.exports = {};\n');
  put('frontend/script/downscale-live2d-textures.py', '# frozen worker\n');
  put('script/preview-qt-macos.sh', '#!/bin/bash\nexit 0\n', 0o755);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  git(['init', '-q']);
  git(['config', 'user.name', 'Preview Fixture']);
  git(['config', 'user.email', 'preview-fixture@example.invalid']);
  git(['add', '--', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'frozen fixture']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const source = records.sourceInventory(root);
  const base = path.join(root, '.tools/python/cpython-3.12.14-macos-aarch64-none');
  const python = put('.tools/python/cpython-3.12.14-macos-aarch64-none/bin/python3.12', 'fake-python\n', 0o755);
  put('.tools/python/cpython-3.12.14-macos-aarch64-none/lib/python3.12/os.py', '# copied stdlib\n');
  put('.tools/python/cpython-3.12.14-macos-aarch64-none/lib/libpython.dylib', 'fake-python-library\n');
  fs.symlinkSync('libpython.dylib', path.join(base, 'lib/libpython-link.dylib'));
  put('.venv/pyvenv.cfg', `home = ${path.join(base, 'bin')}\ninclude-system-site-packages = false\n`);
  put('.venv/lib/python3.12/site-packages/dependency.py', '# copied dependency\n');
  fs.mkdirSync(path.join(root, '.venv/bin'));
  fs.symlinkSync(python, path.join(root, '.venv/bin/python'));
  fs.symlinkSync('python', path.join(root, '.venv/bin/python3'));
  fs.symlinkSync('python3', path.join(root, '.venv/bin/python3.12'));
  const node = put('.tools/node/bin/node', 'fake-node\n', 0o755);
  const external = put('.tools/qt-sdk/lib/QtCore', 'fake-qt\n');
  const framework = path.dirname(put('.tools/live2d/Framework/shader.glsl', 'fake-shader\n'));
  const build = path.join(root, '.tools/qt-candidates/preview-fixture');
  const app = path.join(build, 'Reverie Scene.app');
  put('.tools/qt-candidates/preview-fixture/Reverie Scene.app/Contents/MacOS/Reverie Scene', 'fake-host\n', 0o755);
  put('.tools/qt-candidates/preview-fixture/Reverie Scene.app/Contents/Resources/main.qml', '// frozen qml\n');
  fs.symlinkSync('main.qml', path.join(app, 'Contents/Resources/link.qml'));
  const application = records.directoryInventory(app);
  const record = { schema: 'reverie.qt.local-build.v2', candidate: 'preview-fixture', previewWorkspaceContract: 'v1',
    diagnostics: { qmlProfilerEnabled: false, timingProbesEnabled: false, ordinaryLauncherAllowed: true },
    source: { head, inventory: records.digest(source), runtimeInputs: records.digest(records.runtimeInputs(source)) },
    application: { inventory: records.digest(application) }, python: { prefix: path.join(root, '.venv'), basePrefix: base },
    externalFiles: [python, node, external].map(file => ({ path: file, sha256: records.fileHash(file) })),
    externalTrees: [{ path: framework, inventory: records.digest(records.directoryInventory(framework)) }] };
  writeJson(path.join(build, 'source-inventory.json'), source);
  writeJson(path.join(build, 'application-inventory.json'), application);
  writeJson(path.join(build, 'build.json'), record);
  const report = path.join(root, '.tools/local/preview-fixture/runs/000001-fixture');
  fs.mkdirSync(report, { recursive: true });
  writeJson(path.join(report, 'run-ledger.json'), { unitIsolation: { scratch } });
  writeJson(path.join(report, 'runtime-config.json'), { candidateDirectory: build });
  put('.tools/registered-run/active-local.json', JSON.stringify({ schema: 'reverie.active-local-run.v1',
    metadata: { outputDirectory: report } }));
  const fakeProcess = processFixture(scratch), signatureCalls = [];
  const runtime = loadRuntime(fakeProcess, options.spawn, signatureCalls);
  const destination = path.join(scratch, 'runtime');
  const install = () => runtime.installIsolatedRuntime({ projectRoot: root, buildDirectory: build, destination, isolationRoot: scratch });
  function adopt() {
    const reportDirectory = path.join(root, '.tools/reports/formal-preview-fixture');
    fs.mkdirSync(reportDirectory, { recursive: true });
    const pointer = { directory: build, buildManifestSha256: records.fileHash(path.join(build, 'build.json')) };
    const pointerPath = put('.tools/qt-candidates/last-local-sdk.json', JSON.stringify(pointer, null, 2) + '\n');
    const registration = { registrationId: 'formal-preview-fixture', runKind: 'formal', adoptCandidate: true,
      candidateDirectory: build, sourceHead: head, configSha256: 'a'.repeat(64), toolCommit: head, sourceTreeHash: 'b'.repeat(40) };
    const registrationPath = path.join(reportDirectory, 'registration.json');
    writeJson(registrationPath, registration);
    const authorization = { schema: 'reverie.registered-run.authorization.v1', approved: true,
      userApprovalText: '批准运行正式批 fixture', registrationSha256: records.fileHash(registrationPath),
      ...Object.fromEntries(['registrationId', 'configSha256', 'toolCommit', 'sourceHead', 'sourceTreeHash'].map(key => [key, registration[key]])) };
    const authorizationPath = path.join(reportDirectory, 'authorization.json');
    writeJson(authorizationPath, authorization);
    const ledger = { passed: true, defaultPointerCandidateVerified: true, postAdoptionBindingsVerified: true,
      adoptedPointerSha256: records.fileHash(pointerPath), sourceHead: head, configSha256: registration.configSha256,
      authorizationSha256: records.fileHash(authorizationPath) };
    writeJson(path.join(reportDirectory, 'run-ledger.json'), ledger);
    return { reportDirectory, registration, authorization, ledger, pointerPath };
  }
  return { scratch, root, put, writeJson, head, build, app, record, base, python, node, external, framework, report,
    fakeProcess, signatureCalls, runtime, destination, install, adopt };
}

test('isolated installation binds all inventories and relocates Python without changing its source', t => {
  const f = fixture(t), originalCfg = fs.readFileSync(path.join(f.root, '.venv/pyvenv.cfg'));
  const result = f.install();
  assert.equal(result.runtimeRoot, f.destination);
  assert.equal(result.candidate, 'preview-fixture');
  assert.equal(result.sourceHead, f.head);
  assert.equal(result.installationKind, 'isolated');
  assert.equal(result.isolationRoot, f.scratch);
  assert.equal(result.metadataPath, result.manifestPath);
  assert.ok(fs.statSync(result.metadataPath).size <= 64 * 1024);
  assert.ok(fs.realpathSync(result.python).startsWith(path.join(f.destination, '.tools/python') + path.sep));
  assert.equal(records.fileHash(fs.realpathSync(result.python)), records.fileHash(f.python));
  assert.equal(records.fileHash(result.node), records.fileHash(f.node));
  assert.equal(fs.readlinkSync(path.join(f.destination, '.venv/bin/python3')), 'python');
  assert.equal(fs.readlinkSync(path.join(f.destination, '.venv/bin/python3.12')), 'python');
  assert.match(fs.readFileSync(path.join(f.destination, '.venv/pyvenv.cfg'), 'utf8'), new RegExp('^home = ' +
    path.dirname(fs.realpathSync(result.python)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm'));
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.venv/pyvenv.cfg')), originalCfg);
  assert.ok(f.signatureCalls.length >= 2);
  assert.ok(f.signatureCalls.every(args => args[0] === '--verify' && args[1] === '--strict'));
  const manifest = JSON.parse(fs.readFileSync(result.inventoryPath));
  assert.ok(manifest.copiedSources.some(row => row.relocation === 'venv-home'));
  assert.ok(manifest.entries.some(row => row.path === 'candidate/build.json'));
  assert.ok(!manifest.entries.some(row => /^preview-(runtime|manifest)/.test(row.path)));
});

test('frozen source exports from the recorded commit after developer source changes', t => {
  const f = fixture(t);
  f.put('src/main.py', 'print("developer changed")\n');
  f.install();
  assert.equal(fs.readFileSync(path.join(f.destination, 'src/main.py'), 'utf8'), 'print("frozen backend")\n');
});

test('installed verification does not require the developer Git tree or original interpreter binaries', t => {
  const f = fixture(t); f.install();
  fs.rmSync(path.join(f.root, '.git'), { recursive: true });
  fs.rmSync(path.join(f.root, 'src'), { recursive: true });
  fs.writeFileSync(f.python, 'developer Python changed\n');
  fs.writeFileSync(f.node, 'developer Node changed\n');
  assert.equal(f.runtime.verifyRuntime(f.destination).sourceHead, f.head);
});

function rejectsChangedRuntime(t, mutate) {
  const f = fixture(t); f.install(); mutate(f);
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
}
test('verification rejects runtime input changed', t => {
  rejectsChangedRuntime(t, f => fs.appendFileSync(path.join(f.destination, 'src/main.py'), '# changed\n'));
});
test('verification rejects runtime input missing', t => {
  rejectsChangedRuntime(t, f => fs.unlinkSync(path.join(f.destination, 'src/main.py')));
});
test('verification rejects runtime input extra', t => {
  rejectsChangedRuntime(t, f => fs.writeFileSync(path.join(f.destination, 'src/extra.py'), '# extra\n'));
});
test('verification rejects application changed', t => {
  rejectsChangedRuntime(t, f => fs.appendFileSync(path.join(f.destination, 'candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene'), 'changed'));
});
test('verification rejects Python dependency changed', t => {
  rejectsChangedRuntime(t, f => fs.appendFileSync(path.join(f.destination, '.venv/lib/python3.12/site-packages/dependency.py'), 'changed'));
});
test('verification rejects Python executable changed', t => {
  rejectsChangedRuntime(t, f => fs.appendFileSync(fs.realpathSync(path.join(f.destination, '.venv/bin/python')), 'changed'));
});
test('verification rejects Node executable changed', t => {
  rejectsChangedRuntime(t, f => fs.appendFileSync(path.join(f.destination, '.tools/node/bin/node'), 'changed'));
});
test('verification rejects unexpected directory', t => {
  rejectsChangedRuntime(t, f => fs.mkdirSync(path.join(f.destination, 'unexpected')));
});

test('verification rejects a symlink escaping the installed runtime', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.destination, 'src/main.py');
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, 'src/main.py'), file);
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_LINK_ESCAPES/);
});

test('metadata and inventory changes are rejected before starting the host', t => {
  const f = fixture(t); f.install();
  fs.appendFileSync(path.join(f.destination, 'preview-runtime.json'), ' ');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_METADATA_SEAL/);
});

test('inventory file changes are rejected by the metadata binding', t => {
  const f = fixture(t); f.install();
  fs.appendFileSync(path.join(f.destination, 'preview-manifest.json'), ' ');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_MANIFEST_CHANGED/);
});

test('metadata links and hardlinks are rejected as unsafe control files', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.destination, 'preview-runtime.json'), saved = path.join(f.scratch, 'saved-meta');
  fs.renameSync(file, saved); fs.symlinkSync(saved, file);
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RECORD_UNSAFE/);
  fs.unlinkSync(file); fs.linkSync(saved, file);
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RECORD_UNSAFE/);
});

test('original Qt and SDK files remain required and hash checked', t => {
  const f = fixture(t); f.install();
  fs.appendFileSync(f.external, 'changed');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /External build dependency changed/);
});

test('external SDK tree additions are rejected', t => {
  const f = fixture(t); f.install();
  fs.writeFileSync(path.join(f.framework, 'extra.glsl'), '// extra\n');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /External SDK framework\/shader files changed/);
});

test('unsupported and diagnostic candidates are rejected before installation', t => {
  const f = fixture(t);
  delete f.record.previewWorkspaceContract;
  f.writeJson(path.join(f.build, 'build.json'), f.record);
  assert.throws(f.install, /PREVIEW_UNSUPPORTED_CANDIDATE/);
  assert.equal(fs.existsSync(f.destination), false);
  f.record.previewWorkspaceContract = 'v1'; f.record.diagnostics.timingProbesEnabled = true;
  f.writeJson(path.join(f.build, 'build.json'), f.record);
  assert.throws(f.install, /diagnostic performance entry/);
});

test('production installation only accepts a supported default adopted formal candidate', t => {
  const f = fixture(t); f.adopt();
  const result = f.runtime.installDefaultRuntime(f.root);
  assert.equal(result.installationKind, 'adopted');
  assert.equal(result.runtimeRoot, path.join(f.root, '.tools/preview-runtime/preview-fixture'));
});

test('production installation refuses a candidate without completed adoption', t => {
  const f = fixture(t), adoption = f.adopt();
  adoption.ledger.postAdoptionBindingsVerified = false;
  f.writeJson(path.join(adoption.reportDirectory, 'run-ledger.json'), adoption.ledger);
  assert.throws(() => f.runtime.installDefaultRuntime(f.root), /PREVIEW_CANDIDATE_NOT_ADOPTED/);
  assert.equal(fs.existsSync(path.join(f.root, '.tools/preview-runtime')), false);
});

test('production installation refuses changed default pointer and approval bindings', t => {
  const f = fixture(t), adoption = f.adopt();
  f.writeJson(adoption.pointerPath, { directory: f.build, buildManifestSha256: '0'.repeat(64) });
  assert.throws(() => f.runtime.installDefaultRuntime(f.root), /PREVIEW_DEFAULT_POINTER_CHANGED/);
  f.writeJson(adoption.pointerPath, { directory: f.build, buildManifestSha256: records.fileHash(path.join(f.build, 'build.json')) });
  adoption.authorization.sourceHead = '0'.repeat(40);
  f.writeJson(path.join(adoption.reportDirectory, 'authorization.json'), adoption.authorization);
  assert.throws(() => f.runtime.installDefaultRuntime(f.root), /PREVIEW_CANDIDATE_NOT_ADOPTED/);
});

test('isolated installation rejects destinations outside the current runner root', t => {
  const f = fixture(t);
  assert.throws(() => f.runtime.installIsolatedRuntime({ projectRoot: f.root, buildDirectory: f.build,
    destination: path.join(path.dirname(f.scratch), 'unrelated-preview-runtime'), isolationRoot: f.scratch }), /PREVIEW_ISOLATED_DESTINATION/);
  assert.throws(() => f.runtime.installIsolatedRuntime({ projectRoot: f.root, buildDirectory: f.build,
    destination: f.scratch, isolationRoot: f.scratch }), /PREVIEW_ISOLATED_DESTINATION/);
});

test('isolated installation binds active run build and isolation root', t => {
  const f = fixture(t);
  f.writeJson(path.join(f.report, 'runtime-config.json'), { candidateDirectory: path.join(f.root, 'other-build') });
  assert.throws(f.install, /PREVIEW_ACTIVE_BUILD_ISOLATION_MISMATCH/);
  f.writeJson(path.join(f.report, 'runtime-config.json'), { candidateDirectory: f.build });
  fs.unlinkSync(path.join(f.root, '.tools/registered-run/active-local.json'));
  assert.throws(f.install, /PREVIEW_ACTIVE_RUN_REQUIRED/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('isolated installation requires the current engine data-root identity', t => {
  const f = fixture(t);
  f.fakeProcess.env.REVERIE_DATA_DIR = path.join(f.scratch, 'different/data');
  assert.throws(f.install, /PREVIEW_ISOLATION_ROOT_REQUIRED/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('registered smoke uses the same isolated installer without an adoption bypass flag', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, '.tools/registered-run/active-local.json'));
  f.put('.tools/registered-run/active-registration.json', JSON.stringify({ schema: 'reverie.active-registration.v1',
    state: 'frozen', metadata: { reportDirectory: path.relative(f.root, f.report) } }));
  assert.equal(f.install().installationKind, 'isolated');
});

test('installation failure removes only the directory created by that attempt', t => {
  const f = fixture(t);
  f.put('.venv/pyvenv.cfg', `home = ${f.base}\ninclude-system-site-packages = true\n`);
  assert.throws(f.install, /PREVIEW_VENV_CONFIGURATION/);
  assert.equal(fs.existsSync(f.destination), false);
  fs.mkdirSync(f.destination, { mode: 0o700 });
  fs.writeFileSync(path.join(f.destination, 'preserve'), 'old contents');
  assert.throws(f.install, /PREVIEW_RUNTIME_ALREADY_EXISTS/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'preserve'), 'utf8'), 'old contents');
});

test('signature verification failure refuses installation and startup', async t => {
  const f = fixture(t), failure = Error('fixture codesign rejected');
  f.signatureCalls.failure = failure;
  assert.throws(f.install, error => error === failure);
  assert.equal(fs.existsSync(f.destination), false);
  delete f.signatureCalls.failure; f.install();
  f.signatureCalls.failure = failure;
  await assert.rejects(f.runtime.startRuntime({ runtimeRoot: f.destination, workspace: path.join(f.scratch, 'workspace') }),
    error => error === failure);
  assert.equal(fs.existsSync(path.join(f.scratch, 'workspace')), false);
});

test('logs rotate at the byte cap and retain ten files across launcher sessions', t => {
  const f = fixture(t), workspace = path.join(f.scratch, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  for (let session = 0; session < 2; session++) {
    const log = f.runtime.boundedLog(workspace);
    log.write(Buffer.alloc(f.runtime.LOG_MAX_BYTES * 7 + 11, 65 + session));
    log.close();
  }
  const logs = path.join(workspace, 'logs'), names = fs.readdirSync(logs);
  assert.equal(names.length, f.runtime.LOG_MAX_FILES);
  for (const name of names) {
    const info = fs.statSync(path.join(logs, name));
    assert.ok(info.size <= f.runtime.LOG_MAX_BYTES);
    assert.equal(info.mode & 0o777, 0o600);
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 4242; child.exitCode = null; child.signalCode = null; child.kills = [];
  child.kill = signal => { child.kills.push(signal); child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}
function readyBytes(f, child, workspace, overrides = {}) {
  return Buffer.from('REVERIE_PREVIEW_READY ' + JSON.stringify({ schema: 'reverie.qt.preview.ready.v1',
    hostPid: child.pid, backendPid: child.pid + 1, workspaceId: records.sha256(workspace), candidate: 'preview-fixture',
    sourceHead: f.head, recoveryState: 'clean', runtimeWritable: true, ...overrides }) + '\n');
}
test('launcher forwards SIGTERM, bounded output and the fixed three host arguments', async t => {
  const child = fakeChild(); let call, f, workspace;
  f = fixture(t, { spawn(executable, args, options) {
    call = { executable, args, options };
    queueMicrotask(() => {
      child.stdout.write('early host output\n');
      child.stderr.write('preview stderr\n');
      assert.equal(fs.existsSync(path.join(workspace, 'logs')), false);
      const ready = readyBytes(f, child, workspace);
      child.stdout.write(ready.subarray(0, 11)); child.stdout.write(ready.subarray(11));
      f.fakeProcess.emit('SIGTERM');
    });
    return child;
  } });
  const installed = f.install(); workspace = path.join(f.scratch, 'workspace');
  const result = await f.runtime.startRuntime({ runtimeRoot: f.destination, workspace });
  assert.equal(call.executable, installed.hostExecutable);
  assert.deepEqual(call.args, ['--workspace', workspace, '--project-root', f.destination, '--python', installed.python]);
  assert.equal(call.options.cwd, f.destination);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV'])
    assert.equal(call.options.env[key], undefined);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.exitCode, null);
  assert.equal(result.readyObserved, true);
  assert.equal(f.fakeProcess.listenerCount('SIGTERM'), 0);
  assert.match(Buffer.concat(f.fakeProcess.output.stdout).toString(), /REVERIE_PREVIEW_READY/);
  assert.match(Buffer.concat(f.fakeProcess.output.stderr).toString(), /preview stderr/);
  assert.ok(fs.readdirSync(result.logDirectory).length > 0);
  const text = fs.readdirSync(result.logDirectory).map(name => fs.readFileSync(path.join(result.logDirectory, name), 'utf8')).join('');
  assert.match(text, /early host output/);
  assert.match(text, /preview stderr/);
});

test('launcher preserves Chinese second-instance rejection without writing workspace logs', async t => {
  const child = fakeChild();
  const f = fixture(t, { spawn() {
    queueMicrotask(() => { child.stderr.write('此预览工作区已打开，请使用已运行的窗口。\n');
      child.exitCode = 66; child.emit('close', 66, null); });
    return child;
  } });
  f.install();
  const workspace = path.join(f.scratch, 'workspace'), logs = path.join(workspace, 'logs');
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(logs, { mode: 0o700 });
  fs.writeFileSync(path.join(logs, 'existing.log'), 'keep original logs\n');
  const result = await f.runtime.startRuntime({ runtimeRoot: f.destination, workspace });
  assert.equal(result.exitCode, 66);
  assert.equal(result.readyObserved, false);
  assert.match(Buffer.concat(f.fakeProcess.output.stderr).toString(), /此预览工作区已打开/);
  assert.deepEqual(fs.readdirSync(result.logDirectory), ['existing.log']);
  assert.equal(fs.readFileSync(path.join(logs, 'existing.log'), 'utf8'), 'keep original logs\n');
});

test('launcher does not write logs for a forged or mismatched ready record', async t => {
  const child = fakeChild(); let f, workspace;
  f = fixture(t, { spawn() {
    queueMicrotask(() => {
      for (const overrides of [{ hostPid: child.pid + 100 }, { candidate: 'other' }, { sourceHead: '0'.repeat(40) },
        { workspaceId: '0'.repeat(64) }, { recoveryState: 'recovering' }, { runtimeWritable: false }, { schema: 'other' }])
        child.stdout.write(readyBytes(f, child, workspace, overrides));
      child.exitCode = 1; child.emit('close', 1, null);
    });
    return child;
  } });
  f.install(); workspace = path.join(f.scratch, 'workspace');
  const result = await f.runtime.startRuntime({ runtimeRoot: f.destination, workspace });
  assert.equal(result.readyObserved, false);
  assert.equal(fs.existsSync(result.logDirectory), false);
});

test('launcher bounds early output and flushes it only after a valid ready line', async t => {
  const child = fakeChild(); let f, workspace;
  f = fixture(t, { spawn() {
    queueMicrotask(() => {
      child.stderr.write(Buffer.alloc(f.runtime.LOG_MAX_BYTES * 2, 120));
      child.stdout.write(readyBytes(f, child, workspace));
      child.exitCode = 0; child.emit('close', 0, null);
    });
    return child;
  } });
  f.install(); workspace = path.join(f.scratch, 'workspace');
  const result = await f.runtime.startRuntime({ runtimeRoot: f.destination, workspace });
  assert.equal(result.readyObserved, true);
  const files = fs.readdirSync(result.logDirectory);
  assert.equal(files.reduce((total, name) => total + fs.statSync(path.join(result.logDirectory, name)).size, 0), f.runtime.LOG_MAX_BYTES);
});

test('launcher rejects an isolated workspace escape before creating it or spawning', async t => {
  const f = fixture(t); f.install();
  const workspace = path.join(path.dirname(f.scratch), 'unrelated-preview-workspace');
  await assert.rejects(f.runtime.startRuntime({ runtimeRoot: f.destination, workspace }), /PREVIEW_ISOLATED_WORKSPACE/);
});

test('launcher rejects broad workspace permissions and symlinks', async t => {
  const f = fixture(t); f.install();
  const workspace = path.join(f.scratch, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o755 });
  await assert.rejects(f.runtime.startRuntime({ runtimeRoot: f.destination, workspace }), /PREVIEW_WORKSPACE_PERMISSIONS/);
  fs.rmdirSync(workspace);
  const target = path.join(f.scratch, 'workspace-target');
  fs.mkdirSync(target, { mode: 0o700 }); fs.symlinkSync(target, workspace);
  await assert.rejects(f.runtime.startRuntime({ runtimeRoot: f.destination, workspace }), /PREVIEW_DIRECTORY_ALIAS/);
});

test('future workspace format refuses an installed legacy target before host or directory initialization', async t => {
  const f = fixture(t); f.install();
  const runtime = f.runtime.verifyRuntime(f.destination);
  assert.equal(runtime.supportedDataFormat, 1);
  assert.equal(runtime.workspaceControlContract, null);
  const workspace = path.join(f.scratch, 'workspace'), data = path.join(workspace, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.chmodSync(workspace, 0o700);
  fs.mkdirSync(path.join(workspace, 'avatars'), { mode: 0o700 });
  const file = path.join(data, f.runtime.DATA_FORMAT_RECORD);
  const bytes = JSON.stringify({ schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: 2 }) + '\n';
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  await assert.rejects(f.runtime.startRuntime({ runtimeRoot: f.destination, workspace }), /PREVIEW_DATA_FORMAT_TOO_NEW/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(workspace).sort(), ['avatars', 'data']);
  assert.deepEqual(fs.readdirSync(data), [f.runtime.DATA_FORMAT_RECORD]);
});

test('launcher format reader treats missing legacy data as one without creating it and rejects malformed records', t => {
  const f = fixture(t), workspace = path.join(f.scratch, 'workspace');
  assert.equal(f.runtime.checkDataFormat(workspace), 1);
  assert.equal(fs.existsSync(workspace), false);
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(path.join(workspace, 'data'), { mode: 0o700 });
  const file = path.join(workspace, 'data', f.runtime.DATA_FORMAT_RECORD);
  for (const value of [null, [], { schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: true },
    { schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: 1.5 },
    { schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: 0 },
    { schema: 'reverie.preview.data-format.v2', formatVersion: 1 },
    { schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: 1, extra: 0 }]) {
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.throws(() => f.runtime.checkDataFormat(workspace), /PREVIEW_DATA_FORMAT_INVALID/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('launcher format record cannot be a symlink or a hard link', t => {
  const f = fixture(t), workspace = path.join(f.scratch, 'workspace'), data = path.join(workspace, 'data');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 }); fs.chmodSync(workspace, 0o700);
  const original = path.join(data, 'original.json'), record = path.join(data, f.runtime.DATA_FORMAT_RECORD);
  const bytes = JSON.stringify({ schema: f.runtime.DATA_FORMAT_SCHEMA, formatVersion: 1 });
  fs.writeFileSync(original, bytes, { mode: 0o600 }); fs.linkSync(original, record);
  assert.throws(() => f.runtime.checkDataFormat(workspace), /PREVIEW_DATA_FORMAT_INVALID/);
  fs.unlinkSync(record); fs.symlinkSync('original.json', record);
  assert.throws(() => f.runtime.checkDataFormat(workspace), /PREVIEW_DATA_FORMAT_INVALID/);
  assert.equal(fs.readFileSync(original, 'utf8'), bytes);
});

function resealFixtureMetadata(f, mutate) {
  const metadataFile = path.join(f.destination, 'preview-runtime.json'), manifestFile = path.join(f.destination, 'preview-manifest.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile)), manifest = JSON.parse(fs.readFileSync(manifestFile));
  mutate(metadata, manifest);
  f.writeJson(manifestFile, manifest); metadata.manifestSha256 = records.fileHash(manifestFile);
  f.writeJson(metadataFile, metadata);
  fs.writeFileSync(path.join(f.destination, 'preview-runtime.sha256'), records.fileHash(metadataFile) + '\n');
}

test('old installation missing support fields remains readable as format one and is never a controller', t => {
  const f = fixture(t); f.install();
  resealFixtureMetadata(f, (metadata, manifest) => {
    delete metadata.supportedDataFormat; delete manifest.supportedDataFormat;
    delete metadata.workspaceControlContract; delete manifest.workspaceControlContract;
  });
  const before = fs.readFileSync(path.join(f.destination, 'preview-runtime.json'));
  const runtime = f.runtime.verifyRuntime(f.destination);
  assert.equal(runtime.supportedDataFormat, 1); assert.equal(runtime.workspaceControlContract, null);
  assert.throws(() => f.runtime.recoveryController(runtime, f.root), /PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED/);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'preview-runtime.json')), before);
});

test('a legacy candidate cannot acquire maintenance capability by editing only installation metadata', t => {
  const f = fixture(t); f.install();
  resealFixtureMetadata(f, (metadata, manifest) => {
    metadata.workspaceControlContract = 'v1'; manifest.workspaceControlContract = 'v1';
  });
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_BUNDLE_CAPABILITY_BINDING/);
});

test('maintenance capability and format support are bound to the verified candidate build', t => {
  const f = fixture(t);
  f.put('.tools/qt-candidates/preview-fixture/Reverie Scene.app/Contents/Info.plist',
    '<?xml version="1.0"?><plist version="1.0"><dict><key>ReverieSupportedDataFormat</key><integer>1</integer>' +
    '<key>ReverieWorkspaceControlContract</key><string>v1</string></dict></plist>');
  const application = records.directoryInventory(f.app);
  f.record.application.inventory = records.digest(application);
  f.writeJson(path.join(f.build, 'application-inventory.json'), application);
  f.record.supportedDataFormat = 1; f.record.workspaceControlContract = 'v1';
  f.writeJson(path.join(f.build, 'build.json'), f.record); f.install();
  const runtime = f.runtime.verifyRuntime(f.destination);
  assert.equal(runtime.supportedDataFormat, 1); assert.equal(runtime.workspaceControlContract, 'v1');
  assert.equal(f.runtime.recoveryController(runtime, f.root), runtime);
  assert.throws(() => f.runtime.runWorkspaceControl({ runtime, workspace: path.join(f.scratch, 'workspace'),
    operation: 'restore', snapshot: '../escape' }), /PREVIEW_RESTORE_SNAPSHOT_NAME/);
});

test('launcher adds no arbitrary controller parameter to the public command grammar', async t => {
  const f = fixture(t);
  await assert.rejects(f.runtime.main(['start', '--control-runtime-root', path.join(f.scratch, 'runtime')]), /PREVIEW_ARGUMENTS/);
});

test('self-consistent legacy build and installation edits cannot forge a signed controller capability', t => {
  const f = fixture(t); f.install();
  const installedBuild = path.join(f.destination, 'candidate/build.json');
  const value = JSON.parse(fs.readFileSync(installedBuild));
  value.supportedDataFormat = 1; value.workspaceControlContract = 'v1'; f.writeJson(installedBuild, value);
  resealFixtureMetadata(f, (metadata, manifest) => {
    metadata.workspaceControlContract = 'v1'; manifest.workspaceControlContract = 'v1';
    metadata.buildManifestSha256 = records.fileHash(installedBuild);
    const row = manifest.entries.find(entry => entry.path === 'candidate/build.json');
    row.bytes = fs.statSync(installedBuild).size; row.sha256 = records.fileHash(installedBuild);
  });
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_BUNDLE_CAPABILITY_BINDING/);
});

test('signed capability reader rejects duplicate and unknown declarations and defaults historical plists to legacy', t => {
  const f = fixture(t), file = path.join(f.app, 'Contents/Info.plist');
  const header = '<?xml version="1.0"?><plist version="1.0"><dict>', footer = '</dict></plist>';
  fs.writeFileSync(file, header + '<key>CFBundleName</key><string>Historical</string>' + footer);
  assert.deepEqual(f.runtime.signedBundleCapabilities(f.app), { supportedDataFormat: 1, workspaceControlContract: undefined });
  for (const body of [
    '<key>ReverieSupportedDataFormat</key><integer>0</integer>',
    '<key>ReverieSupportedDataFormat</key><integer>1</integer><key>ReverieSupportedDataFormat</key><integer>2</integer>',
    '<key>ReverieWorkspaceControlContract</key><string>v2</string>',
    '<key>ReverieWorkspaceControlContract</key><string>v1</string>',
  ]) {
    fs.writeFileSync(file, header + body + footer);
    assert.throws(() => f.runtime.signedBundleCapabilities(f.app), /PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID/);
  }
});

// These helpers only extend synthetic fixtures. They model historical catalogs
// without changing the installed production candidate or relaxing its seal.
function addLegacyFixtureDisplayFiles(f, names) {
  const rows = names.map(name => {
    const file = path.join(f.destination, name);
    fs.writeFileSync(file, 'historical Finder display bytes\n', { mode: 0o600 });
    const info = fs.lstatSync(file);
    return { path: name, type: 'file', bytes: info.size, mode: info.mode & 0o777,
      sha256: records.fileHash(file) };
  });
  resealFixtureMetadata(f, (_metadata, manifest) => {
    manifest.entries.push(...rows);
    manifest.entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  });
}

function addFixtureSourceDisplayRow(f) {
  const name = 'src/.DS_Store', file = f.put(name, 'historical source display bytes\n');
  const sourceFile = path.join(f.build, 'source-inventory.json');
  const source = JSON.parse(fs.readFileSync(sourceFile));
  source.push({ path: name, type: 'file', bytes: fs.lstatSync(file).size, sha256: records.fileHash(file) });
  source.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  f.record.source.inventory = records.digest(source);
  f.record.source.runtimeInputs = records.digest(records.runtimeInputs(source));
  f.writeJson(sourceFile, source);
  f.writeJson(path.join(f.build, 'build.json'), f.record);
  return source;
}

function assertHistoricalFixtureDisplayFiles(t, operation) {
  const f = fixture(t); f.install();
  const names = ['.DS_Store', '.venv/.DS_Store', '.venv/lib/python3.12/site-packages/.DS_Store',
    'src/.DS_Store', 'candidate/Reverie Scene.app/Contents/Resources/.DS_Store',
    `.tools/python/${path.basename(f.base)}/lib/python3.12/.DS_Store`];
  addLegacyFixtureDisplayFiles(f, names);
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
  const controls = ['preview-runtime.json', 'preview-manifest.json', 'preview-runtime.sha256']
    .map(name => [name, fs.readFileSync(path.join(f.destination, name))]);
  for (const name of names) {
    const file = path.join(f.destination, name);
    if (operation === 'changed') fs.writeFileSync(file, 'new Finder display bytes of a different length\n');
    else fs.unlinkSync(file);
  }
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
  for (const [name, bytes] of controls) assert.deepEqual(fs.readFileSync(path.join(f.destination, name)), bytes);
}

test('historical manifest Finder display files may be changed without rewriting installation records', t => {
  assertHistoricalFixtureDisplayFiles(t, 'changed');
});
test('historical manifest Finder display files may be missing without rewriting installation records', t => {
  assertHistoricalFixtureDisplayFiles(t, 'missing');
});

test('additional regular Finder display files are ignored at every installed runtime layer', t => {
  const f = fixture(t); f.install();
  const names = ['.DS_Store', 'candidate/.DS_Store', 'candidate/Reverie Scene.app/Contents/Resources/.DS_Store',
    'src/.DS_Store', '.venv/lib/python3.12/site-packages/.DS_Store',
    `.tools/python/${path.basename(f.base)}/lib/python3.12/.DS_Store`];
  const manifest = fs.readFileSync(path.join(f.destination, 'preview-manifest.json'));
  for (const name of names) fs.writeFileSync(path.join(f.destination, name), 'new Finder display bytes\n', { mode: 0o600 });
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'preview-manifest.json')), manifest);
});

function assertFixtureNonMetadataChangeRejected(t, name, operation) {
  const f = fixture(t), relative = `.venv/lib/python3.12/site-packages/${name}`;
  if (operation !== 'extra') f.put(relative, 'original non-metadata bytes\n');
  f.install();
  const file = path.join(f.destination, relative);
  if (operation === 'missing') fs.unlinkSync(file);
  else fs.writeFileSync(file, 'different non-metadata bytes\n', { mode: 0o600 });
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
}

test('Finder display exclusion still rejects extra ordinary.py', t => {
  assertFixtureNonMetadataChangeRejected(t, 'ordinary.py', 'extra');
});
test('Finder display exclusion still rejects missing ordinary.py', t => {
  assertFixtureNonMetadataChangeRejected(t, 'ordinary.py', 'missing');
});
test('Finder display exclusion still rejects changed ordinary.py', t => {
  assertFixtureNonMetadataChangeRejected(t, 'ordinary.py', 'changed');
});
test('Finder display exclusion still rejects extra .DS_Store.bak', t => {
  assertFixtureNonMetadataChangeRejected(t, '.DS_Store.bak', 'extra');
});
test('Finder display exclusion still rejects missing .DS_Store.bak', t => {
  assertFixtureNonMetadataChangeRejected(t, '.DS_Store.bak', 'missing');
});
test('Finder display exclusion still rejects changed .DS_Store.bak', t => {
  assertFixtureNonMetadataChangeRejected(t, '.DS_Store.bak', 'changed');
});
test('Finder display exclusion still rejects extra x.DS_Store', t => {
  assertFixtureNonMetadataChangeRejected(t, 'x.DS_Store', 'extra');
});
test('Finder display exclusion still rejects missing x.DS_Store', t => {
  assertFixtureNonMetadataChangeRejected(t, 'x.DS_Store', 'missing');
});
test('Finder display exclusion still rejects changed x.DS_Store', t => {
  assertFixtureNonMetadataChangeRejected(t, 'x.DS_Store', 'changed');
});

function assertFixtureDisplayTypeChangeRejected(t, replacement) {
  const f = fixture(t); f.install();
  const name = '.venv/.DS_Store', file = path.join(f.destination, name);
  addLegacyFixtureDisplayFiles(f, [name]);
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
  fs.unlinkSync(file);
  if (replacement === 'directory') fs.mkdirSync(file, { mode: 0o700 });
  else fs.symlinkSync('pyvenv.cfg', file);
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
}

test('a historical regular .DS_Store replaced by a directory remains an integrity failure', t => {
  assertFixtureDisplayTypeChangeRejected(t, 'directory');
});
test('a historical regular .DS_Store replaced by a link remains an integrity failure', t => {
  assertFixtureDisplayTypeChangeRejected(t, 'link');
});

test('installation omits regular Finder display files from app, Python, venv and copy provenance', t => {
  const f = fixture(t);
  const relativeNames = ['.tools/qt-candidates/preview-fixture/Reverie Scene.app/Contents/Resources/.DS_Store',
    `.tools/python/${path.basename(f.base)}/.DS_Store`,
    `.tools/python/${path.basename(f.base)}/lib/python3.12/.DS_Store`,
    '.venv/.DS_Store', '.venv/lib/python3.12/site-packages/.DS_Store'];
  for (const name of relativeNames) f.put(name, 'source Finder display bytes\n');
  const application = records.directoryInventory(f.app);
  assert.ok(application.some(row => row.path === 'Contents/Resources/.DS_Store' && row.type === 'file'));
  f.record.application.inventory = records.digest(application);
  f.writeJson(path.join(f.build, 'application-inventory.json'), application);
  f.writeJson(path.join(f.build, 'build.json'), f.record);
  const result = f.install(), manifest = JSON.parse(fs.readFileSync(result.inventoryPath));
  const installedNames = ['candidate/Reverie Scene.app/Contents/Resources/.DS_Store',
    `.tools/python/${path.basename(f.base)}/.DS_Store`,
    `.tools/python/${path.basename(f.base)}/lib/python3.12/.DS_Store`,
    '.venv/.DS_Store', '.venv/lib/python3.12/site-packages/.DS_Store'];
  for (const name of installedNames) assert.equal(fs.lstatSync(path.join(f.destination, name), { throwIfNoEntry: false }), undefined);
  assert.ok(!manifest.entries.some(row => path.posix.basename(row.path) === '.DS_Store'));
  assert.ok(!manifest.copiedSources.some(row => path.posix.basename(row.path) === '.DS_Store'));
  for (const name of relativeNames) assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), 'source Finder display bytes\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination, 'candidate/application-inventory.json'))), application);
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
});

test('installation preserves a directory named .DS_Store and all ordinary files inside it', t => {
  const f = fixture(t);
  f.put('.venv/.DS_Store/ordinary.py', '# ordinary nested source\n');
  const result = f.install(), manifest = JSON.parse(fs.readFileSync(result.inventoryPath));
  assert.ok(fs.lstatSync(path.join(f.destination, '.venv/.DS_Store')).isDirectory());
  assert.equal(fs.readFileSync(path.join(f.destination, '.venv/.DS_Store/ordinary.py'), 'utf8'), '# ordinary nested source\n');
  assert.ok(manifest.entries.some(row => row.path === '.venv/.DS_Store' && row.type === 'directory'));
  assert.ok(manifest.copiedSources.some(row => row.path === '.venv/.DS_Store/ordinary.py'));
  fs.appendFileSync(path.join(f.destination, '.venv/.DS_Store/ordinary.py'), '# changed\n');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
});

test('installation preserves and verifies a symbolic link named .DS_Store', t => {
  const f = fixture(t); fs.symlinkSync('pyvenv.cfg', path.join(f.root, '.venv/.DS_Store'));
  const result = f.install(), manifest = JSON.parse(fs.readFileSync(result.inventoryPath));
  assert.ok(fs.lstatSync(path.join(f.destination, '.venv/.DS_Store')).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(f.destination, '.venv/.DS_Store')), 'pyvenv.cfg');
  assert.ok(manifest.entries.some(row => row.path === '.venv/.DS_Store' && row.type === 'link' && row.target === 'pyvenv.cfg'));
  assert.ok(manifest.copiedSources.some(row => row.path === '.venv/.DS_Store' && row.target === 'pyvenv.cfg'));
  fs.unlinkSync(path.join(f.destination, '.venv/.DS_Store'));
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
});

test('historical runtime source display rows retain their raw catalog digest but are not installed', t => {
  const f = fixture(t), source = addFixtureSourceDisplayRow(f);
  const sourceBytes = fs.readFileSync(path.join(f.build, 'source-inventory.json'));
  const buildBytes = fs.readFileSync(path.join(f.build, 'build.json'));
  const result = f.install(), manifest = JSON.parse(fs.readFileSync(result.inventoryPath));
  assert.equal(fs.lstatSync(path.join(f.destination, 'src/.DS_Store'), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(manifest.sourceRuntimeInputs, records.digest(records.runtimeInputs(source)));
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'candidate/source-inventory.json')), sourceBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'candidate/build.json')), buildBytes);
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
});

test('display-file exclusion cannot authenticate a changed raw source catalog', t => {
  const f = fixture(t); addFixtureSourceDisplayRow(f); f.install();
  const sourceFile = path.join(f.destination, 'candidate/source-inventory.json');
  const source = JSON.parse(fs.readFileSync(sourceFile));
  source.find(row => row.path === 'src/.DS_Store').sha256 = '0'.repeat(64);
  f.writeJson(sourceFile, source);
  resealFixtureMetadata(f, (_metadata, manifest) => {
    const row = manifest.entries.find(entry => entry.path === 'candidate/source-inventory.json');
    row.bytes = fs.lstatSync(sourceFile).size; row.sha256 = records.fileHash(sourceFile);
  });
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /Source inventory changed/);
});

test('ignored Finder display changes do not hide application QML changes', t => {
  const f = fixture(t); f.install();
  const resources = path.join(f.destination, 'candidate/Reverie Scene.app/Contents/Resources');
  fs.writeFileSync(path.join(resources, '.DS_Store'), 'new Finder display bytes\n', { mode: 0o600 });
  assert.equal(f.runtime.verifyRuntime(f.destination).candidate, 'preview-fixture');
  fs.appendFileSync(path.join(resources, 'main.qml'), '// changed production QML\n');
  assert.throws(() => f.runtime.verifyRuntime(f.destination), /PREVIEW_RUNTIME_FILES_CHANGED/);
});

test('candidate application verifiers reject a historical display file replaced by an empty directory', t => {
  const f = fixture(t);
  const file = f.put('.tools/qt-candidates/preview-fixture/Reverie Scene.app/Contents/Resources/.DS_Store', 'historical display bytes\n');
  const application = records.directoryInventory(f.app);
  f.record.application.inventory = records.digest(application);
  f.writeJson(path.join(f.build, 'application-inventory.json'), application);
  f.writeJson(path.join(f.build, 'build.json'), f.record);
  assert.equal(f.install().candidate, 'preview-fixture');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => records.verifyBuild(f.root, f.build), /Application changed/);
  assert.throws(() => records.verifyRecordedBuild(f.build), /Application changed/);
});
