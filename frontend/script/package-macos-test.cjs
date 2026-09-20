'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { createSeedConfig } = require('./seed-config.cjs');
const { copyProductionPythonSource, OMITTED_SOURCE_MODULES } = require('./production-runtime.cjs');
const { assertLive2DReleaseGate } = require('../electron/live2d-release-gate.cjs');
const { prepareVendoredRuntime } = require('./prepare-vendored-runtime.cjs');
const { collectInstalledNpmLicenses } = require('./collect-installed-npm-licenses.cjs');
const { redact } = require('../electron/safe-log.cjs');
const { stageMacPythonRuntime, auditMacRuntime, inspectTree, parseRuntimeLock, MANIFEST_NAME } = require('./production-runtime-macos.cjs');
const { auditMacApp } = require('./macos-app-audit.cjs');

const frontend = path.resolve(__dirname, '..');
const root = path.resolve(frontend, '..');
const tools = path.join(root, '.tools');
const output = path.join(frontend, 'release-macos');
// Keep the delivered signed app outside File Provider-managed Documents trees.
// Reports remain beside the repository's other release artifacts.
const buildRoot = path.join(os.homedir(), 'Library', 'Developer', 'Reverie', 'LocalBuilds',
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 12));
const appStage = path.join(buildRoot, '.macos-installer-app');
const resources = path.join(buildRoot, '.macos-installer-resources');
const artifactRoot = path.join(buildRoot, 'mac-arm64');
const appPath = path.join(artifactRoot, 'Reverie macOS Test.app');
const manifest = require('../../config/macos-toolchain.json');
const startedAt = new Date().toISOString();
const timings = [];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (name) => {
  const before = fs.statSync(name);
  const bytes = fs.readFileSync(name);
  const after = fs.statSync(name);
  if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Incomplete or changing build input: ${name}. Materialize synced files before rebuilding.`);
  }
  return hash(bytes);
};
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter(([, value]) => value !== undefined));
    const child = spawn(command, args, { cwd: options.cwd || frontend, env, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) { resolve((stdout + (options.includeStderr ? stderr : '')).trim()); return; }
      const detail = (stderr.trim() || stdout.trim())
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,"'}]+/gi, '$1[REDACTED]');
      const safe = redact(detail).replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[LOCAL_PATH]');
      reject(new Error(`${path.basename(command)} failed (${code ?? signal}): ${safe.slice(-4000)}`));
    });
  });
}
async function phase(name, operation) {
  const start = Date.now(); console.log(`[macOS build] ${name}`);
  try { const value = await operation(); timings.push({ name, elapsedMs: Date.now() - start, passed: true }); return value; }
  catch (error) { timings.push({ name, elapsedMs: Date.now() - start, passed: false }); throw error; }
}
function copyTree(source, destination, filter = () => true) {
  const stat = fs.lstatSync(source);
  if (!filter(source, stat)) return;
  if (stat.isSymbolicLink()) throw new Error(`Source symlink is not allowed here: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), filter);
  } else if (stat.isFile()) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
}
function resetStage(directory) {
  if (![appStage, resources].includes(directory)) throw new Error('Unexpected staging destination');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Staging directory cannot be a symlink');
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true });
}
async function sourceCandidate() {
  const names = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.gitignore', '.github', '.env.example', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE', 'CREDITS.md', 'AGPL_EXCLUDED.md', 'LICENSES_CREDITS', 'pyproject.toml', '.python-version', 'requirements*', 'pytest.ini', 'conftest.py', 'charset_normalizer.py', 'msgpack.py', 'ormsgpack.py', 'soxr.py', 'config', 'docs', 'script', 'src', 'tests', 'frontend', ':!frontend/.visual-check', ':!frontend/.codex-preview.err.log', ':!frontend/.codex-preview.out.log', ':!frontend/dev-server.log', ':!frontend/dev-server.stderr.log', ':!frontend/dev-server.stdout.log'], { cwd: root, capture: true })).split('\0').filter(Boolean).sort();
  const files = [];
  for (const name of [...new Set(names)]) {
    const file = path.join(root, name);
    if (!inside(root, file) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    files.push({ path: name, sha256: fileHash(file), bytes: fs.statSync(file).size });
  }
  return { head: await run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true }), branch: await run('git', ['branch', '--show-current'], { cwd: root, capture: true }), dirty: Boolean(await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, capture: true })), sha256: hash(JSON.stringify(files)), files };
}
async function collectLicenses(python) {
  collectInstalledNpmLicenses(frontend, path.join(resources, 'THIRD_PARTY_LICENSES', 'npm'));
  await run(python, ['-I', '-B', path.join(__dirname, 'collect-python-licenses.py'), path.join(resources, 'THIRD_PARTY_LICENSES', 'python')], { cwd: resources });
}
function bundleInventory(directory) {
  const files = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current), relative = path.relative(directory, current);
    if (stat.isSymbolicLink()) {
      if (!inside(fs.realpathSync(directory), fs.realpathSync(current))) throw new Error(`App contains an escaping symlink: ${relative}`);
      files.push({ path: relative, symlink: fs.readlinkSync(current) });
    } else if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: fileHash(current) });
  }; visit(directory); return { sha256: hash(JSON.stringify(files)), files };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--reuse-runtime') || args.length > 1) throw new Error('Usage: package-macos.sh [--reuse-runtime]');
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== `v${manifest.node.version}`) throw new Error('Build requires the existing pinned macOS arm64 Node toolchain');
  fs.mkdirSync(output, { recursive: true });
  const candidate = await phase('Capture current source candidate', sourceCandidate);
  writeJson(path.join(output, 'source-candidate.json'), candidate);
  resetStage(appStage);
  let runtime;
  if (args.includes('--reuse-runtime')) {
    runtime = await phase('Verify and reuse the exact independent staged runtime', async () => {
      const runtimeRoot = path.join(resources, 'python');
      const manifestPath = path.join(runtimeRoot, MANIFEST_NAME);
      const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const expectedPackages = parseRuntimeLock(fs.readFileSync(path.join(root, 'requirements-macos-arm64.lock'), 'utf8'));
      if (cached.inventoryStage !== 'pre-app-signing' || cached.source.sha256 !== manifest.python.download.sha256
        || cached.source.version !== manifest.python.version || cached.source.build !== manifest.python.build
        || cached.lock.sha256 !== fileHash(path.join(root, 'requirements-macos-arm64.lock'))
        || cached.packages.length !== expectedPackages.length
        || expectedPackages.some((expected) => !cached.packages.some((item) => ['name', 'version', 'filename', 'sha256'].every((key) => item[key] === expected[key])))
        || JSON.stringify(inspectTree(runtimeRoot).filter((item) => item.path !== MANIFEST_NAME)) !== JSON.stringify(cached.files)) {
        throw new Error('Staged runtime does not match its pinned inputs and pre-signing inventory; use the normal fresh staging build');
      }
      const audit = await auditMacRuntime({ runtimeRoot, projectRoot: root, scratchRoot: path.join(frontend, '.package-smoke-macos', 'runtime-audit') });
      for (const name of fs.readdirSync(resources)) if (name !== 'python') fs.rmSync(path.join(resources, name), { recursive: true, force: true });
      return { runtimeRoot, manifestPath, manifest: cached, audit };
    });
  } else {
    resetStage(resources);
    runtime = await phase('Stage independent pinned production Python', async () => {
      const cacheRoot = path.join(buildRoot, 'cache');
      // Reuse downloaded archives only. Never read the old unpacked uv cache
      // through File Provider. The staging helper rechecks every archive hash.
      const previousCache = path.join(frontend, '.macos-runtime-dev', 'cache');
      for (const directory of ['', 'wheels']) {
        const source = path.join(previousCache, directory), destination = path.join(cacheRoot, directory);
        fs.mkdirSync(destination, { recursive: true });
        if (!fs.existsSync(source)) continue;
        for (const name of fs.readdirSync(source)) {
          if (!(directory ? name.endsWith('.whl') : name.endsWith('.tar.gz'))) continue;
          const input = path.join(source, name), target = path.join(destination, name);
          if (!fs.lstatSync(input).isFile() || fs.existsSync(target)) continue;
          fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL);
        }
      }
      return stageMacPythonRuntime({ projectRoot: root, stagingRoot: resources, cacheRoot, uvPath: path.join(tools, 'uv', 'uv'), onProgress: (message) => console.log(`[macOS runtime] ${message}`) });
    });
  }
  const python = path.join(resources, 'python', 'bin', 'python3.12');
  await phase('Build production renderer', async () => {
    prepareVendoredRuntime(frontend);
    await run(process.execPath, [path.join(__dirname, 'run-clean-tool.cjs'), 'vite', 'build'], { env: { NODE_ENV: 'production', VITE_ELECTRON_BUILD: 'true', VITE_LIVE2D_PUBLIC_ENABLED: 'false', SENTRY_AUTH_TOKEN: '' } });
  });
  await phase('Stage desktop host, source, empty seed and notices', async () => {
    copyTree(path.join(frontend, 'dist'), path.join(appStage, 'dist'));
    copyTree(path.join(frontend, 'electron'), path.join(appStage, 'electron'), (name, stat) => path.basename(name) !== 'bridge-supervisor.cjs' && !/\.(?:test|spec|fixture)\.(?:c?js|mjs|json)$/i.test(name) && !(stat.isDirectory() && /(?:__fixtures__|fixtures|tests?)$/i.test(name)));
    writeJson(path.join(appStage, 'package.json'), { name: 'reverie-macos-test', productName: 'Reverie macOS Test', version: '0.5.5', description: 'Reverie independent macOS arm64 core local test', author: 'Muhe Studio contributors', main: 'electron/main.js', license: 'GPL-3.0-only' });
    copyProductionPythonSource(path.join(root, 'src'), path.join(resources, 'src'), resources);
    const seed = createSeedConfig();
    seed.ui = { mode: 'mvp', experience_mode: 'core' };
    writeJson(path.join(resources, 'data', 'config.json'), seed);
    writeJson(path.join(resources, 'data', 'user', 'profile.json'), { name: '', nickname: '', birthday: '', interests: [], hobbies: [], favorite_topics: [], important_dates: [], sticker_preferences: {}, long_term_goals: [], habits: [], historical_events: [] });
    for (const name of ['LICENSE', 'NOTICE', 'CREDITS.md', 'AGPL_EXCLUDED.md', 'requirements-macos-arm64.lock']) copyTree(path.join(root, name), path.join(resources, name));
    copyTree(path.join(frontend, 'public', 'icon.ico'), path.join(resources, 'icon.ico'));
    writeJson(path.join(resources, 'TEST-BUILD-DO-NOT-RELEASE.json'), { schema: 'reverie.macos-test-build.v1', appId: 'com.muhe.reverie.macos.test', platform: 'darwin', arch: 'arm64', publishable: false, distribution: 'TEST_ONLY_DO_NOT_RELEASE' });
    writeJson(path.join(resources, 'BUILD-CANDIDATE.json'), { schema: 'reverie.macos-build-candidate.v1', sourceSha256: candidate.sha256, gitHead: candidate.head, dirty: candidate.dirty, transport: 'framed-stdio-v4', profile: 'independent-core-local-test', live2dCoreBundled: false, sourceOmissions: OMITTED_SOURCE_MODULES });
    await run(python, ['-I', '-B', '-c', 'import pathlib,sys;[(compile(p.read_text(encoding="utf-8"),str(p),"exec")) for p in pathlib.Path(sys.argv[1]).rglob("*.py")]', path.join(resources, 'src')], { cwd: resources });
    assertLive2DReleaseGate({ buildEnabled: '0', platform: 'darwin', scanRoots: [appStage, path.join(resources, 'src'), path.join(resources, 'data')] });
    await collectLicenses(python);
  });
  await phase('Prepare nested native signing inventory', async () => {
    const natives = [];
    const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else if (entry.isFile()) { const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(4); fs.readSync(fd, bytes, 0, 4, 0); fs.closeSync(fd); if (['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.toString('hex'))) natives.push(`Contents/Resources/${path.relative(resources, file).split(path.sep).join('/')}`); } } };
    visit(path.join(resources, 'python'));
    writeJson(path.join(resources, 'MACOS-SIGNING-INPUTS.json'), { binaries: natives });
  });
  await phase('electron-builder arm64 app with local ad-hoc signing', async () => {
    // File Provider can reattach FinderInfo during signing in Documents. Sign
    // outside synced folders, then copy the signed bytes into the owned output.
    const temporaryOutput = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-macos-build-'));
    try {
      await run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), '--config', 'electron-builder.macos.config.cjs', '--mac', '--arm64', '--dir', '--publish', 'never'], { env: { REVERIE_MACOS_BUILD_OUTPUT: temporaryOutput, CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: undefined, CSC_NAME: undefined, CSC_KEY_PASSWORD: undefined, CSC_INSTALLER_LINK: undefined, CSC_INSTALLER_KEY_PASSWORD: undefined, APPLE_ID: undefined, APPLE_APP_SPECIFIC_PASSWORD: undefined, APPLE_API_KEY: undefined, ELECTRON_BUILDER_CACHE: path.join(tools, 'cache', 'electron-builder') } });
      const signedApp = path.join(temporaryOutput, 'mac-arm64', 'Reverie macOS Test.app');
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', signedApp]);
      if (fs.existsSync(appPath) && fs.lstatSync(appPath).isSymbolicLink()) throw new Error('Generated app output is redirected');
      fs.rmSync(appPath, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(appPath), { recursive: true });
      fs.cpSync(signedApp, appPath, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    } finally { fs.rmSync(temporaryOutput, { recursive: true, force: true }); }
  });
  const finalAudit = await phase('Audit signed independent runtime and signatures', async () => {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    const audit = await auditMacRuntime({ runtimeRoot: path.join(appPath, 'Contents', 'Resources', 'python'), projectRoot: root, probe: true, scratchRoot: path.join(frontend, '.package-smoke-macos', 'runtime-audit') });
    const signing = JSON.parse(fs.readFileSync(path.join(resources, 'MACOS-SIGNING-INPUTS.json')));
    for (const binary of signing.binaries) await run('/usr/bin/codesign', ['--verify', '--strict', path.join(appPath, binary)], { capture: true });
    return audit;
  });
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const appNativeAudit = await phase('Audit whole app native dependency closure and nested signatures',
    () => auditMacApp({ appPath, reportPath: path.join(output, 'app-native-audit.json') }));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
  const fuses = await libraryRequire('@electron/fuses').getCurrentFuseWire(appPath);
  const expectedFuses = { 0: 48, 1: 49, 2: 48, 3: 48, 4: 49, 5: 49, 7: 48 };
  if (fuses.version !== '1' || Object.entries(expectedFuses).some(([key, value]) => fuses[key] !== value)) throw new Error('Packaged Electron fuses differ from the production security policy');
  const finalCandidate = await sourceCandidate();
  if (finalCandidate.sha256 !== candidate.sha256) throw new Error('Source candidate changed during packaging; rebuild before acceptance');
  const inventory = bundleInventory(appPath);
  const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', appPath], { capture: true, includeStderr: true });
  const entitlements = await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], { capture: true, includeStderr: true });
  const toolchain = {
    node: process.versions.node,
    uv: await run(path.join(tools, 'uv', 'uv'), ['--version'], { capture: true }),
    pnpm: require(path.join(tools, 'pnpm', 'package.json')).version,
    electron: require('electron/package.json').version,
    electronBuilder: require('electron-builder/package.json').version,
    python: runtime.manifest.source,
  };
  const locks = Object.fromEntries(['requirements-macos-arm64.lock', 'frontend/pnpm-lock.yaml', 'config/macos-toolchain.json']
    .map((name) => [name, fileHash(path.join(root, name))]));
  const result = { schema: 'reverie.macos-build.v1', startedAt, completedAt: new Date().toISOString(), appPath, candidate, architecture: 'arm64', toolchain, locks, runtimeManifest: path.join(appPath, 'Contents', 'Resources', 'python', MANIFEST_NAME), stagingRuntimeManifest: runtime.manifestPath, runtimeAudit: finalAudit, appNativeAudit, signingMetadataCleanup: JSON.parse(fs.readFileSync(path.join(output, 'signing-metadata-cleanup.json'), 'utf8')), fuses, signature, entitlements, signing: { identity: 'ad-hoc', hardenedRuntime: true, entitlementsPolicy: 'unchanged electron-builder default macOS entitlements', formalDistribution: false, notarized: false, crossVersionKeychainValidated: false }, timings, bundle: inventory };
  writeJson(path.join(output, 'macos-build.json'), result);
  writeJson(path.join(frontend, '.package-smoke-macos', 'latest-package.json'), { appPath, buildManifest: path.join(output, 'macos-build.json') });
  fs.rmSync(path.join(output, 'last-build-failure.json'), { force: true });
  const obsolete = path.join(output, 'mac-arm64', 'Reverie macOS Test.app');
  if (fs.existsSync(obsolete) && !fs.lstatSync(obsolete).isSymbolicLink()) {
    const marker = path.join(obsolete, 'Contents/Resources/TEST-BUILD-DO-NOT-RELEASE.json');
    if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).appId === 'com.muhe.reverie.macos.test') {
      fs.rmSync(obsolete, { recursive: true, force: true });
    }
  }
  console.log(`[macOS build] Local core app ready: ${appPath}`);
}
main().catch((error) => { writeJson(path.join(output, 'last-build-failure.json'), { startedAt, failedAt: new Date().toISOString(), error: error.stack, timings }); console.error(error); process.exitCode = 1; });
