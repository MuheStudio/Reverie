'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertLive2DReleaseGate,
  evaluateLive2DRuntime,
  scanForbiddenLive2DFiles,
  validateLive2DLicense,
} = require('./live2d-release-gate.cjs');

function license(overrides = {}) {
  return {
    schema: 'reverie.live2d.public-license.v1',
    applicationId: 'studio.muhe.reverie',
    contractId: 'contract-1234',
    platforms: ['win32'],
    validFrom: '2025-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    licensee: 'Muhe Studio',
    ...overrides,
  };
}

test('Live2D license is bound to app, platform, contract, and validity interval', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(validateLive2DLicense(license(), { now, platform: 'win32' }).contractId, 'contract-1234');
  assert.throws(() => validateLive2DLicense(license({ applicationId: 'evil.app' }), { now }), /applicationId/i);
  assert.throws(() => validateLive2DLicense(license({ platforms: ['darwin'] }), { now }), /win32/i);
  assert.throws(
    () => validateLive2DLicense(license({ expiresAt: '2025-12-31T00:00:00Z' }), { now }),
    /currently valid/i,
  );
});

test('unlicensed release scan catches Core, moc3, samples, and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-'));
  fs.writeFileSync(path.join(root, 'Live2DCubismCore.dll'), 'x');
  fs.writeFileSync(path.join(root, 'character.moc3'), 'x');
  fs.mkdirSync(path.join(root, 'cubism-sample'));
  const findings = scanForbiddenLive2DFiles([root]);
  assert.ok(findings.length >= 3);
  assert.throws(
    () => assertLive2DReleaseGate({ buildEnabled: '0', scanRoots: [root] }),
    /Unlicensed/i,
  );
});

test('runtime needs both build/runtime gates and a valid manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-'));
  const manifest = path.join(root, 'license.json');
  fs.writeFileSync(manifest, JSON.stringify(license()));
  const enabled = evaluateLive2DRuntime({
    isPackaged: true,
    buildEnabled: '1',
    runtimeEnabled: '1',
    licensePath: manifest,
    now: Date.parse('2026-01-01T00:00:00Z'),
    platform: 'win32',
    coreAvailable: true,
    rendererAvailable: true,
  });
  assert.equal(enabled.available, true);
  assert.match(evaluateLive2DRuntime({
    isPackaged: true,
    buildEnabled: '1',
    runtimeEnabled: '1',
    licensePath: manifest,
    coreAvailable: false,
    rendererAvailable: true,
  }).reason, /Core is missing/i);
  assert.equal(evaluateLive2DRuntime({
    isPackaged: true,
    buildEnabled: '1',
    runtimeEnabled: '0',
    licensePath: manifest,
    coreAvailable: true,
    rendererAvailable: true,
  }).available, false);
});
