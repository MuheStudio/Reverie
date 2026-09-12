'use strict';

const { parentPort, workerData } = require('worker_threads');
const { AvatarManager } = require('./avatar-manager.cjs');
const { createRuntimeTextureTransformer } = require('./live2d-import-transform.cjs');

function serializeError(error) {
  const code = typeof error?.code === 'string' && error.code.startsWith('AVATAR_')
    ? error.code
    : 'AVATAR_IMPORT_FAILED';
  const message = code === 'AVATAR_IMPORT_FAILED'
    ? 'Avatar import could not be completed'
    : String(error.message || 'Avatar import failed').slice(0, 500);
  return { code, message };
}

function maybeTextureTransformer(config) {
  if (!config || typeof config !== 'object') return null;
  try {
    return createRuntimeTextureTransformer(config);
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
    return () => {
      throw new Error(detail || 'texture transformer is unavailable');
    };
  }
}

try {
  const manager = new AvatarManager({
    storageDir: workerData.storageDir,
    live2dRuntime: workerData.live2dRuntime,
    live2dTextureTransformer: maybeTextureTransformer(workerData.textureTransformer),
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
