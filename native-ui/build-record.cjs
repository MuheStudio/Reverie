'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha256(fs.readFileSync(file));
const digest = entries => ({ digestKind: 'ordered-file-link-inventory-sha256',
  sha256: sha256(JSON.stringify(entries)), count: entries.length });

// Only an exact regular-file basename is operating-system display metadata.
// Invalid paths, directories and links must remain visible to all guards.
function finderMetadataFile(entry) {
  return entry?.type === 'file' && typeof entry.path === 'string'
    && !path.posix.isAbsolute(entry.path) && path.posix.normalize(entry.path) === entry.path
    && entry.path.split('/').every(part => part && part !== '.' && part !== '..')
    && [0, 10, 13, 92].every(code => !entry.path.includes(String.fromCharCode(code)))
    && path.posix.basename(entry.path) === '.DS_Store';
}
const withoutFinderMetadata = entries => entries.filter(entry => !finderMetadataFile(entry));

function verifyApplicationInventory(buildDir, app, record) {
  const saved = JSON.parse(fs.readFileSync(path.join(buildDir, 'application-inventory.json')));
  // Authenticate the original bytes/catalog before applying the display-file
  // policy. Historical build records and their inventories are never rewritten.
  assert.deepEqual(digest(saved), record.application.inventory, 'Application inventory changed');
  // directoryInventory intentionally omits directories. Do not let filtering a
  // historical display-file row conceal its replacement by an empty directory.
  for (const row of saved.filter(finderMetadataFile)) {
    const actual = fs.lstatSync(path.join(app, row.path), { throwIfNoEntry: false });
    assert(actual === undefined || actual.isFile(), 'Application changed');
  }
  assert.deepEqual(withoutFinderMetadata(directoryInventory(app)), withoutFinderMetadata(saved), 'Application changed');
}
function verifyExternalTree(input) {
  const actual = directoryInventory(input.path);
  const raw = digest(actual);
  // The original digest remains mandatory. The filtered view can match it
  // when an originally metadata-free SDK acquires a new display file.
  const observed = raw.sha256 === input.inventory.sha256 && raw.count === input.inventory.count
    ? raw : digest(withoutFinderMetadata(actual));
  assert.deepEqual(observed, input.inventory, 'External SDK framework/shader files changed');
}

function entry(root, name) {
  const p = path.join(root, name), s = fs.lstatSync(p);
  if (s.isSymbolicLink()) return { path: name, type: 'link', target: fs.readlinkSync(p) };
  assert(s.isFile(), `Not a regular source file: ${name}`);
  return { path: name, type: 'file', bytes: s.size, sha256: fileHash(p) };
}
function directoryInventory(root) {
  const names = [];
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) walk(name); else names.push(name);
    }
  }
  walk('');
  return names.sort().map(name => entry(root, name));
}
function sourceInventory(root) {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set(names)].filter(name => fs.existsSync(path.join(root, name))).sort()
    .map(name => entry(root, name));
}
function runtimeInputs(entries) {
  return entries.filter(e => /^(native-ui\/|src\/|frontend\/electron\/|frontend\/script\/|config\/.*toolchain|requirements.*lock$|frontend\/package\.json$|frontend\/pnpm-lock\.yaml$|frontend\/src\/components\/DreamRoom\/xiangqiEngine\.ts$|script\/(macos-common|.*qt-macos|.*qt-performance)\.)/.test(e.path));
}
function validateOrdinaryBuildMode(record) {
  assert(!record.diagnostics?.qmlProfilerEnabled && !record.diagnostics?.timingProbesEnabled
    && record.diagnostics?.ordinaryLauncherAllowed !== false,
  'Use the isolated diagnostic performance entry for profiler or timing builds');
}
function verifyBuild(root, buildDir) {
  const record = JSON.parse(fs.readFileSync(path.join(buildDir, 'build.json')));
  assert.equal(record.schema, 'reverie.qt.local-build.v2');
  const app = path.join(buildDir, 'Reverie Scene.app');
  assert(!fs.lstatSync(app).isSymbolicLink(), 'App directory must not be a link');
  verifyApplicationInventory(buildDir, app, record);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app]);
  const source = JSON.parse(fs.readFileSync(path.join(buildDir, 'source-inventory.json')));
  assert.deepEqual(digest(source), record.source.inventory, 'Source inventory changed');
  assert.deepEqual(digest(runtimeInputs(source)), record.source.runtimeInputs, 'Input subset changed');
  assert.deepEqual(withoutFinderMetadata(runtimeInputs(sourceInventory(root))), withoutFinderMetadata(runtimeInputs(source)),
    'Current native/backend inputs differ from the fixed candidate; rebuild explicitly');
  const saved = JSON.parse(fs.readFileSync(path.join(buildDir, 'application-inventory.json')));
  assert.deepEqual(digest(saved), record.application.inventory, 'Application inventory changed');
  for (const input of record.externalFiles) assert.equal(fileHash(input.path), input.sha256,
    `External build dependency changed: ${path.basename(input.path)}`);
  for (const input of record.externalTrees) verifyExternalTree(input);
  return { record, app, binary: path.join(app, 'Contents/MacOS/Reverie Scene'),
    buildManifestSha256: fileHash(path.join(buildDir, 'build.json')) };
}
// Installed preview roots intentionally have no Git checkout. Preserve the
// existing development verifier above, while reusing its recorded application,
// source-catalog and external-dependency checks for frozen runtime copies.
function verifyRecordedBuild(buildDir, executableCopies = null) {
  const record = JSON.parse(fs.readFileSync(path.join(buildDir, 'build.json')));
  assert.equal(record.schema, 'reverie.qt.local-build.v2');
  const app = path.join(buildDir, 'Reverie Scene.app');
  assert(!fs.lstatSync(app).isSymbolicLink(), 'App directory must not be a link');
  verifyApplicationInventory(buildDir, app, record);
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app]);
  const source = JSON.parse(fs.readFileSync(path.join(buildDir, 'source-inventory.json')));
  assert.deepEqual(digest(source), record.source.inventory, 'Source inventory changed');
  assert.deepEqual(digest(runtimeInputs(source)), record.source.runtimeInputs, 'Input subset changed');
  const saved = JSON.parse(fs.readFileSync(path.join(buildDir, 'application-inventory.json')));
  assert.deepEqual(digest(saved), record.application.inventory, 'Application inventory changed');
  const copied = new Map();
  if (executableCopies !== null) {
    assert.deepEqual(Object.keys(executableCopies).sort(), ['node', 'python']);
    for (const [key, matches] of [
      ['python', record.externalFiles.filter(input => /^python3(?:\.\d+)?$/.test(path.basename(input.path)))],
      ['node', record.externalFiles.filter(input => path.basename(input.path) === 'node')],
    ]) {
      assert.equal(matches.length, 1, 'Executable must have one original build binding');
      const replacement = executableCopies[key];
      assert(typeof replacement === 'string' && path.isAbsolute(replacement));
      assert(fs.statSync(replacement).isFile(), 'Executable copy must be a file');
      copied.set(matches[0].path, replacement);
    }
  }
  for (const input of record.externalFiles) assert.equal(fileHash(copied.get(input.path) || input.path), input.sha256,
    `External build dependency changed: ${path.basename(input.path)}`);
  for (const input of record.externalTrees) verifyExternalTree(input);
  return { record, app, binary: path.join(app, 'Contents/MacOS/Reverie Scene'),
    buildManifestSha256: fileHash(path.join(buildDir, 'build.json')) };
}
module.exports = { sha256, fileHash, digest, directoryInventory, sourceInventory, runtimeInputs, finderMetadataFile,
  withoutFinderMetadata, validateOrdinaryBuildMode, verifyBuild, verifyRecordedBuild };
