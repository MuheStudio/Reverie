'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const SCHEMA = 'reverie.focus.v1';
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 180 * 60;
const MAX_TIMER_MS = 2_147_000_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampDurationSeconds(value) {
  const seconds = Math.round(finiteNumber(value, 0));
  if (seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    throw new RangeError(`Focus duration must be between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS} seconds`);
  }
  return seconds;
}

function idleState(epoch = 0) {
  return {
    schema: SCHEMA,
    phase: 'idle',
    id: null,
    generation: 0,
    epoch,
    durationSeconds: 0,
    remainingSeconds: 0,
    startedAtUtc: null,
    endsAtUtc: null,
    pausedAtUtc: null,
    completedAtUtc: null,
    stoppedAtUtc: null,
    localModeActive: false,
    requiresAudioRearm: false,
    completionEffect: null,
    updatedAtUtc: new Date(0).toISOString(),
  };
}

function isStateShape(value) {
  const base = Boolean(
    value
    && typeof value === 'object'
    && value.schema === SCHEMA
    && ['idle', 'starting', 'running', 'paused', 'completed', 'stopped'].includes(value.phase)
    && Number.isInteger(value.generation)
    && value.generation >= 0
    && Number.isInteger(value.epoch)
    && value.epoch >= 0,
  );
  if (!base) return false;
  if (!Number.isInteger(value.durationSeconds) || value.durationSeconds < 0
    || value.durationSeconds > MAX_DURATION_SECONDS
    || !Number.isInteger(value.remainingSeconds) || value.remainingSeconds < 0
    || value.remainingSeconds > value.durationSeconds) return false;
  if (value.id !== null && (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 64)) return false;
  for (const key of [
    'startedAtUtc', 'endsAtUtc', 'pausedAtUtc', 'completedAtUtc', 'stoppedAtUtc', 'updatedAtUtc',
  ]) {
    if (value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])))) {
      return false;
    }
  }
  if (value.completionEffect != null) {
    if (typeof value.completionEffect !== 'object'
      || typeof value.completionEffect.id !== 'string'
      || value.completionEffect.id !== `focus-complete:${value.id}`
      || value.completionEffect.source !== 'local_focus') return false;
  }
  return true;
}

function normalizeLoadedState(value) {
  return {
    ...value,
    localModeActive: typeof value.localModeActive === 'boolean'
      ? value.localModeActive
      : ['starting', 'running', 'paused'].includes(value.phase),
    completionEffect: value.completionEffect
      ? {
          ...value.completionEffect,
          claimedAtUtc: value.completionEffect.claimedAtUtc || null,
          deliveredAtUtc: value.completionEffect.deliveredAtUtc || null,
        }
      : null,
  };
}

class FocusManager {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('FocusManager requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.statePath = path.join(this.storageDir, 'focus-state.json');
    this.backupPath = path.join(this.storageDir, 'focus-state.backup.json');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.monotonicNow = typeof options.monotonicNow === 'function'
      ? options.monotonicNow
      : () => performance.now();
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    this.enterLocalMode = typeof options.enterLocalMode === 'function'
      ? options.enterLocalMode
      : async () => undefined;
    this.exitLocalMode = typeof options.exitLocalMode === 'function'
      ? options.exitLocalMode
      : async () => undefined;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    this.onCompletion = typeof options.onCompletion === 'function' ? options.onCompletion : () => {};
    this.timer = null;
    this.monotonicAnchor = null;
    this.operation = Promise.resolve();
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.state = normalizeLoadedState(this._loadState());
    this._reconcile({ persist: true });
    if (this.state.phase === 'completed') this._scheduleCompletionEffect();
    if (this.state.localModeActive && ['completed', 'stopped'].includes(this.state.phase)) {
      void this._serial(() => this._releaseLocalMode());
    }
  }

  _loadFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('invalid focus state file');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isStateShape(parsed)) throw new Error('invalid focus state schema');
      return normalizeLoadedState(parsed);
  }

  _loadState() {
    for (const candidate of [this.statePath, this.backupPath]) {
      try {
        if (fs.existsSync(candidate)) return this._loadFile(candidate);
      } catch (error) {
        const quarantine = `${candidate}.corrupt-${this.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try { fs.renameSync(candidate, quarantine); } catch {}
      }
    }
    return idleState();
  }

  _persist() {
    fs.mkdirSync(this.storageDir, { recursive: true });
    this.state.updatedAtUtc = new Date(this.now()).toISOString();
    const tempPath = path.join(
      this.storageDir,
      `.focus-state-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const bytes = Buffer.from(`${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(this.statePath)) fs.copyFileSync(this.statePath, this.backupPath);
      fs.renameSync(tempPath, this.statePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }

  _serial(operation) {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }

  _remainingMs() {
    if (this.state.phase !== 'running') return Math.max(0, this.state.remainingSeconds * 1000);
    const wallDeadline = Date.parse(this.state.endsAtUtc || '');
    const wallRemaining = Number.isFinite(wallDeadline) ? wallDeadline - this.now() : 0;
    const storedCeiling = Math.max(0, finiteNumber(this.state.remainingSeconds) * 1000);
    let remaining = Math.min(storedCeiling, Math.max(0, wallRemaining));
    if (this.monotonicAnchor && this.monotonicAnchor.id === this.state.id
      && this.monotonicAnchor.generation === this.state.generation) {
      const elapsed = Math.max(0, this.monotonicNow() - this.monotonicAnchor.at);
      // While this process is alive, monotonic time is authoritative. Wall-clock
      // jumps must not shorten or extend a focus interval.
      remaining = Math.max(0, this.monotonicAnchor.remainingMs - elapsed);
    }
    return Math.max(0, remaining);
  }

  _publicState() {
    const current = clone(this.state);
    if (current.phase === 'running') current.remainingSeconds = Math.ceil(this._remainingMs() / 1000);
    return current;
  }

  _emit() {
    this.onStateChange(this._publicState());
  }

  _armTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.state.phase !== 'running') return;
    const expectedId = this.state.id;
    const expectedGeneration = this.state.generation;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1, this._remainingMs()));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this._serial(async () => {
        if (this.state.phase !== 'running'
          || this.state.id !== expectedId
          || this.state.generation !== expectedGeneration) return;
        if (this._remainingMs() > 0) {
          this._checkpointRunning();
          this._armTimer();
          return;
        }
        this._markCompleted();
        this._scheduleCompletionEffect();
        await this._releaseLocalMode();
      });
    }, delay);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  _checkpointRunning() {
    if (this.state.phase !== 'running') return;
    const remainingMs = this._remainingMs();
    this.state.remainingSeconds = Math.ceil(remainingMs / 1000);
    this.monotonicAnchor = {
      id: this.state.id,
      generation: this.state.generation,
      at: this.monotonicNow(),
      remainingMs,
    };
    this._persist();
  }

  _markCompleted() {
    if (this.state.phase !== 'running') return;
    const completedAtUtc = new Date(this.now()).toISOString();
    const effectId = `focus-complete:${this.state.id}`;
    this.state = {
      ...this.state,
      phase: 'completed',
      remainingSeconds: 0,
      endsAtUtc: this.state.endsAtUtc || completedAtUtc,
      completedAtUtc,
      completionEffect: {
        id: effectId,
        source: 'local_focus',
        createdAtUtc: completedAtUtc,
        claimedAtUtc: null,
        deliveredAtUtc: null,
      },
    };
    this.monotonicAnchor = null;
    this._persist();
    this._emit();
  }

  _scheduleCompletionEffect() {
    if (this.state.phase !== 'completed' || !this.state.completionEffect
      || this.state.completionEffect.deliveredAtUtc
      || this.state.completionEffect.claimedAtUtc) return;
    // Claim durably before invoking an external effect. The renderer can always
    // reconstruct the deterministic effect from state, so a crash cannot cause
    // duplicate API/memory work.
    this.state.completionEffect.claimedAtUtc = new Date(this.now()).toISOString();
    this._persist();
    const effect = clone(this.state.completionEffect);
    const publicState = this._publicState();
    Promise.resolve(this.onCompletion(effect, publicState)).then(() => {
      if (this.state.completionEffect?.id !== effect.id
        || this.state.completionEffect.deliveredAtUtc) return;
      this.state.completionEffect.deliveredAtUtc = new Date(this.now()).toISOString();
      this._persist();
      this._emit();
    }).catch(() => {
      // Keep the claim. The completion remains visible in getState/onChanged,
      // but an OS notification is never duplicated after an ambiguous crash.
    });
  }

  async _releaseLocalMode() {
    if (!this.state.localModeActive) return;
    const epoch = this.state.epoch + 1;
    const sessionId = this.state.id;
    this.state.epoch = epoch;
    this._persist();
    const gateState = await this.exitLocalMode({ epoch, sessionId });
    if (this.state.id !== sessionId || !['completed', 'stopped'].includes(this.state.phase)) return;
    if (Number.isInteger(gateState?.epoch) && gateState.epoch >= epoch) {
      this.state.epoch = gateState.epoch;
    }
    this.state.localModeActive = false;
    this._persist();
    this._emit();
  }

  _reconcile({ persist = false } = {}) {
    if (this.state.phase === 'starting') {
      // A crash during gate activation cannot prove that remote traffic was stopped.
      // Fail closed: preserve the epoch but require an explicit new start.
      this.state = {
        ...this.state,
        phase: 'stopped',
        stoppedAtUtc: new Date(this.now()).toISOString(),
        endsAtUtc: null,
        generation: this.state.generation + 1,
        localModeActive: true,
      };
      persist = true;
    }
    if (this.state.phase === 'running') {
      const remainingMs = this._remainingMs();
      if (remainingMs <= 0) {
        this._markCompleted();
        this._scheduleCompletionEffect();
        void this._serial(() => this._releaseLocalMode());
        return this._publicState();
      }
      this.state.remainingSeconds = Math.ceil(remainingMs / 1000);
      this.monotonicAnchor = {
        id: this.state.id,
        generation: this.state.generation,
        at: this.monotonicNow(),
        remainingMs,
      };
      if (persist) this._persist();
      this._armTimer();
    } else if (persist) {
      this._persist();
    }
    return this._publicState();
  }

  getState() {
    return this._reconcile({ persist: this.state.phase === 'running' });
  }

  reconcileGateEpoch(epoch, active) {
    if (!Number.isInteger(epoch) || epoch < 0) throw new TypeError('Gate epoch is invalid');
    if (epoch > this.state.epoch) this.state.epoch = epoch;
    if (active && ['starting', 'running', 'paused', 'completed', 'stopped'].includes(this.state.phase)) {
      this.state.localModeActive = true;
    }
    this._persist();
    return this._publicState();
  }

  start(input = {}) {
    return this._serial(async () => {
      const durationSeconds = clampDurationSeconds(
        input.durationSeconds ?? finiteNumber(input.durationMinutes) * 60,
      );
      if (['starting', 'running', 'paused'].includes(this.state.phase)
        || this.state.localModeActive) {
        throw new Error('A focus session is already active');
      }
      const now = this.now();
      const id = crypto.randomUUID();
      const epoch = this.state.epoch + 1;
      const generation = this.state.generation + 1;
      this.state = {
        schema: SCHEMA,
        phase: 'starting',
        id,
        generation,
        epoch,
        durationSeconds,
        remainingSeconds: durationSeconds,
        startedAtUtc: new Date(now).toISOString(),
        endsAtUtc: null,
        pausedAtUtc: null,
        completedAtUtc: null,
        stoppedAtUtc: null,
        localModeActive: false,
        requiresAudioRearm: false,
        completionEffect: null,
        updatedAtUtc: new Date(now).toISOString(),
      };
      this._persist();
      this._emit();
      try {
        const gateState = await this.enterLocalMode({ epoch, sessionId: id });
        if (Number.isInteger(gateState?.epoch) && gateState.epoch >= epoch) {
          this.state.epoch = gateState.epoch;
        }
      } catch (error) {
        this.state = {
          ...idleState(epoch),
          generation,
          updatedAtUtc: new Date(this.now()).toISOString(),
        };
        this._persist();
        this._emit();
        throw error;
      }
      this.state.localModeActive = true;
      const runningAt = this.now();
      const remainingMs = durationSeconds * 1000;
      this.state.phase = 'running';
      this.state.startedAtUtc = new Date(runningAt).toISOString();
      this.state.endsAtUtc = new Date(runningAt + remainingMs).toISOString();
      this.monotonicAnchor = { id, generation, at: this.monotonicNow(), remainingMs };
      this._persist();
      this._armTimer();
      this._emit();
      return this._publicState();
    });
  }

  pause() {
    return this._serial(async () => {
      if (this.state.phase !== 'running') throw new Error('No running focus session');
      const remainingMs = this._remainingMs();
      this.state.phase = 'paused';
      this.state.remainingSeconds = Math.ceil(remainingMs / 1000);
      this.state.pausedAtUtc = new Date(this.now()).toISOString();
      this.state.endsAtUtc = null;
      this.state.generation += 1;
      this.monotonicAnchor = null;
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      this._persist();
      this._emit();
      return this._publicState();
    });
  }

  resume() {
    return this._serial(async () => {
      if (this.state.phase !== 'paused') throw new Error('No paused focus session');
      const remainingMs = Math.max(0, this.state.remainingSeconds * 1000);
      if (remainingMs <= 0) {
        this.state.phase = 'running';
        this._markCompleted();
        this._scheduleCompletionEffect();
        await this._releaseLocalMode();
        return this._publicState();
      }
      this.state.phase = 'running';
      this.state.generation += 1;
      this.state.pausedAtUtc = null;
      this.state.endsAtUtc = new Date(this.now() + remainingMs).toISOString();
      this.monotonicAnchor = {
        id: this.state.id,
        generation: this.state.generation,
        at: this.monotonicNow(),
        remainingMs,
      };
      this._persist();
      this._armTimer();
      this._emit();
      return this._publicState();
    });
  }

  stop() {
    return this._serial(async () => {
      if (!['starting', 'running', 'paused'].includes(this.state.phase)) {
        if (this.state.localModeActive && ['completed', 'stopped'].includes(this.state.phase)) {
          await this._releaseLocalMode();
        }
        return this._publicState();
      }
      const stoppedAtUtc = new Date(this.now()).toISOString();
      this.state = {
        ...this.state,
        phase: 'stopped',
        remainingSeconds: this.state.phase === 'running'
          ? Math.ceil(this._remainingMs() / 1000)
          : this.state.remainingSeconds,
        endsAtUtc: null,
        stoppedAtUtc,
        generation: this.state.generation + 1,
      };
      this.monotonicAnchor = null;
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      this._persist();
      this._emit();
      await this._releaseLocalMode();
      return this._publicState();
    });
  }

  requireAudioRearm() {
    if (!['running', 'paused'].includes(this.state.phase) || this.state.requiresAudioRearm) return this._publicState();
    this.state.requiresAudioRearm = true;
    if (this.state.phase === 'running') this._checkpointRunning();
    else this._persist();
    this._emit();
    return this._publicState();
  }

  acknowledgeAudioRearm() {
    if (!this.state.requiresAudioRearm) return this._publicState();
    this.state.requiresAudioRearm = false;
    if (this.state.phase === 'running') this._checkpointRunning();
    else this._persist();
    this._emit();
    return this._publicState();
  }

  reconcileAfterResume() {
    return this._serial(async () => {
      if (this.state.phase !== 'running') return this._publicState();
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      // performance.now() may pause on some Windows sleep paths. Drop the old
      // monotonic anchor exactly at the OS resume boundary, then consume sleep
      // from the persisted UTC deadline before establishing a fresh anchor.
      this.monotonicAnchor = null;
      const remainingMs = this._remainingMs();
      if (remainingMs <= 0) {
        this._markCompleted();
        this._scheduleCompletionEffect();
        await this._releaseLocalMode();
        return this._publicState();
      }
      this.state.remainingSeconds = Math.ceil(remainingMs / 1000);
      this.monotonicAnchor = {
        id: this.state.id,
        generation: this.state.generation,
        at: this.monotonicNow(),
        remainingMs,
      };
      this._persist();
      this._armTimer();
      this._emit();
      return this._publicState();
    });
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = {
  FocusManager,
  SCHEMA,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  clampDurationSeconds,
};
