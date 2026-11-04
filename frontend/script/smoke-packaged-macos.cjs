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
const isolation = require('./acceptance-isolation.cjs');
const uiChecks = require('./ui-workspace-contract.cjs');
const summaryContract = require('./summary-package-contract.cjs');
const xiangqiContract = require('./xiangqi-package-contract.cjs');
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

function modelMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => typeof item?.text === 'string' ? item.text : '').join('\n');
  return '';
}
function summaryValidatorRevision() {
  const script = require.resolve('./summary-package-contract.cjs');
  return { script: path.relative(projectRoot, script).split(path.sep).join('/'), sha256: hashFile(script) };
}
function isXiangqiModelRequest(body) {
  return Array.isArray(body?.messages) && body.messages.some(message => message.role === 'system'
    && modelMessageText(message.content).includes('正在陪用户下xiangqi。'));
}
function fakeProviderReply(body) {
  if (isXiangqiModelRequest(body)) return JSON.stringify({move:'0,6,0,5',comment:'合成对手走一步'});
  if (summaryContract.isSummaryRequest(body)) return summaryContract.SUMMARY_REPLY;
  const latestUser = (body.messages || []).filter(message => message?.role === 'user').at(-1);
  if (modelMessageText(latestUser?.content).includes('CS fixture:')) return summaryContract.CHAT_REPLY;
  return modelMessageText(latestUser?.content).includes('WB fixture:') ? 'WB fixture reply' : assistantMessage;
}

async function startFakeProvider() {
  const requests = [];
  const fake = { requests, holdNextSummary: false, summaryResponseHeld: false };
  let heldSummary;
  fake.releaseSummary = () => {
    fake.holdNextSummary = false;
    if (!heldSummary) return false;
    const release = heldSummary; heldSummary = null; fake.summaryResponseHeld = false; release(); return true;
  };
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
        choices: [{ index: 0, message: { role: 'assistant', content: fakeProviderReply(body) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      });
      const respond = () => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(result) });
        response.end(result);
      };
      if (fake.holdNextSummary && summaryContract.isSummaryRequest(body)) {
        fake.holdNextSummary = false; fake.summaryResponseHeld = true; heldSummary = respond;
      } else respond();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return Object.assign(fake, { server, port: server.address().port });
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
  if (process.platform === 'darwin') {
    if (running.rootIdentity) isolation.collectProcesses(running, processSnapshot());
    return;
  }
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
  if (process.platform === 'darwin') return isolation.remainingProcesses(running);
  const alive = new Set(processSnapshot().map((item) => item.pid));
  return [...running.owned.values()].filter((item) => alive.has(item.pid));
}


function requireAlive(running) {
  if (running.observationError) throw Object.assign(running.observationError, { fatal: true });
  if (process.platform === 'darwin' && running.rootIdentity) {
    try { isolation.guardedAction(running, 'check'); }
    catch (error) { throw Object.assign(error, { fatal: true }); }
  }
  if (running.logError) throw Object.assign(new Error(`${running.label} live log failed: ${running.logError.message}`), { fatal: true });
  const fatalStartup = running.logs.join('').match(/\[Electron\] Fatal startup failure[^\n]*/);
  if (fatalStartup) {
    throw Object.assign(new Error(`${running.label}: ${fatalStartup[0]}`), { fatal: true });
  }
  if (running.error || running.child.exitCode !== null || running.child.signalCode !== null) {
    throw Object.assign(new Error(`${running.label} exited early: ${running.error?.message || running.logs.join('').slice(-2500)}`), { fatal: true });
  }
}


async function chatHistory(cdp, conversationId = 'dream-room') {
  assert.match(conversationId, /^[A-Za-z0-9._:-]{1,160}$/);
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
      payload: { conversation_id: ${JSON.stringify(conversationId)}, limit: 100 } }).catch((error) => {
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
      shown.role === item.role && shown.content === item.content).length === expected.filter((other) =>
      other.role === item.role && other.content === item.content).length)
      ? expected : null;
  })()`), 'exact user and assistant bubbles displayed');
}


async function forceCleanup(running) {
  running.cdp?.close(); running.mainCdp?.close();
  clearInterval(running.ownershipTimer);
  if (!running.child.pid) return;
  if (process.platform === 'darwin') {
    // Failed observation is never permission to signal a stale PID or a group.
    assert.ok(running.rootIdentity, 'Missing captured process identity; no cleanup signal sent');
    collectOwned(running);
    const survivors = remainingOwned(running);
    if (!survivors.length) return;
    running.forcedCleanup = true;
    for (const item of survivors.reverse()) isolation.signalOwned(running, item, 'SIGKILL');
    await waitFor(() => remainingOwned(running).length === 0, `${running.label} owned cleanup`, 10_000, true);
    return;
  }
  // The existing Windows runner retains its process inspection contract.
  collectOwned(running);
  const survivors = remainingOwned(running);
  if (!survivors.length) return;
  running.forcedCleanup = true;
  for (const item of survivors.reverse()) {
    spawnSync('taskkill', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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
  isolation.assertIsolation(runRoot, userData);
  for (const name of ['tmp', 'cache', 'crashpad']) isolation.assertIsolation(runRoot, path.join(runRoot, name));
  // HOME identifies the logged-in macOS Keychain user. All application data,
  // Chromium caches, crash reports and temporary files are separately located.
  return {
    HOME: process.env.HOME || '', USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
    TMPDIR: `${path.join(runRoot, 'tmp')}${path.sep}`, XDG_CACHE_HOME: path.join(runRoot, 'cache'),
    REVERIE_TEST_USER_DATA_DIR: userData, PYTHON_DOTENV_DISABLED: '1',
  };
}

function appendApplicationLog(running, chunk, appendFile = fs.appendFileSync) {
  const text = String(chunk);
  running.logs.push(text);
  // Stream callbacks must not throw outside the acceptance runner. Retain the
  // original write error and surface it through readiness and finalization.
  if (running.logPath && !running.logError) {
    try { appendFile(running.logPath, text); } catch (error) { running.logError = error; }
  }
}

function summarizeDebuggerTargets(targets) {
  return targets.slice(0, 10).map((target) => {
    let scheme = null, origin = null;
    try { const url = new URL(target.url); scheme = url.protocol; origin = url.origin; } catch {}
    return { type: String(target.type || '').slice(0, 32), scheme, origin,
      productionUrl: target.url === PACKAGED_URL };
  });
}

async function launchApplication(identity, runRoot, userData, label, port, active, outputRoot) {
  isolation.assertIsolation(runRoot, userData);
  isolation.prepareNativeController(runRoot);
  const running = { label, logs: [], owned: new Map(), startedAt: Date.now(), identity, userData, runRoot, phases: [] };
  if (outputRoot) {
    running.logPath = path.join(outputRoot, `${label}.log`);
    fs.writeFileSync(running.logPath, '', { flag: 'wx', mode: 0o600 });
  }
  running.child = spawn(identity.executable, [
    `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`,
    `--disk-cache-dir=${path.join(userData, 'Cache')}`,
    `--crash-dumps-dir=${path.join(runRoot, 'crashpad')}`,
  ], { cwd: runRoot, env: childEnvironment(runRoot, userData), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.child.once('error', (error) => { running.error = error; });
  running.child.stdout.on('data', (chunk) => appendApplicationLog(running, chunk));
  running.child.stderr.on('data', (chunk) => appendApplicationLog(running, chunk));
  active.push(running);
  await waitFor(() => {
    if (running.error || running.child.exitCode !== null) throw Object.assign(new Error('Test app exited before identity capture'), { fatal: true });
    isolation.registerRoot(running); return true;
  }, 'spawned process identity', 3000);
  running.ownershipTimer = setInterval(() => {
    try { collectOwned(running); } catch (error) { running.observationError = error; }
  }, 1000);
  running.ownershipTimer.unref();
  running.child.once('exit', () => clearInterval(running.ownershipTimer));
  return running;
}

async function startPackagedApp(identity, runRoot, userData, cycle, active, outputRoot, stage) {
  const port = await freePort();
  const running = await launchApplication(identity, runRoot, userData, `normal-${cycle}`, port, active, outputRoot);
  const phase = (name) => {
    running.phase = name;
    running.phases.push({ name, elapsedMs: Date.now() - running.startedAt });
    stage?.(`${running.label}: ${name}`);
  };
  phase('Waiting for production renderer');
  const target = await waitFor(async () => {
    requireAlive(running);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    running.debuggerTargets = summarizeDebuggerTargets(targets);
    return targets.find((item) => item.type === 'page' && item.url === PACKAGED_URL);
  }, `${running.label} production renderer`, 150_000);
  phase('Waiting for React and sandboxed preload');
  running.cdp = await connectCdp(target.webSocketDebuggerUrl, () => requireAlive(running));
  await waitFor(() => evaluate(running.cdp, `document.readyState === 'complete'
    && Boolean(document.querySelector('[data-testid="mvp-room"]')) && Boolean(window.electronAPI?.bridge)`),
  'packaged React and sandboxed preload', 90_000);
  const surface = await evaluate(running.cdp, `({ url: location.href, require: typeof window.require,
    frozen: Object.isFrozen(window.electronAPI), platform: window.electronAPI.platform })`);
  assert.deepEqual(surface, { url: PACKAGED_URL, require: 'undefined', frozen: true, platform: 'darwin' });
  phase('Waiting for V4 authority');
  running.connection = await waitFor(async () => {
    requireAlive(running);
    const result = await evaluate(running.cdp, 'window.electronAPI.bridge.getConnectionConfig()');
    return result?.transport === 'electron-ipc' && result.protocolVersion === 4 ? result : null;
  }, 'packaged V4 authority', 150_000);
  assert.equal(running.connection.secret, '', 'Renderer received an authentication secret');
  phase('Checking production authority and process boundaries');
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
  running.evidence = { label: running.label, processIdentity: running.rootIdentity,
    isolationDirectories: isolation.assertIsolation(runRoot, userData), readyMs: Date.now() - running.startedAt,
    protocolVersion: running.connection.protocolVersion, surface, csp, python,
    childPath: childEnvironment(runRoot, userData).PATH, cwd: runRoot, startupStages: running.phases };
  return running;
}

async function normalPackagedQuit(running, _outputRoot) {
  collectOwned(running);
  running.cdp?.close();
  const result = isolation.guardedAction(running, 'quit');
  running.quitMethod = result.method;
  await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null,
    `${running.label} normal quit`, 30_000, true);
  assert.equal(running.child.exitCode, 0, `Abnormal application exit: ${running.child.exitCode}/${running.child.signalCode}`);
  await waitFor(() => remainingOwned(running).length === 0, `${running.label} descendants exit`, 15_000, true);
  running.gracefulExit = true;
}

// Compatibility export for tooling that reads controller outcomes. No fallback
// binds by application name/path or asks another tool to open the application.
function runNativeErrorHelper(requestPath, running) {
  assert.ok(running?.rootIdentity, 'Owned process context is required for fatal confirmation');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const startedAt = Date.now();
  try {
    const result = isolation.guardedAction(running, 'confirm-fatal', {
      expectedTitle: request.expectedTitle, expectedMessage: request.expectedMessage,
      expectedExitCode: request.expectedExitCode,
    });
    return { available: true, attempted: true, exitCode: 0, result, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { available: true, attempted: true, exitCode: 2, error: String(error), elapsedMs: Date.now() - startedAt };
  }
}

async function acknowledgeFatalStartupDialog(running, kind, outputRoot) {
  collectOwned(running);
  const request = { kind, appRoot: running.identity.appRoot, appId: APP_ID,
    expected: running.rootIdentity, expectedTitle: 'Reverie 启动失败',
    expectedMessage: '安全初始化未完成，应用将退出。', expectedExitCode: 1 };
  const requestPath = path.join(outputRoot, `native-fatal-${kind}-needed.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  const helperRecord = runNativeErrorHelper(requestPath, running);
  running.nativeFatalConfirmation = helperRecord;
  fs.writeFileSync(path.join(outputRoot, `native-fatal-${kind}-helper.json`), JSON.stringify(helperRecord, null, 2));
  assert.equal(helperRecord.exitCode, 0, `Fatal alert controller stopped without fallback: ${helperRecord.error || ''}`);
  await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null,
    `${kind} native fatal error acknowledgement`, 30_000);
  assert.equal(running.child.signalCode, null, 'Fatal storage rejection was terminated by a signal');
  assert.equal(running.child.exitCode, 1, 'Fatal storage rejection must exit 1 after its error dialog is confirmed');
  await waitFor(() => remainingOwned(running).length === 0, 'fatal startup descendants exit', 15_000, true);
  running.quitMethod = 'verified existing fatal error dialog confirmed; application exited 1';
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
  const userData = isolation.createIsolatedDirectory(runRoot, `negative-${kind}`);
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
  const running = await launchApplication(identity, runRoot, userData, `negative-${kind}`, await freePort(), active, outputRoot);
  const diagnosticPattern = kind === 'missing-vault' ? /REVERIE_STORAGE_KEY_MISSING/
    : kind === 'vault'
      ? /(?:REVERIE_STORAGE_KEY_CORRUPT|encrypted database key is corrupt|database key.*invalid schema)/i
      : /(?:encrypted database.*(?:verified|authentication|failed)|file is not a database|SQLCipher.*(?:failed|error)|hmac check failed)/i;
  const diagnostic = await waitFor(() => {
    if (running.logError) throw Object.assign(new Error(`${running.label} live log failed: ${running.logError.message}`), { fatal: true });
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
  if (running.uiContractEnabled) running.uiDuringReply=await uiChecks.navigateDuringReply(running.cdp);
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


// Requests use the real preload/host V4 path; no application test API is added.
async function archiveRequest(cdp, type, payload = {}) {
  assert.ok(['archive:get', 'archive:put'].includes(type));
  const requestId = `worldbook-archive-${crypto.randomUUID()}`;
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const requestId = ${JSON.stringify(requestId)};
    const timer = setTimeout(() => { dispose(); reject(new Error('Worldbook archive request timed out')); }, 15000);
    const dispose = window.electronAPI.bridge.onMessage((frame) => {
      if (frame?.request_id !== requestId || !['archive:result', 'error'].includes(frame.type)) return;
      clearTimeout(timer); dispose();
      if (frame.type === 'error' || frame.payload?.ok !== true) reject(new Error(JSON.stringify(frame.payload)));
      else resolve(frame.payload);
    });
    window.electronAPI.bridge.send({ type: ${JSON.stringify(type)}, request_id: requestId,
      payload: ${JSON.stringify(payload)} }).catch(error => { clearTimeout(timer); dispose(); reject(error); });
  })`);
}

function worldbookBaseArchive(record) {
  assert.equal(record?.ok, true, 'Archive fixture requires a successful authoritative read');
  if (record.exists === false && record.archive == null) {
    return { characters: [], activeCharacterIds: [], worldBooks: [] };
  }
  assert.ok(record.archive && Array.isArray(record.archive.characters)
    && Array.isArray(record.archive.activeCharacterIds) && Array.isArray(record.archive.worldBooks),
  'Existing authoritative archive is invalid; do not replace it with an empty fixture');
  return structuredClone(record.archive);
}

function worldbookFixture() {
  const entry = { id: 'package-worldbook-entry', keywords: ['WB fixture:'], secondaryKeywords: [],
    selectiveLogic: 'and_any', content: 'WB_CURRENT_A', enabled: true, alwaysActive: false,
    useRegex: false, caseSensitive: true, scanDepth: 1, insertionOrder: 1, priority: 1,
    tokenBudget: null, position: 'before_char', role: 'system', depth: 0, comment: '' };
  return { id: 'package-worldbook-contract', name: 'Synthetic packaged worldbook', entries: [entry],
    scanDepth: 1, tokenBudget: 500, recursiveScanning: false,
    createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' };
}
function assertWorldbookPrompt(request, included, excluded = []) {
  const system = (request?.body?.messages || []).filter(message => message.role === 'system')
    .map(message => modelMessageText(message.content)).join('\n');
  assert.ok(system, 'Actual model request has no system prompt');
  for (const marker of included) assert.ok(system.includes(marker), `Worldbook marker missing from actual system prompt: ${marker}`);
  for (const marker of excluded) assert.equal(system.includes(marker), false, `Stale/failed worldbook marker entered system prompt: ${marker}`);
}
function worldbookRecordIdentity(record, bookId) {
  assert.equal(record?.ok, true);
  const book = record.archive?.worldBooks?.find(item => item.id === bookId);
  assert.ok(book, 'Persisted packaged worldbook is missing');
  assert.ok(typeof record.persona_id === 'string' && record.persona_id);
  assert.ok(Number.isSafeInteger(record.revision) && record.revision > 0);
  assert.match(record.checksum, /^[a-f0-9]{64}$/);
  return { personaId: record.persona_id, revision: record.revision, checksum: record.checksum,
    bookId: book.id, entryIds: book.entries.map(item => item.id),
    bookSha256: crypto.createHash('sha256').update(JSON.stringify(book)).digest('hex') };
}
function assertWorldbookWorkers(logs, pythonRoot, snapshot = processSnapshot()) {
  const records = [...logs.matchAll(/worldbook_regex_(spawn|timeout|reap) pid=(\d+) executable=([^\r\n]+)/g)]
    .map(match => ({ kind: match[1], pid: Number(match[2]), executable: match[3].trim(), position: match.index }));
  const spawns = records.filter(item => item.kind === 'spawn');
  assert.ok(spawns.length >= 2, 'Real regex timeout and repaired worker spawns were not recorded');
  for (const spawn of spawns) {
    assert.ok(path.isAbsolute(spawn.executable) && inside(pythonRoot, path.resolve(spawn.executable)), 'Regex worker used an external interpreter');
    assert.ok(records.some(item => item.kind === 'reap' && item.pid === spawn.pid && item.position > spawn.position), 'Regex worker was not reaped');
    assert.equal(snapshot.some(item => item.pid === spawn.pid && path.resolve(item.name) === path.resolve(spawn.executable)), false,
      'Recorded regex worker is still running');
  }
  const timeout = records.find(item => item.kind === 'timeout');
  assert.ok(timeout && records.some(item => item.kind === 'reap' && item.pid === timeout.pid && item.position > timeout.position),
    'Timed-out regex worker did not record a completed reap');
  return { spawned: spawns.length, timeoutRecorded: true, allReaped: true, externalInterpreter: false,
    pids: spawns.map(item => item.pid) };
}

function composerReadyExpression(text) {
  return `(() => {const input=document.querySelector('textarea[placeholder^="给 "]:not(:disabled)');const button=Array.from(document.querySelectorAll('[data-testid="mvp-room"] button')).find(b=>b.textContent.trim()==='发送');return Boolean(input&&input.value===${JSON.stringify(text)}&&button&&!button.disabled);})()`;
}
async function submitFixtureUiText(running, text) {
  await running.cdp.call('Input.insertText', { text });
  // A connected textarea is not proof that React has accepted its draft or
  // released the previous active request. Wait for the actual send control.
  await waitFor(() => evaluate(running.cdp, composerReadyExpression(text)), 'controlled draft and enabled send control');
  await evaluate(running.cdp, `(() => {const b=Array.from(document.querySelectorAll('[data-testid="mvp-room"] button')).find(b=>b.textContent.trim()==='发送');if(!b||b.disabled)throw Error('Send control changed before click');b.click();return true;})()`);
}

async function performFixtureUiChat(running, fake, text) {
  const start = fake.requests.length;
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('textarea[placeholder^="给 "]:not(:disabled)'))`),
    'fixture enabled packaged chat input');
  await evaluate(running.cdp, `window.__worldbookSmokeFrames = [];
    window.__worldbookSmokeDispose = window.electronAPI.bridge.onMessage(frame => window.__worldbookSmokeFrames.push(frame));
    document.querySelector('textarea[placeholder^="给 "]').focus(); true`);
  try {
    await submitFixtureUiText(running, text);
    const request = await waitFor(() => fake.requests.slice(start).find(item => {
      if (summaryContract.isSummaryRequest(item.body)) return false;
      const user = (item.body.messages || []).filter(message => message.role === 'user').at(-1);
      return modelMessageText(user?.content).includes(text);
    }), 'fixture real UI turn reached local model');
    const terminal = await waitFor(async () => {
      const frames = await evaluate(running.cdp, 'window.__worldbookSmokeFrames');
      const error = frames.find(frame => frame.type === 'chat:error');
      if (error) throw Object.assign(new Error(JSON.stringify(error)), { fatal: true });
      return frames.find(frame => frame.type === 'chat:done' || frame.payload?.state === 'ready_waiting');
    }, 'worldbook reply readiness');
    if (terminal.type !== 'chat:done') {
      const requestId = terminal.payload?.request_id || terminal.request_id;
      assert.ok(requestId);
      await evaluate(running.cdp, `window.electronAPI.bridge.send({ type:'chat:reveal',
        request_id:${JSON.stringify(`worldbook-reveal-${crypto.randomUUID()}`)}, payload:{request_id:${JSON.stringify(requestId)}} })`);
    }
    const done = await waitFor(() => evaluate(running.cdp,
      'window.__worldbookSmokeFrames.find(frame => frame.type === "chat:done")'), 'worldbook chat terminal');
    assert.equal(done.payload.degraded_to_local_reflex, false, 'Worldbook test bypassed the model');
    const history = await chatHistory(running.cdp);
    assert.equal(history.items.filter(item => item.role === 'user' && item.content === text).length, 1,
      'Worldbook UI message was missing or duplicated');
    return { request, requestId: done.payload?.request_id || done.request_id };
  } finally {
    await evaluate(running.cdp, 'window.__worldbookSmokeDispose?.(); delete window.__worldbookSmokeDispose; true');
  }
}

async function checkWorldbookCapabilities(running, session, stage) {
  const original = await archiveRequest(running.cdp, 'archive:get');
  let record = original;
  const book = worldbookFixture(), normalEntry = structuredClone(book.entries[0]);
  const baseArchive = worldbookBaseArchive(original);
  const steps = [], logsStart = running.logs.length;
  const save = async (entries) => {
    const archive = structuredClone(baseArchive);
    archive.worldBooks = (archive.worldBooks || []).filter(item => item.id !== book.id);
    if (entries !== null) archive.worldBooks.push({ ...book, entries: structuredClone(entries) });
    const previousRevision = record.revision;
    record = await archiveRequest(running.cdp, 'archive:put', { archive, expected_revision: previousRevision });
    assert.equal(record.revision, previousRevision + 1, 'Archive revision did not advance after save');
    assert.equal(record.persona_id, original.persona_id, 'Worldbook save changed persona');
    if (entries !== null) assert.deepEqual(record.archive.worldBooks.find(item => item.id === book.id).entries.map(item => item.id),
      entries.map(item => item.id), 'Save changed entry IDs');
    return record;
  };
  const chat = async (name, text, included, excluded) => {
    stage?.(`Packaged worldbook: ${name}`);
    const result = await performFixtureUiChat(running, session.fake, text);
    assertWorldbookPrompt(result.request, included, excluded);
    steps.push({ name, revision: record.revision, included, excluded, actualModelPromptChecked: true });
    return result;
  };
  await save([normalEntry]);
  await chat('saved content A', 'WB fixture: current A', ['WB_CURRENT_A'], ['WB_CURRENT_B']);
  normalEntry.content = 'WB_CURRENT_B'; await save([normalEntry]);
  await chat('next turn uses saved B', 'WB fixture: current B', ['WB_CURRENT_B'], ['WB_CURRENT_A']);
  normalEntry.enabled = false; await save([normalEntry]);
  await chat('disabled entry omitted', 'WB fixture: disabled', [], ['WB_CURRENT_A', 'WB_CURRENT_B']);
  await save(null);
  await chat('deleted book omitted', 'WB fixture: deleted', [], ['WB_CURRENT_A', 'WB_CURRENT_B']);
  const faulty = { ...normalEntry, id: 'package-worldbook-regex', enabled: true, useRegex: true,
    keywords: ['.*'], secondaryKeywords: ['(a+)+$'], selectiveLogic: 'not_any', content: 'WB_MUST_NOT', priority: 2 };
  const healthy = { ...normalEntry, id: 'package-worldbook-healthy', enabled: true, keywords: ['WB'], content: 'WB_HEALTHY' };
  await save([faulty, healthy]);
  const timedOut = await chat('regex timeout isolates one entry', `WB fixture: timeout ${'a'.repeat(5000)}!`,
    ['WB_HEALTHY'], ['WB_MUST_NOT', 'WB_CURRENT_A', 'WB_CURRENT_B']);
  const failed = await archiveRequest(running.cdp, 'archive:get');
  const diagnostics = failed.world_book_diagnostics;
  assert.equal(diagnostics?.persona_id, original.persona_id);
  assert.equal(diagnostics?.revision, record.revision);
  assert.ok(diagnostics?.request_id);
  assert.ok(timedOut.requestId, 'Actual chat terminal omitted its request identity');
  assert.equal(diagnostics.request_id, timedOut.requestId);
  assert.ok(diagnostics.entries.some(item => item.code === 'regex_timeout' && item.entry_id === faulty.id
    && item.book_id === book.id && item.revision === record.revision), 'Real regex timeout diagnostic missing');
  await waitFor(() => evaluate(running.cdp,
    `document.querySelector('[data-testid="worldbook-notice"]')?.textContent?.includes('超时')`), 'visible worldbook timeout warning');
  faulty.secondaryKeywords = ['Z+']; await save([faulty, healthy]);
  assert.deepEqual(record.world_book_diagnostics?.entries, [], 'Save did not clear the previous revision warning');
  await chat('saved regex repair applies next turn', 'WB fixture: fixed regex', ['WB_HEALTHY', 'WB_MUST_NOT'], []);
  const repaired = await archiveRequest(running.cdp, 'archive:get');
  assert.deepEqual(repaired.world_book_diagnostics?.entries, [], 'Repaired regex left a stale diagnostic');
  await waitFor(() => evaluate(running.cdp, `!document.querySelector('[data-testid="worldbook-notice"]')`),
    'worldbook warning cleared after repair');
  const finalEntry = { ...normalEntry, enabled: true, content: 'WB_FINAL_PERSISTED', keywords: ['WB fixture:'] };
  await save([finalEntry]);
  await chat('benign archive retained for restarts', 'WB fixture: final archive', ['WB_FINAL_PERSISTED'], ['WB_MUST_NOT', 'WB_HEALTHY']);
  const final = await archiveRequest(running.cdp, 'archive:get');
  session.worldbookExpected = worldbookRecordIdentity(final, book.id);
  const workers = assertWorldbookWorkers(running.logs.slice(logsStart).join(''), path.join(running.identity.resources, 'python'));
  return { passed: true, steps, originalRevision: original.revision, finalArchive: session.worldbookExpected,
    timeoutDiagnostic: { persona_id: diagnostics.persona_id, revision: diagnostics.revision,
      request_id: diagnostics.request_id, entries: diagnostics.entries, truncated: diagnostics.truncated },
    visibleWarning: true, repairClearsWarning: true, workers,
    preservedForRestartChecks: true, mutationsLimitedToIsolatedArchive: true };
}

async function summaryRequest(cdp, type, payload = {}) {
  const results = { 'summary:status': 'summary:result', 'ai_usage:get': 'ai_usage:result',
    'ai_usage:grant': 'ai_usage:result', 'ai_usage:revoke': 'ai_usage:result', 'settings:update': 'settings:update:result',
    'settings:get': 'settings:get:result', 'api:budget:get': 'api:budget:result',
    'game_state:get': 'game_state:result', 'game_state:put': 'game_state:result' };
  assert.ok(Object.hasOwn(results, type), 'Unsupported summary acceptance request');
  const requestId = `package-summary-${crypto.randomUUID()}`;
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const requestId = ${JSON.stringify(requestId)};
    const timer = setTimeout(() => { dispose(); reject(new Error('Summary acceptance request timed out')); }, 15000);
    const dispose = window.electronAPI.bridge.onMessage(frame => {
      if (frame?.request_id !== requestId || ![${JSON.stringify(results[type])}, 'error'].includes(frame.type)) return;
      clearTimeout(timer); dispose();
      if (frame.type === 'error' || frame.payload?.error || frame.payload?.ok === false) reject(new Error('Summary acceptance request refused'));
      else resolve(frame.payload);
    });
    window.electronAPI.bridge.send({ type: ${JSON.stringify(type)}, request_id: requestId,
      payload: ${JSON.stringify(payload)} }).catch(error => { clearTimeout(timer); dispose(); reject(error); });
  })`);
}

async function enterSummaryPanel(running) {
  await evaluate(running.cdp, `(() => {
    const button = Array.from(document.querySelectorAll('nav[aria-label="主要功能"] button'))
      .find(item => item.dataset.nav === 'settings' || item.textContent.trim() === '设置');
    if (!button || button.disabled) throw new Error('MVP settings control unavailable');
    button.click(); return true;
  })()`);
  await waitFor(() => evaluate(running.cdp, `Boolean(Array.from(document.querySelectorAll('select')).find(select =>
    Array.from(select.options).some(option => option.value === 'dream')))`), 'existing UI mode selector');
  await evaluate(running.cdp, `(() => {
    const select = Array.from(document.querySelectorAll('select')).find(item => Array.from(item.options).some(option => option.value === 'dream'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'dream');
    select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`);
  await evaluate(running.cdp, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === '保存界面模式');
    if (!button || button.disabled) throw new Error('UI mode save unavailable'); button.click(); return true;
  })()`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="dream-room"][data-connection="connected"]'))`),
    'DreamRoom through saved UI mode');
  await evaluate(running.cdp, `document.querySelector('[data-nav="settings"]').click(); true`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-panel="settings"]'))`), 'DreamRoom settings drawer');
  await evaluate(running.cdp, `(() => {
    const button = Array.from(document.querySelectorAll('[data-panel="settings"] button')).find(item =>
      item.querySelector('span')?.textContent.trim() === '遗忘设置');
    if (!button || button.disabled) throw new Error('Memory settings control unavailable'); button.click(); return true;
  })()`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="summary-enabled"]:not(:disabled)'))`),
    'summary panel with current persona proof');
}

async function returnToCoreChat(running) {
  await uiChecks.returnCoreMode(running.cdp);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('textarea[placeholder^="给 "]:not(:disabled)'))`), 'core chat restored');
}

async function importSummaryViaUi(running, session) {
  isolation.assertIsolation(session.runRoot, session.userData);
  const content = summaryContract.legacyFixture();
  const filename = path.join(session.runRoot, 'tmp', `unattributed-summary-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
  await enterSummaryPanel(running);
  await evaluate(running.cdp, `window.__summaryImportFrames = [];
    window.__summaryImportDispose = window.electronAPI.bridge.onMessage(frame => {
      if (frame?.type === 'summary:result' || frame?.type === 'error') window.__summaryImportFrames.push(frame);
    }); true`);
  let preview, imported;
  try {
    const document = await running.cdp.call('DOM.getDocument');
    const selected = await running.cdp.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: '[data-testid="summary-legacy-file"]' });
    assert.ok(selected.nodeId, 'Existing summary file input missing');
    await running.cdp.call('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [filename] });
    preview = await waitFor(() => evaluate(running.cdp, `window.__summaryImportFrames.find(frame => frame.payload?.operation === 'preview')?.payload`),
      'legacy preview through actual file input');
    summaryContract.assertLegacyResult(preview, content, false);
    await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="summary-import-preview"]')?.textContent.includes('未归属 1 条'))`),
      'visible unattributed import preview');
    await evaluate(running.cdp, `(() => {
      const button = document.querySelector('[data-testid="summary-import-confirm"]');
      if (!button || button.disabled) throw new Error('Summary confirmation control unavailable'); button.click(); return true;
    })()`);
    imported = await waitFor(() => evaluate(running.cdp, `window.__summaryImportFrames.find(frame => frame.payload?.operation === 'import')?.payload`),
      'legacy import after UI confirmation');
    summaryContract.assertLegacyResult(imported, content, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), content, 'Legacy import modified the selected source file');
  } finally {
    await evaluate(running.cdp, 'window.__summaryImportDispose?.(); delete window.__summaryImportDispose; true');
  }
  await returnToCoreChat(running);
  return { preview, imported, sourceFileUnchanged: true, selectedThroughFileInput: true, confirmedThroughUi: true };
}

async function grantSummary(running) {
  const disclosure = await summaryRequest(running.cdp, 'ai_usage:get');
  const feature = disclosure.features?.conversation_summary;
  assert.ok(feature?.description && typeof feature.description === 'string');
  assert.match(feature.consent_digest, /^[a-f0-9]{64}$/);
  const granted = await summaryRequest(running.cdp, 'ai_usage:grant', { feature: 'conversation_summary',
    consent_digest: feature.consent_digest, api_cost_acknowledged: true, user_confirmed: true });
  assert.equal(granted.features?.conversation_summary?.effective, true);
}

async function performConversationFixtureChat(running, fake, conversationId, text) {
  assert.match(conversationId, /^summary-budget-[a-f0-9-]+$/);
  const requestId = `summary-budget-${crypto.randomUUID()}`, start = fake.requests.length;
  await evaluate(running.cdp, `window.__summaryBudgetFrames = [];
    window.__summaryBudgetDispose = window.electronAPI.bridge.onMessage(frame => {
      if (frame?.request_id === ${JSON.stringify(requestId)} || frame?.payload?.request_id === ${JSON.stringify(requestId)})
        window.__summaryBudgetFrames.push(frame);
    }); true`);
  try {
    await evaluate(running.cdp, `window.electronAPI.bridge.send({ type: 'chat:send', request_id: ${JSON.stringify(requestId)},
      payload: { request_id: ${JSON.stringify(requestId)}, conversation_id: ${JSON.stringify(conversationId)}, text: ${JSON.stringify(text)} } })`);
    const request = await waitFor(() => fake.requests.slice(start).find(item => {
      if (summaryContract.isSummaryRequest(item.body)) return false;
      const user = (item.body.messages || []).filter(message => message.role === 'user').at(-1);
      return modelMessageText(user?.content).includes(text);
    }), 'separate budget conversation reached the local model');
    const terminal = await waitFor(async () => {
      const frames = await evaluate(running.cdp, 'window.__summaryBudgetFrames');
      if (frames.some(frame => ['error', 'chat:error'].includes(frame.type)
        || ['failed', 'failed_uncertain', 'cancelled'].includes(frame.payload?.state))) {
        throw Object.assign(new Error('Budget fixture chat failed before commit'), { fatal: true });
      }
      return frames.find(frame => frame.type === 'chat:done' || frame.payload?.state === 'ready_waiting');
    }, 'separate budget conversation reply readiness');
    if (terminal.type !== 'chat:done') await evaluate(running.cdp,
      `window.electronAPI.bridge.send({ type: 'chat:reveal', request_id: ${JSON.stringify(`summary-reveal-${crypto.randomUUID()}`)},
        payload: { request_id: ${JSON.stringify(requestId)} } })`);
    const done = await waitFor(() => evaluate(running.cdp,
      'window.__summaryBudgetFrames.find(frame => frame.type === "chat:done")'), 'separate budget conversation committed reply');
    assert.equal(done.payload.conversation_id, conversationId);
    assert.equal(done.payload.degraded_to_local_reflex, false);
    const history = await chatHistory(running.cdp, conversationId);
    assert.equal(history.items.filter(item => item.role === 'user' && item.content === text).length, 1);
    summaryContract.assertPrompt(request, false);
    return { requestId, history };
  } finally {
    await evaluate(running.cdp, 'window.__summaryBudgetDispose?.(); delete window.__summaryBudgetDispose; true');
  }
}

async function checkSummaryBudget(running, session, stage) {
  const conversationId = `summary-budget-${crypto.randomUUID()}`;
  const mainBefore = summaryContract.summaryIdentity(await summaryRequest(running.cdp, 'summary:status',
    { conversation_id: summaryContract.CONVERSATION }));
  const settings = await summaryRequest(running.cdp, 'settings:get');
  const previous = settings.features?.api_background_daily_request_budget;
  assert.ok(Number.isSafeInteger(previous) && previous >= 1);
  const before = await summaryRequest(running.cdp, 'api:budget:get');
  assert.equal(before.tracking_enabled, true); assert.equal(before.background_enforced, true);
  assert.equal(before.background.requests, 1, 'Expected the completed main summary to consume one background request');
  assert.equal(before.by_purpose.find(item => item.purpose === 'memory_summary')?.requests, 1);
  const calls = summaryContract.summaryCalls(session.fake).length;
  let result;
  try {
    await summaryRequest(running.cdp, 'settings:update', { section: 'personality', api_background_daily_request_budget: 1 });
    const limited = await summaryRequest(running.cdp, 'api:budget:get');
    assert.equal(limited.background.request_budget, 1, 'Background budget did not apply to the live tracker');
    let history;
    for (let turn = 1; turn <= 14; turn += 1) {
      stage?.(`Packaged conversation summary: independent budget fixture ${turn}`);
      const chat = await performConversationFixtureChat(running, session.fake, conversationId,
        summaryContract.historyTurn(turn).replace('history', 'budget'));
      history = chat.history;
      assert.equal(history.items.length, turn * 2, 'Budget fixture did not commit complete exchanges');
    }
    const threshold = summaryContract.olderHistoryBoundary(history);
    const status = await waitFor(async () => {
      const value = await summaryRequest(running.cdp, 'summary:status', { conversation_id: conversationId });
      if (value.errorCode && value.errorCode !== 'budget_denied') throw Object.assign(new Error('Unexpected packaged summary rejection'), { fatal: true });
      return value.errorCode === 'budget_denied' && value.running === false ? value : null;
    }, 'budget denial without contacting the summary model', 30_000);
    summaryContract.assertBudgetDenied(status, session.fake, calls);
    const after = await summaryRequest(running.cdp, 'api:budget:get');
    assert.equal(after.background.requests, before.background.requests);
    assert.equal(after.by_purpose.find(item => item.purpose === 'memory_summary')?.requests, 1);
    const mainAfter = summaryContract.summaryIdentity(await summaryRequest(running.cdp, 'summary:status',
      { conversation_id: summaryContract.CONVERSATION }));
    assert.deepEqual(mainAfter, mainBefore, 'Budget test changed the main conversation summary');
    result = { conversationId, threshold, completeExchanges: 14, errorCode: status.errorCode,
      attempts: status.attempts, activeCount: status.activeCount, additionalSummaryModelCalls: 0,
      backgroundRequestsBefore: before.background.requests, backgroundRequestsAfter: after.background.requests,
      mainSummaryUnchanged: true, cooldownSeconds: status.cooldownSeconds };
  } finally {
    await summaryRequest(running.cdp, 'settings:update', { section: 'personality', api_background_daily_request_budget: previous });
    const restored = await summaryRequest(running.cdp, 'api:budget:get');
    assert.equal(restored.background.request_budget, previous, 'Original background budget was not restored');
  }
  const unchangedFailure = await summaryRequest(running.cdp, 'summary:status', { conversation_id: conversationId });
  summaryContract.assertBudgetDenied(unchangedFailure, session.fake, calls);
  session.summaryBudgetExpected = { conversationId, attempts: { ...unchangedFailure.attempts }, errorCode: unchangedFailure.errorCode };
  return { ...result, originalBudgetRestored: true, noAutomaticRetryAfterBudgetRestore: true };
}

async function checkSummaryCapabilities(running, session, stage) {
  const status = () => summaryRequest(running.cdp, 'summary:status', { conversation_id: summaryContract.CONVERSATION });
  let current = await status();
  summaryContract.assertNoSummaryWork(current, session.fake, false);
  await summaryRequest(running.cdp, 'settings:update', { section: 'personality', emotion_system_enabled: false });
  await summaryRequest(running.cdp, 'settings:update', { section: 'chat', reply_delay_min: 1, reply_delay_max: 1, split_messages: false });
  const steps = [];
  const chat = async (name, text, active) => {
    stage?.(`Packaged conversation summary: ${name}`);
    const result = await performFixtureUiChat(running, session.fake, text);
    summaryContract.assertPrompt(result.request, active);
    steps.push({ name, actualModelPromptChecked: true, summaryInjected: active, requestId: result.requestId });
    return result;
  };
  for (let turn = 1; turn <= 14; turn += 1) await chat(`default-off history ${turn}`, summaryContract.historyTurn(turn), false);
  current = await status();
  const threshold = summaryContract.assertEnoughHistory(current, await chatHistory(running.cdp));
  summaryContract.assertNoSummaryWork(current, session.fake, false);
  await enterSummaryPanel(running);
  await evaluate(running.cdp, `(() => {
    const control = document.querySelector('[data-testid="summary-enabled"]');
    if (control.checked || control.disabled) throw new Error('Summary default-off UI state is invalid'); control.click(); return true;
  })()`);
  await waitFor(async () => (await status()).enabled === true, 'summary feature enabled through UI');
  await returnToCoreChat(running);
  await chat('enabled without consent', 'CS fixture: feature alone does not authorize generation', false);
  summaryContract.assertNoSummaryWork(await status(), session.fake, true);
  await grantSummary(running);
  session.fake.holdNextSummary = true;
  try {
    await chat('authorized generation trigger', 'CS fixture: explicit consent permits background summary after commit', false);
    await waitFor(() => session.fake.summaryResponseHeld, 'local summary response deliberately held');
    const pending = await status();
    assert.equal(pending.activeCount, 0); assert.equal(pending.running, true);
    assert.deepEqual(pending.attempts, { started: 1 });
    // performFixtureUiChat has already observed chat:done and the committed
    // history. Only now may the independent background response be released.
  } finally { session.fake.releaseSummary(); }
  current = await waitFor(async () => {
    const value = await status();
    if (value.lastAttempt?.status === 'failed') throw Object.assign(new Error('Packaged summary generation failed'), { fatal: true });
    return value.attempts?.completed === 1 && value.running === false ? value : null;
  }, 'committed asynchronous summary', 30_000);
  const generated = summaryContract.assertGeneratedSource(current, session.fake, await chatHistory(running.cdp));
  await chat('next turn uses completed summary', 'CS fixture: use previously committed synthetic background', true);
  const legacy = await importSummaryViaUi(running, session);
  await chat('unattributed legacy excluded', 'CS fixture: retain independent generated context after legacy import', true);
  const importedStatus = await status();
  assert.equal(importedStatus.legacyInactiveCount, 1);
  assert.deepEqual(summaryContract.summaryIdentity(importedStatus).summaries, generated.summaries);
  const callsBeforeRevoke = summaryContract.summaryCalls(session.fake).length;
  const revoked = await summaryRequest(running.cdp, 'ai_usage:revoke', { feature: 'conversation_summary' });
  assert.equal(revoked.features?.conversation_summary?.effective, false);
  await chat('revocation stops generation and injection', 'CS fixture: revoked summary access', false);
  assert.equal(summaryContract.summaryCalls(session.fake).length, callsBeforeRevoke);
  current = await status(); assert.equal(current.authorized, false); assert.equal(current.running, false);
  assert.deepEqual(current.attempts, generated.attempts);
  await grantSummary(running); // Only restores persisted consent; no chat or generation is triggered.
  const budget = await checkSummaryBudget(running, session, stage);
  current = await status(); assert.equal(current.authorized, true); assert.equal(current.enabled, true);
  assert.equal(current.cooldownSeconds, 300, 'Production summary cooldown changed');
  session.summaryExpected = summaryContract.summaryIdentity(current);
  session.messages = summaryContract.historyIdentity(await chatHistory(running.cdp));
  assertMessages({ items: session.messages });
  await waitForDisplayedMessages(running.cdp, session.messages);
  return { passed: true, defaultDisabled: true, featureAloneDidNotAuthorize: true, explicitConsentGranted: true,
    threshold, steps, chatCompletedBeforeSummaryResponse: true, generatedSourceVerifiedAgainstLedger: true,
    summaryModelCalls: summaryContract.summaryCalls(session.fake).length, budget,
    nextTurnActualPromptChecked: true, legacy, revokedGenerationAndInjectionStopped: true,
    consentRestoredForRestartChecks: true, cooldownSeconds: current.cooldownSeconds,
    finalSummaryIdentity: session.summaryExpected, messageCount: session.messages.length,
    ordinaryApplicationInterfacesOnly: true, directDatabaseWrites: false, cooldownModified: false };
}

// Shared production acceptance session: the same encrypted data and fake model
// survive a relocation. No application code or security settings are modified.
async function createAcceptanceSession(runRoot, userData) {
  isolation.assertIsolation(runRoot, userData);
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

async function checkMediaCapabilities(running, session) {
  const configPath = path.join(session.userData, 'data', 'config.json');
  const original = fs.readFileSync(configPath);
  const previousMode = await evaluate(running.cdp, 'window.electronAPI.localMode.get()');
  const remoteRequests = session.fake.requests.length;
  const fixtureId = 'reverie-media-contract-fixture';
  let enabled = false;
  try {
    const disabled = await evaluate(running.cdp, `(async () => {
      try { await window.electronAPI.download.sniffResources(); return 'unexpected success'; }
      catch (error) { return String(error.message); }
    })()`);
    assert.match(disabled, /REVERIE_DOWNLOAD_SERVICE_DISABLED/);
    const config = JSON.parse(original.toString('utf8'));
    config.features = { ...(config.features || {}), download_service_enabled: true };
    fs.writeFileSync(`${configPath}.media-test`, JSON.stringify(config));
    fs.renameSync(`${configPath}.media-test`, configPath);
    enabled = true;
    await evaluate(running.cdp, `(async () => {
      const image = document.createElement('img'); image.id = ${JSON.stringify(fixtureId)};
      image.alt = 'Synthetic media contract'; image.style.display = 'none';
      image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="blue"/></svg>');
      document.body.appendChild(image); await image.decode();
    })()`);
    const resources = await evaluate(running.cdp, 'window.electronAPI.download.sniffResources()');
    assert.ok(resources.some(item => item.title === 'Synthetic media contract' && item.size === 40000));
    const privateSource = `http://127.0.0.1:${session.fake.port}/forbidden-media`;
    const denied = await evaluate(running.cdp, `window.electronAPI.download.sniffM3u8(${JSON.stringify(privateSource)})`);
    assert.match(denied.error || '', /public host/i);
    const content = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\npart.ts\n#EXT-X-ENDLIST\n';
    const logStart = running.logs.length;
    const segmentDenied = await evaluate(running.cdp, `(async () => {
      try { await window.electronAPI.download.downloadM3u8(${JSON.stringify({ url: privateSource, m3u8Content: content })}); return 'unexpected success'; }
      catch (error) { return String(error.message); }
    })()`);
    // The existing secure registrar intentionally hides internal transport
    // errors from the renderer. Verify both that public boundary and the
    // precise reason in this test-owned main process's diagnostic stream.
    assert.match(segmentDenied, /The requested local operation could not be completed/);
    await waitFor(() => /ERR_MEDIA_ADDRESS/.test(running.logs.slice(logStart).join('')),
      'private segment rejection diagnostic', 5000);
    assert.equal(session.fake.requests.length, remoteRequests, 'Private media denial contacted the fixture server');
    await evaluate(running.cdp, 'window.electronAPI.localMode.set(true)');
    const localDenied = await evaluate(running.cdp, `(async () => {
      try { await window.electronAPI.download.sniffM3u8('https://media.invalid/list.m3u8'); return 'unexpected success'; }
      catch (error) { return String(error.message); }
    })()`);
    assert.match(localDenied, /local focus mode|REVERIE_LOCAL_MODE/);
    const cache = path.join(session.userData, 'data', 'runtime', 'downloads');
    if (fs.existsSync(cache)) assert.deepEqual(fs.readdirSync(cache), [], 'Rejected media left a partial file');
    return { passed: true, defaultDisabled: true, realDomDiscovery: true,
      privateSourceAndSegmentsRejected: true, noDeniedRequestsSent: true,
      localModeRejected: true, temporaryFilesAbsent: true,
      scope: 'Actual packaged preload/IPC and production guards; successful byte transfers separately tested with real local HTTP and injected test connector.' };
  } finally {
    if (enabled) {
      fs.writeFileSync(`${configPath}.media-test`, original);
      fs.renameSync(`${configPath}.media-test`, configPath);
    }
    await evaluate(running.cdp, `document.getElementById(${JSON.stringify(fixtureId)})?.remove()`);
    await evaluate(running.cdp, `window.electronAPI.localMode.set(${Boolean(previousMode.active)})`);
  }
}

async function enterXiangqi(running) {
  await uiChecks.enterFullMode(running.cdp);
  await evaluate(running.cdp, `document.querySelector('[data-nav="activities"]').click(); true`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[aria-label="手机屏幕"]'))`), 'phone game menu');
  await evaluate(running.cdp, `(() => { const b=Array.from(document.querySelectorAll('[aria-label="手机屏幕"] button')).find(b=>b.querySelector('strong')?.textContent==='中国象棋');if(!b)throw Error('Xiangqi launcher missing');b.click();return true; })()`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="xiangqi-game"]'))`), 'Xiangqi panel');
}
async function xiangqiUi(running) {
  return evaluate(running.cdp, `(() => {const e=document.querySelector('[data-testid="xiangqi-game"]');return e?{status:e.dataset.state,revision:Number(e.dataset.revision),moves:Number(e.dataset.moves),disabled:e.querySelectorAll('[role="gridcell"]:disabled').length,notice:e.querySelector('[data-testid="xiangqi-notice"]')?.textContent||''}:null;})()`);
}
async function xiangqiReady(running, count) {
  return waitFor(async()=>{const v=await xiangqiUi(running);return v?.status==='ready'&&(count===undefined||v.moves===count)?v:null;},'canonical Xiangqi ready');
}
async function playXiangqiRound(running) {
  await evaluate(running.cdp, `(() => {const e=document.querySelector('[data-testid="xiangqi-game"]');const b=e.querySelector('[data-mode="companion"]');if(b)b.click();return true;})()`);
  await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="xiangqi-game"] [data-mode="practice"]'))`), 'practice mode committed');
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] [data-square="27"]').click();true`);
  await waitFor(() => evaluate(running.cdp, `(() => {const e=document.querySelector('[data-testid="xiangqi-game"]');return e.querySelector('[data-square="27"]').className.includes('selected') && e.querySelector('[data-square="36"]').className.includes('legalTarget');})()`), 'selected pawn and legal target committed');
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] [data-square="36"]').click();true`);
  await xiangqiReady(running,2);
  const record=await summaryRequest(running.cdp,'game_state:get',{game_id:'xiangqi'});
  assert.deepEqual(record.state[0],{from:27,to:36});assert.equal(record.state.length,2);return record;
}
async function checkXiangqiCapabilities(running,session,stage,companion=false) {
  const requests=session.fake.requests.length;
  const builder=createRequire(require.resolve('electron-builder'));
  const dependencies=createRequire(builder.resolve('app-builder-lib'));
  const asar=dependencies('@electron/asar');
  const archive=path.join(running.identity.resources,'app.asar');
  const graph=JSON.parse(asar.extractFile(archive,'dist/retired-dependency-build-graph.json'));
  xiangqiContract.assertRetirementGraph(graph);
  if (typeof asar.uncache === 'function') asar.uncache(archive);
  await enterXiangqi(running);await xiangqiReady(running,0);
  stage?.('Packaged Xiangqi: actual move and legal practice response');
  let record=await playXiangqiRound(running);
  stage?.('Packaged Xiangqi: undo and explicit reset');
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] button[title="悔棋"]').click();true`);await xiangqiReady(running,0);
  await playXiangqiRound(running);
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] button[title="重新开始"]').click();true`);await xiangqiReady(running,0);
  record=await playXiangqiRound(running);
  stage?.('Packaged Xiangqi: malformed existing record is retained and blocked');
  const invalid=[{from:27,to:36},{from:54,to:70}];
  const bad=await summaryRequest(running.cdp,'game_state:put',{game_id:'xiangqi',state:invalid,expected_revision:record.revision});
  await enterXiangqi(running);
  await waitFor(async()=>{const v=await xiangqiUi(running);return v?.status==='invalid'?v:null;},'invalid whole Xiangqi record');
  const blocked=await xiangqiUi(running);assert.equal(blocked.disabled,90);assert.match(blocked.notice,/原记录保留/);
  const retained=await summaryRequest(running.cdp,'game_state:get',{game_id:'xiangqi'});assert.equal(retained.revision,bad.revision);assert.deepEqual(retained.state,invalid);
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] button[title="重新开始"]').click();true`);await xiangqiReady(running,0);
  record=await playXiangqiRound(running);
  stage?.('Packaged Xiangqi: stale revision adopts current state without replay');
  const fresh=await summaryRequest(running.cdp,'game_state:put',{game_id:'xiangqi',state:record.state,expected_revision:record.revision});
  await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] button[title="悔棋"]').click();true`);
  await waitFor(async()=>{const v=await xiangqiUi(running);return v?.status==='ready'&&v.revision===fresh.revision&&v.notice.includes('冲突')?v:null;},'Xiangqi revision conflict');
  const final=await summaryRequest(running.cdp,'game_state:get',{game_id:'xiangqi'});assert.equal(final.revision,fresh.revision);assert.deepEqual(final.state,fresh.state);
  session.xiangqiExpected=xiangqiContract.stateIdentity(final);
  assert.equal(session.fake.requests.length,requests,'Practice game unexpectedly called model');
  let companionEvidence=null;
  if(companion) {
    stage?.('Packaged Xiangqi: actual companion HTTP prompt and legal response');
    await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] button[title="重新开始"]').click();true`);await xiangqiReady(running,0);
    await evaluate(running.cdp, `(() => {const b=document.querySelector('[data-testid="xiangqi-game"] [data-mode="practice"]');if(b)b.click();return true;})()`);
    await waitFor(()=>evaluate(running.cdp,`Boolean(document.querySelector('[data-testid="xiangqi-game"] [data-mode="companion"]'))`),'companion mode');
    await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] [data-square="27"]').click();true`);
    await waitFor(()=>evaluate(running.cdp,`document.querySelector('[data-testid="xiangqi-game"] [data-square="36"]').className.includes('legalTarget')`),'companion legal user target');
    await evaluate(running.cdp, `document.querySelector('[data-testid="xiangqi-game"] [data-square="36"]').click();true`);
    const request=await waitFor(()=>session.fake.requests.slice(requests).find(r=>isXiangqiModelRequest(r.body)),'actual Xiangqi request at HTTP model');
    const board=request.body.messages.filter(m=>m.role==='user').map(m=>modelMessageText(m.content)).join('\n');
    assert.ok(board.includes('黑车')&&board.includes('红马')&&board.includes('y=0')&&board.includes('y=9'),'model board lost color/role/coordinates');
    assert.equal(board.split('\n').filter(line=>/^y=\d /.test(line)).length,10);assert.ok(!/[△▲]/.test(board));
    await xiangqiReady(running,2);
    const result=await summaryRequest(running.cdp,'game_state:get',{game_id:'xiangqi'});
    assert.deepEqual(result.state,[{from:27,to:36},{from:54,to:45}]);
    const modelCalls=session.fake.requests.slice(requests).filter(r=>isXiangqiModelRequest(r.body)).length;assert.equal(modelCalls,1);
    session.xiangqiExpected=xiangqiContract.stateIdentity(result);
    companionEvidence={actualHttpPromptChecked:true,pieceColorsRolesAndCoordinates:true,rows:10,legalResponseApplied:true,modelCalls,boardPromptSha256:crypto.createHash('sha256').update(board).digest('hex')};
  }

  await returnToCoreChat(running);
  return {passed:true,rendererRetirementGraphVerified:true,actualUiMoves:true,legalPracticeResponse:true,undoAndReset:true,invalidRecordRetained:true,noPrefixReplay:true,explicitResetUsedOriginalRevision:true,revisionConflictProtected:true,modelCalls:companionEvidence?.modelCalls||0,practiceModelCalls:0,companion:companionEvidence,finalIdentity:session.xiangqiExpected,gameSchemaMigrated:false};
}

async function runAcceptanceCycle(session, identity, label, active, outputRoot, options = {}) {
  const { runRoot, userData, fake } = session;
  const requestsBefore = fake.requests.length;
  const running = await startPackagedApp(identity, runRoot, userData, label, active, outputRoot, options.stage);
  const first = session.messages === null;
  if (first) {
    if (options.uiContract) {
      session.uiContract = await uiChecks.prepareUiChecks(running.cdp, path.join(outputRoot, `ui-${label}`));
      running.uiContractEnabled = true;
    }
    if (options.mediaContract) {
      options.stage?.(`Normal cycle ${label}: packaged media contract`);
      session.mediaContract = await checkMediaCapabilities(running, session);
    }
    options.stage?.(`Normal cycle ${label}: model chat and persisted message IDs`);
    session.chat = await performChat(running, fake);
    session.messages = session.chat.messages;
    if (session.uiContract && running.uiDuringReply) session.uiContract.cases.push(running.uiDuringReply);
    if (session.uiContract) session.uiContract.cases.push(await uiChecks.verifyFullWorkspace(running.cdp));
    if (options.worldbookContract) session.worldbookContract = await checkWorldbookCapabilities(running, session, options.stage);
    if (options.summaryContract) session.summaryContract = await checkSummaryCapabilities(running, session, options.stage);
    if (options.xiangqiContract) session.xiangqiContract = await checkXiangqiCapabilities(running, session, options.stage, options.xiangqiCompanion);
  } else {
    options.stage?.(`Normal cycle ${label}: restore messages and IDs without model requests`);
    const history = await chatHistory(running.cdp);
    const coreMessages = assertMessages(history);
    const recovered = session.summaryExpected ? summaryContract.historyIdentity(history) : coreMessages;
    assert.deepEqual(recovered, session.messages, 'Cold-start recovery changed persisted IDs or content');
    await waitForDisplayedMessages(running.cdp, recovered);
    assert.equal(fake.requests.length, requestsBefore, 'History restore called the model');
    if (session.worldbookExpected) {
      const record = await archiveRequest(running.cdp, 'archive:get');
      const restored = worldbookRecordIdentity(record, session.worldbookExpected.bookId);
      assert.deepEqual(restored, session.worldbookExpected, 'Worldbook identity, revision or content changed on restart');
      running.worldbookRestored = { ...restored, noModelCall: fake.requests.length === requestsBefore };
      assert.equal(running.worldbookRestored.noModelCall, true);
    }
    if (session.summaryExpected) {
      const status = await summaryRequest(running.cdp, 'summary:status', { conversation_id: summaryContract.CONVERSATION });
      assert.equal(status.enabled, true); assert.equal(status.authorized, true);
      const restored = summaryContract.summaryIdentity(status);
      assert.deepEqual(restored, session.summaryExpected, 'Summary identity, source references or attempt counts changed on restart');
      assert.equal(fake.requests.length, requestsBefore, 'Summary status or restoration called the model');
      running.summaryRestored = { ...restored, noModelCall: true };
      const rejected = await summaryRequest(running.cdp, 'summary:status', { conversation_id: session.summaryBudgetExpected.conversationId });
      summaryContract.assertBudgetDenied(rejected, fake, session.summaryContract.summaryModelCalls);
      assert.deepEqual(rejected.attempts, session.summaryBudgetExpected.attempts);
      assert.equal(rejected.errorCode, session.summaryBudgetExpected.errorCode);
      assert.equal(fake.requests.length, requestsBefore, 'Restoring the failed budget scope retried a model request');
      running.summaryRestored.budgetFailureRestored = true;
    }
  }
  if (!first && session.xiangqiExpected) {
    const record=await summaryRequest(running.cdp,'game_state:get',{game_id:'xiangqi'});
    assert.deepEqual(xiangqiContract.stateIdentity(record),session.xiangqiExpected,'Xiangqi moves/revision changed across restart');
    await enterXiangqi(running);await xiangqiReady(running,session.xiangqiExpected.moves.length);
    assert.equal((await xiangqiUi(running)).revision,session.xiangqiExpected.revision);
    await returnToCoreChat(running);
    assert.equal(fake.requests.length,requestsBefore,'Game recovery called model');
    running.xiangqiRestored={...session.xiangqiExpected,noModelCall:true,actualUiRestored:true};
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
    recoveredMessages: session.messages, ...(running.worldbookRestored ? { worldbookRestored: running.worldbookRestored } : {}),
    ...(running.summaryRestored ? { summaryRestored: running.summaryRestored } : {}),
    ...(running.xiangqiRestored ? { xiangqiRestored: running.xiangqiRestored } : {}) };
  session.cycles.push(result);
  return result;
}

async function closeAcceptanceSession(session) {
  if (!session) return;
  session.fake.server.closeAllConnections();
  await new Promise((resolve) => session.fake.server.close(resolve));
}

async function detachOwnedMount(mountPoint, { invoke = run, wait = delay, attempts = [] } = {}) {
  assert.ok(path.isAbsolute(mountPoint) && path.parse(mountPoint).root !== mountPoint, 'An exact owned mount point is required');
  // A recently closed app can leave a short-lived OS volume reference. Retry
  // only our exact mount point; never force detach or target a volume by name.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      invoke('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 30_000 });
      attempts.push({ attempt, elapsedMs: Date.now() - startedAt, passed: true });
      return;
    } catch (error) {
      attempts.push({ attempt, elapsedMs: Date.now() - startedAt, passed: false, error: String(error) });
      if (attempt === 3) throw error;
      await wait(attempt * 1000);
    }
  }
}

async function finalizePackageAcceptance({ active, session, mount, runRoot, outputRoot, report, started, verifyIntegrity }, {
  cleanupApplication = forceCleanup, closeSession = closeAcceptanceSession,
  writeFile = fs.writeFileSync, removeScratch = isolation.removeIsolationContext,
  exists = fs.existsSync,
} = {}) {
  const errors = [];
  const attempt = async (name, action) => {
    try { await action(); return true; }
    catch (error) {
      report.passed = false;
      errors.push({ name, error });
      report.finalizationErrors = errors.map((item) => ({ stage: item.name, message: String(item.error) }));
      return false;
    }
  };
  let processesStopped = true;
  for (const running of active.slice().reverse()) {
    if (!await attempt(`process:${running.label}`, () => cleanupApplication(running))) processesStopped = false;
    if (running.logError) await attempt(`live-log:${running.label}`, () => { throw running.logError; });
    if (running.observationError) await attempt(`process-observation:${running.label}`, () => { throw running.observationError; });
    await attempt(`log:${running.label}`, () => writeFile(path.join(outputRoot, `${running.label}.log`), running.logs.join('')));
  }
  report.applicationDiagnostics = active.map((running) => ({ label: running.label, pid: running.child?.pid,
    processIdentity: running.rootIdentity || null, observationError: running.observationError ? String(running.observationError) : null,
    lastStartupPhase: running.phase || null, startupStages: running.phases || [],
    debuggerTargets: running.debuggerTargets || [], exitCode: running.child?.exitCode,
    signal: running.child?.signalCode, liveLogError: running.logError ? String(running.logError) : null }));
  await attempt('fake-provider-close', () => closeSession(session));
  report.forcedCleanup = active.filter((running) => running.forcedCleanup).map((running) => running.label);
  if (report.forcedCleanup.length) await attempt('forced-cleanup', () => {
    throw new Error('Passing acceptance cannot depend on forced cleanup');
  });
  await attempt('integrity', verifyIntegrity);
  await attempt('detach', () => mount.detach());
  report.noResidualMounts = !mount.mounted;
  report.noResidualProcesses = processesStopped;
  if (!mount.mounted && processesStopped) {
    await attempt('scratch-remove', () => {
      removeScratch(runRoot); report.scratchRemoved = !exists(runRoot);
      assert.equal(report.scratchRemoved, true, 'Acceptance scratch remains after cleanup');
    });
  }
  report.elapsedMs = Date.now() - started;
  report.completedAt = new Date().toISOString();
  const reportWritten = await attempt('final-report-write', () => writeFile(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2)));
  return { reportWritten, errors };
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
    cwd: runRoot, env: childEnvironment(runRoot, isolation.createIsolatedDirectory(runRoot, `probe-${crypto.randomUUID()}`)), timeout: 120_000,
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

function validateReportDestination(destination) {
  const resolved = path.resolve(destination);
  assert.ok(!resolved.split(path.sep).some((part) => /\.app$/i.test(part)),
    'Report output cannot be inside an application');
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    assert.notEqual(parent, ancestor, 'Report destination has no existing ancestor');
    ancestor = parent;
  }
  assert.ok(!fs.realpathSync(ancestor).split(path.sep).some((part) => /\.app$/i.test(part)),
    'Report output resolves through an application');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write('Usage: node script/smoke-packaged-macos.cjs [--app /absolute/Test.app] [--manifest /absolute/macos-build.json] [--out /absolute/report-parent] [--startup-groups 1|2] [--media-contract] [--worldbook-contract] [--summary-contract] [--xiangqi-contract] [--xiangqi-companion-contract] [--ui-contract]\nDefaults to .package-smoke-macos/latest-package.json; an explicit --app defaults to release-macos/macos-build.json unless --manifest is supplied. Requires the exact successful build. Runs three normal cycles per fresh-profile group and three fail-closed storage cases using the last group. --media-contract additionally checks packaged download IPC with synthetic DOM and denied loopback requests, without relaxing production policy. --worldbook-contract checks saved prompts, disabled/deleted entries, isolated regex timeout and repair, and archive identity recovery in the final packaged app. --summary-contract checks default-off and explicit-consent gates, post-commit generation, actual next-turn prompts, inactive legacy import, revocation and stable summary/message identities across restarts using only the local fake model. Native controls operate only on verified existing PID/birth identities; unavailable access stops the test without external UI fallback. Production bridge timeouts are unchanged.\n');
    return;
  }
  const readArg = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${flag} requires a path`);
    return path.resolve(args[index + 1]);
  };
  for (let index = 0; index < args.length; index += 1) {
    if (['--media-contract', '--worldbook-contract', '--summary-contract', '--xiangqi-contract', '--ui-contract', '--xiangqi-companion-contract'].includes(args[index])) continue;
    assert.ok(['--app', '--manifest', '--out', '--startup-groups'].includes(args[index]), `Unknown argument: ${args[index]}`);
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${args[index]} requires a path`);
    index += 1;
  }
  const groupsArg = args.indexOf('--startup-groups');
  const startupGroups = groupsArg < 0 ? 1 : Number(args[groupsArg + 1]);
  assert.ok([1, 2].includes(startupGroups), '--startup-groups must be 1 or 2');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const inputs = resolvePackageInputs(args);
  const sourceApp = fs.realpathSync(inputs.appPath);
  const buildManifestPath = inputs.manifestPath;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const outputRoot = path.join(readArg('--out', path.join(frontendRoot, '.package-smoke-macos')), runId);
  validateReportDestination(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const tempParent = '/private/tmp/Reverie 核心 验收';
  fs.mkdirSync(tempParent, { recursive: true });
  const { runRoot } = isolation.createIsolationContext(tempParent);
  for (const name of ['tmp', 'cache', 'crashpad']) isolation.createIsolatedDirectory(runRoot, name);
  // Mount points change inode on attach and are not writable application directories.
  for (const name of ['staging', '只读应用']) fs.mkdirSync(path.join(runRoot, name));
  const mountPoint = path.join(runRoot, '只读应用');
  const imagePath = path.join(runRoot, '只读验收介质.dmg');
  const report = { passed: false, runId, sourceApp, runRoot, outputRoot, cycles: [], negativeCases: [], stages: [],
    startupSampling: { groups: startupGroups, cyclesPerGroup: 3, freshProfiles: startupGroups, automaticRetry: false, systemCachesCleared: false, negativeCases: 'once using final group' },
    validationRevision: { script: path.relative(projectRoot, __filename), sha256: hashFile(__filename),
      summaryContractValidator: summaryValidatorRevision(),
      xiangqiContractValidator: {script:'frontend/script/xiangqi-package-contract.cjs',sha256:hashFile(path.join(__dirname,'xiangqi-package-contract.cjs'))},
      uiContractValidator: {script:'frontend/script/ui-workspace-contract.cjs',sha256:hashFile(path.join(__dirname,'ui-workspace-contract.cjs'))},
      nativeErrorHelper: { script: path.relative(projectRoot, nativeErrorHelper),
        sha256: fs.existsSync(nativeErrorHelper) ? hashFile(nativeErrorHelper) : null },
      isolationController: { script: 'frontend/script/acceptance-isolation.cjs', sha256: hashFile(path.join(__dirname, 'acceptance-isolation.cjs')) },
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
    const previous = report.stages.at(-1);
    if (previous) previous.durationMs = report.stageElapsedMs - previous.elapsedMs;
    report.stages.push({ name, elapsedMs: report.stageElapsedMs });
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
    let lastUserData;
    report.startupGroups = [];
    for (let group = 1; group <= startupGroups; group += 1) {
      const userData = isolation.createIsolatedDirectory(runRoot, `user-data-${group}`);
      const session = await createAcceptanceSession(runRoot, userData);
      fake = session.fake; lastUserData = userData;
      const groupReport = { group, userData, cycles: [] }; report.startupGroups.push(groupReport);
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const label = `g${group}-${cycle}`;
        stage(`Normal cycle ${label}: packaged startup and V4 authentication`);
        const result = await runAcceptanceCycle(session, identity, label, active, outputRoot,
          { xiangqiCompanion: args.includes('--xiangqi-companion-contract'), uiContract: args.includes('--ui-contract'), mediaContract: args.includes('--media-contract'), worldbookContract: args.includes('--worldbook-contract'), summaryContract: args.includes('--summary-contract'), xiangqiContract: args.includes('--xiangqi-contract'), stage });
        report.cycles.push(result); groupReport.cycles.push(result);
        report.chat = session.chat; report.keychain = session.keychain;
        if (session.uiContract) { report.uiContract=session.uiContract;groupReport.uiContract=session.uiContract; }
        if (session.mediaContract) report.mediaContract = session.mediaContract;
        if (session.worldbookContract) { report.worldbookContract = session.worldbookContract; groupReport.worldbookContract = session.worldbookContract; }
        if (session.summaryContract) { report.summaryContract = session.summaryContract; groupReport.summaryContract = session.summaryContract; }
        if (session.xiangqiContract) { report.xiangqiContract=session.xiangqiContract;groupReport.xiangqiContract=session.xiangqiContract; }
      }
      groupReport.fakeProviderRequests = fake.requests.map((request) => ({ method: request.method, path: request.url }));
      if (group < startupGroups) { await closeAcceptanceSession(session); fake = null; }
    }
    for (const kind of ['vault', 'database', 'missing-vault']) {
      stage(`Negative ${kind}: unchanged ciphertext and fail-closed startup`);
      const requestsBefore = fake.requests.length;
      report.negativeCases.push(await verifyNegativeStartup(identity, runRoot, lastUserData, kind, active, outputRoot));
      assert.equal(fake.requests.length, requestsBefore, 'Failed storage startup called the model');
    }
    report.fakeProviderRequests = fake.requests.map((request) => ({ method: request.method, path: request.url }));
    report.passed = true;
  } catch (error) {
    failure = error; report.error = error.stack || String(error);
  } finally {
    try {
      const previous = report.stages.at(-1);
      if (previous) previous.durationMs = Date.now() - started - previous.elapsedMs;
      const finalized = await finalizePackageAcceptance({ active, session: fake ? { fake } : null,
        mount: { get mounted() { return mounted; }, async detach() {
          if (!mounted) return;
          report.detachAttempts = [];
          await detachOwnedMount(mountPoint, { attempts: report.detachAttempts });
          mounted = false;
        } }, runRoot, outputRoot, report, started,
        verifyIntegrity: () => {
          if (!mounted || !baseline) return;
          const after = treeManifest(mountedApp);
          assert.deepEqual(after, baseline, 'Application package changed during acceptance');
          report.bundleHashBefore = baseline.sha256; report.bundleHashAfter = after.sha256;
          report.bundleUnchanged = true;
          fs.writeFileSync(path.join(outputRoot, 'bundle-after.json'), JSON.stringify(after, null, 2));
        },
      });
      if (finalized.errors.length) {
        failure ||= finalized.errors[0].error;
        for (const item of finalized.errors) process.stderr.write(`[package-smoke] Finalization ${item.name}: ${item.error}\n`);
      }
      if (finalized.reportWritten) process.stdout.write(`[package-smoke] Report: ${path.join(outputRoot, 'report.json')}\n`);
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    }
  }
  if (failure) throw failure;
  process.stdout.write(`[package-smoke] PASS: ${startupGroups * 3} normal cycles, 3 storage rejection cases, unchanged read-only bundle\n`);
}

module.exports = {
  APP_NAME, APP_ID, buildInventory, treeManifest, verifySuccessfulBuild, resolvePackageInputs, runNativeErrorHelper,
  readBundleIdentity, verifyHardenedBundle, standalonePythonProbe, processSnapshot, forceCleanup,
  createAcceptanceSession, runAcceptanceCycle, closeAcceptanceSession, verifyNegativeStartup,
  setInterrupted, contentDigest, hashFile, run, inside,
  appendApplicationLog, summarizeDebuggerTargets, detachOwnedMount, finalizePackageAcceptance,
  childEnvironment, launchApplication, normalPackagedQuit, validateReportDestination,
  modelMessageText, fakeProviderReply, isXiangqiModelRequest, archiveRequest, worldbookBaseArchive, worldbookFixture, assertWorldbookPrompt,
  worldbookRecordIdentity, assertWorldbookWorkers, summaryRequest, assertMessages, waitForDisplayedMessages, startFakeProvider,
  composerReadyExpression, submitFixtureUiText, summaryValidatorRevision,
};
if (require.main === module) {
  main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
}
