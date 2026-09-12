'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { VoicePackManager } = require('./voice-pack-manager.cjs');

const manager = new VoicePackManager({ storageDir: workerData.storageDir });

function publicRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const { recordPath: _recordPath, ...safe } = record;
  return safe;
}

if (workerData.operation === 'setActive') {
  try {
    manager.setActive(workerData.id);
    parentPort.postMessage({ type: 'active', id: workerData.id });
  } catch (error) {
    parentPort.postMessage({ type: 'error', code: error?.code || 'VOICE_PACK_IMPORT_FAILED', message: error?.message || 'Voice-pack activation failed' });
  }
} else {
  try {
    const preview = manager.preview(workerData.sourcePath);
    parentPort.postMessage({ type: 'preview', preview });
  } catch (error) {
    parentPort.postMessage({ type: 'error', code: error?.code || 'VOICE_PACK_IMPORT_FAILED', message: error?.message || 'Voice-pack preview failed' });
  }
}

parentPort.on('message', (message) => {
  if (message?.type !== 'commit') return;
  try {
    const record = manager.commit(message.previewId, message.confirmation);
    manager.setActive(record.id);
    parentPort.postMessage({ type: 'committed', record: publicRecord(record) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', code: error?.code || 'VOICE_PACK_IMPORT_FAILED', message: error?.message || 'Voice-pack commit failed' });
  }
});
