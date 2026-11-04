'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const recordTools = require('../native-ui/build-record.cjs');
const { fileHash, digest, directoryInventory, sourceInventory, runtimeInputs } = recordTools;
const root = path.resolve(__dirname, '..');
const manifest = require('../config/qt-macos-toolchain.json');
function parseBuildArguments(args) {
  let core = '', candidate = '', profiler = false, timing = false, cmakeDir = '', localPackage = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--local-sdk' && path.isAbsolute(args[i + 1] || '') && !core) core = args[++i];
    else if (args[i] === '--candidate' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(args[i + 1] || '') && !candidate) candidate = args[++i];
    else if (args[i] === '--profile-diagnostics' && !profiler) profiler = true;
    else if (args[i] === '--timing-diagnostics' && !timing) timing = true;
    else if (args[i] === '--cmake-dir' && path.isAbsolute(args[i + 1] || '') && !cmakeDir) cmakeDir = path.resolve(args[++i]);
    else if (args[i] === '--local-package' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(args[i + 1] || '') && !localPackage) localPackage = args[++i];
    else throw Error('Usage: build-qt-macos.sh [--local-sdk ABS_OFFICIAL_NATIVE_SDK] [--candidate UNIQUE_NAME] [--profile-diagnostics] [--timing-diagnostics] [--cmake-dir ABS_PATH] [--local-package PACKAGE_NAME]');
  }
  if (localPackage && (candidate || cmakeDir || profiler || timing))
    throw Error('Local iteration --local-package cannot use candidates, explicit CMake directories or diagnostic modes');
  if (timing && !candidate) throw Error('Timing diagnostics require a fresh named --candidate');
  if (cmakeDir && !candidate) throw Error('An explicit CMake directory requires a fresh named --candidate');
  return { core, candidate, profiler, timing, ...(cmakeDir ? { cmakeDir } : {}), ...(localPackage ? { localPackage } : {}) };
}
function validateCMakeDirectory(directory, projectRoot = root) {
  const parent = path.join(projectRoot, '.tools/qt-builds');
  const relative = path.relative(parent, directory);
  if (!path.isAbsolute(directory) || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Explicit CMake directories must be fresh children of project .tools/qt-builds');
  for (let current = directory; current !== projectRoot; current = path.dirname(current)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error('CMake directory components must be real directories');
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length)
    throw Error('Explicit CMake directory is not empty; preserve it and choose a fresh directory');
  return directory;
}
function localBuildDirectory(localPackage, projectRoot = root) {
  if (typeof localPackage !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(localPackage))
    throw Error('Local iteration package must be a closed lowercase package name');
  return path.join(projectRoot, '.tools/qt-builds', `local-${localPackage}`);
}
function validateLocalBuildDirectory(localPackage, projectRoot = root) {
  const directory = localBuildDirectory(localPackage, projectRoot);
  for (let current = directory; current !== projectRoot; current = path.dirname(current)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw Error('Local CMake directory components must be real directories');
  }
  // These are the paths written directly by this builder. Do not follow a
  // stale output alias into any candidate or pointer, even in incremental mode.
  for (const name of ['Reverie Scene.app', 'source-inventory.json', 'application-inventory.json', 'build.json']) {
    const info = fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false });
    if (info?.isSymbolicLink() || (info && (name.endsWith('.app') ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)))
      throw Error('Local build outputs must not alias other files or directories');
  }
  return directory;
}
function buildDirectory({ core, profiler, timing, cmakeDir, localPackage }) {
  if (localPackage) return localBuildDirectory(localPackage);
  if (cmakeDir) return cmakeDir;
  const suffix = timing ? (profiler ? '-timing-profiler-diagnostic' : '-timing-diagnostic') : profiler ? '-diagnostic' : '';
  return path.join(root, `.tools/qt-build${core ? '' : '-corefree'}${suffix}`);
}
function buildDiagnosticRecord({ profiler, timing }) {
  return { qmlProfilerEnabled: profiler, timingProbesEnabled: timing, ordinaryLauncherAllowed: !(profiler || timing) };
}
function main(args = process.argv.slice(2)) {
  const { core, candidate, profiler, timing, cmakeDir, localPackage } = parseBuildArguments(args);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('macOS arm64 required');
  if (cmakeDir) validateCMakeDirectory(cmakeDir);
  if (localPackage) validateLocalBuildDirectory(localPackage);
  const build = buildDirectory({ core, profiler, timing, cmakeDir, localPackage });
  const candidates = path.join(root, '.tools/qt-candidates');
  const output = candidate ? path.join(candidates, candidate) : build;
  if (candidate && fs.existsSync(output)) throw Error('Candidate already exists; choose a new name');
  const coreFile = core && path.join(core, 'Core/lib/macos/arm64/libLive2DCubismCore.a');
  if (core && fileHash(coreFile) !== manifest.localNativeSdk.arm64CoreSha256) throw Error('Native Core differs from fixed SDK');
  const qt = path.join(root, '.tools/qt-sdk');
  const qtVersion = execFileSync(path.join(qt, 'bin/qtpaths'), ['--qt-version'], { encoding: 'utf8' }).trim();
  if (qtVersion !== manifest.qtVersion) throw Error('Qt SDK version differs');
  for (const a of manifest.sdkArchives) {
    if (fileHash(path.join(root, '.tools/qt-downloads', a.filename)) !== a.sha256) throw Error('Qt archive checksum mismatch');
  }
  const python = path.join(root, '.venv/bin/python');
  const pythonInfo = JSON.parse(execFileSync(python, ['-I', '-c', 'import sys,platform,json; print(json.dumps({"version":platform.python_version(),"architecture":platform.machine(),"executable":sys.executable,"prefix":sys.prefix,"basePrefix":sys.base_prefix}))'], { encoding: 'utf8' }));
  if (pythonInfo.version !== '3.12.14' || pythonInfo.architecture !== 'arm64' || pythonInfo.prefix !== path.join(root, '.venv') || pythonInfo.prefix === pythonInfo.basePrefix) throw Error('Fixed project development Python required');
  const cmake = execFileSync('/usr/bin/which', ['cmake'], { encoding: 'utf8' }).trim();
  const inputs = sourceInventory(root);
  execFileSync(cmake, ['-S', path.join(root, 'native-ui'), '-B', build, `-DCMAKE_PREFIX_PATH=${qt}`,
    `-DREVERIE_TRUST_CURRENT_HEAD=${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`,
    `-DREVERIE_TRUST_CURRENT_INPUTS=${digest(runtimeInputs(inputs)).sha256}`,
    `-DREVERIE_TRUST_CURRENT_PYTHON=${fileHash(fs.realpathSync(python))}`,
    `-DREVERIE_LOCAL_CUBISM=${core}`, `-DREVERIE_QML_PROFILER=${profiler ? 'ON' : 'OFF'}`,
    `-DREVERIE_TIMING_DIAGNOSTICS=${timing ? 'ON' : 'OFF'}`, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DCMAKE_BUILD_TYPE=RelWithDebInfo'], { stdio: 'inherit' });
  const buildArguments = ['--build', build, ...(candidate ? ['--clean-first'] : []), '--parallel', '6'];
  execFileSync(cmake, buildArguments, { stdio: 'inherit' });
  const postBuildInputs = sourceInventory(root);
  if (digest(postBuildInputs).sha256 !== digest(inputs).sha256) throw Error('Source changed during build; candidate not published');
  if (!localPackage) fs.mkdirSync(candidates, { recursive: true });
  if (localPackage) validateLocalBuildDirectory(localPackage);
  const staging = candidate ? fs.mkdtempSync(path.join(candidates, '.pending-')) : build;
  const app = path.join(staging, 'Reverie Scene.app');
  if (candidate) execFileSync('/usr/bin/ditto', [path.join(build, 'Reverie Scene.app'), app]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app]);
  const binary = path.join(app, 'Contents/MacOS/Reverie Scene');
  const links = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' });
  const externalPaths = links.split('\n').slice(1).map(s => s.trim().split(' (')[0])
    .map(p => p.startsWith('@rpath/') ? path.join(qt, 'lib', p.slice(7)) : p)
    .filter(p => p.startsWith(qt + '/') && fs.existsSync(p));
  externalPaths.push(fs.realpathSync(python), process.execPath);
  if (coreFile) externalPaths.push(coreFile);
  const files = directoryInventory(app);
  const record = {
    schema: 'reverie.qt.local-build.v2', candidate: localPackage ? null : candidate || 'working-build',
    previewWorkspaceContract: 'v1',
    supportedDataFormat: 1,
    workspaceControlContract: 'v1',
    ...(localPackage ? { localIteration: { package: localPackage, acceptanceEligible: false,
      publishesCandidate: false, writesPointers: false } } : {}),
    diagnostics: buildDiagnosticRecord({ profiler, timing }),
    compilation: {buildType:'RelWithDebInfo', cmakeDirectory:build,
      cleanCompilationPolicy: {mode:candidate ? 'clean-first-named-candidate' : localPackage ? 'incremental-local-package' : 'incremental-working-build',
        cleanFirst:Boolean(candidate), builderSha256:fileHash(__filename),
        reason:'Named candidates compile from clean targets; Make same-second source timestamps cannot retain stale compiled objects. Source/toolchain/prior candidates are not removed.'},
      flagsSha256:fileHash(path.join(build,'CMakeFiles/ReverieScene.dir/flags.make')),
      flags:fs.readFileSync(path.join(build,'CMakeFiles/ReverieScene.dir/flags.make'),'utf8')},
    source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
      inventory: digest(inputs), postBuildInventory: digest(postBuildInputs), postBuildInventoryVerified:true,
      runtimeInputs: digest(runtimeInputs(inputs)) },
    application: { relativePath: 'Reverie Scene.app', inventory: digest(files), executableSha256: fileHash(binary),
      architecture: execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim(),
      signature: 'ad-hoc-local-test', strictSignatureVerified: true },
    qt: { version: qtVersion, build: manifest.qtBuild }, python: pythonInfo, node: process.version,
    core: core ? manifest.localNativeSdk : null,
    externalFiles: [...new Set(externalPaths)].map(p => ({ path: p, sha256: fileHash(p) })),
    externalTrees: core ? [path.join(core, 'Framework')].map(p => ({ path: p, inventory: digest(directoryInventory(p)) })) : [],
    dynamicLibraries: links.split('\n').slice(1).filter(Boolean),
    scope: localPackage ? 'Local package iteration only; not acceptance evidence. No candidate or pointer publication. External Qt/Python/Node/SDK files required.' :
      'Project-local development candidate; external Qt/Python/Node/SDK files required. Not a standalone distribution.'
  };
  for (const [name, value] of [['source-inventory.json', inputs], ['application-inventory.json', files], ['build.json', record]]) fs.writeFileSync(path.join(staging, name), JSON.stringify(value, null, 2) + '\n');
  if (candidate) {
    for (const name of ['ArchiveEditorTest', 'AvatarTransformTest', 'RuntimeBridgeTest', 'SceneDirectorTest']) if (fs.existsSync(path.join(build, name))) fs.copyFileSync(path.join(build, name), path.join(staging, name));
    fs.renameSync(staging, output);
    const pointer = path.join(candidates, timing ? (profiler ? 'last-timing-profiler-diagnostic.json' : 'last-timing-diagnostic.json') : profiler ? 'last-diagnostic.json' : core ? 'last-local-sdk.json' : 'last-corefree.json');
    fs.writeFileSync(pointer + '.tmp', JSON.stringify({ directory: output, buildManifestSha256: fileHash(path.join(output, 'build.json')) }, null, 2) + '\n');
    fs.renameSync(pointer + '.tmp', pointer);
  }
  console.log(path.join(output, 'Reverie Scene.app'));
}
if (require.main === module) main();
module.exports = { parseBuildArguments, buildDirectory, buildDiagnosticRecord, validateCMakeDirectory,
  localBuildDirectory, validateLocalBuildDirectory, main };
