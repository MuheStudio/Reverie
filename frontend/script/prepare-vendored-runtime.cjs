'use strict';

// Offline repair for older pnpm file: snapshots created before the tracked
// renderer distribution was restored. Only missing, hash-verified files are
// copied; existing files with different contents are never overwritten.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = 'pixi-live2d-display';
const PACKAGE_VERSION = '0.4.0-reverie.1';
const FILES = ['cubism4.es.js', 'cubism4.js'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readRegularFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${filename}`);
  return fs.readFileSync(filename);
}

function prepareVendoredRuntime(frontendDirectory = path.resolve(__dirname, '..')) {
  const frontendRoot = fs.realpathSync(frontendDirectory);
  const sourceRoot = path.join(frontendRoot, 'vendor', PACKAGE_NAME);
  const sourcePackage = JSON.parse(readRegularFile(path.join(sourceRoot, 'package.json')));
  if (sourcePackage.name !== PACKAGE_NAME || sourcePackage.version !== PACKAGE_VERSION) {
    throw new Error('Unexpected vendored renderer package identity');
  }
  const upstream = JSON.parse(readRegularFile(path.join(sourceRoot, 'UPSTREAM.json')));
  if (upstream.package !== PACKAGE_NAME || upstream.version !== '0.4.0') {
    throw new Error('Unexpected upstream renderer identity');
  }
  const verified = FILES.map((name) => {
    const relative = `dist/${name}`;
    const expected = upstream.files?.[relative];
    const content = readRegularFile(path.join(sourceRoot, relative));
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || content.length !== expected.bytes || hash(content) !== expected.sha256) {
      throw new Error(`Vendored renderer integrity check failed: ${relative}`);
    }
    return { name, content, sha256: expected.sha256 };
  });

  const nodeModulesRoot = path.join(frontendRoot, 'node_modules');
  if (fs.realpathSync(nodeModulesRoot) !== nodeModulesRoot) {
    throw new Error('Refusing to write to node_modules outside the project');
  }
  const installedRoot = fs.realpathSync(path.join(nodeModulesRoot, PACKAGE_NAME));
  const relativeRoot = path.relative(nodeModulesRoot, installedRoot);
  if (!relativeRoot || relativeRoot.startsWith(`..${path.sep}`) || relativeRoot === '..' || path.isAbsolute(relativeRoot)) {
    throw new Error('Installed renderer is outside this project node_modules');
  }
  const installedPackage = JSON.parse(readRegularFile(path.join(installedRoot, 'package.json')));
  if (installedPackage.name !== PACKAGE_NAME || installedPackage.version !== PACKAGE_VERSION) {
    throw new Error('Installed renderer identity does not match the vendored package');
  }
  const targetDirectory = path.join(installedRoot, 'dist');
  try {
    const stat = fs.lstatSync(targetDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Renderer dist is not an ordinary directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(targetDirectory);
  }
  // Preflight every existing target before repairing any missing file.
  const targets = verified.map((entry) => {
    const target = path.join(targetDirectory, entry.name);
    try {
      if (hash(readRegularFile(target)) !== entry.sha256) {
        throw new Error(`Installed renderer differs from upstream; refusing to overwrite: ${target}`);
      }
      return { ...entry, target, missing: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...entry, target, missing: true };
    }
  });
  for (const entry of targets) {
    if (entry.missing) fs.writeFileSync(entry.target, entry.content, { flag: 'wx', mode: 0o644 });
    if (hash(readRegularFile(entry.target)) !== entry.sha256) {
      throw new Error(`Installed renderer failed post-copy verification: ${entry.target}`);
    }
  }
  return { package: PACKAGE_NAME, version: PACKAGE_VERSION, verified: FILES,
    restored: targets.filter((entry) => entry.missing).map((entry) => entry.name) };
}

if (require.main === module) {
  try { console.log(JSON.stringify(prepareVendoredRuntime(), null, 2)); } catch (error) {
    console.error(`[vendored renderer] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { prepareVendoredRuntime };
