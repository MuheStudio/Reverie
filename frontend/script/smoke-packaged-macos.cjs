'use strict';

// Acceptance of the signed, hardened test .app. This runner never enables the
// main-process inspector, weakens fuses, or injects an application test API.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const frontendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(frontendRoot, '..');
const APP_ID = 'com.muhe.reverie.macos.test';
const APP_NAME = 'Reverie macOS Test.app';
const PACKAGED_URL = 'reverie-app://app/index.html';
const MARKER_NAME = 'TEST-BUILD-DO-NOT-RELEASE.json';
const nativeErrorHelper = path.join(__dirname, 'macos-confirm-error.swift');
const token = String(crypto.randomInt(100_000_000_000, 1_000_000_000_000));
const userMessage = `应用包验收 ${token}`;
const assistantMessage = token; // Within the product's 20-character casual reply budget.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let interrupted = false;

async function waitFor(check, label, timeoutMs = 45_000, cleanup = false) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (interrupted && !cleanup) throw new Error('Desktop smoke interrupted');
    try { const value = await check(); if (value) return value; } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}


function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.ok, true, `${url}: HTTP ${response.status}`);
  return response.json();
}

async function startFakeProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        response.writeHead(400); response.end(); return;
      }
      requests.push({ method: request.method, url: request.url, body });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404); response.end(); return;
      }
      const result = JSON.stringify({
        id: `core-smoke-${requests.length}`, object: 'chat.completion', created: 1,
        model: 'reverie-core-smoke',
        choices: [{ index: 0, message: { role: 'assistant', content: assistantMessage }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(result) });
      response.end(result);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests, port: server.address().port };
}

async function connectCdp(url, checkAlive) {
  const socket = new WebSocket(url, { handshakeTimeout: 5_000 });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve); socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const fail = (error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const watchdog = checkAlive ? setInterval(() => {
    try { checkAlive(); } catch (error) { fail(error); socket.close(); }
  }, 200) : null;
  watchdog?.unref();
  socket.on('error', fail);
  socket.on('close', () => { clearInterval(watchdog); fail(new Error('Debugger connection closed')); });
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      checkAlive?.();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

function processSnapshot() {
  // Read executable names and ancestry only; never inspect another process's
  // command line or environment (which can contain credentials).
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.error || result.status !== 0) throw new Error('Cannot inspect test process cleanup');
    return [].concat(JSON.parse(result.stdout || '[]')).map((item) => ({
      pid: item.ProcessId, ppid: item.ParentProcessId, name: item.Name,
    }));
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5_000 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect test process cleanup');
  return result.stdout.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] }));
}

function collectOwned(running) {
  if (!running?.child.pid) return;
  running.owned.set(running.child.pid, { pid: running.child.pid, name: running.label });
  const snapshot = processSnapshot();
  let changed;
  do {
    changed = false;
    for (const item of snapshot) {
      if (running.owned.has(item.ppid) && !running.owned.has(item.pid)) {
        running.owned.set(item.pid, item); changed = true;
      }
    }
  } while (changed);
}

function remainingOwned(running) {
  const alive = new Set(processSnapshot().map((item) => item.pid));
  return [...running.owned.values()].filter((item) => alive.has(item.pid));
}


function requireAlive(running) {
  const fatalStartup = running.logs.join('').match(/\[Electron\] Fatal startup failure[^\n]*/);
  if (fatalStartup) {
    throw Object.assign(new Error(`${running.label}: ${fatalStartup[0]}`), { fatal: true });
  }
  if (running.error || running.child.exitCode !== null || running.child.signalCode !== null) {
    throw Object.assign(new Error(`${running.label} exited early: ${running.error?.message || running.logs.join('').slice(-2500)}`), { fatal: true });
  }
}


async function chatHistory(cdp) {
  const requestId = `core-history-${crypto.randomUUID()}`;
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const requestId = ${JSON.stringify(requestId)};
    const timeout = setTimeout(() => { dispose(); reject(new Error('Chat history timed out')); }, 15000);
    const dispose = window.electronAPI.bridge.onMessage((frame) => {
      if (frame?.request_id !== requestId) return;
      if (!['chat:history:result', 'error'].includes(frame.type)) return;
      clearTimeout(timeout); dispose();
      if (frame.type === 'error') reject(new Error(JSON.stringify(frame.payload)));
      else resolve(frame.payload);
    });
    window.electronAPI.bridge.send({ type: 'chat:history', request_id: requestId,
      payload: { conversation_id: 'dream-room', limit: 100 } }).catch((error) => {
        clearTimeout(timeout); dispose(); reject(error);
      });
  })`);
}

function assertMessages(history) {
  const items = history?.items || [];
  assert.equal(items.filter((item) => item.role === 'user' && item.content === userMessage).length, 1, 'User message missing or duplicated');
  assert.equal(items.filter((item) => item.role === 'assistant' && item.content.includes(assistantMessage)).length, 1, 'Assistant message missing or duplicated');
  return items.filter((item) => item.content.includes(token)).map((item) => ({ id: item.id, role: item.role, content: item.content }));
}

async function waitForDisplayedMessages(cdp, messages) {
  const expected = messages.map(({ role, content }) => ({ role, content }));
  return waitFor(() => evaluate(cdp, `(() => {
    const expected = ${JSON.stringify(expected)};
    const displayed = Array.from(document.querySelectorAll(
      '[data-testid="mvp-room"] article[data-role]:not([data-streaming="true"])'
    )).map((article) => ({ role: article.dataset.role,
      content: article.querySelector(':scope > p')?.textContent || '' }));
    return expected.every((item) => displayed.filter((shown) =>
      shown.role === item.role && shown.content === item.content).length === 1)
      ? expected : null;
  })()`), 'exact user and assistant bubbles displayed');
}


async function forceCleanup(running) {
  running.cdp?.close(); running.mainCdp?.close();
  if (!running.child.pid) return;
  let observationError;
  let survivors;
  try { collectOwned(running); survivors = remainingOwned(running); } catch (error) {
    observationError = error;
    survivors = [...running.owned.values()];
  }
  if (!observationError && !survivors.length) return;
  running.forcedCleanup = true;
  if (process.platform === 'win32') {
    for (const item of survivors.reverse()) {
      spawnSync('taskkill', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } else {
    // Every root was spawned into its own process group; never kill by name.
    try { process.kill(-running.child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  // Even if a restricted environment denies `ps`, still tear down the owned
  // process group before reporting that cleanup could not be independently
  // verified. A diagnostic failure must never skip process termination.
  if (observationError) {
    await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null,
      `${running.label} root cleanup`, 10_000, true);
    throw observationError;
  }
  await waitFor(() => remainingOwned(running).length === 0, `${running.label} fallback cleanup`, 10_000, true);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return String(result.stdout || '').trim();
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function treeManifest(root) {
  root = fs.realpathSync(root);
  const entries = [];
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    const relative = path.relative(root, current).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      assert.ok(inside(root, fs.realpathSync(current)), `Bundle symlink escapes: ${relative}`);
      entries.push({ path: relative, type: 'link', target: fs.readlinkSync(current) });
    } else if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name));
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: 'file', size: stat.size, mode: stat.mode & 0o777, sha256: hashFile(current) });
    } else throw new Error(`Unexpected bundle file type: ${relative}`);
  };
  walk(root);
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

function readBundleIdentity(appRoot) {
  const plist = path.join(appRoot, 'Contents', 'Info.plist');
  const appId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
  const executableName = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]);
  assert.equal(appId, APP_ID, 'Refusing to test a non-test application identity');
  assert.equal(path.basename(executableName), executableName, 'Unsafe executable name');
  const resources = path.join(appRoot, 'Contents', 'Resources');
  const marker = JSON.parse(fs.readFileSync(path.join(resources, MARKER_NAME), 'utf8'));
  assert.equal(marker.schema, 'reverie.macos-test-build.v1');
  assert.equal(marker.publishable, false);
  assert.equal(marker.distribution, 'TEST_ONLY_DO_NOT_RELEASE');
  assert.equal(marker.platform, 'darwin'); assert.equal(marker.arch, 'arm64');
  assert.equal(marker.appId, appId);
  return { appRoot, appId, executableName, executable: path.join(appRoot, 'Contents', 'MacOS', executableName), resources, marker };
}

async function verifyHardenedBundle(identity, outputRoot) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', identity.appRoot]);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const dependencies = createRequire(builderRequire.resolve('app-builder-lib'));
  const { getCurrentFuseWire, FuseV1Options } = dependencies('@electron/fuses');
  const wire = await getCurrentFuseWire(identity.appRoot);
  const expected = { RunAsNode: false, EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
    GrantFileProtocolExtraPrivileges: false };
  for (const [name, enabled] of Object.entries(expected)) {
    assert.equal(wire[FuseV1Options[name]], enabled ? 49 : 48, `Production fuse changed: ${name}`);
  }
  const asar = dependencies('@electron/asar');
  const archive = path.join(identity.resources, 'app.asar');
  assert.ok(fs.statSync(archive).isFile(), 'Production ASAR missing');
  const main = asar.extractFile(archive, 'electron/main.js').toString('utf8');
  const security = asar.extractFile(archive, 'electron/runtime-security.cjs').toString('utf8');
  const appProtocol = asar.extractFile(archive, 'electron/app-protocol.cjs').toString('utf8');
  assert.ok(main.includes('contextIsolation: true') && main.includes('sandbox: true') && main.includes('nodeIntegration: false'), 'Window isolation configuration missing');
  assert.ok(security.includes('event.sender.mainFrame') && security.includes('isTrustedUrl(frame.url)'), 'Production IPC sender/origin checks missing');
  assert.ok(/if \(process\.platform === 'darwin' \|\|[\s\S]{0,200}!offerStorageKeyReset\(\)/.test(main),
    'macOS key failures must reject before the Windows reset dialog');
  assert.ok(appProtocol.includes("default-src 'self'") && appProtocol.includes("object-src 'none'"), 'Production CSP missing');
  const files = asar.listPackage(archive, { isPack: false });
  assert.ok(!files.some((file) => /(?:^|\/)[^/]+\.(?:moc3|model3\.json)$/i.test(file)), 'Core app contains a Live2D model');
  const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', identity.appRoot], { encoding: 'utf8' });
  assert.equal(entitlements.status, 0);
  fs.writeFileSync(path.join(outputRoot, 'entitlements.txt'), `${entitlements.stdout}\n${entitlements.stderr}`);
  const signature = spawnSync('/usr/bin/codesign', ['-dvv', identity.appRoot], { encoding: 'utf8' });
  fs.writeFileSync(path.join(outputRoot, 'signature.txt'), `${signature.stdout}\n${signature.stderr}`);
  return { fuses: expected, fuseWire: wire, asarSha256: hashFile(archive), signatureVerified: true,
    macKeyFailurePolicy: 'darwin short-circuit rejects before offerStorageKeyReset; verified in the immutable production ASAR' };
}

function childEnvironment(runRoot, userData) {
  // HOME identifies the logged-in macOS Keychain user. All application data,
  // Chromium caches, crash reports and temporary files are separately located.
  return {
    HOME: process.env.HOME || '', USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    TMPDIR: `${path.join(runRoot, 'tmp')}${path.sep}`, XDG_CACHE_HOME: path.join(runRoot, 'cache'),
    REVERIE_TEST_USER_DATA_DIR: userData, PYTHON_DOTENV_DISABLED: '1',
  };
}

function launchApplication(identity, runRoot, userData, label, port, active) {
  const running = { label, logs: [], owned: new Map(), startedAt: Date.now(), identity, userData, runRoot };
  running.child = spawn(identity.executable, [
    `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`,
    `--disk-cache-dir=${path.join(userData, 'Cache')}`,
    `--crash-dumps-dir=${path.join(runRoot, 'crashpad')}`,
  ], { cwd: runRoot, env: childEnvironment(runRoot, userData), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.child.once('error', (error) => { running.error = error; });
  running.child.stdout.on('data', (chunk) => running.logs.push(String(chunk)));
  running.child.stderr.on('data', (chunk) => running.logs.push(String(chunk)));
  active.push(running);
  return running;
}

async function startPackagedApp(identity, runRoot, userData, cycle, active) {
  const port = await freePort();
  const running = launchApplication(identity, runRoot, userData, `normal-${cycle}`, port, active);
  const target = await waitFor(async () => {
    requireAlive(running);
    return (await fetchJson(`http://127.0.0.1:${port}/json/list`))
      .find((item) => item.type === 'page' && item.url === PACKAGED_URL);
  }, `${running.label} production renderer`, 150_000);
  running.cdp = await connectCdp(target.webSocketDebuggerUrl, () => requireAlive(running));
  await waitFor(() => evaluate(running.cdp, `document.readyState === 'complete'
    && Boolean(document.querySelector('[data-testid="mvp-room"]')) && Boolean(window.electronAPI?.bridge)`),
  'packaged React and sandboxed preload', 90_000);
  const surface = await evaluate(running.cdp, `({ url: location.href, require: typeof window.require,
    frozen: Object.isFrozen(window.electronAPI), platform: window.electronAPI.platform })`);
  assert.deepEqual(surface, { url: PACKAGED_URL, require: 'undefined', frozen: true, platform: 'darwin' });
  running.connection = await waitFor(async () => {
    requireAlive(running);
    const result = await evaluate(running.cdp, 'window.electronAPI.bridge.getConnectionConfig()');
    return result?.transport === 'electron-ipc' && result.protocolVersion === 4 ? result : null;
  }, 'packaged V4 authority', 150_000);
  assert.equal(running.connection.secret, '', 'Renderer received an authentication secret');
  const csp = await evaluate(running.cdp, `(async () => (await fetch(location.href)).headers.get('content-security-policy'))()`);
  assert.ok(csp?.includes("default-src 'self'") && csp.includes("object-src 'none'"), 'Production CSP header missing');
  assert.ok(!/unsafe-eval|connect-src[^;]*(?:https?:|\*)/.test(csp), 'Production CSP was relaxed');
  const rejected = await evaluate(running.cdp, `(async () => {
    try { await window.electronAPI.bridge.send({type:'undeclared:smoke-command',payload:{}}); return false; }
    catch { return true; }
  })()`);
  assert.equal(rejected, true, 'Undeclared IPC command was accepted');
  collectOwned(running);
  const pythonRoot = path.join(identity.resources, 'python');
  const python = [...running.owned.values()].filter((item) => /python/i.test(path.basename(item.name)));
  assert.ok(python.length, 'No real Python child observed');
  for (const item of python) {
    assert.ok(path.isAbsolute(item.name) && inside(pythonRoot, fs.realpathSync(item.name)), `External Python fallback: ${item.name}`);
  }
  const forbidden = [...running.owned.values()].filter((item) => /(?:\/\.venv\/|\/\.codex\/|\/\.tools\/|\/vite(?:\/|$))/.test(item.name));
  assert.deepEqual(forbidden, [], 'Application used an external development runtime');
  running.evidence = { label: running.label, readyMs: Date.now() - running.startedAt,
    protocolVersion: running.connection.protocolVersion, surface, csp, python,
    childPath: childEnvironment(runRoot, userData).PATH, cwd: runRoot };
  return running;
}

async function normalPackagedQuit(running, outputRoot) {
  collectOwned(running);
  const actual = processSnapshot().find((item) => item.pid === running.child.pid);
  assert.ok(actual && fs.realpathSync(actual.name) === fs.realpathSync(running.identity.executable), 'Refusing Quit for an unverified process');
  assert.equal(readBundleIdentity(running.identity.appRoot).appId, APP_ID);
  running.cdp?.close();
  const appleScript = 'on run argv\nset targetPath to item 1 of argv\ntell application targetPath to quit\nend run';
  const quit = spawnSync('/usr/bin/osascript', ['-e', appleScript, running.identity.appRoot], {
    encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME || '' },
  });
  running.quitMethod = quit.status === 0 ? 'standard Quit AppleEvent to verified .app path' : 'native quit assistance required';
  if (quit.error || quit.status !== 0) {
    const request = { label: running.label, appRoot: running.identity.appRoot, appId: APP_ID,
      pid: running.child.pid, reason: quit.error?.message || quit.stderr,
      instruction: 'Use the existing app Quit menu or Command-Q in this verified application; do not grant permissions or select reset.' };
    fs.writeFileSync(path.join(outputRoot, 'native-quit-needed.json'), JSON.stringify(request, null, 2));
    process.stdout.write(`[package-smoke] Native Quit assistance needed: ${JSON.stringify(request)}\n`);
  }
  await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null, `${running.label} normal quit`, 300_000, true);
  assert.equal(running.child.exitCode, 0, `Abnormal application exit: ${running.child.exitCode}/${running.child.signalCode}`);
  await waitFor(() => remainingOwned(running).length === 0, `${running.label} descendants exit`, 15_000, true);
  running.gracefulExit = running.child.exitCode === 0;
}

async function bindNativeUiController(running, outputRoot) {
  const ackPath = path.join(outputRoot, 'native-ui-controller-ready.json');
  const request = { appRoot: running.identity.appRoot, appId: APP_ID, pid: running.child.pid, ackPath,
    expectedAck: { appId: APP_ID, pid: running.child.pid }, timeoutMs: 300_000,
    instruction: 'Bind the already-running normal application in the native UI controller and read its window, then write expectedAck to ackPath. Do not quit this normal cycle manually.' };
  fs.writeFileSync(path.join(outputRoot, 'native-ui-controller-needed.json'), JSON.stringify(request, null, 2));
  process.stdout.write(`[package-smoke] Bind native UI controller: ${JSON.stringify(request)}\n`);
  await waitFor(() => {
    requireAlive(running);
    if (!fs.existsSync(ackPath)) return false;
    const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
    return ack.appId === APP_ID && ack.pid === running.child.pid;
  }, 'native UI controller binding acknowledgement', 300_000);
  return { appId: APP_ID, boundDuringNormalPid: running.child.pid, acknowledged: true,
    timeoutScope: 'Test-controller assistance only; production bridge timeouts are unchanged' };
}

function runNativeErrorHelper(requestPath) {
  const record = { available: fs.existsSync(nativeErrorHelper), attempted: false };
  if (!record.available) return record;
  let scratch;
  try {
    const stat = fs.lstatSync(nativeErrorHelper);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Native UI helper must be a regular source file');
    const source = fs.readFileSync(nativeErrorHelper);
    assert.equal(source.length, stat.size, 'Native UI helper source was read incompletely');
    record.sha256 = crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(hashFile(nativeErrorHelper), record.sha256, 'Native UI helper changed while being copied');
    scratch = fs.mkdtempSync('/private/tmp/reverie-native-ui-');
    const copiedHelper = path.join(scratch, 'confirm-error.swift');
    fs.writeFileSync(copiedHelper, source, { flag: 'wx', mode: 0o600 });
    assert.equal(fs.statSync(copiedHelper).size, stat.size);
    assert.equal(hashFile(copiedHelper), record.sha256, 'Copied native UI helper hash mismatch');
    const moduleCache = path.join(scratch, 'cache');
    fs.mkdirSync(moduleCache);
    record.sourceBytes = source.length;
    record.executionContext = { cwd: scratch, moduleCache, inheritedControllerEnvironment: true,
      locale: 'en_US.UTF-8', copiedSourceVerified: true };
    record.attempted = true;
    const startedAt = Date.now();
    // Controller context only: preserve its GUI-session environment and use a
    // short ASCII working/cache/temp directory. The application's deliberately
    // minimal childEnvironment remains unchanged.
    const result = spawnSync('/usr/bin/swift', ['-module-cache-path', moduleCache, copiedHelper, requestPath], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGTERM', maxBuffer: 256 * 1024,
      cwd: scratch, env: { ...process.env, TMPDIR: `${scratch}${path.sep}`,
        LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
    });
    Object.assign(record, { elapsedMs: Date.now() - startedAt, exitCode: result.status,
      signal: result.signal, error: result.error?.message || null,
      stdout: String(result.stdout || '').slice(0, 16_384), stderr: String(result.stderr || '').slice(0, 16_384) });
    try { record.result = JSON.parse(record.stdout); } catch {}
  } catch (error) {
    record.error = error.stack || String(error);
  } finally {
    if (scratch) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); record.scratchRemoved = !fs.existsSync(scratch); }
      catch (error) { record.scratchCleanupError = String(error); }
    }
  }
  return record;
}

async function acknowledgeFatalStartupDialog(running, kind, outputRoot) {
  const request = { kind, appRoot: running.identity.appRoot, appId: APP_ID, pid: running.child.pid,
    expectedTitle: 'Reverie 启动失败', expectedMessage: '安全初始化未完成，应用将退出。',
    expectedExitCode: 1, timeoutMs: 300_000,
    instruction: 'Confirm this existing fatal error dialog using its visible 好 / OK / 确定 button. Do not use Quit, Command-Q, signal termination, permission grants, or reset. A prebound UI controller should read the current window without reopening the application.' };
  const requestPath = path.join(outputRoot, `native-fatal-${kind}-needed.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  process.stdout.write(`[package-smoke] Confirm native fatal error dialog: ${JSON.stringify(request)}\n`);
  const helperRecord = runNativeErrorHelper(requestPath);
  process.stdout.write(`[package-smoke] Native error helper ${kind}: exit=${helperRecord.exitCode ?? 'none'}, signal=${helperRecord.signal || 'none'}, elapsed=${helperRecord.elapsedMs ?? 0}ms\n`);
  running.nativeFatalConfirmation = helperRecord;
  fs.writeFileSync(path.join(outputRoot, `native-fatal-${kind}-helper.json`), JSON.stringify(helperRecord, null, 2));
  if (!helperRecord.attempted || helperRecord.exitCode !== 0) {
    process.stdout.write(`[package-smoke] Helper unavailable or unsuccessful; the same visible OK confirmation remains required within 300 seconds.\n`);
  }
  await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null,
    `${kind} native fatal error acknowledgement`, 300_000);
  assert.equal(running.child.signalCode, null, 'Fatal storage rejection was terminated by a signal');
  assert.equal(running.child.exitCode, 1, 'Fatal storage rejection must exit 1 after its error dialog is confirmed');
  await waitFor(() => remainingOwned(running).length === 0, 'fatal startup descendants exit', 15_000, true);
  running.quitMethod = 'native fatal error dialog confirmed; application exited 1';
}

function durableHashes(userData) {
  const hashes = {};
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'Unexpected durable-data symlink');
      if (stat.isDirectory()) walk(file);
      else if (name === 'database-key.vault' || /\.(?:sqlite3|sqlite|db)(?:-(?:wal|shm|journal))?$/.test(name)) {
        hashes[path.relative(userData, file)] = hashFile(file);
      }
    }
  };
  for (const name of ['data', 'runtime']) {
    const directory = path.join(userData, name);
    if (fs.existsSync(directory)) walk(directory);
  }
  return hashes;
}

async function verifyNegativeStartup(identity, runRoot, originalData, kind, active, outputRoot) {
  const userData = path.join(runRoot, `negative-${kind}`);
  fs.mkdirSync(userData);
  for (const name of ['data', 'runtime']) {
    fs.cpSync(path.join(originalData, name), path.join(userData, name), { recursive: true, verbatimSymlinks: true });
  }
  const vaultPath = path.join(userData, 'runtime', 'storage-key', 'database-key.vault');
  let fixtureBytes;
  if (kind === 'missing-vault') {
    // Only the disposable cloned vault is removed. The existing encrypted
    // databases must prevent key generation even though the OS Keychain works.
    fixtureBytes = fs.statSync(vaultPath).size;
    fs.unlinkSync(vaultPath);
  } else {
    const target = kind === 'vault' ? vaultPath : path.join(userData, 'data', 'runtime', 'kernel.sqlite3');
    const contents = fs.readFileSync(target);
    fixtureBytes = contents.length;
    assert.ok(kind === 'vault' ? fixtureBytes >= 1 && fixtureBytes <= 64 * 1024 : fixtureBytes >= 4096,
      `Negative ${kind} fixture has invalid byte length: ${fixtureBytes}`);
    if (kind === 'vault') crypto.randomFillSync(contents);
    else contents[Math.min(200, contents.length - 1)] ^= 0x7f;
    fs.writeFileSync(target, contents);
    contents.fill(0);
  }
  const before = durableHashes(userData);
  const running = launchApplication(identity, runRoot, userData, `negative-${kind}`, await freePort(), active);
  const diagnosticPattern = kind === 'missing-vault' ? /REVERIE_STORAGE_KEY_MISSING/
    : kind === 'vault'
      ? /(?:REVERIE_STORAGE_KEY_CORRUPT|encrypted database key is corrupt|database key.*invalid schema)/i
      : /(?:encrypted database.*(?:verified|authentication|failed)|file is not a database|SQLCipher.*(?:failed|error)|hmac check failed)/i;
  const diagnostic = await waitFor(() => {
    const logs = running.logs.join('');
    assert.ok(!/Local backend authenticated:|stage:\s*['"]v4-authenticated/.test(logs), 'Corrupt storage obtained an authenticated bridge');
    const match = logs.match(diagnosticPattern);
    if (match) return match[0];
    if (running.error || running.child.exitCode !== null) throw Object.assign(new Error(`Missing fail-closed diagnostic: ${logs.slice(-2000)}`), { fatal: true });
    return null;
  }, `${kind} fail-closed diagnostic`, 150_000);
  collectOwned(running);
  if (kind === 'vault' || kind === 'missing-vault') {
    await acknowledgeFatalStartupDialog(running, kind, outputRoot);
  } else if (running.child.exitCode === null && running.child.signalCode === null) {
    await normalPackagedQuit(running, outputRoot);
  } else {
    assert.equal(running.child.signalCode, null, 'Storage rejection terminated by signal');
    assert.equal(running.child.exitCode, 1, 'Unexpected failed-startup exit');
    await waitFor(() => remainingOwned(running).length === 0, 'failed startup descendants exit', 15_000, true);
  }
  assert.deepEqual(durableHashes(userData), before, 'Corrupt storage was reset, rewritten, removed, or replaced');
  if (kind === 'missing-vault') assert.equal(fs.existsSync(vaultPath), false, 'A replacement key was generated for existing encrypted data');
  assert.ok(!/Local backend authenticated:|stage:\s*['"]v4-authenticated/.test(running.logs.join('')), 'Corrupt storage was accepted');
  const resetFiles = fs.readdirSync(path.join(userData, 'runtime', 'storage-key'));
  assert.ok(!resetFiles.some((name) => /superseded|quarantin|reset/i.test(name)), 'Key reset side effect detected');
  return { kind, fixtureBytes, diagnostic, durableHashesUnchanged: true, authenticated: false,
    ...(kind === 'missing-vault' ? { replacementKeyGenerated: false } : {}),
    ...(running.nativeFatalConfirmation ? { nativeFatalConfirmation: running.nativeFatalConfirmation } : {}),
    exitCode: running.child.exitCode, quitMethod: running.quitMethod || 'application refused startup and exited', elapsedMs: Date.now() - running.startedAt };
}

async function performChat(running, fake) {
  const config = { llm: { provider: 'ollama', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'reverie-core-smoke' } };
  const provider = await evaluate(running.cdp, `(async () => {
    const config = ${JSON.stringify(config)};
    const test = await window.electronAPI.providerConfig.test(config, {});
    if (!test.ok) throw new Error(JSON.stringify(test));
    const saved = await window.electronAPI.providerConfig.commit(config, {}, 'persistent', test.receipt);
    return { provider: saved.config.llm.provider, error: saved.status.writeError || null };
  })()`);
  assert.deepEqual(provider, { provider: 'ollama', error: null });
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('textarea[placeholder^="给 "]:not(:disabled)'))`), 'enabled packaged chat input');
  await evaluate(running.cdp, `window.__packageSmokeFrames = [];
    window.electronAPI.bridge.onMessage((frame) => window.__packageSmokeFrames.push(frame));
    document.querySelector('textarea[placeholder^="给 "]').focus(); true`);
  await running.cdp.call('Input.insertText', { text: userMessage });
  await running.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await running.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(() => fake.requests.some((request) => request.body.messages?.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(userMessage))), 'packaged UI message reached loopback model');
  const result = await waitFor(async () => {
    const frames = await evaluate(running.cdp, 'window.__packageSmokeFrames');
    const error = frames.find((frame) => frame.type === 'chat:error');
    if (error) throw Object.assign(new Error(JSON.stringify(error)), { fatal: true });
    return frames.find((frame) => frame.type === 'chat:done' || frame.payload?.state === 'ready_waiting');
  }, 'packaged reply readiness');
  if (result.type !== 'chat:done') {
    const requestId = result.payload?.request_id || result.request_id;
    assert.ok(requestId);
    await evaluate(running.cdp, `window.electronAPI.bridge.send({ type:'chat:reveal',request_id:'package-reveal-${token}',payload:{request_id:${JSON.stringify(requestId)}} })`);
  }
  const done = await waitFor(() => evaluate(running.cdp, 'window.__packageSmokeFrames.find((frame) => frame.type === "chat:done")'), 'packaged chat terminal');
  assert.equal(done.payload.degraded_to_local_reflex, false, 'Chat silently fell back to a local reply');
  const messages = assertMessages(await chatHistory(running.cdp));
  await waitForDisplayedMessages(running.cdp, messages);
  return { messages, done: done.payload };
}


// Shared production acceptance session: the same encrypted data and fake model
// survive a relocation. No application code or security settings are modified.
async function createAcceptanceSession(runRoot, userData) {
  const fake = await startFakeProvider();
  try {
    fs.mkdirSync(path.join(userData, 'data'));
    fs.writeFileSync(path.join(userData, 'data', 'config.json'), JSON.stringify({
      llm: { provider: 'ollama', model: 'reverie-core-smoke', base_url: `http://127.0.0.1:${fake.port}/v1` },
      chat: { reply_delay_min: 1, reply_delay_max: 1, split_messages: false },
      ui: { mode: 'mvp', experience_mode: 'core', onboarding_completed: true,
        onboarding_version: 3, onboarding_state: 'complete', onboarding_last_step: 'finish' },
    }));
  } catch (error) { fake.server.close(); throw error; }
  return { runRoot, userData, fake, cycles: [], messages: null, vaultHash: null };
}

async function runAcceptanceCycle(session, identity, label, active, outputRoot, options = {}) {
  const { runRoot, userData, fake } = session;
  const requestsBefore = fake.requests.length;
  const running = await startPackagedApp(identity, runRoot, userData, label, active);
  const first = session.messages === null;
  if (first) {
    if (options.nativeUiController) session.nativeUiController = await bindNativeUiController(running, outputRoot);
    session.chat = await performChat(running, fake);
    session.messages = session.chat.messages;
  } else {
    const recovered = assertMessages(await chatHistory(running.cdp));
    assert.deepEqual(recovered, session.messages, 'Cold-start recovery changed persisted IDs or content');
    await waitForDisplayedMessages(running.cdp, recovered);
    assert.equal(fake.requests.length, requestsBefore, 'History restore called the model');
  }
  options.stage?.(`Normal cycle ${label}: native application Quit`);
  await normalPackagedQuit(running, outputRoot);
  if (first) {
    const service = 'Reverie macOS Test Safe Storage';
    // Exact service metadata only; never request or print the Keychain secret.
    const keychain = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(keychain.status, 0, `Cannot verify this test app's Keychain metadata: ${keychain.stderr}`);
    fs.writeFileSync(path.join(outputRoot, 'keychain-metadata.txt'), keychain.stdout);
    session.keychain = { service, metadataVerified: true, secretExported: false,
      scope: 'Current OS user, real Electron safeStorage API, same signed candidate across restarts and relocation; cross-signature/version reuse is untested' };
  }
  const currentVaultHash = hashFile(path.join(userData, 'runtime', 'storage-key', 'database-key.vault'));
  if (session.vaultHash) assert.equal(currentVaultHash, session.vaultHash, 'Protected storage key was silently replaced');
  session.vaultHash = currentVaultHash;
  const database = fs.readFileSync(path.join(userData, 'data', 'runtime', 'kernel.sqlite3'));
  assert.notEqual(database.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
  assert.equal(database.includes(Buffer.from(userMessage)), false);
  const result = { ...running.evidence, appPath: identity.appRoot, normalQuit: true, quitMethod: running.quitMethod,
    modelCalls: fake.requests.length - requestsBefore, protectedKeyStable: true, encryptedDatabase: true,
    recoveredMessages: session.messages };
  session.cycles.push(result);
  return result;
}

async function closeAcceptanceSession(session) {
  if (!session) return;
  session.fake.server.closeAllConnections();
  await new Promise((resolve) => session.fake.server.close(resolve));
}

function setInterrupted(value) { interrupted = Boolean(value); }

function contentDigest(manifest) {
  const contents = manifest.entries.filter((item) => item.type !== 'directory')
    .map(({ mode: _mode, ...item }) => item);
  return crypto.createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

function buildInventory(manifest) {
  const files = manifest.entries.filter((item) => item.type !== 'directory').map((item) => (
    item.type === 'link' ? { path: item.path, symlink: item.target }
      : { path: item.path, bytes: item.size, sha256: item.sha256 }
  ));
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

function verifySuccessfulBuild(identity, manifestPath, actualTree) {
  const stat = fs.lstatSync(manifestPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Build manifest must be a regular file');
  const build = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(build.schema, 'reverie.macos-build.v1', 'Successful macOS build manifest required');
  assert.equal(build.architecture, 'arm64');
  assert.equal(identity.appId, APP_ID);
  assert.ok(typeof build.appPath === 'string' && path.isAbsolute(build.appPath) && build.appPath.endsWith('.app'), 'Build application identity is incomplete');
  assert.ok(!build.error && !build.failedAt && build.success !== false, 'Failed build cannot be accepted');
  assert.ok(Number.isFinite(Date.parse(build.startedAt)) && Number.isFinite(Date.parse(build.completedAt))
    && Date.parse(build.completedAt) >= Date.parse(build.startedAt), 'Build has no successful completion timestamp');
  assert.ok(Array.isArray(build.timings) && build.timings.length > 0
    && build.timings.every((phase) => phase.passed === true), 'Build contains an incomplete or failed phase');
  assert.equal(build.runtimeAudit?.ok, true, 'Build runtime audit did not pass');
  assert.equal(build.appNativeAudit?.ok, true, 'Build whole-app native audit did not pass');
  assert.equal(build.signing?.identity, 'ad-hoc');
  assert.equal(build.signing?.hardenedRuntime, true);
  assert.ok(Array.isArray(build.candidate?.files) && build.candidate.files.length > 0, 'Build candidate inventory missing');
  const candidateDigest = crypto.createHash('sha256').update(JSON.stringify(build.candidate.files)).digest('hex');
  assert.equal(build.candidate.sha256, candidateDigest, 'Build candidate source hash is inconsistent');
  const candidate = JSON.parse(fs.readFileSync(path.join(identity.resources, 'BUILD-CANDIDATE.json'), 'utf8'));
  assert.equal(candidate.schema, 'reverie.macos-build-candidate.v1');
  assert.equal(candidate.sourceSha256, build.candidate.sha256, 'App belongs to a different source candidate');
  assert.equal(candidate.gitHead, build.candidate.head);
  assert.equal(candidate.transport, 'framed-stdio-v4');
  assert.equal(candidate.profile, 'independent-core-local-test');
  assert.equal(candidate.live2dCoreBundled, false);
  const actual = buildInventory(actualTree);
  assert.ok(Array.isArray(build.bundle?.files), 'Final signed bundle inventory missing');
  assert.deepEqual(actual.files, build.bundle.files, 'App files, byte counts or symlink targets differ from the successful signed build');
  assert.equal(actual.sha256, build.bundle.sha256, 'Final signed bundle hash differs from the successful build');
  return { manifestPath: fs.realpathSync(manifestPath), manifestSha256: hashFile(manifestPath),
    sourceSha256: build.candidate.sha256, signedBundleSha256: actual.sha256,
    buildCompletedAt: build.completedAt, appId: identity.appId, matched: true };
}

function standalonePythonProbe(identity, runRoot) {
  const executable = path.join(identity.resources, 'python', 'bin', 'python3.12');
  assert.ok(fs.lstatSync(executable).isFile() && !fs.lstatSync(executable).isSymbolicLink(), 'Bundled Python must be a regular executable');
  const code = [
    'import json,sys,pathlib,importlib',
    'modules=[importlib.import_module(name) for name in ["sqlcipher3.dbapi2","sqlite_vec","cryptography","numpy","PIL.Image","lxml.etree","pydantic_core","jiter","primp"]]',
    'db=modules[0].connect(":memory:")',
    'cipher=db.execute("PRAGMA cipher_version").fetchone()[0]',
    'db.close()',
    'print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3]),"prefix":sys.prefix,"basePrefix":sys.base_prefix,"sysPath":sys.path,"cipherVersion":cipher,"modules":[str(pathlib.Path(m.__file__).resolve()) for m in modules]}))',
  ].join('\n');
  const result = JSON.parse(run(executable, ['-I', '-B', '-c', code], {
    cwd: runRoot, env: childEnvironment(runRoot, path.join(runRoot, 'probe-user-data')), timeout: 120_000,
  }));
  const runtimeRoot = fs.realpathSync(path.join(identity.resources, 'python'));
  assert.equal(result.version[0], 3); assert.equal(result.version[1], 12);
  assert.equal(fs.realpathSync(result.executable), fs.realpathSync(executable));
  assert.equal(fs.realpathSync(result.prefix), runtimeRoot);
  assert.equal(fs.realpathSync(result.basePrefix), runtimeRoot, 'Bundled interpreter depended on a virtual environment');
  for (const location of [...result.sysPath, ...result.modules]) {
    assert.ok(path.isAbsolute(location) && inside(runtimeRoot, path.resolve(location)), `External Python import path: ${location}`);
  }
  assert.ok(result.cipherVersion, 'Bundled SQLCipher unavailable');
  return result;
}

function resolvePackageInputs(args, frontendDirectory = frontendRoot) {
  const option = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return null;
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a path`);
    return path.resolve(args[index + 1]);
  };
  const explicitApp = option('--app');
  const explicitManifest = option('--manifest');
  if (explicitApp) {
    return { appPath: explicitApp, manifestPath: explicitManifest
      || path.join(frontendDirectory, 'release-macos', 'macos-build.json') };
  }
  const pointer = path.join(frontendDirectory, '.package-smoke-macos', 'latest-package.json');
  const latest = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  assert.ok(typeof latest.appPath === 'string' && path.isAbsolute(latest.appPath), 'Latest package pointer has no absolute app path');
  assert.ok(typeof latest.buildManifest === 'string' && path.isAbsolute(latest.buildManifest), 'Latest package pointer has no absolute build manifest');
  return { appPath: latest.appPath, manifestPath: explicitManifest || latest.buildManifest };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node script/smoke-packaged-macos.cjs [--app /absolute/Test.app] [--manifest /absolute/macos-build.json] [--out /absolute/report-parent] [--native-ui-controller]\nDefaults to .package-smoke-macos/latest-package.json; an explicit --app defaults to release-macos/macos-build.json unless --manifest is supplied. Requires the exact successful build. Runs 3 normal cycles and 3 fail-closed storage cases. Fatal error dialogs require visible OK confirmation within 300 seconds; --native-ui-controller adds a normal-window binding/ack pause for an external test controller. Production bridge timeouts are unchanged.\n');
    return;
  }
  const readArg = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${flag} requires a path`);
    return path.resolve(args[index + 1]);
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--native-ui-controller') continue;
    assert.ok(['--app', '--manifest', '--out'].includes(args[index]), `Unknown argument: ${args[index]}`);
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${args[index]} requires a path`);
    index += 1;
  }
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const inputs = resolvePackageInputs(args);
  const sourceApp = fs.realpathSync(inputs.appPath);
  const buildManifestPath = inputs.manifestPath;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const outputRoot = path.join(readArg('--out', path.join(frontendRoot, '.package-smoke-macos')), runId);
  fs.mkdirSync(outputRoot, { recursive: true });
  const tempParent = '/private/tmp/Reverie 核心 验收';
  fs.mkdirSync(tempParent, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(tempParent, 'run-'));
  for (const name of ['tmp', 'cache', 'crashpad', 'staging', '只读应用', 'user-data']) fs.mkdirSync(path.join(runRoot, name));
  const userData = path.join(runRoot, 'user-data');
  const mountPoint = path.join(runRoot, '只读应用');
  const imagePath = path.join(runRoot, '只读验收介质.dmg');
  const report = { passed: false, runId, sourceApp, runRoot, outputRoot, cycles: [], negativeCases: [],
    validationRevision: { script: path.relative(projectRoot, __filename), sha256: hashFile(__filename),
      nativeErrorHelper: { script: path.relative(projectRoot, nativeErrorHelper),
        sha256: fs.existsSync(nativeErrorHelper) ? hashFile(nativeErrorHelper) : null },
      scope: 'Validator revision; the immutable binary build snapshot is separately bound by buildBinding' },
    scope: 'Signed arm64 core test app on a read-only relocated volume; real UI chat and encrypted recovery',
    excluded: ['Live2D rendering', 'onboarding interaction', 'public distribution signing/notarization', 'real model quality'] };
  const active = [];
  let mounted = false;
  let mountedApp;
  let baseline;
  let fake;
  let failure;
  const started = Date.now();
  const stage = (name) => {
    report.stage = name;
    report.stageElapsedMs = Date.now() - started;
    fs.writeFileSync(path.join(outputRoot, 'progress.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`[package-smoke] ${name} (${report.stageElapsedMs}ms)\n`);
  };
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    stage('Validate test identity, signature, ASAR and production fuses');
    const sourceIdentity = readBundleIdentity(sourceApp);
    const sourceManifest = treeManifest(sourceApp);
    report.buildBinding = verifySuccessfulBuild(sourceIdentity, buildManifestPath, sourceManifest);
    const existing = processSnapshot().filter((item) => item.name === sourceIdentity.executable
      || (item.name.includes(APP_NAME) && path.basename(item.name) === sourceIdentity.executableName));
    assert.deepEqual(existing, [], 'An existing test application is running; its process will not be touched');
    report.security = await verifyHardenedBundle(sourceIdentity, outputRoot);
    report.sourceContentDigest = contentDigest(sourceManifest);
    stage('Copy final app outside repository and mount a read-only test volume');
    run('/usr/bin/ditto', [sourceApp, path.join(runRoot, 'staging', APP_NAME)]);
    run('/usr/bin/hdiutil', ['create', '-quiet', '-format', 'UDRO', '-srcfolder', path.join(runRoot, 'staging'), '-volname', 'Reverie 核心 验收', imagePath], { timeout: 180_000 });
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, imagePath], { timeout: 60_000 });
    mounted = true;
    mountedApp = path.join(mountPoint, APP_NAME);
    const identity = readBundleIdentity(mountedApp);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', identity.appRoot]);
    assert.ok(!inside(projectRoot, identity.appRoot) && /[\u4e00-\u9fff]/.test(identity.appRoot) && identity.appRoot.includes(' '));
    const writeProbe = path.join(identity.appRoot, 'readonly-write-probe');
    assert.throws(() => fs.writeFileSync(writeProbe, 'must not be writable'), (error) => ['EROFS', 'EACCES', 'EPERM'].includes(error.code));
    baseline = treeManifest(mountedApp);
    assert.equal(contentDigest(baseline), report.sourceContentDigest, 'Read-only copy differs from the final app');
    verifySuccessfulBuild(identity, buildManifestPath, baseline);
    fs.writeFileSync(path.join(outputRoot, 'bundle-before.json'), JSON.stringify(baseline, null, 2));
    report.readOnly = { appPath: identity.appRoot, writeRejected: true, medium: 'temporary UDRO verification image, not a distribution artifact' };
    stage('Audit every native image, loader context and signature in the read-only app');
    const { auditMacApp } = require('./macos-app-audit.cjs');
    const appAudit = await auditMacApp({ appPath: identity.appRoot, reportPath: path.join(outputRoot, 'app-native-audit.json') });
    assert.equal(appAudit.ok, true); assert.equal(appAudit.applicationUnchanged, true);
    report.appNativeAudit = { ok: true, applicationUnchanged: true,
      nativeFileCount: appAudit.nativeFiles.length, signatureCount: appAudit.signatures.length,
      loaderContextCount: appAudit.contexts.length, report: 'app-native-audit.json' };
    stage('Audit relocated bundled Python and native dependencies');
    const { auditMacRuntime } = require('./production-runtime-macos.cjs');
    const runtimeAudit = await auditMacRuntime({ runtimeRoot: path.join(identity.resources, 'python'), probe: false,
      scratchRoot: path.join(runRoot, 'tmp'), reportPath: path.join(outputRoot, 'native-runtime-audit.json') });
    assert.equal(runtimeAudit.ok, true);
    report.runtimeAudit = { ok: runtimeAudit.ok, runtimeUnchanged: runtimeAudit.runtimeUnchanged,
      nativeFileCount: runtimeAudit.nativeFiles.length, report: 'native-runtime-audit.json' };
    report.pythonProbe = standalonePythonProbe(identity, runRoot);
    const session = await createAcceptanceSession(runRoot, userData);
    fake = session.fake;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      stage(`Normal cycle ${cycle}: packaged startup and V4 authentication`);
      report.cycles.push(await runAcceptanceCycle(session, identity, cycle, active, outputRoot,
        { nativeUiController: args.includes('--native-ui-controller'), stage }));
      report.chat = session.chat; report.keychain = session.keychain;
      if (session.nativeUiController) report.nativeUiController = session.nativeUiController;
    }
    for (const kind of ['vault', 'database', 'missing-vault']) {
      stage(`Negative ${kind}: unchanged ciphertext and fail-closed startup`);
      const requestsBefore = fake.requests.length;
      report.negativeCases.push(await verifyNegativeStartup(identity, runRoot, userData, kind, active, outputRoot));
      assert.equal(fake.requests.length, requestsBefore, 'Failed storage startup called the model');
    }
    report.fakeProviderRequests = fake.requests.map((request) => ({ method: request.method, path: request.url }));
    report.passed = true;
  } catch (error) {
    failure = error; report.error = error.stack || String(error);
  } finally {
    for (const running of active.reverse()) {
      try { await forceCleanup(running); } catch (error) { failure ||= error; report.cleanupError = String(error); report.passed = false; }
      fs.writeFileSync(path.join(outputRoot, `${running.label}.log`), running.logs.join(''));
    }
    if (fake) { fake.server.closeAllConnections(); await new Promise((resolve) => fake.server.close(resolve)); }
    report.forcedCleanup = active.filter((running) => running.forcedCleanup).map((running) => running.label);
    if (report.passed && report.forcedCleanup.length) {
      failure = new Error('Passing acceptance cannot depend on forced cleanup'); report.passed = false;
    }
    if (mounted && baseline) {
      try {
        const after = treeManifest(mountedApp);
        assert.deepEqual(after, baseline, 'Application package changed during acceptance');
        report.bundleHashBefore = baseline.sha256; report.bundleHashAfter = after.sha256;
        report.bundleUnchanged = true;
        fs.writeFileSync(path.join(outputRoot, 'bundle-after.json'), JSON.stringify(after, null, 2));
      } catch (error) { failure ||= error; report.passed = false; report.bundleError = String(error); }
    }
    if (mounted) {
      try { run('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 30_000 }); mounted = false; }
      catch (error) { failure ||= error; report.passed = false; report.detachError = String(error); }
    }
    if (!mounted) {
      try { fs.rmSync(runRoot, { recursive: true, force: true }); report.scratchRemoved = true; }
      catch (error) { failure ||= error; report.passed = false; report.cleanupError = String(error); }
    }
    report.noResidualProcesses = !report.cleanupError;
    report.elapsedMs = Date.now() - started;
    fs.writeFileSync(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2));
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    process.stdout.write(`[package-smoke] Report: ${path.join(outputRoot, 'report.json')}\n`);
  }
  if (failure) throw failure;
  process.stdout.write(`[package-smoke] PASS: 3 normal cycles, 3 storage rejection cases, unchanged read-only bundle\n`);
}

module.exports = {
  APP_NAME, APP_ID, buildInventory, treeManifest, verifySuccessfulBuild, resolvePackageInputs, runNativeErrorHelper,
  readBundleIdentity, verifyHardenedBundle, standalonePythonProbe, processSnapshot, forceCleanup,
  createAcceptanceSession, runAcceptanceCycle, closeAcceptanceSession, verifyNegativeStartup,
  setInterrupted, contentDigest, hashFile, run, inside,
};
if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
