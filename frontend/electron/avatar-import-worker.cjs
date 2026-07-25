'use strict';

const { parentPort, workerData } = require('worker_threads');
const { AvatarManager } = require('./avatar-manager.cjs');

function serializeError(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('AVATAR_')
    ? error.code
    : 'AVATAR_IMPORT_FAILED';
  const message = code === 'AVATAR_IMPORT_FAILED'
    ? 'Avatar import could not be completed'
    : String(error.message || 'Avatar import failed').slice(0, 500);
  return { code, message };
}

try {
  const manager = new AvatarManager({
    storageDir: workerData.storageDir,
    live2dRuntime: workerData.live2dRuntime,
  });
  if (workerData.operation === 'addVrma') {
    const motionCandidate = manager.beginMotionImport(workerData.avatarId, workerData.sourcePath, {
      importId: workerData.importId,
    });
    parentPort.postMessage({ ok: true, motionCandidate });
  } else {
    const candidate = workerData.sourceIsDirectory
      ? manager.beginImportDirectory(workerData.sourcePath, { importId: workerData.importId })
      : manager.beginImport(workerData.sourcePath, { importId: workerData.importId });
    parentPort.postMessage({ ok: true, candidate });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
}
