'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const FAILURE_CODES = new Set([
  'REVERIE_LOCATION_PERMISSION_DENIED',
  'REVERIE_LOCATION_ACCESS_UNSPECIFIED',
  'REVERIE_LOCATION_SERVICE_DISABLED',
  'REVERIE_LOCATION_DEVICE_UNAVAILABLE',
  'REVERIE_LOCATION_TIMEOUT',
  'REVERIE_LOCATION_NO_DATA',
  'REVERIE_LOCATION_NATIVE_FAILURE',
]);

function publicFailure(code, status = 'Failed') {
  return {
    ok: false,
    code: FAILURE_CODES.has(code) ? code : 'REVERIE_LOCATION_NATIVE_FAILURE',
    status: String(status || 'Failed').slice(0, 64),
    source: 'windows-winrt',
  };
}

function validateResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return publicFailure('REVERIE_LOCATION_NATIVE_FAILURE');
  }
  if (value.ok !== true) return publicFailure(value.code, value.status);
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  const accuracy = Number(value.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1_000_000) {
    return publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'InvalidData');
  }
  const timestamp = new Date(String(value.timestamp || ''));
  if (!Number.isFinite(timestamp.getTime())) {
    return publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'InvalidTimestamp');
  }
  return {
    ok: true,
    code: 'REVERIE_LOCATION_OK',
    status: String(value.status || 'Ready').slice(0, 64),
    latitude,
    longitude,
    accuracy,
    timestamp: timestamp.toISOString(),
    source: 'windows-winrt',
  };
}

class WindowsLocationProvider {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawn = options.spawnImpl || spawn;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.scriptPath = path.resolve(
      options.scriptPath || path.join(__dirname, 'windows-location.ps1'),
    );
    this.powershellPath = options.powershellPath || (
      process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe'
    );
    this.inFlight = null;
  }

  requestCurrent() {
    if (this.platform !== 'win32') {
      return Promise.resolve(publicFailure(
        'REVERIE_LOCATION_DEVICE_UNAVAILABLE',
        'UnsupportedPlatform',
      ));
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._request().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  _request() {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child;
      try {
        child = this.spawn(this.powershellPath, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
        ], {
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'SpawnFailed'));
        return;
      }
      const timer = setTimeout(() => {
        finish(publicFailure('REVERIE_LOCATION_TIMEOUT', 'Timeout'));
        try { child.kill(); } catch {}
      }, this.timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => {
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
          try { child.kill(); } catch {}
          finish(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'OutputLimit'));
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.stderr?.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          try { child.kill(); } catch {}
          finish(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'OutputLimit'));
        }
      });
      child.once('error', () => {
        finish(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'SpawnFailed'));
      });
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0 || stdout.length === 0) {
          finish(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'NativeExit'));
          return;
        }
        try {
          finish(validateResult(JSON.parse(stdout.toString('utf8').trim())));
        } catch {
          finish(publicFailure('REVERIE_LOCATION_NATIVE_FAILURE', 'InvalidJson'));
        }
      });
    });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  WindowsLocationProvider,
  publicFailure,
  validateResult,
};
