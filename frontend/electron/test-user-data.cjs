'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEST_MARKER = 'TEST-BUILD-DO-NOT-RELEASE.json';

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

module.exports = { resolveTestUserDataOverride };
