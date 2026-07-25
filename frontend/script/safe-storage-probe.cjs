'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, safeStorage } = require('electron');

const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-safe-storage-'));
app.setPath('userData', probeDir);

app.whenReady().then(() => {
  const available = safeStorage.isEncryptionAvailable();
  let roundTrip = false;
  let errorCode = '';
  if (available) {
    try {
      const canary = `reverie-safe-storage-${process.pid}`;
      roundTrip = safeStorage.decryptString(safeStorage.encryptString(canary)) === canary;
    } catch (error) {
      errorCode = String(error?.code || error?.name || 'UNKNOWN');
    }
  }
  process.stdout.write(`${JSON.stringify({
    platform: process.platform,
    available,
    roundTrip,
    errorCode,
  })}\n`);
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({
    platform: process.platform,
    available: false,
    roundTrip: false,
    errorCode: String(error?.code || error?.name || 'STARTUP_FAILED'),
  })}\n`);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  app.quit();
});
