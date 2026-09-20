'use strict';

// Exercise the delivered image itself, then an installed copy with the image
// detached. Every UI/security/storage operation uses the production app runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_NAME, APP_ID, treeManifest, verifySuccessfulBuild,
  readBundleIdentity, verifyHardenedBundle, standalonePythonProbe, processSnapshot,
  forceCleanup, createAcceptanceSession, runAcceptanceCycle, closeAcceptanceSession,
  verifyNegativeStartup, setInterrupted, contentDigest, hashFile, run, inside,
} = require('./smoke-packaged-macos.cjs');
const frontendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(frontendRoot, '..');
const DIGEST = /^[0-9a-f]{64}$/;

function absoluteOption(args, name) {
  const index = args.indexOf(name);
  assert.ok(index === args.lastIndexOf(name), `${name} may be supplied only once`);
  if (index < 0) return null;
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--') && path.isAbsolute(value), `${name} requires an absolute path`);
  return path.resolve(value);
}

function resolveDmgInputs(args, frontendDirectory = frontendRoot) {
  const explicitDmg = absoluteOption(args, '--dmg');
  const explicitManifest = absoluteOption(args, '--manifest');
  const explicitAppManifest = absoluteOption(args, '--app-manifest');
  let pointer = {};
  if (!explicitDmg) {
    pointer = JSON.parse(fs.readFileSync(path.join(frontendDirectory, '.package-smoke-macos', 'latest-dmg.json'), 'utf8'));
    assert.ok(typeof pointer.dmgPath === 'string' && path.isAbsolute(pointer.dmgPath), 'Latest DMG pointer has no absolute image path');
    assert.ok(typeof pointer.buildManifest === 'string' && path.isAbsolute(pointer.buildManifest), 'Latest DMG pointer has no absolute build manifest');
  } else assert.ok(explicitManifest, 'An explicit --dmg requires --manifest');
  return { dmgPath: explicitDmg || pointer.dmgPath, manifestPath: explicitManifest || pointer.buildManifest,
    appManifestPath: explicitAppManifest || pointer.appManifest || null };
}

function readRegularJson(file, label) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), `${label} path must be absolute`);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, stat.size, `${label} short read`);
  return JSON.parse(bytes.toString('utf8'));
}

function verifyDmgManifest(inputs) {
  const manifest = readRegularJson(inputs.manifestPath, 'DMG manifest');
  assert.equal(manifest.schema, 'reverie.macos-dmg.v1');
  assert.ok(!manifest.error && !manifest.failedAt && manifest.success !== false, 'Failed DMG build cannot be accepted');
  assert.ok(Number.isFinite(Date.parse(manifest.startedAt)) && Number.isFinite(Date.parse(manifest.completedAt))
    && Date.parse(manifest.completedAt) >= Date.parse(manifest.startedAt), 'DMG build has no successful completion timestamp');
  assert.ok(Array.isArray(manifest.timings) && manifest.timings.length > 0
    && manifest.timings.every((item) => item.passed === true), 'DMG build contains an incomplete or failed phase');
  assert.deepEqual(manifest.app, { name: APP_NAME, appId: APP_ID, version: '0.5.5' });
  assert.equal(manifest.signing?.application, 'ad-hoc');
  assert.equal(manifest.signing?.dmg, 'unsigned');
  assert.equal(manifest.signing?.notarized, false);
  assert.equal(manifest.format, 'UDZO'); assert.equal(manifest.filesystem, 'HFS+');
  assert.match(manifest.instructionsSha256 || '', DIGEST, 'Installation instructions digest missing');
  for (const name of ['appManifestSha256', 'sourceSha256', 'signedBundleSha256']) {
    assert.match(manifest.source?.[name] || '', DIGEST, `Missing ${name}`);
  }
  assert.ok(typeof manifest.source.appPath === 'string' && path.isAbsolute(manifest.source.appPath), 'Source application path missing');
  assert.match(manifest.artifact?.sha256 || '', DIGEST);
  assert.ok(Number.isSafeInteger(manifest.artifact.bytes) && manifest.artifact.bytes > 0, 'DMG artifact byte count missing');
  assert.ok(typeof manifest.artifact.path === 'string' && path.isAbsolute(manifest.artifact.path), 'DMG artifact path missing');
  const stat = fs.lstatSync(inputs.dmgPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'DMG must be a regular file');
  assert.equal(stat.size, manifest.artifact.bytes, 'DMG byte count differs from completed build');
  assert.equal(hashFile(inputs.dmgPath), manifest.artifact.sha256, 'DMG SHA-256 differs from completed build');
  const appManifestPath = inputs.appManifestPath || manifest.appManifestPath;
  const appManifest = readRegularJson(appManifestPath, 'Application build manifest');
  assert.equal(hashFile(appManifestPath), manifest.source.appManifestSha256, 'Application manifest SHA-256 differs from the DMG build');
  assert.equal(appManifest.schema, 'reverie.macos-build.v1');
  assert.equal(appManifest.candidate?.sha256, manifest.source.sourceSha256, 'DMG source candidate differs from application build');
  assert.equal(appManifest.bundle?.sha256, manifest.source.signedBundleSha256, 'DMG signed bundle differs from application build');
  const expectedName = `Reverie-macOS-Test-0.5.5-arm64-${manifest.source.signedBundleSha256.slice(0, 12)}.dmg`;
  assert.equal(path.basename(manifest.artifact.path), expectedName, 'DMG artifact naming does not bind the application digest');
  return { manifest, appManifest, binding: {
    manifestPath: fs.realpathSync(inputs.manifestPath), manifestSha256: hashFile(inputs.manifestPath),
    dmgPath: fs.realpathSync(inputs.dmgPath), dmgSha256: manifest.artifact.sha256, bytes: stat.size,
    appManifestPath: fs.realpathSync(appManifestPath), appManifestSha256: manifest.source.appManifestSha256,
    sourceSha256: manifest.source.sourceSha256, signedBundleSha256: manifest.source.signedBundleSha256,
    matched: true,
  } };
}

function parsePlist(xml, invoke = run) {
  return JSON.parse(invoke('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }));
}

function mountedImages(invoke = run) {
  return parsePlist(invoke('/usr/bin/hdiutil', ['info', '-plist']), invoke).images || [];
}

function imageMatches(image, imagePath) {
  const actual = image['image-path'];
  if (typeof actual !== 'string') return false;
  try { return fs.realpathSync(actual) === fs.realpathSync(imagePath); } catch { return path.resolve(actual) === path.resolve(imagePath); }
}

// The cleanup ledger is refreshed even if attach fails after mounting. Detach
// targets only this exact image at this exact test mountpoint; never an unknown
// mount, never -force. A failed detach preserves scratch for diagnosis.
function createDmgMount(dmgPath, mountPoint, { invoke = run, listImages = () => mountedImages(invoke) } = {}) {
  let mounted = false;
  let detachTarget = mountPoint;
  const events = [];
  const refresh = () => {
    const matching = listImages().filter((image) => imageMatches(image, dmgPath));
    mounted = matching.length > 0;
    assert.ok(matching.length <= 1, 'Ambiguous attachments for this image; preserve scratch');
    if (matching.length) {
      const entities = matching[0]['system-entities'] || [];
      const volumes = entities.filter((entity) => entity['mount-point']);
      assert.ok(volumes.every((entity) => entity['mount-point'] === mountPoint),
        'Image is mounted outside the owned mountpoint; preserve scratch');
      if (!volumes.length) {
        // hdiutil can attach a disk device and fail before mounting its volume.
        const device = entities.find((entity) => /^\/dev\/disk\d+$/.test(entity['dev-entry'] || ''));
        assert.ok(device, 'Image attachment has no safely identifiable disk device; preserve scratch');
        detachTarget = device['dev-entry'];
      } else detachTarget = mountPoint;
    }
    return mounted;
  };
  return {
    get mounted() { return mounted; }, events,
    attach() {
      assert.equal(listImages().filter((image) => imageMatches(image, dmgPath)).length, 0,
        'Image is already attached; existing mount will not be touched');
      try {
        const response = parsePlist(invoke('/usr/bin/hdiutil', ['attach', '-plist', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath], { timeout: 60_000 }), invoke);
        mounted = (response['system-entities'] || []).some((entity) => entity['mount-point'] === mountPoint);
        assert.equal(mounted, true, 'DMG attach did not produce the requested mountpoint');
        assert.equal(refresh(), true, 'DMG mount is missing from hdiutil inventory');
        const volume = parsePlist(invoke('/usr/sbin/diskutil', ['info', '-plist', mountPoint]), invoke);
        assert.equal(volume.WritableVolume, false, 'Final DMG volume is writable');
        assert.equal(volume.FilesystemType, 'hfs', 'Final DMG must contain HFS+');
        events.push({ event: 'mounted-readonly', at: new Date().toISOString(), mountPoint, volumeName: volume.VolumeName });
        return volume;
      } catch (error) {
        try { refresh(); } catch (inspectionError) { mounted = true; error.mountInspectionError = String(inspectionError); }
        throw error;
      }
    },
    detach() {
      if (!mounted) return;
      assert.equal(refresh(), true, 'Owned DMG mount unexpectedly disappeared');
      invoke('/usr/bin/hdiutil', ['detach', detachTarget], { timeout: 30_000 });
      assert.equal(refresh(), false, 'DMG is still mounted after detach');
      events.push({ event: 'detached', at: new Date().toISOString(), mountPoint, target: detachTarget });
    },
  };
}

function validateVolumeLayout(mountPoint) {
  const entries = fs.readdirSync(mountPoint).sort();
  const expected = [APP_NAME, 'Applications', '安装说明.txt'];
  const metadata = new Set(['.DS_Store', '.background', '.VolumeIcon.icns', '.fseventsd', '.Trashes', '.Spotlight-V100', '.DocumentRevisions-V100', '.HFS+ Private Directory Data\r']);
  for (const item of expected) assert.ok(entries.includes(item), `DMG is missing ${item}`);
  for (const item of entries) assert.ok(expected.includes(item) || metadata.has(item), `Unexpected DMG root entry: ${item}`);
  const app = fs.lstatSync(path.join(mountPoint, APP_NAME));
  assert.ok(app.isDirectory() && !app.isSymbolicLink(), 'DMG application must be a real directory');
  const shortcut = path.join(mountPoint, 'Applications');
  assert.ok(fs.lstatSync(shortcut).isSymbolicLink(), 'Applications must be a symbolic link');
  assert.equal(fs.readlinkSync(shortcut), '/Applications');
  const readme = path.join(mountPoint, '安装说明.txt');
  assert.ok(fs.lstatSync(readme).isFile() && !fs.lstatSync(readme).isSymbolicLink(), 'Installation instructions must be a regular file');
  const text = fs.readFileSync(readme, 'utf8');
  for (const part of ['Reverie macOS Test', '未公证', 'Applications']) assert.ok(text.includes(part), `Installation instructions omit ${part}`);
  assert.match(text, /[\u4e00-\u9fff]/);
  const finderMetadata = path.join(mountPoint, '.DS_Store');
  assert.ok(fs.lstatSync(finderMetadata).isFile() && fs.statSync(finderMetadata).size > 0, 'DMG Finder layout metadata missing');
  return { entries, applicationsLink: '/Applications', instructionsSha256: hashFile(readme),
    finderMetadataSha256: hashFile(finderMetadata), visualLayout: 'Finder appearance requires separate visual inspection' };
}

function verifyCopyBinding(identity, appManifestPath, sourceTree) {
  const copied = treeManifest(identity.appRoot);
  assert.equal(contentDigest(copied), contentDigest(sourceTree), 'Installed application copy differs from the mounted application');
  verifySuccessfulBuild(identity, appManifestPath, copied);
  return copied;
}

async function auditCandidate(identity, runRoot, outputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const security = await verifyHardenedBundle(identity, outputRoot);
  const { auditMacApp } = require('./macos-app-audit.cjs');
  const app = await auditMacApp({ appPath: identity.appRoot, reportPath: path.join(outputRoot, 'app-native-audit.json') });
  assert.equal(app.ok, true); assert.equal(app.applicationUnchanged, true);
  const { auditMacRuntime } = require('./production-runtime-macos.cjs');
  const runtime = await auditMacRuntime({ runtimeRoot: path.join(identity.resources, 'python'), probe: true,
    scratchRoot: path.join(runRoot, 'tmp'), reportPath: path.join(outputRoot, 'native-runtime-audit.json') });
  assert.equal(runtime.ok, true); assert.equal(runtime.runtimeUnchanged, true);
  return { security, python: standalonePythonProbe(identity, runRoot),
    appNativeAudit: { ok: true, nativeFileCount: app.nativeFiles.length,
      signatureCount: app.signatures.length, loaderContextCount: app.contexts.length, applicationUnchanged: true },
    runtimeAudit: { ok: true, nativeFileCount: runtime.nativeFiles.length, runtimeUnchanged: true,
      storage: runtime.probe.storage, plaintextReadRejected: runtime.probe.plaintextReadRejected,
      networkGuard: runtime.probe.networkGuard } };
}

function validateReportDestination(destination) {
  const resolved = path.resolve(destination);
  assert.ok(!resolved.split(path.sep).some((part) => part.endsWith('.app')), 'Report output cannot be inside an application');
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    assert.notEqual(parent, ancestor, 'Report destination has no existing ancestor');
    ancestor = parent;
  }
  assert.ok(!fs.realpathSync(ancestor).split(path.sep).some((part) => part.endsWith('.app')),
    'Report output resolves through an application');
}

// Cleanup must not depend on a writable report filesystem. Logging failures
// are acceptance failures, but every remaining owned resource still closes.
async function finalizeDmgAcceptance({ active, session, mount, runRoot, outputRoot, report, started, verifyIntegrity }, {
  cleanupApplication = forceCleanup, closeSession = closeAcceptanceSession,
  writeFile = fs.writeFileSync, removeScratch = (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  exists = fs.existsSync,
} = {}) {
  const errors = [];
  const attempt = async (name, action) => {
    try { await action(); return true; }
    catch (error) {
      report.passed = false;
      errors.push({ name, error });
      report.finalizationErrors = errors.map((item) => ({ stage: item.name, message: String(item.error) }));
      return false;
    }
  };
  let processesStopped = true;
  for (const running of active.slice().reverse()) {
    if (!await attempt(`process:${running.label}`, () => cleanupApplication(running))) processesStopped = false;
    await attempt(`log:${running.label}`, () => writeFile(path.join(outputRoot, `${running.label}.log`), running.logs.join('')));
  }
  await attempt('fake-provider-close', () => closeSession(session));
  report.forcedCleanup = active.filter((running) => running.forcedCleanup).map((running) => running.label);
  if (report.forcedCleanup.length) await attempt('forced-cleanup', () => {
    throw new Error('Passing acceptance cannot depend on forced cleanup');
  });
  await attempt('integrity', verifyIntegrity);
  await attempt('detach', () => mount.detach());
  report.noResidualMounts = !mount.mounted;
  report.noResidualProcesses = processesStopped;
  if (!mount.mounted && processesStopped) {
    await attempt('scratch-remove', () => {
      removeScratch(runRoot); report.scratchRemoved = !exists(runRoot);
      assert.equal(report.scratchRemoved, true, 'Acceptance scratch remains after cleanup');
    });
  }
  report.elapsedMs = Date.now() - started;
  report.completedAt = new Date().toISOString();
  const reportWritten = await attempt('final-report-write', () => writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2)));
  return { reportWritten, errors };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: ./script/check-macos-dmg.sh [--dmg /absolute/test.dmg --manifest /absolute/macos-dmg.json] [--app-manifest /absolute/macos-build.json] [--out /absolute/report-parent]\nDefaults to .package-smoke-macos/latest-dmg.json. Tests the final read-only DMG, then a copy outside the repository after detaching the DMG, with shared isolated data, three restart cycles and three storage rejection cases.\n');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--dmg', '--manifest', '--app-manifest', '--out'].includes(args[index]), `Unknown argument: ${args[index]}`);
    absoluteOption(args, args[index]);
  }
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const inputs = resolveDmgInputs(args);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const outputRoot = path.join(absoluteOption(args, '--out') || path.join(frontendRoot, '.dmg-smoke-macos'), runId);
  validateReportDestination(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const tempParent = '/private/tmp/Reverie DMG 验收';
  fs.mkdirSync(tempParent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(tempParent, 'run-'));
  for (const item of ['最终 镜像', '安装 目录', 'user-data', 'tmp', 'cache', 'crashpad']) fs.mkdirSync(path.join(runRoot, item));
  const mountPoint = path.join(runRoot, '最终 镜像');
  const userData = path.join(runRoot, 'user-data');
  const mount = createDmgMount(inputs.dmgPath, mountPoint);
  const report = { schema: 'reverie.macos-dmg-acceptance.v1', passed: false, runId, runRoot, outputRoot,
    inputs, cycles: [], negativeCases: [], mountEvents: mount.events, phases: [],
    validationRevision: ['smoke-dmg-macos.cjs', 'smoke-packaged-macos.cjs', 'macos-confirm-error.swift'].map((name) => ({
      script: `frontend/script/${name}`, sha256: hashFile(path.join(__dirname, name)),
    })),
    scope: 'Final UDZO DMG mounted read-only, then installed copy after detach, same isolated encrypted data and signed candidate',
    excluded: ['formal distribution signing/notarization', 'cross-version/cross-signature Keychain migration', 'Live2D rendering', 'real model quality'] };
  const active = [];
  let session;
  let failure;
  let mountedBaseline;
  let installedBaseline;
  let installedIdentity;
  let binding;
  let manifest;
  const started = Date.now();
  const stage = (name) => {
    report.stage = name; report.stageElapsedMs = Date.now() - started;
    report.phases.push({ name, elapsedMs: report.stageElapsedMs });
    fs.writeFileSync(path.join(outputRoot, 'progress.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`[dmg-smoke] ${name} (${report.stageElapsedMs}ms)\n`);
  };
  const onSignal = () => setInterrupted(true);
  setInterrupted(false); process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    stage('Bind final DMG bytes to successful signed application build');
    ({ binding, manifest } = verifyDmgManifest(inputs)); report.dmgBinding = binding;
    run('/usr/bin/hdiutil', ['verify', inputs.dmgPath], { timeout: 180_000 });
    const imageInfo = parsePlist(run('/usr/bin/hdiutil', ['imageinfo', '-plist', inputs.dmgPath]));
    assert.equal(imageInfo.Format, 'UDZO', 'Delivered image is not UDZO');
    report.image = { verified: true, format: imageInfo.Format };
    stage('Mount actual final image read-only and verify installer contents');
    report.volume = mount.attach();
    report.layout = validateVolumeLayout(mountPoint);
    assert.equal(report.layout.instructionsSha256, manifest.instructionsSha256, 'DMG installation instructions differ from completed build');
    const mountedIdentity = readBundleIdentity(path.join(mountPoint, APP_NAME));
    const bundleVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
      path.join(mountedIdentity.appRoot, 'Contents', 'Info.plist')]);
    assert.equal(bundleVersion, manifest.app.version, 'Application version differs from DMG manifest');
    const existing = processSnapshot().filter((item) => item.name.includes(APP_NAME)
      && path.basename(item.name) === mountedIdentity.executableName);
    assert.deepEqual(existing, [], 'An existing test application is running; its process will not be touched');
    assert.ok(!inside(projectRoot, mountedIdentity.appRoot) && /[\u4e00-\u9fff]/.test(mountedIdentity.appRoot) && mountedIdentity.appRoot.includes(' '));
    assert.throws(() => fs.writeFileSync(path.join(mountedIdentity.appRoot, 'readonly-write-probe'), 'must fail'),
      (error) => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
    report.image.writeRejected = true;
    mountedBaseline = treeManifest(mountedIdentity.appRoot);
    report.buildBinding = verifySuccessfulBuild(mountedIdentity, binding.appManifestPath, mountedBaseline);
    stage('Audit final mounted app, native libraries and standalone Python');
    report.mountedAudit = await auditCandidate(mountedIdentity, runRoot, path.join(outputRoot, 'mounted'));
    session = await createAcceptanceSession(runRoot, userData);
    stage('Final mounted DMG: real Keychain, V4 and simulated-model UI chat');
    report.cycles.push(await runAcceptanceCycle(session, mountedIdentity, 'mounted-1', active, outputRoot, { stage }));
    report.chat = session.chat; report.keychain = session.keychain;
    stage('Copy application to Chinese and space installation path, then detach final DMG');
    const installedApp = path.join(runRoot, '安装 目录', APP_NAME);
    run('/usr/bin/ditto', [mountedIdentity.appRoot, installedApp], { timeout: 180_000 });
    installedIdentity = readBundleIdentity(installedApp);
    installedBaseline = verifyCopyBinding(installedIdentity, binding.appManifestPath, mountedBaseline);
    assert.deepEqual(treeManifest(mountedIdentity.appRoot), mountedBaseline, 'Mounted app changed during acceptance');
    report.mountedBundleUnchanged = true;
    report.mountedBundleHash = mountedBaseline.sha256;
    mount.detach();
    assert.equal(fs.existsSync(mountedIdentity.executable), false, 'Mounted executable remains accessible after detach');
    report.relocation = { installedApp, imageDetachedBeforeInstalledStartup: true, sameUserData: userData };
    stage('Audit copied app after DMG detach');
    report.installedAudit = await auditCandidate(installedIdentity, runRoot, path.join(outputRoot, 'installed'));
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      stage(`Installed restart ${cycle}: same Keychain, messages and IDs after DMG detach`);
      assert.equal(mount.mounted, false);
      report.cycles.push(await runAcceptanceCycle(session, installedIdentity, `installed-${cycle}`, active, outputRoot, { stage }));
    }
    for (const kind of ['vault', 'database', 'missing-vault']) {
      stage(`Installed negative ${kind}: refuse without resetting encrypted data`);
      const requestsBefore = session.fake.requests.length;
      report.negativeCases.push(await verifyNegativeStartup(installedIdentity, runRoot, userData, kind, active, outputRoot));
      assert.equal(session.fake.requests.length, requestsBefore, 'Failed storage startup called the model');
    }
    report.fakeProviderRequests = session.fake.requests.map((request) => ({ method: request.method, path: request.url }));
    report.passed = true;
  } catch (error) { failure = error; report.error = error.stack || String(error); }
  finally {
    try {
      const finalized = await finalizeDmgAcceptance({ active, session, mount, runRoot, outputRoot, report, started,
        verifyIntegrity: () => {
          if (mountedBaseline && mount.mounted) {
            assert.deepEqual(treeManifest(path.join(mountPoint, APP_NAME)), mountedBaseline, 'Mounted app changed');
            report.mountedBundleUnchanged = true;
          }
          if (installedBaseline) {
            const after = treeManifest(installedIdentity.appRoot);
            assert.deepEqual(after, installedBaseline, 'Installed application changed during acceptance');
            report.installedBundleHashBefore = installedBaseline.sha256; report.installedBundleHashAfter = after.sha256;
            report.installedBundleUnchanged = true;
          }
          if (binding) {
            const after = verifyDmgManifest(inputs);
            assert.deepEqual(after.binding, binding, 'DMG or manifests changed during acceptance');
            report.dmgUnchanged = true;
          }
        },
      });
      if (finalized.errors.length) {
        failure ||= finalized.errors[0].error;
        // stderr remains a diagnostic path even when ENOSPC prevents logs and
        // the final report. Never print a success/report-written claim then.
        for (const item of finalized.errors) process.stderr.write(`[dmg-smoke] Finalization ${item.name}: ${item.error}\n`);
      }
      if (finalized.reportWritten) process.stdout.write(`[dmg-smoke] Report: ${path.join(outputRoot, 'report.json')}\n`);
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); setInterrupted(false);
    }
  }
  if (failure) throw failure;
  process.stdout.write('[dmg-smoke] PASS: mounted image chat, copied app with image detached, 3 restarts, 3 storage refusals\n');
}

module.exports = { resolveDmgInputs, verifyDmgManifest, createDmgMount, validateVolumeLayout, verifyCopyBinding, validateReportDestination, finalizeDmgAcceptance, main };
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
