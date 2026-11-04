'use strict';
// Static final-payload audit. Never executes the app or its Python interpreter.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const policy = require('./source-migration-policy.cjs');
const root = path.resolve(__dirname, '../..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function inventory(directory) {
  const realRoot = fs.realpathSync(directory), files = [];
  function visit(current) {
    const stat = fs.lstatSync(current), relative = path.relative(directory, current);
    if (stat.isSymbolicLink()) {
      const target = path.relative(realRoot, fs.realpathSync(current));
      assert(target !== '..' && !target.startsWith(`..${path.sep}`) && !path.isAbsolute(target), 'Escaping application link');
      files.push({ path: relative, symlink: fs.readlinkSync(current) });
    } else if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    else { assert(stat.isFile(), 'Unexpected application object'); files.push({ path: relative, bytes: stat.size, sha256: hash(fs.readFileSync(current)) }); }
  }
  visit(directory);
  return { files, sha256: hash(JSON.stringify(files)) };
}
function audit(manifestPath, outputPath) {
  assert(!fs.existsSync(outputPath), 'Audit output already exists');
  const manifestStat = fs.lstatSync(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= 64 * 1024 * 1024, 'Invalid build manifest');
  const raw = fs.readFileSync(manifestPath), build = JSON.parse(raw);
  assert(path.isAbsolute(build.appPath) && path.basename(build.appPath) === 'Reverie macOS Test.app', 'Expected explicit Reverie test application');
  const appStat = fs.lstatSync(build.appPath);
  assert(appStat.isDirectory() && !appStat.isSymbolicLink(), 'Expected real application directory');
  const marker = JSON.parse(fs.readFileSync(path.join(build.appPath, 'Contents/Resources/TEST-BUILD-DO-NOT-RELEASE.json')));
  assert.equal(marker.appId, 'com.muhe.reverie.macos.test');
  assert.equal(marker.publishable, false);
  assert.equal(hash(JSON.stringify(build.candidate.files)), build.candidate.sha256, 'Source manifest digest mismatch');
  const before = inventory(build.appPath);
  assert.deepEqual(before, build.bundle, 'Actual application differs from successful build');
  const resources = path.join(build.appPath, 'Contents/Resources'), archive = path.join(resources, 'app.asar');
  const frontend = createRequire(path.join(root, 'frontend/package.json'));
  const builder = createRequire(frontend.resolve('electron-builder'));
  const dependencies = createRequire(builder.resolve('app-builder-lib'));
  const asar = dependencies('@electron/asar');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-summary-audit-'));
  try {
    asar.extractAll(archive, scratch);
    const finalPayload = policy.assertSourceMigrationStage({ projectRoot: root, resourceRoot: resources, appRoot: scratch });
    const rendererGraph=JSON.parse(fs.readFileSync(path.join(scratch,'dist/retired-dependency-build-graph.json')));
    require('./xiangqi-package-contract.cjs').assertRetirementGraph(rendererGraph);
    const npm=JSON.parse(fs.readFileSync(path.join(resources,'THIRD_PARTY_LICENSES/npm/inventory.json')));
    require('./retired-dependency-policy.cjs').assertNoRetiredPackages(npm);
    const modules = [];
    for (const [directory, names] of [['worldbook', policy.REQUIRED_WORLDBOOK_MODULES], ['conversation_summary', policy.REQUIRED_SUMMARY_MODULES]]) {
      for (const name of names) {
        const relative = `src/${directory}/${name}`, bytes = fs.readFileSync(path.join(resources, relative));
        const expected = build.candidate.files.find(item => item.path === relative);
        assert(expected && expected.sha256 === hash(bytes) && expected.bytes === bytes.length, `Packaged module differs: ${relative}`);
        modules.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
    for (const relative of ['LICENSE', 'NOTICE']) {
      const expected = build.candidate.files.find(item => item.path === relative);
      assert(expected && expected.sha256 === hash(fs.readFileSync(path.join(resources, relative))), 'Candidate notice differs');
    }
    assert(!fs.existsSync(path.join(resources, 'src/memory/hypa_v3.py')));
    for (const name of ['main.js', 'preload.js', ...policy.REQUIRED_MEDIA_MODULES]) {
      const expected = build.candidate.files.find(item => item.path === `frontend/electron/${name}`);
      assert(expected && expected.sha256 === hash(asar.extractFile(archive, `electron/${name}`)), 'ASAR host differs from source candidate');
    }
    assert.deepEqual(inventory(build.appPath), before, 'Audit modified the application');
    const result = { schema: 'reverie.macos-source-audit.v1', passed: true, completedAt: new Date().toISOString(),
      codeCommit: build.candidate.head, buildManifestSha256: hash(raw), sourceSha256: build.candidate.sha256,
      signedBundleSha256: before.sha256, digestKind: 'ordered-signed-app-inventory-json-sha256',
      asarSha256: hash(fs.readFileSync(archive)), finalPayload, modules, oldHypaAbsent: true,
      retiredElephantopsAbsent: true, installedNpmNoticeInstances:npm.length, rendererGraphSha256:hash(fs.readFileSync(path.join(scratch,'dist/retired-dependency-build-graph.json'))), rendererGraph,
      appUnchanged: true, applicationExecuted: false, overallLicenseSwitched: false,
      scope: 'Final actual files and extracted ASAR; signature/runtime/dynamic claims belong to their separate reports.' };
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: audit-macos-source.cjs BUILD_MANIFEST OUTPUT_JSON');
    const r = audit(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
    console.log(JSON.stringify({ passed: r.passed, codeCommit: r.codeCommit, signedBundleSha256: r.signedBundleSha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, audit };
