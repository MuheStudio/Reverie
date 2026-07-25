'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const SCHEMA = 'reverie.local-network-gate.v1';

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1';
}

function parseRemoteUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return { isNetwork: false, isLoopback: false, url: null };
  }
  const isNetwork = ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol);
  return { isNetwork, isLoopback: isLoopbackHostname(parsed.hostname), url: parsed };
}

class LocalNetworkGate {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('LocalNetworkGate requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.statePath = path.join(this.storageDir, 'local-network-gate.json');
    this.backupPath = path.join(this.storageDir, 'local-network-gate.backup.json');
    this.state = this._load();
    this.electronSession = null;
    this.listenerInstalled = false;
    this.nodeRestore = null;
  }

  _load() {
    for (const candidate of [this.statePath, this.backupPath]) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid gate state file');
        const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (value?.schema === SCHEMA && typeof value.active === 'boolean'
          && Number.isInteger(value.epoch) && value.epoch >= 0) return value;
        throw new Error('invalid gate state schema');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        try { fs.renameSync(candidate, `${candidate}.corrupt-${Date.now()}`); } catch {}
      }
    }
    return {
      schema: SCHEMA,
      active: false,
      epoch: 0,
      sessionId: null,
      changedAtUtc: new Date(0).toISOString(),
    };
  }

  _persist() {
    fs.mkdirSync(this.storageDir, { recursive: true });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(this.statePath)) fs.copyFileSync(this.statePath, this.backupPath);
    } catch {}
    fs.renameSync(temp, this.statePath);
  }

  install(electronSession) {
    if (!electronSession || this.listenerInstalled) return;
    this.electronSession = electronSession;
    electronSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        const remote = parseRemoteUrl(details.url);
        callback({ cancel: Boolean(this.state.active && remote.isNetwork && !remote.isLoopback) });
      },
    );
    this.listenerInstalled = true;
  }

  installNodeGuards(targetGlobal = globalThis) {
    if (this.nodeRestore) return this.nodeRestore;
    const gate = this;
    const originals = {
      fetch: typeof targetGlobal.fetch === 'function' ? targetGlobal.fetch : null,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      tlsConnect: tls.connect,
    };

    const assertRequestArgs = (protocol, args) => {
      const first = args[0];
      if (first instanceof URL || typeof first === 'string') {
        let value = first;
        if (typeof value === 'string' && value.startsWith('/')) value = `${protocol}//localhost${value}`;
        gate.assertAllowed(value, 'Node network request');
        return;
      }
      const options = first && typeof first === 'object' ? first : {};
      const hostname = options.hostname || options.host || 'localhost';
      const port = options.port ? `:${options.port}` : '';
      gate.assertAllowed(`${options.protocol || protocol}//${hostname}${port}/`, 'Node network request');
    };
    const assertSocketArgs = (args, purpose) => {
      const first = args[0];
      const options = first && typeof first === 'object'
        ? first
        : { port: first, host: args[1] };
      const host = options.host || options.hostname || 'localhost';
      if (gate.state.active && !isLoopbackHostname(host)) {
        const error = new Error(`${purpose} is disabled during local focus mode`);
        error.code = 'REVERIE_LOCAL_MODE';
        throw error;
      }
    };

    if (originals.fetch) {
      targetGlobal.fetch = function guardedFetch(input, init) {
        gate.assertAllowed(input instanceof URL ? input : input?.url || input, 'Node fetch');
        return originals.fetch.call(this, input, init);
      };
    }
    http.request = function guardedHttpRequest(...args) {
      assertRequestArgs('http:', args);
      return originals.httpRequest.apply(this, args);
    };
    http.get = function guardedHttpGet(...args) {
      assertRequestArgs('http:', args);
      return originals.httpGet.apply(this, args);
    };
    https.request = function guardedHttpsRequest(...args) {
      assertRequestArgs('https:', args);
      return originals.httpsRequest.apply(this, args);
    };
    https.get = function guardedHttpsGet(...args) {
      assertRequestArgs('https:', args);
      return originals.httpsGet.apply(this, args);
    };
    net.connect = function guardedNetConnect(...args) {
      assertSocketArgs(args, 'Node TCP connection');
      return originals.netConnect.apply(this, args);
    };
    net.createConnection = function guardedCreateConnection(...args) {
      assertSocketArgs(args, 'Node TCP connection');
      return originals.netCreateConnection.apply(this, args);
    };
    tls.connect = function guardedTlsConnect(...args) {
      assertSocketArgs(args, 'Node TLS connection');
      return originals.tlsConnect.apply(this, args);
    };

    this.nodeRestore = () => {
      if (originals.fetch) targetGlobal.fetch = originals.fetch;
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      net.connect = originals.netConnect;
      net.createConnection = originals.netCreateConnection;
      tls.connect = originals.tlsConnect;
      this.nodeRestore = null;
    };
    return this.nodeRestore;
  }

  snapshot() {
    return { ...this.state };
  }

  enable({ epoch, sessionId }) {
    const nextEpoch = Number.isInteger(epoch) && epoch > this.state.epoch ? epoch : this.state.epoch + 1;
    this.state = {
      schema: SCHEMA,
      active: true,
      epoch: nextEpoch,
      sessionId: String(sessionId || ''),
      changedAtUtc: new Date().toISOString(),
    };
    // Persist before acknowledging the caller. A crash may leave networking
    // disabled, but must never silently re-enable it during a focus session.
    this._persist();
    return this.snapshot();
  }

  disable({ epoch, sessionId } = {}) {
    if (sessionId && this.state.sessionId && String(sessionId) !== this.state.sessionId) {
      throw new Error('Focus session mismatch while disabling local mode');
    }
    const nextEpoch = Number.isInteger(epoch) && epoch > this.state.epoch ? epoch : this.state.epoch + 1;
    this.state = {
      schema: SCHEMA,
      active: false,
      epoch: nextEpoch,
      sessionId: null,
      changedAtUtc: new Date().toISOString(),
    };
    this._persist();
    return this.snapshot();
  }

  assertAllowed(value, purpose = 'network request') {
    const remote = parseRemoteUrl(value);
    if (this.state.active && remote.isNetwork && !remote.isLoopback) {
      const error = new Error(`${purpose} is disabled during local focus mode`);
      error.code = 'REVERIE_LOCAL_MODE';
      throw error;
    }
    return remote.url;
  }

  dispose() {
    this.nodeRestore?.();
    this.nodeRestore = null;
  }
}

module.exports = {
  LocalNetworkGate,
  SCHEMA,
  isLoopbackHostname,
  parseRemoteUrl,
};
