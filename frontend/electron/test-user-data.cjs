'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEST_MARKER = 'TEST-BUILD-DO-NOT-RELEASE.json';
const MAC_TEST_APP_ID = 'com.muhe.reverie.macos.test';
const MAC_TEST_PRODUCT_NAME = 'Reverie macOS Test';

function readBundleIdentifier(packageRoot) {
  const plistPath = path.join(packageRoot, 'Contents', 'Info.plist');
  const stat = fs.lstatSync(plistPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(plistPath) !== plistPath) {
    throw new Error('macOS bundle identity file is unsafe');
  }
  return execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath,
  ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function validateMacTestBuild(packageRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(packageRoot));
  const markerPath = path.join(root, 'Contents', 'Resources', TEST_MARKER);
  let stat;
  try { stat = fs.lstatSync(markerPath); } catch (error) {
    if (error.code === 'ENOENT' && options.required === false) return null;
    throw new Error('packaged macOS test marker is missing or invalid');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 64 * 1024
    || fs.realpathSync(markerPath) !== markerPath) {
    throw new Error('packaged macOS test marker is unsafe');
  }
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {
    throw new Error('packaged macOS test marker is missing or invalid');
  }
  if (marker.schema !== 'reverie.macos-test-build.v1'
    || marker.publishable !== false || marker.distribution !== 'TEST_ONLY_DO_NOT_RELEASE'
    || marker.platform !== 'darwin' || marker.arch !== 'arm64'
    || marker.appId !== MAC_TEST_APP_ID || (options.arch || process.arch) !== 'arm64') {
    throw new Error('packaged macOS test marker does not authorize data isolation');
  }
  let actualAppId;
  try { actualAppId = (options.readBundleIdentifier || readBundleIdentifier)(root); } catch {
    throw new Error('packaged macOS test bundle identity could not be read');
  }
  if (actualAppId !== MAC_TEST_APP_ID) throw new Error('packaged macOS test bundle identity mismatch');
  return Object.freeze({ appId: MAC_TEST_APP_ID, productName: MAC_TEST_PRODUCT_NAME, packageRoot: root });
}

function canonicalFuturePath(requested) {
  let ancestor = path.resolve(requested);
  const suffix = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      const physical = fs.realpathSync(ancestor);
      if (!fs.statSync(physical).isDirectory()) throw new Error('test user-data parent is not a directory');
      return path.join(physical, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink has no valid physical destination; do not walk past
      // it and accidentally treat the path as a new ordinary directory.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('test user-data path contains a dangling symlink'); } catch (inspection) {
        if (inspection.code !== 'ENOENT') throw inspection;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('test user-data path cannot be resolved');
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function resolveTestUserDataOverride(options = {}) {
  const requested = options.requestedPath;
  if (!requested) return null;
  if (!options.isPackaged) {
    throw new Error('test user-data override is reserved for packaged test builds');
  }
  if (!path.isAbsolute(requested)) {
    throw new Error('test user-data override must be absolute');
  }
  const packageRoot = path.resolve(options.packageRoot || '');
  if ((options.platform || process.platform) === 'darwin') {
    const identity = validateMacTestBuild(packageRoot, { ...options, required: true });
    const resolved = canonicalFuturePath(requested);
    if (resolved === identity.packageRoot || resolved.startsWith(`${identity.packageRoot}${path.sep}`)) {
      throw new Error('test user data must not be stored inside the package');
    }
    return resolved;
  }
  const markerPath = path.join(packageRoot, TEST_MARKER);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('packaged test marker is missing or invalid');
  }
  if (
    marker?.schema !== 'reverie.windows-test-build.v1'
    || marker?.publishable !== false
    || marker?.distribution !== 'TEST_ONLY_DO_NOT_RELEASE'
  ) {
    throw new Error('packaged test marker does not authorize data isolation');
  }
  const resolved = path.resolve(requested);
  if (resolved === packageRoot || resolved.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error('test user data must not be stored inside the package');
  }
  return resolved;
}

module.exports = { MAC_TEST_APP_ID, MAC_TEST_PRODUCT_NAME, validateMacTestBuild, resolveTestUserDataOverride };
