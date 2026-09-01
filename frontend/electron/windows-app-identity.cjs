'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FORMAL_APP_USER_MODEL_ID = 'studio.muhe.reverie';
const TEST_BUILD_MARKER = 'TEST-BUILD-DO-NOT-RELEASE.json';

function readDistributionMetadata(resourcesPath) {
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return null;
  const markerPath = path.join(path.dirname(resourcesPath), TEST_BUILD_MARKER);
  try {
    const metadata = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (metadata?.schema !== 'reverie.windows-test-build.v1'
      || metadata.publishable !== false
      || metadata.distribution !== 'TEST_ONLY_DO_NOT_RELEASE') {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
}

function shouldSetFormalAppUserModelId({ platform, isPackaged, resourcesPath }) {
  if (platform !== 'win32') return false;
  return !isPackaged || readDistributionMetadata(resourcesPath) === null;
}

module.exports = {
  FORMAL_APP_USER_MODEL_ID,
  TEST_BUILD_MARKER,
  readDistributionMetadata,
  shouldSetFormalAppUserModelId,
};
