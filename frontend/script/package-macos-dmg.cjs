'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { treeManifest, verifySuccessfulBuild, resolvePackageInputs } = require('./smoke-packaged-macos.cjs');
const { createDmgMount, validateVolumeLayout, validateReportDestination, verifyDmgManifest } = require('./smoke-dmg-macos.cjs');
const pins = require('../../config/macos-dmg-toolchain.json');
const tools = require('../../config/macos-toolchain.json');
const frontend = path.resolve(__dirname, '..');
const root = path.dirname(frontend);
const APP_NAME = 'Reverie macOS Test.app';
const APP_ID = 'com.muhe.reverie.macos.test';
const buildRoot = path.join(os.homedir(), 'Library', 'Developer', 'Reverie', 'LocalBuilds',
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 12));
const activeCommands = new Set();
let interrupted = false;
function hashFile(file) {
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Expected regular input file');
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  let count = 0;
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) { count += n; hash.update(buffer.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  const after = fs.statSync(file);
  assert.ok(count === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'Incomplete or changing input');
  return hash.digest('hex');
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function parseInputs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--app', '--manifest', '--out'].includes(args[i]) && !options[args[i]], 'Unknown or repeated option');
    assert.ok(args[i + 1] && path.isAbsolute(args[i + 1]), 'Options require absolute paths');
    options[args[i]] = args[i + 1];
  }
  const selected = resolvePackageInputs(Object.entries(options).filter(([k]) => k !== '--out').flat(), frontend);
  return { ...selected, outputDirectory: options['--out'] || path.join(buildRoot, 'dmg') };
}
function createConfig({ metadata, output, app, instructions, version, artifactName, volumeName }) {
  return {
    extends: null, appId: APP_ID, productName: 'Reverie macOS Test', publish: null,
    electronVersion: require('electron/package.json').version,
    npmRebuild: false, directories: { app: metadata, output },
    mac: { target: [{ target: 'dmg', arch: ['arm64'] }], identity: null, notarize: false,
      gatekeeperAssess: false, minimumSystemVersion: '14.0' },
    dmg: { artifactName, title: volumeName, format: 'UDZO', filesystem: 'HFS+',
      sign: false, writeUpdateInfo: false, backgroundColor: '#F5F6F7', icon: null,
      window: { width: 640, height: 420 }, iconSize: 96, iconTextSize: 13,
      contents: [
        { x: 160, y: 170, type: 'file', path: app, name: APP_NAME },
        { x: 480, y: 170, type: 'link', path: '/Applications', name: 'Applications' },
        { x: 320, y: 250, type: 'file', path: instructions, name: '安装说明.txt' },
      ] },
  };
}
function buildEnvironment(work) {
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_CACHE: path.join(buildRoot, 'cache', 'electron-builder'),
    TMPDIR: path.join(work, 'tmp'), TMP: path.join(work, 'tmp'), TEMP: path.join(work, 'tmp'),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  for (const key of Object.keys(env)) {
    if (/^(?:CSC_|APPLE_|SENTRY_AUTH_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|CUSTOM_DMGBUILD_PATH$|PYTHON|VIRTUAL_ENV$|DYLD_|NODE_OPTIONS$)/i.test(key)
      || /(?:electron.*mirror|electron.*custom|npm_config.*mirror|ELECTRON_BUILDER_BINARIES)/i.test(key)) delete env[key];
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return env;
}
async function run(command, args, options = {}) {
  if (interrupted && !options.cleanup) throw new Error('DMG build interrupted');
  return new Promise((resolve, reject) => {
    // Every command gets a private process group, including builder's helpers.
    const child = spawn(command, args, { cwd: options.cwd || frontend, env: options.env || process.env,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let forcedTimer, terminationReason;
    function signalGroup(signal) {
      if (!Number.isInteger(child.pid)) return;
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      signalGroup('SIGTERM');
      forcedTimer = setTimeout(() => signalGroup('SIGKILL'), 3000);
    };
    activeCommands.add(terminate);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (options.live) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (options.live) process.stderr.write(chunk); });
    const timer = setTimeout(() => terminate('timeout'), options.timeout || 300_000);
    const clear = () => { clearTimeout(timer); clearTimeout(forcedTimer); activeCommands.delete(terminate); };
    child.once('error', (error) => { clear(); reject(error); });
    child.once('close', (code, signal) => {
      clear();
      if (code !== 0 || terminationReason) signalGroup('SIGKILL');
      code === 0 && !terminationReason ? resolve(stdout.trim())
        : reject(new Error(`${path.basename(command)} failed (${terminationReason || code || signal}): ${(stderr || stdout).slice(-5000)}`));
    });
  });
}
async function cleanupBuilderMounts(work) {
  const infoFile = path.join(work, 'cleanup-mounts.plist');
  fs.writeFileSync(infoFile, await run('/usr/bin/hdiutil', ['info', '-plist'], { cleanup: true }));
  const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoFile], { cleanup: true }));
  for (const image of info.images || []) {
    const imagePath = image['image-path'];
    if (typeof imagePath !== 'string' || !path.resolve(imagePath).startsWith(work + path.sep)) continue;
    const entities = image['system-entities'] || [];
    const target = entities.find((item) => item['mount-point'])?.['mount-point'] || entities[0]?.['dev-entry'];
    assert.ok(target, 'Cannot identify owned builder attachment; preserving work directory');
    await run('/usr/bin/hdiutil', ['detach', target], { timeout: 30_000, cleanup: true });
  }
}
async function identity(app) {
  assert.equal(path.basename(app), APP_NAME);
  assert.ok(fs.lstatSync(app).isDirectory() && !fs.lstatSync(app).isSymbolicLink());
  const plist = path.join(app, 'Contents', 'Info.plist');
  const appId = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
  assert.equal(appId, APP_ID);
  const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const resources = path.join(app, 'Contents', 'Resources');
  const marker = JSON.parse(fs.readFileSync(path.join(resources, 'TEST-BUILD-DO-NOT-RELEASE.json'), 'utf8'));
  assert.equal(marker.appId, APP_ID); assert.equal(marker.publishable, false);
  assert.equal(marker.distribution, 'TEST_ONLY_DO_NOT_RELEASE');
  return { appRoot: app, resources, appId, version };
}
function verifyExisting(paths, expected) {
  const present = Object.values(paths).filter((file) => fs.existsSync(file));
  if (!present.length) return null;
  assert.equal(present.length, 3, 'Incomplete or conflicting DMG output; no files were overwritten');
  for (const file of Object.values(paths)) assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  assert.equal(manifest.schema, 'reverie.macos-dmg.v1');
  assert.ok(!manifest.error && !manifest.failedAt && manifest.success !== false);
  assert.ok(manifest.completedAt && manifest.timings?.length && manifest.timings.every((p) => p.passed === true));
  assert.deepEqual(manifest.source, expected.source, 'Existing DMG belongs to different app inputs');
  assert.deepEqual(manifest.buildInputs, expected.buildInputs, 'Existing DMG used different packaging inputs');
  assert.equal(manifest.artifact.path, paths.dmg);
  assert.equal(manifest.artifact.bytes, fs.statSync(paths.dmg).size);
  assert.equal(manifest.artifact.sha256, hashFile(paths.dmg), 'Existing DMG checksum mismatch');
  assert.equal(fs.readFileSync(paths.checksum, 'utf8'), `${manifest.artifact.sha256}  ${path.basename(paths.dmg)}\n`);
  return manifest;
}
async function verifyMountedImage(dmg, appManifest, expectedTree, instructionsHash, work) {
  await run('/usr/bin/hdiutil', ['verify', dmg]);
  const info = JSON.parse(await run('/usr/bin/hdiutil', ['imageinfo', '-plist', dmg]).then((xml) => {
    const file = path.join(work, `imageinfo-${crypto.randomUUID()}.plist`); fs.writeFileSync(file, xml);
    return run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  }));
  assert.equal(info.Format, 'UDZO');
  const mount = path.join(work, 'mounted'); fs.mkdirSync(mount, { recursive: true });
  const attachment = createDmgMount(dmg, mount);
  try {
    attachment.attach();
    const layout = validateVolumeLayout(mount);
    assert.equal(layout.instructionsSha256, instructionsHash);
    const app = path.join(mount, APP_NAME), actual = treeManifest(app);
    assert.deepEqual(actual, expectedTree, 'DMG changed application files, links or modes');
    verifySuccessfulBuild(await identity(app), appManifest, actual);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    assert.throws(() => fs.writeFileSync(path.join(app, 'readonly-write-probe'), 'must fail'),
      (error) => ['EROFS', 'EPERM', 'EACCES'].includes(error.code));
    return { verified: true, format: info.Format, filesystem: 'HFS+', readonly: true, appUnchanged: true, layout };
  } finally {
    try { attachment.detach(); }
    catch (error) { error.preserveWork = true; throw error; }
  }
}
async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log('Usage: package-macos-dmg.sh [--app /absolute/Test.app] [--manifest /absolute/macos-build.json] [--out /absolute/output-directory]'); return; }
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, `v${tools.node.version}`);
  assert.equal(require('electron-builder/package.json').version, pins.electronBuilder);
  const inputs = parseInputs(args), sourceApp = fs.realpathSync(inputs.appPath);
  const sourceIdentity = await identity(sourceApp), sourceTree = treeManifest(sourceApp);
  const binding = verifySuccessfulBuild(sourceIdentity, inputs.manifestPath, sourceTree);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp]);
  validateReportDestination(buildRoot);
  validateReportDestination(inputs.outputDirectory);
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.mkdirSync(inputs.outputDirectory, { recursive: true });
  assert.equal(fs.realpathSync(inputs.outputDirectory), path.resolve(inputs.outputDirectory), 'Output directory is redirected');
  assert.ok(!inputs.outputDirectory.split(path.sep).some((part) => part.endsWith('.app')), 'Output cannot be inside an application');
  const artifactName = `Reverie-macOS-Test-${sourceIdentity.version}-arm64-${binding.signedBundleSha256.slice(0, 12)}.dmg`;
  const paths = { dmg: path.join(inputs.outputDirectory, artifactName),
    manifest: path.join(inputs.outputDirectory, artifactName.replace(/\.dmg$/, '.json')),
    checksum: path.join(inputs.outputDirectory, `${artifactName}.sha256`) };
  const instructionsSource = path.join(root, 'docs', 'MACOS-INSTALL.txt');
  const inputFiles = [__filename, path.join(root, 'script/package-macos-dmg.sh'),
    path.join(__dirname, 'smoke-dmg-macos.cjs'), path.join(__dirname, 'smoke-packaged-macos.cjs'),
    path.join(root, 'config/macos-dmg-toolchain.json'), instructionsSource];
  const captureInputs = () => Object.fromEntries(inputFiles.map((file) => [path.relative(root, file), hashFile(file)]));
  const buildInputs = captureInputs();
  const source = { appPath: sourceApp, appManifestSha256: binding.manifestSha256,
    sourceSha256: binding.sourceSha256, signedBundleSha256: binding.signedBundleSha256 };
  const existing = verifyExisting(paths, { source, buildInputs });
  const work = fs.mkdtempSync(path.join(buildRoot, 'dmg-work-'));
  let preserveWork = false;
  let mountsCleaned = false;
  const onSignal = () => { interrupted = true; for (const terminate of activeCommands) terminate('interrupted'); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const startedAt = new Date().toISOString(), timings = [];
  async function phase(name, operation) {
    console.log(`[macOS DMG] ${name}`); const start = Date.now();
    try { const result = await operation(); timings.push({ name, elapsedMs: Date.now() - start, passed: true }); return result; }
    catch (error) { timings.push({ name, elapsedMs: Date.now() - start, passed: false }); throw error; }
  }
  try {
    if (existing) {
      verifyDmgManifest({ dmgPath: paths.dmg, manifestPath: paths.manifest, appManifestPath: inputs.manifestPath });
      await phase('Verify existing DMG before reuse', () => verifyMountedImage(paths.dmg, inputs.manifestPath, sourceTree, hashFile(instructionsSource), work));
      await phase('Confirm owned build mounts are detached', () => cleanupBuilderMounts(work));
      mountsCleaned = true;
    } else {
      for (const name of ['metadata', 'output', 'tool', 'tmp']) fs.mkdirSync(path.join(work, name));
      const env = buildEnvironment(work), metadata = path.join(work, 'metadata');
      const stagedApp = path.join(work, APP_NAME), instructions = path.join(metadata, '安装说明.txt');
      await phase('Copy the immutable accepted app', async () => {
        await run('/usr/bin/ditto', [sourceApp, stagedApp]);
        assert.deepEqual(treeManifest(stagedApp), sourceTree, 'Copy changed application');
        fs.copyFileSync(instructionsSource, instructions);
        writeJson(path.join(metadata, 'package.json'), { name: 'reverie-macos-dmg', productName: 'Reverie macOS Test',
          version: sourceIdentity.version, description: 'Local core test DMG', author: 'Muhe Studio contributors', license: 'GPL-3.0-only' });
      });
      const tool = await phase('Verify the pinned arm64 DMG build tool', async () => {
        const cache = path.join(buildRoot, 'cache', 'dmg'); fs.mkdirSync(cache, { recursive: true });
        const archive = path.join(cache, pins.dmgBuilder.filename);
        if (!fs.existsSync(archive)) {
          const temporary = path.join(work, pins.dmgBuilder.filename);
          await run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '5', '--output', temporary, pins.dmgBuilder.url], { timeout: 300_000 });
          assert.equal(hashFile(temporary), pins.dmgBuilder.sha256, 'DMG tool archive checksum mismatch');
          fs.copyFileSync(temporary, archive, fs.constants.COPYFILE_EXCL);
        }
        assert.equal(hashFile(archive), pins.dmgBuilder.sha256, 'Cached DMG tool differs from the pinned archive');
        const entries = (await run('/usr/bin/tar', ['-tzf', archive])).split('\n');
        assert.ok(entries.every((entry) => !path.posix.isAbsolute(entry) && !entry.split('/').includes('..')), 'Unsafe tool archive paths');
        await run('/usr/bin/tar', ['-xzf', archive, '-C', path.join(work, 'tool')]);
        const executable = path.join(work, 'tool', 'dmgbuild');
        assert.ok(fs.lstatSync(executable).isFile() && !fs.lstatSync(executable).isSymbolicLink());
        // Upstream dmgbuild is a shell launcher around its own build-only Python.
        // Check that interpreter, not the text launcher, and never copy it into the app.
        const toolPython = fs.realpathSync(path.join(work, 'tool', 'python', 'bin', 'python3'));
        assert.ok(toolPython.startsWith(path.join(work, 'tool') + path.sep));
        const architectures = await run('/usr/bin/lipo', ['-archs', toolPython]); assert.equal(architectures, 'arm64');
        env.CUSTOM_DMGBUILD_PATH = executable;
        const upstreamVersionText = fs.readFileSync(path.join(work, 'tool', 'VERSION.txt'), 'utf8').trim();
        assert.ok(upstreamVersionText.includes(`hash: ${pins.dmgBuilder.build}`));
        return { ...pins.dmgBuilder, executableSha256: hashFile(executable),
          pythonSha256: hashFile(toolPython), upstreamVersionText, buildOnly: true, architectures };
      });
      const volumeName = `Reverie macOS Test ${sourceIdentity.version} arm64`;
      const config = createConfig({ metadata, output: path.join(work, 'output'), app: stagedApp,
        instructions, version: sourceIdentity.version, artifactName, volumeName });
      const configPath = path.join(work, 'dmg-config.json'); writeJson(configPath, config);
      await phase('Build DMG without rebuilding or signing the app', () => run(process.execPath,
        [require.resolve('electron-builder/out/cli/cli.js'), '--projectDir', metadata, '--config', configPath,
          '--mac', 'dmg', '--arm64', '--prepackaged', stagedApp, '--publish', 'never'], { env, live: true, timeout: 300_000 }));
      const dmg = path.join(work, 'output', artifactName);
      const imageAudit = await phase('Verify final compressed image and contained signature',
        () => verifyMountedImage(dmg, inputs.manifestPath, sourceTree, hashFile(instructionsSource), work));
      await phase('Confirm owned build mounts are detached', () => cleanupBuilderMounts(work));
      mountsCleaned = true;
      assert.deepEqual(treeManifest(sourceApp), sourceTree, 'Original app changed during packaging');
      assert.deepEqual(treeManifest(stagedApp), sourceTree, 'Builder mutated the prepackaged app');
      assert.deepEqual(captureInputs(), buildInputs, 'Packaging inputs changed during build; retry with a stable candidate');
      const result = { schema: 'reverie.macos-dmg.v1', startedAt, completedAt: new Date().toISOString(),
        artifactName, volumeName, format: 'UDZO', filesystem: 'HFS+', source, buildInputs,
        appManifestPath: fs.realpathSync(inputs.manifestPath),
        app: { name: APP_NAME, appId: APP_ID, version: sourceIdentity.version },
        artifact: { path: paths.dmg, sha256: hashFile(dmg), bytes: fs.statSync(dmg).size },
        signing: { application: 'ad-hoc', dmg: 'unsigned', notarized: false },
        toolchain: { node: process.versions.node, electronBuilder: pins.electronBuilder, dmgBuilder: tool },
        instructionsSha256: hashFile(instructionsSource), imageAudit, timings };
      fs.copyFileSync(dmg, paths.dmg, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(paths.checksum, `${result.artifact.sha256}  ${artifactName}\n`, { flag: 'wx' });
      writeJson(paths.manifest, result);
    }
    const pointer = path.join(frontend, '.package-smoke-macos', 'latest-dmg.json'); fs.mkdirSync(path.dirname(pointer), { recursive: true });
    if (interrupted) throw new Error('DMG build interrupted before publishing its successful pointer');
    const temporaryPointer = `${pointer}.${process.pid}.tmp`;
    writeJson(temporaryPointer, { dmgPath: paths.dmg, buildManifest: paths.manifest, appManifest: fs.realpathSync(inputs.manifestPath) });
    fs.renameSync(temporaryPointer, pointer);
    console.log(`[macOS DMG] ${existing ? 'Verified and reused' : 'Created'}: ${paths.dmg}`);
    console.log(`[macOS DMG] SHA-256: ${hashFile(paths.dmg)}`);
  } catch (error) {
    preserveWork = Boolean(error.preserveWork);
    const reports = path.join(frontend, 'release-macos'); fs.mkdirSync(reports, { recursive: true });
    writeJson(path.join(reports, `dmg-failure-${Date.now()}.json`), { startedAt, failedAt: new Date().toISOString(), timings, error: String(error) });
    throw error;
  } finally {
    try { if (!mountsCleaned) await cleanupBuilderMounts(work); }
    catch (error) { preserveWork = true; console.error(`[macOS DMG] Mount cleanup failed: ${error}`); process.exitCode = 1; }
    if (!preserveWork) fs.rmSync(work, { recursive: true, force: true });
    else console.error(`[macOS DMG] Preserved mounted work directory for diagnosis: ${work}`);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); interrupted = false;
  }
}
if (require.main === module) main().catch((error) => { console.error(`[macOS DMG] ${error.stack || error}`); process.exitCode = 1; });
module.exports = { createConfig, parseInputs, hashFile, verifyExisting, verifyMountedImage, buildEnvironment, runCommand: run };
