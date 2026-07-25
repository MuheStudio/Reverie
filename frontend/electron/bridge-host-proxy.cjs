'use strict';

const { EventEmitter } = require('events');
const { COMMAND_NAMES, MESSAGE_NAMES } = require('./protocol-v3.generated.cjs');

const MAX_RENDERER_FRAME_BYTES = 4 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

function normalizeFrame(value, { renderer = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Bridge frame must be an object');
  }
  const type = String(value.type || '');
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(type)) {
    throw new TypeError('Bridge frame type is invalid');
  }
  if (renderer && type.startsWith('bridge:auth')) {
    throw new TypeError('Renderer may not control bridge authentication');
  }
  if (renderer && !COMMAND_NAMES.has(type)) {
    throw new TypeError('Renderer bridge command is not declared by protocol V3');
  }
  if (!renderer && !MESSAGE_NAMES.has(type)) {
    throw new TypeError('Bridge message is not declared by protocol V3');
  }
  const payload = value.payload === undefined ? {} : value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Bridge frame payload must be an object');
  }
  const requestId = value.request_id === undefined ? '' : String(value.request_id);
  if (requestId && !REQUEST_ID.test(requestId)) {
    throw new TypeError('Bridge request id is invalid');
  }
  const normalized = {
    type,
    payload,
    ...(requestId ? { request_id: requestId } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_RENDERER_FRAME_BYTES) {
    throw new RangeError('Bridge frame is too large');
  }
  return normalized;
}

class BridgeHostProxy extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.supervisor || typeof options.broadcast !== 'function') {
      throw new TypeError('BridgeHostProxy requires a supervisor and broadcaster');
    }
    if (options.supervisor.transport !== 'stdio-framed') {
      throw new TypeError('Production BridgeHostProxy requires framed stdio');
    }
    this.supervisor = options.supervisor;
    this.broadcast = options.broadcast;
    this.auth = null;
    this.framedConnected = false;
    this.framedListener = null;
  }

  async connect() {
    const config = await this.supervisor.waitUntilReady();
    if (!this.framedListener) {
      this.framedListener = (frame) => {
        this.broadcast('bridge:message', normalizeFrame(frame));
      };
      this.supervisor.on('message', this.framedListener);
    }
    this.framedConnected = true;
    this.auth = Object.freeze({
      protocol_version: 2,
      client_id: config.clientId,
      persona_id: config.personaId,
      persona_epoch: config.personaEpoch,
      persona_fingerprint: config.personaFingerprint,
      runtime_degraded: config.runtimeDegraded === true,
      runtime_unavailable: config.runtimeUnavailable || [],
    });
    return this.getRendererConfig();
  }

  getRendererConfig() {
    if (!this.framedConnected || !this.auth) {
      const error = new Error('The host-owned bridge is not authenticated');
      error.code = 'REVERIE_BRIDGE_NOT_READY';
      throw error;
    }
    return Object.freeze({
      transport: 'electron-ipc',
      url: 'electron-ipc://bridge',
      secret: '',
      protocolVersion: 2,
      generation: this.supervisor.generation,
      clientId: this.auth.client_id,
      personaId: this.auth.persona_id,
      personaEpoch: this.auth.persona_epoch,
      personaFingerprint: this.auth.persona_fingerprint,
      modelEpoch: this.auth.model_epoch,
      restartRequired: this.auth.persona_restart_required === true,
    });
  }

  sendFromRenderer(value) {
    const frame = normalizeFrame(value, { renderer: true });
    if (!this.framedConnected || !this.auth) {
      const error = new Error('The host-owned bridge is unavailable');
      error.code = 'REVERIE_BRIDGE_NOT_READY';
      throw error;
    }
    return this.supervisor.sendBusinessFrame(frame);
  }

  disconnect() {
    this.framedConnected = false;
    if (this.framedListener) {
      this.supervisor.off('message', this.framedListener);
      this.framedListener = null;
    }
    this.auth = null;
  }
}

module.exports = {
  BridgeHostProxy,
  MAX_RENDERER_FRAME_BYTES,
  normalizeFrame,
};
