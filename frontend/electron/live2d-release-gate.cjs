'use strict';

const fs = require('fs');
const path = require('path');

const LICENSE_SCHEMA = 'reverie.live2d.public-license.v1';
const APP_ID = 'studio.muhe.reverie';
const FORBIDDEN_PACKAGE_NAMES = [
  /live2dcubismcore/i,
  /\.moc3$/i,
  /cubism[\\/_-]?(?:sdk|sample|framework)/i,
  /live2d[\\/_-]?(?:sdk|sample)/i,
];

function parseIso(value, label) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) throw new Error(`Live2D license ${label} is invalid`);
  return timestamp;
}

function validateLive2DLicense(value, options = {}) {
  const now = options.now ?? Date.now();
  const platform = options.platform || process.platform;
  const appId = options.appId || APP_ID;
  if (!value || typeof value !== 'object' || value.schema !== LICENSE_SCHEMA) {
    throw new Error('Live2D publication license manifest has an invalid schema');
  }
  if (value.applicationId !== appId) throw new Error('Live2D license applicationId does not match this app');
  if (typeof value.contractId !== 'string' || !/^[A-Za-z0-9._/-]{4,128}$/.test(value.contractId)) {
    throw new Error('Live2D license contractId is missing or invalid');
  }
  if (!Array.isArray(value.platforms) || !value.platforms.includes(platform)) {
    throw new Error(`Live2D license does not cover ${platform}`);
  }
  const validFrom = parseIso(value.validFrom, 'validFrom');
  const expiresAt = parseIso(value.expiresAt, 'expiresAt');
  if (validFrom > now || expiresAt < now || expiresAt <= validFrom) {
    throw new Error('Live2D publication license is not currently valid');
  }
  if (typeof value.licensee !== 'string' || !value.licensee.trim()) {
    throw new Error('Live2D licensee is missing');
  }
  return Object.freeze({
    schema: LICENSE_SCHEMA,
    applicationId: appId,
    contractId: value.contractId,
    platforms: [...value.platforms],
    validFrom: new Date(validFrom).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    licensee: value.licensee.trim(),
  });
}

function readLicenseManifest(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ''));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error('Live2D license manifest must be a small regular file');
  }
  return validateLive2DLicense(JSON.parse(fs.readFileSync(resolved, 'utf8')), options);
}

function scanForbiddenLive2DFiles(roots) {
  const findings = [];
  const visit = (root, current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      findings.push({ path: current, reason: 'symlink' });
      return;
    }
    const relative = path.relative(root, current).replace(/\\/g, '/');
    if (relative && FORBIDDEN_PACKAGE_NAMES.some((pattern) => pattern.test(relative))) {
      findings.push({ path: current, reason: 'live2d-runtime-or-model' });
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) visit(root, path.join(current, name));
    }
  };
  for (const rootValue of roots) {
    const root = path.resolve(rootValue);
    if (fs.existsSync(root)) visit(root, root);
  }
  return findings;
}

function evaluateLive2DRuntime(options = {}) {
  const isPackaged = Boolean(options.isPackaged);
  const buildEnabled = String(options.buildEnabled ?? process.env.REVERIE_LIVE2D_PUBLIC_BUILD) === '1';
  const runtimeEnabled = String(options.runtimeEnabled ?? process.env.REVERIE_LIVE2D_PUBLIC_RUNTIME) === '1';
  const coreAvailable = options.coreAvailable === true;
  const rendererAvailable = options.rendererAvailable === true;
  const developmentEnabled = !isPackaged
    && String(options.developmentEnabled ?? process.env.REVERIE_LIVE2D_DEV) === '1';
  if (developmentEnabled) {
    if (!coreAvailable || !rendererAvailable) {
      return Object.freeze({
        available: false,
        coreAvailable,
        rendererAvailable,
        licenseAccepted: false,
        developmentOnly: true,
        reason: !coreAvailable
          ? 'Live2D Cubism Core is missing'
          : 'Live2D renderer package is missing',
      });
    }
    return Object.freeze({
      available: true,
      coreAvailable: true,
      rendererAvailable: true,
      licenseAccepted: false,
      developmentOnly: true,
      reason: 'Development-only Live2D runtime; public distribution is disabled',
    });
  }
  if (!buildEnabled || !runtimeEnabled) {
    return Object.freeze({
      available: false,
      coreAvailable,
      rendererAvailable,
      licenseAccepted: false,
      developmentOnly: false,
      reason: 'Live2D public runtime is disabled by the build and runtime gates',
    });
  }
  if (!coreAvailable || !rendererAvailable) {
    return Object.freeze({
      available: false,
      coreAvailable,
      rendererAvailable,
      licenseAccepted: false,
      developmentOnly: false,
      reason: !coreAvailable
        ? 'Live2D Cubism Core is missing'
        : 'Live2D renderer package is missing',
    });
  }
  try {
    const license = readLicenseManifest(options.licensePath, options);
    return Object.freeze({
      available: true,
      coreAvailable: true,
      rendererAvailable: true,
      licenseAccepted: true,
      developmentOnly: false,
      contractId: license.contractId,
      expiresAt: license.expiresAt,
      reason: '',
    });
  } catch (error) {
    return Object.freeze({
      available: false,
      coreAvailable,
      rendererAvailable,
      licenseAccepted: false,
      developmentOnly: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function assertLive2DReleaseGate(options = {}) {
  const enabled = String(options.buildEnabled ?? process.env.REVERIE_LIVE2D_PUBLIC_BUILD) === '1';
  if (enabled) {
    return readLicenseManifest(options.licensePath, {
      now: options.now,
      appId: options.appId || APP_ID,
      platform: options.platform || 'win32',
    });
  }
  const findings = scanForbiddenLive2DFiles(options.scanRoots || []);
  if (findings.length) {
    const sample = findings.slice(0, 8).map((item) => item.path).join(', ');
    throw new Error(`Unlicensed Live2D runtime/model files found in release inputs: ${sample}`);
  }
  return null;
}

module.exports = {
  APP_ID,
  FORBIDDEN_PACKAGE_NAMES,
  LICENSE_SCHEMA,
  assertLive2DReleaseGate,
  evaluateLive2DRuntime,
  readLicenseManifest,
  scanForbiddenLive2DFiles,
  validateLive2DLicense,
};
