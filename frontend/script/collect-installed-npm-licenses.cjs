'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const LICENSE_NAME = /^(?:licen[cs]es?|copying|notice)(?:[._-].*)?$/i;

function readPackageFile(packageRoot, filename) {
  const real = fs.realpathSync(filename);
  const before = fs.statSync(real);
  if (!inside(packageRoot, real) || !before.isFile()) throw new Error('Dependency notice file escaped its package');
  const bytes = fs.readFileSync(real);
  const after = fs.statSync(real);
  if (!after.isFile() || bytes.length !== before.size || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error(`Dependency file was short-read or changed during collection: ${path.relative(packageRoot, real)}`);
  }
  return bytes;
}

function ensureOutputDirectory(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error('License output directory is redirected through a symlink');
    }
  }
}

/** Read the installed production graph without registry/cache access or executing package code. */
function collectInstalledNpmLicenses(frontendDirectory, destinationDirectory) {
  const frontend = fs.realpathSync(frontendDirectory);
  const destination = path.resolve(destinationDirectory);
  const visited = new Map();
  const rootManifest = JSON.parse(readPackageFile(frontend, path.join(frontend, 'package.json')));

  function resolveInstalled(name, parent, optional) {
    if (!PACKAGE_NAME.test(name) || ['.', '..'].includes(name.split('/').at(-1))) throw new Error(`Invalid dependency name: ${name}`);
    const resolver = createRequire(path.join(parent, 'package.json'));
    // Append a subpath so names shared with Node builtins (url/events/...) still
    // resolve the installed browser package declared by this manifest.
    for (const directory of resolver.resolve.paths(`${name}/package.json`) || []) {
      if (!inside(frontend, directory)) continue;
      const candidate = path.join(directory, ...name.split('/'));
      let stat;
      try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const real = fs.realpathSync(candidate);
      if (!inside(frontend, real)) throw new Error(`Installed dependency escaped frontend: ${name}`);
      if ((!stat.isDirectory() && !stat.isSymbolicLink()) || !fs.statSync(real).isDirectory()) {
        throw new Error(`Installed dependency is not a package directory: ${name}`);
      }
      return real;
    }
    if (optional) return null;
    throw new Error(`Required production dependency is not installed: ${name}`);
  }

  function edges(metadata, includePeers) {
    const result = new Map();
    for (const name of Object.keys(metadata.dependencies || {})) result.set(name, false);
    for (const name of Object.keys(metadata.optionalDependencies || {})) result.set(name, true);
    if (includePeers) for (const name of Object.keys(metadata.peerDependencies || {})) {
      if (!result.has(name)) result.set(name, metadata.peerDependenciesMeta?.[name]?.optional === true);
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b));
  }

  function visit(directory) {
    if (visited.has(directory)) return;
    const manifestBytes = readPackageFile(directory, path.join(directory, 'package.json'));
    const metadata = JSON.parse(manifestBytes);
    if (typeof metadata.name !== 'string' || !PACKAGE_NAME.test(metadata.name)
      || typeof metadata.version !== 'string' || !/^[0-9A-Za-z.+_-]+$/.test(metadata.version)) {
      throw new Error('Installed dependency has invalid package identity');
    }
    const record = { directory, metadata, manifestSha256: hash(manifestBytes), files: [], missingOptional: [] };
    visited.set(directory, record);
    function notice(filename, relative, ancestors = new Set()) {
      const real = fs.realpathSync(filename);
      if (!inside(directory, real)) throw new Error(`Dependency notice escaped package: ${metadata.name}`);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        if (ancestors.has(real)) throw new Error('Dependency notice directory contains a symlink cycle');
        const next = new Set(ancestors).add(real);
        for (const name of fs.readdirSync(real).sort()) notice(path.join(real, name), path.join(relative, name), next);
      } else if (stat.isFile()) {
        const bytes = readPackageFile(directory, real);
        if (!record.files.some((file) => file.path === relative)) record.files.push({ path: relative, bytes, sha256: hash(bytes) });
      } else throw new Error('Dependency notice is not a regular file or directory');
    }
    for (const name of fs.readdirSync(directory).sort()) if (LICENSE_NAME.test(name)) notice(path.join(directory, name), name);
    const declared = typeof metadata.license === 'string' ? metadata.license.match(/^SEE LICEN[CS]E IN (.+)$/i) : null;
    if (declared) {
      const filename = path.resolve(directory, declared[1]);
      if (!inside(directory, filename)) throw new Error('Declared license path escaped its package');
      notice(filename, path.relative(directory, filename));
    }
    for (const [name, optional] of edges(metadata, true)) {
      const dependency = resolveInstalled(name, directory, optional);
      if (dependency) visit(dependency);
      else record.missingOptional.push(name);
    }
  }
  for (const [name, optional] of edges(rootManifest, false)) {
    const dependency = resolveInstalled(name, frontend, optional);
    if (dependency) visit(dependency);
  }

  // Validate the complete input graph before creating any output.
  ensureOutputDirectory(destination);
  const inventory = [];
  for (const record of [...visited.values()].sort((a, b) => a.directory.localeCompare(b.directory))) {
    const { metadata } = record;
    const identity = `${metadata.name}@${metadata.version}`;
    const sourcePath = path.relative(frontend, record.directory).split(path.sep).join('/');
    const targetName = `${identity.replace(/[^a-zA-Z0-9._-]/g, '_')}-${hash(sourcePath).slice(0, 12)}`;
    const target = path.join(destination, targetName);
    ensureOutputDirectory(target);
    for (const file of record.files) {
      const output = path.join(target, file.path);
      ensureOutputDirectory(path.dirname(output));
      fs.writeFileSync(output, file.bytes, { flag: 'wx' });
    }
    const entry = { name: metadata.name, version: metadata.version, license: metadata.license || metadata.licenses || 'UNKNOWN',
      sourcePath, manifestSha256: record.manifestSha256, directory: targetName,
      licenseFiles: record.files.map(({ path: name, sha256 }) => ({ path: name.split(path.sep).join('/'), sha256 })),
      licenseTextStatus: record.files.length ? 'included' : 'package-metadata-only',
      packageMetadata: Object.fromEntries(['author', 'contributors', 'repository', 'homepage', 'copyright']
        .filter((key) => metadata[key] != null).map((key) => [key, metadata[key]])),
      missingOptionalDependencies: record.missingOptional };
    fs.writeFileSync(path.join(target, 'metadata.json'), `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
    inventory.push(entry);
  }
  fs.writeFileSync(path.join(destination, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

module.exports = { collectInstalledNpmLicenses };
