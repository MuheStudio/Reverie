'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const APPROVED_ICON_SHA256 = '13cd9611c1558c0a253897627111940c4728f3d8ca2e81b2cc28090185c0b531';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyPackagedWindowsIcons({ executable, resourceIcon, platform = process.platform }) {
  if (sha256(resourceIcon) !== APPROVED_ICON_SHA256) {
    throw new Error(`Packaged icon does not match the approved icon: ${resourceIcon}`);
  }
  if (platform !== 'win32') return true;
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);

  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:REVERIE_VERIFY_EXE)',
    'if ($null -eq $icon -or $icon.Width -lt 16 -or $icon.Height -lt 16) { exit 1 }',
    '$icon.Dispose()',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    windowsHide: true,
    env: { ...process.env, REVERIE_VERIFY_EXE: executable },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Windows could not extract an associated icon from: ${executable}`);
  }
  return true;
}

module.exports = {
  APPROVED_ICON_SHA256,
  verifyPackagedWindowsIcons,
};
