'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { FramedBridgeSupervisor } = require('../electron/framed-bridge-supervisor.cjs');
const { OMITTED_SOURCE_MODULES } = require('./production-runtime.cjs');

const DEFAULT_TARGET_MARKER = path.join(
  path.resolve(__dirname, '..'),
  '.package-smoke',
  'latest-package.json',
);

function resolvePackageRoot(explicitRoot, markerPath = DEFAULT_TARGET_MARKER) {
  if (explicitRoot) return path.resolve(explicitRoot);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(
      'No packaged smoke target is available. Run package:win:test first or pass PACKAGE_ROOT.',
      { cause: error },
    );
  }
  if (
    marker?.schema !== 'reverie.package-smoke-target.v1'
    || typeof marker.packageRoot !== 'string'
    || !path.isAbsolute(marker.packageRoot)
  ) {
    throw new Error(`Invalid packaged smoke target marker: ${markerPath}`);
  }
  return path.resolve(marker.packageRoot);
}

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
  for (const omitted of [
    'affairs', 'anime_service', 'interest', 'timeline', 'ui', 'work_manager',
  ]) {
    if (!OMITTED_SOURCE_MODULES.includes(omitted)) {
      throw new Error(
        `Smoke omit boundary drifted: '${omitted}' is missing from OMITTED_SOURCE_MODULES in production-runtime.cjs`,
      );
    }
    const target = path.join(resources, 'src', omitted);
    if (fs.existsSync(target)) {
      throw new Error(`Non-MVP Python module was packaged: ${target}`);
    }
  }
  // These are core companion capabilities: they must
  // ship. Their absence once made packaged stickers/games silently inert.
  function assertCoreModule(filename, directory) {
    const moduleName = directory ? filename : path.parse(filename).name;
    if (OMITTED_SOURCE_MODULES.includes(moduleName)) {
      throw new Error(
        `Core companion module '${moduleName}' must not appear in OMITTED_SOURCE_MODULES`,
      );
    }
    const target = path.join(resources, 'src', filename);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Core companion module was not packaged: ${target}`);
    }
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
      throw new Error(`Core companion module has an invalid filesystem type: ${target}`);
    }
  }
  for (const shipped of [
    'diary', 'games', 'immersion', 'stickers',
    'web', 'archive', 'lorebook', 'social', 'keepsakes',
  ]) {
    assertCoreModule(shipped, true);
  }
  for (const omittedFile of ['work_manager.py']) {
    const target = path.join(resources, 'src', omittedFile);
    if (fs.existsSync(target)) {
      throw new Error(`Non-MVP Python module was packaged: ${target}`);
    }
  }
  for (const shippedFile of ['ambient.py', 'backup.py', 'notifications.py']) {
    assertCoreModule(shippedFile, false);
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

function findCanonicalDatabases(root) {
  const matches = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Smoke data contains a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
      return;
    }
    if (['kernel.sqlite3', 'metadata.db', 'world_state.sqlite3'].includes(path.basename(current))) {
      matches.push(current);
    }
  };
  visit(root);
  return matches;
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
        const storageKey = crypto.randomBytes(32);
        const child = spawn(layout.python, [layout.entrypoint, '--stdio-bridge'], {
          cwd: layout.resources,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            REVERIE_BRIDGE_MODE: '1',
            REVERIE_BRIDGE_PROTOCOL_VERSION: '4',
            REVERIE_BRIDGE_SECRET: context.secret,
            REVERIE_PARENT_PID: String(process.pid),
            REVERIE_DATA_DIR: dataDir,
            REVERIE_LOCAL_MODE: '1',
            REVERIE_LOCAL_MODE_EPOCH: String(localMode.epoch),
            REVERIE_LOCAL_MODE_SESSION_ID: localMode.sessionId,
            REVERIE_REQUIRE_ENCRYPTED_STORAGE: '1',
            REVERIE_STORAGE_KEY_FD: '3',
          },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });
        const clearKey = () => storageKey.fill(0);
        child.once('error', clearKey);
        child.stdio[3].end(storageKey, clearKey);
        return child;
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
    if (settings.payload.llm?.provider !== 'ollama') {
      throw new Error('Packaged MVP must default to the loopback-only Ollama provider');
    }
    if (settings.payload.llm?.base_url !== 'http://localhost:11434/v1') {
      throw new Error('Packaged Ollama endpoint must remain on loopback');
    }
    if (settings.payload.llm?.model) {
      throw new Error('Packaged MVP must not guess an installed Ollama model');
    }
    const databases = findCanonicalDatabases(dataDir);
    if (databases.length < 3) {
      throw new Error('Packaged smoke did not create all canonical encrypted databases');
    }
    for (const database of databases) {
      const header = fs.readFileSync(database).subarray(0, 16).toString('utf8');
      if (header === 'SQLite format 3\u0000') {
        throw new Error(`Packaged canonical database is plaintext: ${database}`);
      }
    }
    return {
      ready,
      encryptedDatabaseCount: databases.length,
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
  const packageRoot = resolvePackageRoot(process.argv[2]);
  const result = await smokePackagedBridge(packageRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertPackagedLayout,
  findCanonicalDatabases,
  resolvePackageRoot,
  smokePackagedBridge,
  waitForSettings,
};
