'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { parseBuildArguments, buildDirectory, buildDiagnosticRecord, validateCMakeDirectory } = require('./build-qt-macos.cjs');
const root = path.resolve(__dirname, '..');
const builder = fs.readFileSync(path.join(__dirname, 'build-qt-macos.cjs'), 'utf8');
// Exercise the exact production build argv without invoking its repository
// build, signing or candidate publication. The fixture below uses real macOS
// CMake/Make and compiles only a disposable command-line marker executable.
const expression = builder.match(/^\s*const buildArguments = (.+);$/m)?.[1];
assert(expression, 'Production CMake build arguments must be directly reviewable');
const buildArguments = (build, candidate) => [...vm.runInNewContext(expression, { build, candidate })];
test('timing build options require a unique named candidate and closed flags', () => {
  assert.deepEqual(parseBuildArguments([]), { core: '', candidate: '', profiler: false, timing: false });
  const timing = parseBuildArguments(['--local-sdk', '/licensed/sdk', '--candidate', 'timing-probe', '--timing-diagnostics']);
  assert.equal(timing.timing, true); assert.equal(timing.profiler, false);
  assert.equal(parseBuildArguments(['--candidate', 'timing-profiler', '--timing-diagnostics', '--profile-diagnostics']).profiler, true);
  for (const args of [['--timing-diagnostics'], ['--candidate', 'probe', '--timing-diagnostics', '--timing-diagnostics'],
    ['--candidate', 'probe', '--profile-diagnostics', '--profile-diagnostics'], ['--candidate', 'probe', '--unknown']])
    assert.throws(() => parseBuildArguments(args));
});
test('timing build directories and manifests keep diagnostics out of ordinary launchers', () => {
  const builds = [];
  for (const core of ['', '/licensed/sdk']) for (const profiler of [false, true]) for (const timing of [false, true]) {
    const options = { core, profiler, timing }; builds.push(buildDirectory(options));
    assert.deepEqual(buildDiagnosticRecord(options), { qmlProfilerEnabled: profiler, timingProbesEnabled: timing, ordinaryLauncherAllowed: !(profiler || timing) });
  }
  assert.equal(new Set(builds).size, 8);
  assert(buildDirectory({ core: true, profiler: false, timing: true }).endsWith('/.tools/qt-build-timing-diagnostic'));
  assert(builder.includes('-DREVERIE_TIMING_DIAGNOSTICS=${timing ?'));
});
test('relocated builds use an explicit fresh cache without rewriting migrated caches', () => {
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-relocated-cmake-'));
  try {
    const cache = path.join(project, '.tools/qt-builds/new cache');
    const options = parseBuildArguments(['--candidate', 'relocated', '--cmake-dir', cache]);
    assert.equal(buildDirectory(options), cache);
    assert.equal(validateCMakeDirectory(cache, project), cache);
    fs.mkdirSync(cache, { recursive: true });
    assert.equal(validateCMakeDirectory(cache, project), cache);
    fs.writeFileSync(path.join(cache, 'CMakeCache.txt'), 'preserve old absolute paths');
    assert.throws(() => validateCMakeDirectory(cache, project), /not empty/);
    assert.equal(fs.readFileSync(path.join(cache, 'CMakeCache.txt'), 'utf8'), 'preserve old absolute paths');
    const alias = path.join(project, '.tools/qt-builds/alias');
    fs.symlinkSync(cache, alias);
    assert.throws(() => validateCMakeDirectory(alias, project), /real directories/);
    assert.throws(() => validateCMakeDirectory(path.join(alias, 'child'), project), /real directories/);
    for (const p of [project, path.dirname(cache), '/tmp/outside', path.join(project, '.tools/qt-candidates/current')])
      assert.throws(() => validateCMakeDirectory(p, project), /fresh children/);
    for (const args of [['--cmake-dir', cache], ['--candidate', 'fresh', '--cmake-dir', 'relative'],
      ['--candidate', 'fresh', '--cmake-dir', cache, '--cmake-dir', cache]]) assert.throws(() => parseBuildArguments(args));
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
test('named candidate policy requests clean-first while ordinary working builds retain incremental behavior', () => {
  assert.deepEqual(buildArguments('/isolated/build', 'fresh-candidate'), ['--build', '/isolated/build', '--clean-first', '--parallel', '6']);
  assert.deepEqual(buildArguments('/isolated/build', ''), ['--build', '/isolated/build', '--parallel', '6']);
  assert(builder.includes('postBuildInventoryVerified:true'));
  assert(builder.includes('digest(postBuildInputs).sha256 !== digest(inputs).sha256'));
});
test('actual macOS Make same-second stale compile is eliminated by the named candidate build policy', { skip: process.platform !== 'darwin' }, t => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-make-mtime-'));
  try {
    const source = path.join(fixture, 'source'), build = path.join(fixture, 'build');
    fs.mkdirSync(source);
    const input = path.join(source, 'identity.cpp'), binary = path.join(build, 'identity');
    const priorCandidate = path.join(fixture, 'prior-candidate-marker'); fs.writeFileSync(priorCandidate, 'preserve existing candidate');
    fs.writeFileSync(path.join(source, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(Identity NONE)\nadd_custom_command(OUTPUT "${CMAKE_BINARY_DIR}/identity" COMMAND /usr/bin/clang++ "${CMAKE_SOURCE_DIR}/identity.cpp" -o "${CMAKE_BINARY_DIR}/identity" DEPENDS "${CMAKE_SOURCE_DIR}/identity.cpp" VERBATIM)\nadd_custom_target(marker ALL DEPENDS "${CMAKE_BINARY_DIR}/identity")\n');
    const oldSource = '#include <cstdio>\nint main(){std::puts("old-source");}\n';
    const newSource = '#include <cstdio>\nint main(){std::puts("new-source");}\n';
    fs.writeFileSync(input, oldSource);
    const cmake = execFileSync('/usr/bin/which', ['cmake'], { encoding: 'utf8' }).trim();
    const makeVersion = execFileSync('/usr/bin/make', ['--version'], { encoding: 'utf8' }).split('\n')[0];
    execFileSync(cmake, ['-S', source, '-B', build, '-G', 'Unix Makefiles', '-DCMAKE_MAKE_PROGRAM=/usr/bin/make'], { stdio: 'pipe' });
    execFileSync(cmake, buildArguments(build, ''), { stdio: 'pipe' });
    assert.equal(execFileSync(binary, [], { encoding: 'utf8' }).trim(), 'old-source');
    fs.writeFileSync(input, newSource);
    const second = BigInt(Math.floor(Date.now() / 1000) - 2) * 1_000_000_000n;
    const python = path.join(root, '.venv/bin/python');
    execFileSync(python, ['-I', '-c', 'import os,sys; obj,src=sys.argv[1:3]; second=int(sys.argv[3]); os.utime(obj,ns=(second+100000000,second+100000000)); os.utime(src,ns=(second+900000000,second+900000000))', binary, input, String(second)]);
    const inputTime = fs.statSync(input, { bigint: true }).mtimeNs, binaryTime = fs.statSync(binary, { bigint: true }).mtimeNs;
    assert(inputTime > binaryTime); assert.equal(inputTime / 1_000_000_000n, binaryTime / 1_000_000_000n);
    execFileSync(cmake, buildArguments(build, ''), { stdio: 'pipe' });
    assert.equal(execFileSync(binary, [], { encoding: 'utf8' }).trim(), 'old-source', 'Expected the known same-second Make stale-target reproduction');
    execFileSync(cmake, buildArguments(build, 'fresh-candidate'), { stdio: 'pipe' });
    assert.equal(execFileSync(binary, [], { encoding: 'utf8' }).trim(), 'new-source');
    assert.equal(fs.readFileSync(input, 'utf8'), newSource); assert.equal(fs.readFileSync(priorCandidate, 'utf8'), 'preserve existing candidate');
    t.diagnostic(JSON.stringify({ makeVersion, inputMtimeNs: String(inputTime), oldBinaryMtimeNs: String(binaryTime), sameWholeSecond: true,
      incrementalCompiledMarker: 'old-source', namedCandidateCleanCompiledMarker: 'new-source', sourceAndPriorCandidatePreserved: true }));
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('local package build options use a fixed incremental directory and reject publication conflicts', () => {
  const local = parseBuildArguments(['--local-sdk', '/licensed/sdk', '--local-package', 'process-iteration-20261027']);
  assert.deepEqual(local, { core: '/licensed/sdk', candidate: '', profiler: false, timing: false,
    localPackage: 'process-iteration-20261027' });
  assert.equal(buildDirectory(local), path.join(root, '.tools/qt-builds/local-process-iteration-20261027'));
  assert.deepEqual(buildArguments(buildDirectory(local), local.candidate),
    ['--build', buildDirectory(local), '--parallel', '6']);
  for (const suffix of [['--candidate', 'new-candidate'], ['--cmake-dir', '/tmp/explicit'],
    ['--profile-diagnostics'], ['--timing-diagnostics'], ['--local-package', 'second-package']]) {
    assert.throws(() => parseBuildArguments(['--local-package', 'first-package', ...suffix]));
    assert.throws(() => parseBuildArguments([...suffix, '--local-package', 'first-package']));
  }
  for (const name of ['', '.', '..', '../candidate', 'a/../../candidate', '/absolute', 'Uppercase',
    'with space', 'bad_name', 'a'.repeat(65)])
    assert.throws(() => parseBuildArguments(['--local-package', name]));
});

test('local package directories retain incremental outputs and reject aliases into candidates or pointers', t => {
  const { localBuildDirectory, validateLocalBuildDirectory } = require('./build-qt-macos.cjs');
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-local-directory-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const build = localBuildDirectory('incremental-package', project);
  assert.equal(validateLocalBuildDirectory('incremental-package', project), build);
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'retained incremental cache');
  assert.equal(validateLocalBuildDirectory('incremental-package', project), build);
  assert.equal(fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'), 'retained incremental cache');
  for (const name of ['../escape', '/absolute', 'nested/name'])
    assert.throws(() => localBuildDirectory(name, project), /package name/);
  const candidate = path.join(project, '.tools/qt-candidates/keep');
  fs.mkdirSync(candidate, { recursive: true });
  fs.symlinkSync(candidate, localBuildDirectory('candidate-alias', project));
  assert.throws(() => validateLocalBuildDirectory('candidate-alias', project), /real directories/);
  const pointer = path.join(project, '.tools/qt-candidates/last-local-sdk.json');
  fs.writeFileSync(pointer, 'pointer original bytes\n');
  for (const name of ['Reverie Scene.app', 'build.json', 'source-inventory.json', 'application-inventory.json']) {
    const alias = path.join(build, name);
    fs.symlinkSync(name.endsWith('.app') ? candidate : pointer, alias);
    assert.throws(() => validateLocalBuildDirectory('incremental-package', project), /must not alias/);
    fs.unlinkSync(alias);
  }
  fs.linkSync(pointer, path.join(build, 'build.json'));
  assert.throws(() => validateLocalBuildDirectory('incremental-package', project), /must not alias/);
  fs.unlinkSync(path.join(build, 'build.json'));
  assert.equal(fs.readFileSync(pointer, 'utf8'), 'pointer original bytes\n');
  fs.rmSync(build, { recursive: true });
  fs.rmSync(localBuildDirectory('candidate-alias', project));
  fs.renameSync(path.join(project, '.tools/qt-builds'), path.join(project, '.tools/qt-builds-saved'));
  fs.symlinkSync(candidate, path.join(project, '.tools/qt-builds'));
  assert.throws(() => validateLocalBuildDirectory('incremental-package', project), /real directories/);
});

// Execute main with a disposable filesystem and inert command adapter. No Qt,
// compiler, codesign, process, or repository output is executed by this fixture.
function runLocalBuilderFixture(t, { failBuild = false } = {}) {
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-local-builder-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const local = path.join(project, '.tools/qt-builds/local-process-iteration-20261027');
  const candidates = path.join(project, '.tools/qt-candidates');
  const pointers = ['last-local-sdk.json', 'last-corefree.json', 'last-diagnostic.json',
    'last-timing-diagnostic.json', 'last-timing-profiler-diagnostic.json'];
  fs.mkdirSync(path.join(candidates, 'existing-candidate'), { recursive: true });
  for (const name of pointers) fs.writeFileSync(path.join(candidates, name), `preserve ${name}\n`);
  fs.writeFileSync(path.join(candidates, 'existing-candidate/keep'), 'existing candidate');
  fs.mkdirSync(path.join(project, '.venv/bin'), { recursive: true });
  fs.writeFileSync(path.join(project, '.venv/bin/python'), 'inert python');
  const calls = [], writes = [];
  const guardedFs = { ...fs };
  for (const method of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'copyFileSync', 'renameSync']) {
    guardedFs[method] = (...args) => {
      const paths = args.slice(0, method === 'copyFileSync' || method === 'renameSync' ? 2 : 1);
      for (const file of paths) {
        assert(!String(file).startsWith(candidates + path.sep) && String(file) !== candidates,
          `${method} must never write candidate or pointer paths in local mode`);
        writes.push({ method, path: file });
      }
      return fs[method](...args);
    };
  }
  const command = (executable, argv) => {
    calls.push({ executable, argv });
    if (executable.endsWith('/bin/qtpaths')) return '6.fixture\n';
    if (executable.endsWith('/.venv/bin/python')) return JSON.stringify({ version: '3.12.14',
      architecture: 'arm64', executable, prefix: path.join(project, '.venv'), basePrefix: '/inert/base' });
    if (executable === '/usr/bin/which') return '/inert/cmake\n';
    if (executable === '/inert/cmake' && argv[0] === '-S') {
      fs.mkdirSync(path.join(local, 'CMakeFiles/ReverieScene.dir'), { recursive: true });
      fs.writeFileSync(path.join(local, 'CMakeFiles/ReverieScene.dir/flags.make'), 'fixture flags');
      fs.mkdirSync(path.join(local, 'Reverie Scene.app/Contents/MacOS'), { recursive: true });
      fs.writeFileSync(path.join(local, 'Reverie Scene.app/Contents/MacOS/Reverie Scene'), 'inert app');
      return '';
    }
    if (executable === '/inert/cmake' && argv[0] === '--build') {
      if (failBuild) throw Error('inert build failure');
      return '';
    }
    if (executable === '/usr/bin/codesign') return '';
    if (executable === '/usr/bin/otool') return 'Reverie Scene:\n';
    if (executable === '/usr/bin/lipo') return 'arm64\n';
    if (executable === 'git' && argv[0] === 'rev-parse') return 'f'.repeat(40) + '\n';
    if (executable === 'git' && argv[0] === 'status') return '';
    throw Error(`Unexpected fixture command: ${executable}`);
  };
  const exported = { exports: {} };
  const fakeRequire = name => {
    if (name === 'node:fs') return guardedFs;
    if (name === 'node:path') return path;
    if (name === 'node:child_process') return { execFileSync: command };
    if (name === '../native-ui/build-record.cjs') return { fileHash: () => 'f'.repeat(64),
      digest: rows => ({ sha256: 'f'.repeat(64), count: rows.length }), directoryInventory: () => [],
      sourceInventory: () => [], runtimeInputs: rows => rows };
    if (name === '../config/qt-macos-toolchain.json') return { qtVersion: '6.fixture', qtBuild: 'fixture',
      localNativeSdk: { arm64CoreSha256: 'f'.repeat(64) }, sdkArchives: [] };
    throw Error(`Unexpected fixture import: ${name}`);
  };
  vm.runInNewContext(builder, { require: fakeRequire, module: exported, __dirname: path.join(project, 'script'),
    __filename: path.join(project, 'script/build-qt-macos.cjs'), Buffer,
    process: { platform: 'darwin', arch: 'arm64', execPath: '/inert/node', version: 'fixture' },
    console: { log() {} } });
  const run = () => exported.exports.main(['--local-sdk', '/inert/sdk', '--local-package', 'process-iteration-20261027']);
  return { project, local, candidates, pointers, writes, calls, run };
}

test('local package main preserves every pointer and candidate and produces a check-compatible nonacceptance manifest', t => {
  const f = runLocalBuilderFixture(t);
  f.run();
  const record = JSON.parse(fs.readFileSync(path.join(f.local, 'build.json'), 'utf8'));
  assert.equal(record.schema, 'reverie.qt.local-build.v2');
  assert.equal(record.candidate, null);
  assert.deepEqual(record.localIteration, { package: 'process-iteration-20261027', acceptanceEligible: false,
    publishesCandidate: false, writesPointers: false });
  assert.equal(record.compilation.cmakeDirectory, f.local);
  assert.equal(record.compilation.cleanCompilationPolicy.mode, 'incremental-local-package');
  assert.equal(record.compilation.cleanCompilationPolicy.cleanFirst, false);
  assert.equal(record.diagnostics.ordinaryLauncherAllowed, true);
  assert.equal(record.application.relativePath, 'Reverie Scene.app');
  assert.equal(record.application.strictSignatureVerified, true);
  assert.equal(record.source.postBuildInventoryVerified, true);
  assert.match(record.scope, /not acceptance evidence/);
  assert(f.calls.some(call => call.executable === '/inert/cmake' && call.argv[0] === '--build'));
  assert(!f.calls.some(call => call.argv.includes('--clean-first') || call.executable === '/usr/bin/ditto'));
  assert.deepEqual(fs.readdirSync(f.candidates).sort(), ['existing-candidate', ...f.pointers].sort());
  for (const name of f.pointers) assert.equal(fs.readFileSync(path.join(f.candidates, name), 'utf8'), `preserve ${name}\n`);
  assert.equal(fs.readFileSync(path.join(f.candidates, 'existing-candidate/keep'), 'utf8'), 'existing candidate');
  assert(f.writes.every(write => String(write.path).startsWith(f.local + path.sep)));
});

test('local package failed main performs no pointer publication or candidate staging', t => {
  const f = runLocalBuilderFixture(t, { failBuild: true });
  assert.throws(f.run, /inert build failure/);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.local, 'build.json')), false);
  assert.deepEqual(fs.readdirSync(f.candidates).sort(), ['existing-candidate', ...f.pointers].sort());
  for (const name of f.pointers) assert.equal(fs.readFileSync(path.join(f.candidates, name), 'utf8'), `preserve ${name}\n`);
});
