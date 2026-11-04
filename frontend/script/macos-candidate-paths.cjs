'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function validateCandidateName(name) {
  assert.ok(typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name),
  'Candidate name must be 1–64 lowercase letters, digits or hyphens, starting with a letter');
  return name;
}
function parseBuildOptions(args) {
  const options = { reuseRuntime: false, candidateName: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--reuse-runtime' && !options.reuseRuntime) options.reuseRuntime = true;
    else if (args[index] === '--candidate' && options.candidateName === null) {
      options.candidateName = validateCandidateName(args[++index]);
    } else throw new Error('Usage: package-macos.sh [--reuse-runtime] [--candidate safe-name]');
  }
  return options;
}
function resolveBuildPaths({ projectRoot, home, candidateName = null }) {
  const root = path.resolve(projectRoot), frontend = path.join(root, 'frontend');
  const baseBuildRoot = path.join(home, 'Library', 'Developer', 'Reverie', 'LocalBuilds',
    crypto.createHash('sha256').update(root).digest('hex').slice(0, 12));
  const baseOutput = path.join(frontend, 'release-macos');
  if (candidateName !== null) validateCandidateName(candidateName);
  const buildRoot = candidateName ? path.join(baseBuildRoot, 'candidates', candidateName) : baseBuildRoot;
  const output = candidateName ? path.join(baseOutput, 'candidates', candidateName) : baseOutput;
  const artifactRoot = path.join(buildRoot, 'mac-arm64');
  return { candidateName, baseBuildRoot, buildRoot, output,
    appStage: path.join(buildRoot, '.macos-installer-app'), resources: path.join(buildRoot, '.macos-installer-resources'),
    artifactRoot, appPath: path.join(artifactRoot, 'Reverie macOS Test.app'),
    reusableRuntime: path.join(baseBuildRoot, '.macos-installer-resources', 'python') };
}
function rejectSymlinkAncestors(directory) {
  let current = path.resolve(directory);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(!stat || (stat.isDirectory() && !stat.isSymbolicLink()), 'Candidate output ancestor is redirected or not a directory');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function reserveCandidateOutput(layout) {
  assert.ok(layout.candidateName, 'Named candidate required for exclusive output reservation');
  // Unknown, successful and failed candidates alike must be preserved. Select
  // a new name instead of guessing whether an existing directory is disposable.
  for (const directory of [layout.buildRoot, layout.output]) {
    rejectSymlinkAncestors(path.dirname(directory));
    try { fs.lstatSync(directory); throw new Error(`Candidate output conflict: ${directory}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const directory of [layout.buildRoot, layout.output]) fs.mkdirSync(path.dirname(directory), { recursive: true });
  const created = [];
  try {
    for (const directory of [layout.buildRoot, layout.output]) {
      fs.mkdirSync(directory, { mode: 0o700 }); created.push(directory);
    }
  } catch (error) {
    // Only remove the still-empty directory created by this exact reservation.
    for (const directory of created.reverse()) { try { fs.rmdirSync(directory); } catch {} }
    throw error;
  }
}
function copyRuntimeTree(source, destination, options) {
  fs.cpSync(source, destination, options);
  // copyFile/cp applies the controller umask to newly created files. Restore
  // each verified source mode only on the new tree; never chmod the source or
  // follow a copied symlink. The unchanged inventory check remains mandatory.
  const preserveModes = (input, output) => {
    const sourceStat = fs.lstatSync(input), copiedStat = fs.lstatSync(output);
    if (sourceStat.isSymbolicLink()) {
      assert.ok(copiedStat.isSymbolicLink() && fs.readlinkSync(input) === fs.readlinkSync(output),
        'Runtime mode preservation encountered a changed symlink');
      return;
    }
    assert.ok(!copiedStat.isSymbolicLink(), 'Runtime mode preservation refuses a redirected output');
    if (sourceStat.isDirectory()) {
      assert.ok(copiedStat.isDirectory(), 'Runtime directory changed during copy');
      for (const name of fs.readdirSync(input)) preserveModes(path.join(input, name), path.join(output, name));
      fs.chmodSync(output, sourceStat.mode & 0o777);
    } else {
      assert.ok(sourceStat.isFile() && copiedStat.isFile(), 'Runtime file changed during copy');
      const descriptor = fs.openSync(output, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { fs.fchmodSync(descriptor, sourceStat.mode & 0o777); }
      finally { fs.closeSync(descriptor); }
    }
  };
  preserveModes(source, destination);
}
function copyVerifiedRuntime({ source, destination, manifestName, expectedManifestSha256, expectedFiles, inspectTree },
  copy = copyRuntimeTree) {
  assert.ok(fs.lstatSync(source).isDirectory() && !fs.lstatSync(source).isSymbolicLink(), 'Runtime source must be a real directory');
  const sourceManifest = path.join(source, manifestName);
  const manifestHash = () => crypto.createHash('sha256').update(fs.readFileSync(sourceManifest)).digest('hex');
  const inventory = directory => inspectTree(directory).filter(item => item.path !== manifestName);
  assert.equal(manifestHash(), expectedManifestSha256, 'Verified runtime manifest changed before copy');
  assert.deepEqual(inventory(source), expectedFiles, 'Verified runtime source changed before copy');
  try { fs.lstatSync(destination); throw new Error('Candidate runtime output conflict; no overwrite'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  copy(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: false, errorOnExist: true });
  assert.deepEqual(inventory(destination), expectedFiles, 'Copied candidate runtime inventory differs');
  const copiedHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, manifestName))).digest('hex');
  assert.equal(copiedHash, expectedManifestSha256, 'Copied candidate runtime manifest differs');
  assert.equal(manifestHash(), expectedManifestSha256, 'Verified runtime source manifest changed during copy');
  assert.deepEqual(inventory(source), expectedFiles, 'Verified runtime source changed during copy');
  return destination;
}
module.exports = { validateCandidateName, parseBuildOptions, resolveBuildPaths, reserveCandidateOutput, copyVerifiedRuntime };
