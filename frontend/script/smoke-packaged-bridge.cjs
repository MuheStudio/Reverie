'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FramedBridgeSupervisor } = require('../electron/framed-bridge-supervisor.cjs');

function assertPackagedLayout(packageRoot) {
  const resources = path.join(packageRoot, 'resources');
  const python = path.join(resources, 'python', 'python.exe');
  const entrypoint = path.join(resources, 'src', 'main.py');
  for (const target of [python, entrypoint]) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Packaged bridge input is invalid: ${target}`);
    }
  }
  return { resources, python, entrypoint };
}

function waitForSettings(supervisor, requestId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Packaged settings:get smoke response timed out'));
    }, timeoutMs);
    const onMessage = (frame) => {
      if (frame?.request_id !== requestId || frame.type !== 'settings:get:result') return;
      cleanup();
      if (frame.payload?.ok !== true) {
        reject(new Error('Packaged settings authority returned a failure'));
        return;
      }
      resolve(frame);
    };
    const cleanup = () => {
      clearTimeout(timer);
      supervisor.off('message', onMessage);
    };
    supervisor.on('message', onMessage);
  });
}

async function smokePackagedBridge(packageRoot) {
  const layout = assertPackagedLayout(path.resolve(packageRoot));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-packaged-bridge-'));
  const localMode = { active: true, epoch: 7, sessionId: 'package-smoke' };
  let supervisor;
  try {
    supervisor = new FramedBridgeSupervisor({
      readyTimeoutMs: 30_000,
      spawnChild(context) {
        return spawn(layout.python, [layout.entrypoint, '--stdio-bridge'], {
          cwd: layout.resources,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            REVERIE_BRIDGE_MODE: '1',
            REVERIE_BRIDGE_PROTOCOL_VERSION: '3',
            REVERIE_BRIDGE_SECRET: context.secret,
            REVERIE_PARENT_PID: String(process.pid),
            REVERIE_DATA_DIR: dataDir,
            REVERIE_LOCAL_MODE: '1',
            REVERIE_LOCAL_MODE_EPOCH: String(localMode.epoch),
            REVERIE_LOCAL_MODE_SESSION_ID: localMode.sessionId,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      },
    });
    const logs = [];
    supervisor.on('log', ({ line }) => logs.push(String(line).slice(0, 1000)));
    const ready = await supervisor.start({ localMode });
    const requestId = 'package_smoke_001';
    const response = waitForSettings(supervisor, requestId);
    supervisor.sendBusinessFrame({
      type: 'settings:get',
      payload: {},
      request_id: requestId,
    });
    const settings = await response;
    return {
      ready,
      provider: settings.payload.llm?.provider,
      model: settings.payload.llm?.model,
      apiDefaults: {
        proactiveChat: settings.payload.features?.proactive_chat_enabled,
        automaticDiary: settings.payload.features?.diary_enabled,
        webSearch: settings.payload.features?.web_surfing_enabled,
      },
      stderrTail: logs.slice(-8),
    };
  } finally {
    if (supervisor) await supervisor.stopAndWait('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot) {
    throw new Error('usage: node smoke-packaged-bridge.cjs PACKAGE_ROOT');
  }
  const result = await smokePackagedBridge(packageRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertPackagedLayout, smokePackagedBridge, waitForSettings };
