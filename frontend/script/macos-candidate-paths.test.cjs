'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { inspectTree } = require('./production-runtime-macos.cjs');
const { parseBuildOptions, resolveBuildPaths, reserveCandidateOutput, copyVerifiedRuntime } = require('./macos-candidate-paths.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-candidate-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { projectRoot: path.join(root, 'project'), home: path.join(root, 'home') };
  const baseline = resolveBuildPaths(options), candidate = resolveBuildPaths({ ...options, candidateName: 'worldbook-stage-two' });
  return { root, options, baseline, candidate };
}

test('default layout remains compatible; named app, reports and staging are separated while runtime source remains fixed', t => {
  const f = fixture(t);
  assert.equal(f.baseline.output, path.join(f.options.projectRoot, 'frontend', 'release-macos'));
  assert.equal(f.baseline.appPath, path.join(f.baseline.buildRoot, 'mac-arm64', 'Reverie macOS Test.app'));
  assert.equal(f.candidate.buildRoot, path.join(f.baseline.buildRoot, 'candidates', 'worldbook-stage-two'));
  assert.equal(f.candidate.output, path.join(f.baseline.output, 'candidates', 'worldbook-stage-two'));
  assert.equal(f.candidate.reusableRuntime, path.join(f.baseline.resources, 'python'));
  for (const key of ['appPath', 'appStage', 'resources', 'output']) assert.notEqual(f.candidate[key], f.baseline[key]);
  assert.deepEqual(parseBuildOptions(['--candidate', 'worldbook-stage-two', '--reuse-runtime']),
    { candidateName: 'worldbook-stage-two', reuseRuntime: true });
  assert.deepEqual(parseBuildOptions(['--reuse-runtime', '--candidate', 'worldbook-stage-two']),
    { candidateName: 'worldbook-stage-two', reuseRuntime: true });
  assert.deepEqual(parseBuildOptions([]), { candidateName: null, reuseRuntime: false });
});

test('invalid names, incomplete options and duplicate flags fail before touching any output', t => {
  const f = fixture(t);
  for (const value of ['../escape', '/tmp/destination', 'a/b', 'a\\b', '', 'UPPER', '.', 'con', '-start', 'a'.repeat(65)]) {
    assert.throws(() => resolveBuildPaths({ ...f.options, candidateName: value }), /Candidate name/);
  }
  for (const args of [['--candidate'], ['--candidate', '--reuse-runtime'], ['--candidate', 'one', '--candidate', 'two'],
    ['--reuse-runtime', '--reuse-runtime'], ['--unrecognized']]) assert.throws(() => parseBuildOptions(args));
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('exclusive candidate reservation preserves baseline app, runtime, reports and existing success pointer', t => {
  const f = fixture(t);
  for (const name of [f.baseline.appPath, f.baseline.resources, f.baseline.output]) fs.mkdirSync(name, { recursive: true });
  const sentinels = [path.join(f.baseline.appPath, 'original-app'), path.join(f.baseline.resources, 'original-runtime'),
    path.join(f.baseline.output, 'macos-build.json'), path.join(f.options.projectRoot, 'frontend', '.package-smoke-macos', 'latest-package.json')];
  for (const name of sentinels) { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, 'preserve'); }
  reserveCandidateOutput(f.candidate);
  assert.deepEqual(fs.readdirSync(f.candidate.buildRoot), []);
  assert.deepEqual(fs.readdirSync(f.candidate.output), []);
  for (const name of sentinels) assert.equal(fs.readFileSync(name, 'utf8'), 'preserve');
  assert.throws(() => reserveCandidateOutput(f.candidate), /Candidate output conflict/);
});

for (const side of ['buildRoot', 'output']) test(`existing ${side} is refused without creating the other candidate destination`, t => {
  const f = fixture(t), other = side === 'buildRoot' ? 'output' : 'buildRoot';
  fs.mkdirSync(f.candidate[side], { recursive: true });
  fs.writeFileSync(path.join(f.candidate[side], 'unknown'), 'do not overwrite');
  assert.throws(() => reserveCandidateOutput(f.candidate), /Candidate output conflict/);
  assert.equal(fs.existsSync(f.candidate[other]), false);
  assert.equal(fs.readFileSync(path.join(f.candidate[side], 'unknown'), 'utf8'), 'do not overwrite');
});

test('a symlinked candidate ancestor and a dangling destination are rejected without following them',
  { skip: process.platform === 'win32' }, t => {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.mkdirSync(f.baseline.buildRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(f.baseline.buildRoot, 'candidates'));
    assert.throws(() => reserveCandidateOutput(f.candidate), /redirected/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(f.baseline.buildRoot, 'candidates')); fs.mkdirSync(path.dirname(f.candidate.buildRoot));
    fs.symlinkSync(path.join(f.root, 'missing'), f.candidate.buildRoot);
    assert.throws(() => reserveCandidateOutput(f.candidate), /Candidate output conflict/);
    assert.equal(fs.existsSync(f.candidate.output), false);
  });


function runtimeFixture(t) {
  const f = fixture(t), source = path.join(f.root, 'source-python'), destination = path.join(f.root, 'candidate-python');
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'bin'));
  fs.writeFileSync(path.join(source, 'bin', 'python'), 'synthetic runtime executable');
  fs.writeFileSync(path.join(source, 'module.py'), '# synthetic module\n');
  const manifestName = 'runtime-manifest.json', expectedFiles = inspectTree(source);
  const bytes = JSON.stringify({ files: expectedFiles }); fs.writeFileSync(path.join(source, manifestName), bytes);
  return { source, destination, manifestName, expectedFiles, inspectTree,
    expectedManifestSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('candidate runtime copy verifies every file and original manifest without modifying the baseline', t => {
  const options = runtimeFixture(t), before = inspectTree(options.source);
  assert.equal(copyVerifiedRuntime(options), options.destination);
  assert.deepEqual(inspectTree(options.source), before);
  assert.deepEqual(inspectTree(options.destination), before);
});

test('runtime copy rejects corruption, source changes and existing output instead of silently rebuilding', t => {
  const options = runtimeFixture(t);
  assert.throws(() => copyVerifiedRuntime(options, (source, destination, config) => {
    fs.cpSync(source, destination, config);
    fs.writeFileSync(path.join(destination, 'module.py'), 'corrupt');
  }), /inventory differs/);
  assert.throws(() => copyVerifiedRuntime(options), /output conflict/);
  fs.rmSync(options.destination, { recursive: true });
  fs.writeFileSync(path.join(options.source, 'module.py'), 'changed source');
  assert.throws(() => copyVerifiedRuntime(options), /source changed before copy/);
  assert.equal(fs.existsSync(options.destination), false);
});


test('verified runtime copying preserves a real 0666 lock under a restrictive umask without changing the original',
  { skip: process.platform === 'win32' ? 'POSIX permission mode contract' : false }, t => {
    const options = runtimeFixture(t), lock = path.join(options.source, '.lock');
    fs.writeFileSync(lock, ''); fs.chmodSync(lock, 0o666);
    fs.chmodSync(path.join(options.source, 'bin', 'python'), 0o755);
    options.expectedFiles = inspectTree(options.source).filter(item => item.path !== options.manifestName);
    const bytes = JSON.stringify({ files: options.expectedFiles });
    fs.writeFileSync(path.join(options.source, options.manifestName), bytes);
    options.expectedManifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const before = inspectTree(options.source), previousMask = process.umask(0o077);
    try { copyVerifiedRuntime(options); }
    finally { process.umask(previousMask); }
    assert.equal(fs.statSync(path.join(options.destination, '.lock')).mode & 0o777, 0o666);
    assert.equal(fs.statSync(path.join(options.destination, 'bin', 'python')).mode & 0o777, 0o755);
    assert.deepEqual(inspectTree(options.destination), before);
    assert.deepEqual(inspectTree(options.source), before);
    assert.equal(fs.statSync(lock).mode & 0o777, 0o666);
  });
