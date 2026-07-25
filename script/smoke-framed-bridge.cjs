'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FrameDecoder,
  encodeFrame,
} = require('../frontend/electron/framed-bridge-supervisor.cjs');

const projectRoot = path.resolve(__dirname, '..');
const python = path.resolve(
  process.argv[2]
  || path.join(projectRoot, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python'),
);
const tempRoot = fs.realpathSync(os.tmpdir());
const dataDir = fs.mkdtempSync(path.join(tempRoot, 'reverie-framed-smoke-'));
const child = spawn(python, [path.join(projectRoot, 'src', 'main.py'), '--stdio-bridge'], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    REVERIE_BRIDGE_MODE: '1',
    REVERIE_BRIDGE_PROTOCOL_VERSION: '3',
    REVERIE_BRIDGE_SECRET: 'A'.repeat(43),
    REVERIE_PARENT_PID: String(process.pid),
    REVERIE_DATA_DIR: dataDir,
    REVERIE_LOCAL_MODE: '1',
    REVERIE_LOCAL_MODE_EPOCH: '0',
  },
});

let stderr = '';
let ready = false;
let settled = false;
let forceKillTimer = null;
const decoder = new FrameDecoder((frame) => {
  if (!ready) {
    assert.equal(frame.kind, 'ready');
    assert.equal(frame.transport, 'stdio-framed');
    assert.equal(frame.protocolVersion, 3);
    ready = true;
    child.stdin.write(encodeFrame({
      kind: 'renderer_command',
      schema: 'reverie.command.v3',
      envelope: {
        protocol_version: 3,
        request_id: 'rpc_smoke_12345678',
        idempotency_key: 'rpc_smoke_12345678',
        command: 'persona:get',
        persona: {
          persona_id: frame.personaId,
          epoch: frame.personaEpoch,
          fingerprint: frame.personaFingerprint,
        },
        payload: {},
        created_at_utc: new Date().toISOString(),
      },
    }));
    return;
  }
  if (
    frame.kind === 'event'
    && frame.frame?.type === 'persona:data'
    && frame.frame?.request_id === 'rpc_smoke_12345678'
  ) {
    assert.equal(typeof frame.frame.payload?.persona, 'object');
    finish(null);
  }
});

function cleanup() {
  const resolved = path.resolve(dataDir);
  if (resolved.startsWith(`${tempRoot}${path.sep}`)
    && path.basename(resolved).startsWith('reverie-framed-smoke-')) {
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (error) {
    process.stderr.write(`${error.stack || error}\n${stderr.slice(-4000)}`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Framed bridge smoke passed: ready + persona:get\n');
  }
  // On Windows the child may still hold SQLite/WAL handles until its exit
  // event. Reporting success must not be skipped by an early EPERM cleanup.
  try {
    child.stdin.end();
    forceKillTimer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, 3_000);
    forceKillTimer.unref?.();
  } catch {
    try { child.kill(); } catch {}
  }
}

child.stdout.on('data', (chunk) => {
  try { decoder.push(chunk); } catch (error) { finish(error); }
});
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
});
child.once('error', finish);
child.once('exit', (code, signal) => {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (!settled) {
    finish(new Error(`Python exited before smoke completion (${code}/${signal})`));
  }
  try {
    cleanup();
  } catch (error) {
    process.stderr.write(`Smoke cleanup warning: ${error.message}\n`);
  }
});
const timeout = setTimeout(() => {
  finish(new Error('Framed bridge smoke timed out'));
}, 90_000);
