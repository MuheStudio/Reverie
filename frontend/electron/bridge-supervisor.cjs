'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const READY_PREFIX = 'REVERIE_BRIDGE_READY ';
const CONTROL_PREFIX = 'REVERIE_BRIDGE_CONTROL ';
const READY_SCHEMA = 'reverie.bridge.ready.v1';
const CONTROL_SCHEMA = 'reverie.bridge.control.v1';
const CONTROL_ACK_SCHEMA = 'reverie.bridge.control.ack.v1';

function secretHash(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function isLoopbackHost(value) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(value || '').toLowerCase());
}

function validateReadyPayload(value, expected = {}) {
  if (!value || typeof value !== 'object' || value.schema !== READY_SCHEMA) {
    throw new Error('Invalid bridge ready schema');
  }
  if (!isLoopbackHost(value.host)) throw new Error('Bridge must bind to loopback');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('Bridge reported an invalid port');
  }
  if (expected.pid && value.pid !== expected.pid) throw new Error('Bridge PID mismatch');
  if (!/^[a-f0-9]{64}$/i.test(String(value.secretSha256 || ''))
    || value.secretSha256.toLowerCase() !== String(expected.secretSha256 || '').toLowerCase()) {
    throw new Error('Bridge secret digest mismatch');
  }
  if (!Number.isInteger(value.protocolVersion) || value.protocolVersion !== 2) {
    throw new Error('Unsupported bridge protocol version');
  }
  if (typeof value.personaId !== 'string' || value.personaId.length < 1 || value.personaId.length > 256
    || !Number.isInteger(value.personaEpoch) || value.personaEpoch < 1
    || !/^[a-f0-9]{64}$/i.test(String(value.personaFingerprint || ''))) {
    throw new Error('Bridge persona proof is invalid');
  }
  if ((value.localModeSessionId || null) !== (expected.localModeSessionId || null)) {
    throw new Error('Bridge local-mode session mismatch');
  }
  return {
    schema: READY_SCHEMA,
    host: value.host === 'localhost' ? '127.0.0.1' : value.host,
    port: value.port,
    pid: value.pid,
    protocolVersion: 2,
    localModeEpoch: Number.isInteger(value.localModeEpoch) ? value.localModeEpoch : 0,
    localModeSessionId: value.localModeSessionId || null,
    personaId: value.personaId,
    personaEpoch: value.personaEpoch,
    personaFingerprint: value.personaFingerprint.toLowerCase(),
  };
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

class BridgeSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    if (typeof options.spawnChild !== 'function') {
      throw new TypeError('BridgeSupervisor requires spawnChild');
    }
    this.spawnChild = options.spawnChild;
    this.readyTimeoutMs = options.readyTimeoutMs || 20_000;
    this.controlTimeoutMs = options.controlTimeoutMs || 8_000;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.child = null;
    this.secret = null;
    this.ready = null;
    this.generation = 0;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyTimer = null;
    this.pendingControls = new Map();
    this.stopping = false;
    this.expectedLocalModeEpoch = 0;
    this.expectedLocalModeSessionId = null;
  }

  start(context = {}) {
    if (this.child) return this.readyPromise;
    this.stopping = false;
    this.secret = crypto.randomBytes(32).toString('base64url');
    this.generation += 1;
    const generation = this.generation;
    this.expectedLocalModeEpoch = Number.isInteger(context.localMode?.epoch)
      ? context.localMode.epoch
      : 0;
    this.expectedLocalModeSessionId = context.localMode?.sessionId || null;
    const digest = secretHash(this.secret);
    const child = this.spawnChild({
      secret: this.secret,
      secretSha256: digest,
      generation,
      localMode: context.localMode || { active: false, epoch: 0 },
    });
    if (!child?.stdout || !child?.stderr || !child?.stdin) {
      throw new Error('Bridge child must expose stdin, stdout, and stderr');
    }
    this.child = child;
    this.ready = null;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const decode = (line, stream) => this._handleLine(line, stream, child, digest, generation);
    const stdout = new LineDecoder((line) => decode(line, 'stdout'));
    const stderr = new LineDecoder((line) => decode(line, 'stderr'));
    child.stdout.on('data', (chunk) => {
      try { stdout.push(chunk); } catch (error) {
        this._failReady(error, child);
        void this.stopAndWait('SIGKILL').catch(() => undefined);
      }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr.push(chunk); } catch (error) {
        this._failReady(error, child);
        void this.stopAndWait('SIGKILL').catch(() => undefined);
      }
    });
    child.once('error', (error) => this._handleExit(child, error));
    child.once('close', (code, signal) => {
      this._handleExit(child, new Error(`Bridge exited (${code ?? 'null'}/${signal || 'none'})`));
    });
    this.readyTimer = this.setTimer(() => {
      this._failReady(new Error('Bridge ready handshake timed out'), child);
      void this.stopAndWait('SIGKILL').catch(() => undefined);
    }, this.readyTimeoutMs);
    this.readyTimer?.unref?.();
    return this.readyPromise;
  }

  _handleLine(line, stream, child, digest, generation) {
    if (child !== this.child || generation !== this.generation) return;
    if (line.startsWith(READY_PREFIX)) {
      let payload;
      try { payload = JSON.parse(line.slice(READY_PREFIX.length)); } catch {
        this._failReady(new Error('Bridge ready line is not valid JSON'), child);
        this.kill('SIGKILL');
        return;
      }
      try {
        const ready = validateReadyPayload(payload, {
          pid: child.pid,
          secretSha256: digest,
          localModeSessionId: this.expectedLocalModeSessionId,
        });
        if (ready.localModeEpoch !== this.expectedLocalModeEpoch) {
          throw new Error('Bridge local-mode startup epoch mismatch');
        }
        if (this.ready) throw new Error('Bridge emitted duplicate ready records');
        this.ready = ready;
        this.clearTimer(this.readyTimer);
        this.readyTimer = null;
        this.readyResolve?.(this.getConnectionConfig());
        this.readyResolve = null;
        this.readyReject = null;
        this.emit('ready', { ...ready, generation });
      } catch (error) {
        this._failReady(error, child);
        void this.stopAndWait('SIGKILL').catch(() => undefined);
      }
      return;
    }
    if (line.startsWith(CONTROL_PREFIX)) {
      this._handleControlAck(line.slice(CONTROL_PREFIX.length));
      return;
    }
    this.emit('log', { stream, line });
  }

  _handleControlAck(json) {
    let payload;
    try { payload = JSON.parse(json); } catch { return; }
    if (payload?.schema !== CONTROL_ACK_SCHEMA || typeof payload.requestId !== 'string') return;
    const pending = this.pendingControls.get(payload.requestId);
    if (!pending) return;
    try {
      if (payload.ok !== true) {
        const error = new Error(String(payload.error || 'Bridge rejected the control request'));
        error.code = typeof payload.code === 'string'
          ? payload.code
          : 'REVERIE_CONTROL_REJECTED';
        throw error;
      }
      const result = pending.validateAck(payload);
      pending.resolve(result);
    } catch (error) {
      pending.reject(error);
    }
    this.clearTimer(pending.timer);
    this.pendingControls.delete(payload.requestId);
  }

  _failReady(error, child) {
    if (child !== this.child || this.ready) return;
    this.clearTimer(this.readyTimer);
    this.readyTimer = null;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }

  _handleExit(child, error) {
    if (child !== this.child) return;
    this._failReady(error, child);
    for (const pending of this.pendingControls.values()) {
      this.clearTimer(pending.timer);
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
    return this.getConnectionConfig();
  }

  getConnectionConfig() {
    if (!this.child || !this.ready || !this.secret) {
      const error = new Error('The local bridge is not ready');
      error.code = 'REVERIE_BRIDGE_NOT_READY';
      throw error;
    }
    const host = this.ready.host.includes(':') ? `[${this.ready.host}]` : this.ready.host;
    return Object.freeze({
      url: `ws://${host}:${this.ready.port}`,
      secret: this.secret,
      origin: 'reverie-desktop',
      protocolVersion: 2,
      generation: this.generation,
    });
  }

  async setLocalMode({ active, epoch, sessionId }) {
    await this.waitUntilReady();
    if (!Number.isInteger(epoch) || epoch < 1) throw new TypeError('Local-mode epoch is invalid');
    const expected = {
      active: Boolean(active),
      epoch,
      sessionId: sessionId ? String(sessionId) : null,
    };
    return this._sendControl('local_mode:set', expected, {
      validateAck(payload) {
        if (payload.type && payload.type !== 'local_mode:set') {
          throw new Error('Bridge local-mode acknowledgement type mismatch');
        }
        if (payload.epoch !== expected.epoch || Boolean(payload.active) !== expected.active
          || (payload.sessionId || null) !== expected.sessionId) {
          throw new Error('Bridge local-mode acknowledgement mismatch');
        }
        return {
          epoch: payload.epoch,
          active: Boolean(payload.active),
          sessionId: payload.sessionId || null,
        };
      },
    });
  }

  async setCredentials(credentials) {
    await this.waitUntilReady();
    const normalized = credentials && typeof credentials === 'object'
      ? credentials
      : {};
    return this._sendControl('credentials:set', { credentials: normalized }, {
      validateAck(payload) {
        if (payload.type !== 'credentials:set'
          || !payload.applied || typeof payload.applied !== 'object') {
          throw new Error('Bridge credential acknowledgement mismatch');
        }
        return {
          applied: {
            llm: payload.applied.llm === true,
            imageGen: payload.applied.imageGen === true,
          },
        };
      },
    });
  }

  async backupToFile(filePath) {
    await this.waitUntilReady();
    return this._sendControl('backup:file:export', { path: String(filePath) }, {
      timeoutMs: 15 * 60 * 1000,
      validateAck(payload) {
        if (payload.type !== 'backup:file:export' || payload.operation !== 'export') {
          throw new Error('Bridge backup-export acknowledgement mismatch');
        }
        return {
          operation: 'export',
          completed: true,
        };
      },
    });
  }

  async restoreFromFile(filePath) {
    await this.waitUntilReady();
    return this._sendControl('backup:file:import', { path: String(filePath) }, {
      // A destructive restore continues in the Python worker even if a UI
      // timer expires.  Never report a timeout while it may still commit.
      timeoutMs: 0,
      validateAck(payload) {
        if (payload.type !== 'backup:file:import' || payload.operation !== 'import'
          || !payload.result || typeof payload.result !== 'object') {
          throw new Error('Bridge backup-import acknowledgement mismatch');
        }
        return {
          operation: 'import',
          completed: true,
          result: { ...payload.result },
        };
      },
    });
  }

  _sendControl(type, fields, options = {}) {
    if (!this.child?.stdin || !this.ready) {
      const error = new Error('The local bridge is not ready');
      error.code = 'REVERIE_BRIDGE_NOT_READY';
      return Promise.reject(error);
    }
    const requestId = crypto.randomUUID();
    const payload = {
      schema: CONTROL_SCHEMA,
      type,
      requestId,
      ...fields,
    };
    const validateAck = typeof options.validateAck === 'function'
      ? options.validateAck
      : (value) => value;
    const timeoutDisabled = options.timeoutMs === 0;
    const timeoutMs = Number.isFinite(options.timeoutMs) && !timeoutDisabled
      ? Math.max(100, Math.min(Number(options.timeoutMs), 30 * 60 * 1000))
      : this.controlTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = timeoutDisabled ? null : this.setTimer(() => {
          this.pendingControls.delete(requestId);
          reject(new Error('Bridge control acknowledgement timed out'));
        }, timeoutMs);
      timer?.unref?.();
      this.pendingControls.set(requestId, {
        resolve,
        reject,
        timer,
        validateAck,
      });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pendingControls.get(requestId);
        if (!pending) return;
        this.clearTimer(pending.timer);
        this.pendingControls.delete(requestId);
        reject(error);
      });
    });
  }

  kill(signal = 'SIGTERM') {
    this.stopping = true;
    this.clearTimer(this.readyTimer);
    this.readyTimer = null;
    const child = this.child;
    if (child && child.exitCode === null) child.kill(signal);
    this.child = null;
    this.ready = null;
    this.secret = null;
    for (const pending of this.pendingControls.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingControls.clear();
  }

  async stopAndWait(signal = 'SIGKILL', timeoutMs = 5000) {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.kill(signal);
      return;
    }
    this.stopping = true;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = this.setTimer(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(new Error('Bridge process did not terminate in time'));
      }, timeoutMs);
      timer?.unref?.();
      child.once('close', () => finish());
      child.once('error', (error) => finish(error));
      try {
        child.kill(signal);
      } catch (error) {
        finish(error);
      }
    }).finally(() => {
      if (this.child === child && child.exitCode !== null) {
        this.child = null;
        this.ready = null;
        this.secret = null;
      }
    });
  }
}

module.exports = {
  BridgeSupervisor,
  CONTROL_ACK_SCHEMA,
  CONTROL_PREFIX,
  CONTROL_SCHEMA,
  LineDecoder,
  READY_PREFIX,
  READY_SCHEMA,
  isLoopbackHost,
  secretHash,
  validateReadyPayload,
};
