'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { COMMAND_NAMES } = require('./protocol-v4.generated.cjs');

const MAX_FRAME_BYTES = 1024 * 1024;
const READY_SCHEMA = 'reverie.bridge.stdio.ready.v4';
const CONTROL_SCHEMA = 'reverie.bridge.stdio.control.v4';
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function secretHash(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

class LineDecoder {
  constructor(onLine, maxBuffered = 256 * 1024) {
    this.buffer = '';
    this.onLine = onLine;
    this.maxBuffered = maxBuffered;
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (this.buffer.length > this.maxBuffered) {
      this.buffer = this.buffer.slice(-this.maxBuffered);
      throw new Error('Bridge emitted an overlong line');
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }
  }
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length < 2 || body.length > MAX_FRAME_BYTES) {
    throw new RangeError('Framed bridge payload is outside the safe range');
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

class FrameDecoder {
  constructor(onFrame, maxFrameBytes = MAX_FRAME_BYTES) {
    this.onFrame = onFrame;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming;
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size < 2 || size > this.maxFrameBytes) {
        throw new Error('Bridge emitted an invalid frame length');
      }
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let value;
      try { value = JSON.parse(body.toString('utf8')); } catch {
        throw new Error('Bridge emitted invalid framed JSON');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Bridge frame root must be an object');
      }
      this.onFrame(value);
    }
  }
}

function validateReady(value, expected) {
  if (value?.kind !== 'ready' || value.schema !== READY_SCHEMA
    || value.transport !== 'stdio-framed' || value.protocolVersion !== 4) {
    throw new Error('Invalid framed bridge ready record');
  }
  if (!Number.isInteger(value.pid) || value.pid < 1) {
    throw new Error('Bridge PID is invalid');
  }
  if (value.pid !== expected.pid && expected.allowPidMismatch !== true) {
    throw new Error('Bridge PID mismatch');
  }
  if (String(value.secretSha256 || '').toLowerCase()
    !== String(expected.secretSha256 || '').toLowerCase()) {
    throw new Error('Bridge secret digest mismatch');
  }
  if (value.localModeEpoch !== expected.localModeEpoch
    || (value.localModeSessionId || null) !== (expected.localModeSessionId || null)) {
    throw new Error('Bridge local-mode startup state mismatch');
  }
  if (typeof value.personaId !== 'string' || value.personaId.length < 1
    || !Number.isInteger(value.personaEpoch) || value.personaEpoch < 1
    || !/^[a-f0-9]{64}$/i.test(String(value.personaFingerprint || ''))) {
    throw new Error('Bridge persona proof is invalid');
  }
  return Object.freeze({
    transport: 'stdio-framed',
    protocolVersion: 4,
    personaId: value.personaId,
    personaEpoch: value.personaEpoch,
    personaFingerprint: value.personaFingerprint.toLowerCase(),
    bridgePid: value.pid,
    runtimeDegraded: value.runtimeDegraded === true,
    runtimeUnavailable: Array.isArray(value.runtimeUnavailable)
      ? value.runtimeUnavailable.filter((item) => typeof item === 'string').slice(0, 128)
      : [],
    modelEpoch: Number.isInteger(value.modelEpoch) ? value.modelEpoch : 0,
    personaRestartRequired: value.personaRestartRequired === true,
  });
}

class FramedBridgeSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.spawnChild !== 'function') {
      throw new TypeError('FramedBridgeSupervisor requires spawnChild');
    }
    this.transport = 'stdio-framed';
    this.spawnChild = options.spawnChild;
    this.readyTimeoutMs = options.readyTimeoutMs || 20_000;
    this.controlTimeoutMs = options.controlTimeoutMs || 8_000;
    // Windows venv launchers may create the actual interpreter as a child and
    // then exit. The random owner secret and dedicated stdio pipe remain the
    // authority proof; a launcher PID is not a stable identity there.
    this.allowPidMismatch = options.allowPidMismatch ?? process.platform === 'win32';
    this.child = null;
    this.ready = null;
    this.secret = null;
    this.generation = 0;
    this.pendingControls = new Map();
    this.readyPromise = null;
    this.stopping = false;
  }

  start(context = {}) {
    if (this.child) return this.readyPromise;
    this.stopping = false;
    this.secret = crypto.randomBytes(32).toString('base64url');
    this.generation += 1;
    const generation = this.generation;
    const localMode = context.localMode || { active: false, epoch: 0, sessionId: null };
    const child = this.spawnChild({
      secret: this.secret,
      secretSha256: secretHash(this.secret),
      generation,
      localMode,
      transport: this.transport,
    });
    if (!child?.stdout || !child?.stderr || !child?.stdin) {
      throw new Error('Bridge child must expose stdin, stdout, and stderr');
    }
    this.child = child;
    this.ready = null;
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Framed bridge ready handshake timed out'));
        void this.stopAndWait('SIGKILL').catch(() => undefined);
      }, this.readyTimeoutMs);
      timer.unref?.();
      this._readyResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this._readyReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    const decoder = new FrameDecoder((frame) => {
      try {
        this._handleFrame(frame, child, generation, localMode);
      } catch (error) {
        this._fail(error, child);
      }
    });
    child.stdout.on('data', (chunk) => {
      try { decoder.push(chunk); } catch (error) { this._fail(error, child); }
    });
    const stderr = new LineDecoder((line) => this.emit('log', { stream: 'stderr', line }));
    child.stderr.on('data', (chunk) => {
      try { stderr.push(chunk); } catch (error) { this._fail(error, child); }
    });
    child.once('error', (error) => this._handleExit(child, error));
    child.stdin.on('error', (error) => {
      // EPIPE / ERR_STREAM_DESTROYED fires asynchronously when the bridge
      // dies mid-write — exactly the moment restart logic must survive.
      // Without this listener the error escapes uncaught and the whole app
      // crashes instead of scheduling a restart.
      this._handleExit(child, error);
    });
    child.once('close', (code, signal) => {
      this._handleExit(
        child,
        new Error(`Bridge exited (${code ?? 'null'}/${signal || 'none'})`),
      );
    });
    return this.readyPromise;
  }

  _handleFrame(frame, child, generation, localMode) {
    if (child !== this.child || generation !== this.generation) return;
    if (!this.ready) {
      this.ready = validateReady(frame, {
        pid: child.pid,
        allowPidMismatch: this.allowPidMismatch,
        secretSha256: secretHash(this.secret),
        localModeEpoch: Number.isInteger(localMode.epoch) ? localMode.epoch : 0,
        localModeSessionId: localMode.sessionId || null,
      });
      this._readyResolve?.(this.getHostTransportConfig());
      this._readyResolve = null;
      this._readyReject = null;
      this.emit('ready', { ...this.ready, generation });
      return;
    }
    if (frame.kind === 'event') {
      if (!frame.frame || typeof frame.frame !== 'object' || Array.isArray(frame.frame)) {
        throw new Error('Invalid business event frame');
      }
      this.emit('message', frame.frame);
      return;
    }
    if (frame.kind === 'control_result') {
      this._handleControlResult(frame);
      return;
    }
    if (frame.kind === 'fatal_error') {
      throw new Error(String(frame.error || frame.code || 'Bridge protocol failure'));
    }
    throw new Error('Unsupported framed bridge message');
  }

  _handleControlResult(frame) {
    const pending = this.pendingControls.get(frame.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControls.delete(frame.requestId);
    if (frame.ok !== true) {
      const error = new Error(String(frame.error || 'Bridge rejected the control request'));
      error.code = typeof frame.code === 'string' ? frame.code : 'REVERIE_CONTROL_REJECTED';
      error.retryable = frame.retryable === true;
      pending.reject(error);
      return;
    }
    try {
      pending.resolve(pending.validate(frame));
    } catch (error) {
      pending.reject(error);
    }
  }

  _fail(error, child) {
    if (child !== this.child) return;
    this._readyReject?.(error);
    this._readyResolve = null;
    this._readyReject = null;
    // A protocol failure (malformed/oversized frame, fatal_error reply) is
    // not a deliberate stop: it must surface as an exit event so the host
    // schedules a restart. stopAndWait sets `stopping`, which would otherwise
    // make _handleExit swallow the exit and leave the backend permanently
    // dead while the shell keeps running.
    void this.stopAndWait('SIGKILL')
      .then(() => {
        if (this.child === null) this.emit('exit', error);
      })
      .catch(() => undefined);
  }

  _handleExit(child, error) {
    if (child !== this.child) return;
    this._readyReject?.(error);
    this._readyResolve = null;
    this._readyReject = null;
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingControls.clear();
    this.child = null;
    this.ready = null;
    this.secret = null;
    if (!this.stopping) this.emit('exit', error);
  }

  async waitUntilReady() {
    if (!this.readyPromise) throw new Error('Bridge is not running');
    await this.readyPromise;
    return this.getHostTransportConfig();
  }

  getHostTransportConfig() {
    if (!this.child || !this.ready) {
      const error = new Error('The framed bridge is not ready');
      error.code = 'REVERIE_BRIDGE_NOT_READY';
      throw error;
    }
    return Object.freeze({
      ...this.ready,
      clientId: `electron_stdio_${this.child.pid}`,
      generation: this.generation,
    });
  }

  sendBusinessFrame(frame) {
    if (!this.ready) throw new Error('The framed bridge is not ready');
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new TypeError('Business frame must be an object');
    }
    if (!COMMAND_NAMES.has(String(frame.type || ''))) {
      throw new TypeError('Business frame command is not declared by protocol V4');
    }
    const sourcePayload = { ...(frame.payload || {}) };
    const payloadRequestId = frame.type === 'chat:send'
      ? String(sourcePayload.request_id || '')
      : '';
    const requestId = frame.request_id
      ? String(frame.request_id)
      : payloadRequestId || `ipc_${crypto.randomBytes(12).toString('hex')}`;
    if (!COMMAND_ID.test(requestId)) {
      throw new TypeError('Business frame request id is invalid');
    }
    const idempotencyKey = String(
      sourcePayload.idempotency_key
      || sourcePayload.client_request_id
      || requestId,
    );
    if (!COMMAND_ID.test(idempotencyKey)) {
      throw new TypeError('Business frame idempotency key is invalid');
    }
    // Persona proof and idempotency metadata are host-owned envelope fields.
    // Drop renderer copies instead of allowing two conflicting authorities.
    for (const field of [
      'expected_persona_id',
      'expected_persona_epoch',
      'expected_persona_fingerprint',
      'idempotency_key',
      'client_request_id',
    ]) {
      delete sourcePayload[field];
    }
    this._write({
      kind: 'renderer_command',
      schema: 'reverie.command.v4',
      envelope: {
        protocol_version: 4,
        request_id: requestId,
        idempotency_key: idempotencyKey,
        command: String(frame.type || ''),
        persona: {
          persona_id: this.ready.personaId,
          epoch: this.ready.personaEpoch,
          fingerprint: this.ready.personaFingerprint,
        },
        payload: sourcePayload,
        created_at_utc: new Date().toISOString(),
      },
    });
    return { accepted: true };
  }

  setLocalMode({ active, epoch, sessionId }) {
    return this._sendControl('local_mode:set', { active, epoch, sessionId }, (frame) => ({
      active: Boolean(frame.active),
      epoch: frame.epoch,
      sessionId: frame.sessionId || null,
    }));
  }

  setCredentials(credentials) {
    return this._sendControl('credentials:set', { credentials }, (frame) => ({
      applied: {
        llm: frame.applied?.llm === true,
        imageGen: frame.applied?.imageGen === true,
      },
    }));
  }

  requestAmapNearby(request) {
    return this._sendControl('amap:nearby', { request }, (frame) => {
      if (typeof frame.success !== 'boolean' || typeof frame.code !== 'string'
        || !Array.isArray(frame.items) || frame.items.length > 8) {
        throw new Error('Bridge returned an invalid Amap result');
      }
      const fields = [
        'name', 'broad_category', 'distance_band', 'district', 'short_address',
        'provider', 'observed_at',
      ];
      const items = frame.items.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).some((key) => !fields.includes(key))
          || fields.some((key) => typeof item[key] !== 'string')) {
          throw new Error('Bridge returned a forbidden Amap item');
        }
        return Object.fromEntries(fields.map((key) => [key, item[key]]));
      });
      return { ok: frame.success, code: frame.code, items, provider: 'Amap' };
    }, 8_000);
  }

  getProviderConfig() {
    return this._sendControl('provider:get', {}, (frame) => {
      const llm = frame.llm;
      if (!llm || typeof llm !== 'object' || Array.isArray(llm)
        || typeof llm.provider !== 'string'
        || typeof llm.model !== 'string'
        || typeof llm.base_url !== 'string') {
        throw new Error('Bridge returned invalid provider metadata');
      }
      return {
        provider: llm.provider,
        model: llm.model,
        baseUrl: llm.base_url,
        hasApiKey: llm.has_api_key === true,
        modelEpoch: Number.isInteger(llm.model_epoch) ? llm.model_epoch : 0,
      };
    });
  }

  configureProvider(llm) {
    return this._sendControl('provider:configure', { llm }, (frame) => {
      const configured = frame.llm;
      if (!configured || typeof configured !== 'object' || Array.isArray(configured)
        || typeof configured.provider !== 'string'
        || typeof configured.model !== 'string'
        || typeof configured.base_url !== 'string') {
        throw new Error('Bridge returned invalid configured provider metadata');
      }
      return {
        provider: configured.provider,
        model: configured.model,
        baseUrl: configured.base_url,
        hasApiKey: configured.has_api_key === true,
        modelEpoch: Number.isInteger(configured.model_epoch)
          ? configured.model_epoch
          : 0,
        optionalAiConsentsRevoked: frame.optional_ai_consents_revoked === true,
        cancelledOptionalAiTasks: Number.isInteger(frame.cancelled_optional_ai_tasks)
          ? frame.cancelled_optional_ai_tasks
          : 0,
      };
    });
  }

  testProvider(llm, credential) {
    return this._sendControl(
      'provider:test',
      { llm, credential },
      (frame) => {
        if (typeof frame.provider !== 'string'
          || typeof frame.model !== 'string'
          || !Number.isInteger(frame.latency_ms)
          || frame.latency_ms < 0
          || (frame.finish_reason != null && typeof frame.finish_reason !== 'string')) {
          throw new Error('Bridge returned an invalid provider test result');
        }
        return {
          provider: frame.provider,
          model: frame.model,
          latencyMs: frame.latency_ms,
          finishReason: typeof frame.finish_reason === 'string'
            ? frame.finish_reason.slice(0, 64)
            : 'stop',
        };
      },
      35_000,
    );
  }

  _sendControl(type, fields, validate, timeoutMs = this.controlTimeoutMs) {
    if (!this.ready) return Promise.reject(new Error('The framed bridge is not ready'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === 0 ? null : setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error('Bridge control acknowledgement timed out'));
      }, timeoutMs);
      timer?.unref?.();
      this.pendingControls.set(requestId, { resolve, reject, validate, timer });
      try {
        this._write({
          kind: 'control',
          schema: CONTROL_SCHEMA,
          type,
          requestId,
          ...fields,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        reject(error);
      }
    });
  }

  _write(value) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Bridge stdin is unavailable');
    }
    try {
      this.child.stdin.write(encodeFrame(value));
    } catch (error) {
      // A dead pipe can also throw synchronously; route it through the same
      // teardown as an async stream error, then surface the send failure.
      this._handleExit(this.child, error);
      throw error;
    }
  }

  async stopAndWait(signal = 'SIGKILL', timeoutMs = 5000) {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish();
      }, timeoutMs);
      timer.unref?.();
      child.once('close', finish);
      try { child.kill(signal); } catch { finish(); }
    });
    if (this.child === child) {
      this.child = null;
      this.ready = null;
      this.secret = null;
    }
  }
}

module.exports = {
  CONTROL_SCHEMA,
  FrameDecoder,
  FramedBridgeSupervisor,
  MAX_FRAME_BYTES,
  READY_SCHEMA,
  encodeFrame,
  validateReady,
};
