'use strict';

// Real desktop integration: React input -> sandboxed preload -> V4 Python host
// -> loopback model -> encrypted history -> graceful quit -> cold-start restore.
// The separate e2e-desktop-smoke.cjs retains its full Live2D acceptance checks.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const frontendRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(frontendRoot, '.desktop-core-smoke');
const devUrl = 'http://localhost:5173'; // Must match the production dev trust policy.
// Casual replies are intentionally capped at 20 characters by the product.
// Keep the entire unique fake response below that budget. A numeric token also
// avoids the optional display-only spelling mistakes; no product policy is
// disabled or special-cased for the smoke.
const token = String(crypto.randomInt(100_000_000_000, 1_000_000_000_000));
const userMessage = `桌面核心测试 ${token}`;
const assistantMessage = token;
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

function cleanEnvironment() {
  // Do not inherit provider credentials, proxies, NODE_OPTIONS, PYTHONPATH, or
  // ELECTRON_RUN_AS_NODE. python-dotenv must also ignore the developer's .env.
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'LANG', 'LC_ALL'];
  const env = Object.fromEntries(keys.filter((key) => process.env[key] != null)
    .map((key) => [key, process.env[key]]));
  return { ...env, NODE_ENV: 'development', PYTHON_DOTENV_DISABLED: '1', PYTHONDONTWRITEBYTECODE: '1',
    REVERIE_OPEN_DEVTOOLS: '0', REVERIE_LIVE2D_DEV: '0', VITE_LIVE2D_PUBLIC_ENABLED: 'false' };
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

function startProcess(label, executable, args, env) {
  const running = { label, logs: [], owned: new Map() };
  running.child = spawn(executable, args, {
    cwd: frontendRoot, env, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.child.once('error', (error) => { running.error = error; });
  running.child.stdout.on('data', (chunk) => running.logs.push(String(chunk)));
  running.child.stderr.on('data', (chunk) => running.logs.push(String(chunk)));
  return running;
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

async function startApp(userData, cycle, env, active) {
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const running = startProcess(`Electron cycle ${cycle}`, require('electron'), [
    `--remote-debugging-port=${debugPort}`, `--inspect=127.0.0.1:${inspectPort}`, '.',
  ], { ...env, REVERIE_USER_DATA_DIR: userData });
  active.push(running);
  running.cycle = cycle;
  const target = await waitFor(async () => {
    requireAlive(running);
    return (await fetchJson(`http://127.0.0.1:${debugPort}/json/list`))
      .find((item) => item.type === 'page' && item.url.startsWith(devUrl));
  }, `cycle ${cycle} renderer`);
  running.cdp = await connectCdp(target.webSocketDebuggerUrl, () => requireAlive(running));
  const mainTarget = await waitFor(async () => {
    requireAlive(running);
    return (await fetchJson(`http://127.0.0.1:${inspectPort}/json/list`))[0];
  }, 'main-process debugger');
  running.mainCdp = await connectCdp(mainTarget.webSocketDebuggerUrl, () => requireAlive(running));
  const paths = await evaluate(running.mainCdp, `({
    userData: process.mainModule.require('electron').app.getPath('userData'),
    sessionData: process.mainModule.require('electron').app.getPath('sessionData'),
  })`);
  assert.equal(fs.realpathSync(paths.userData), userData, 'userData isolation failed');
  assert.ok(paths.sessionData === userData || paths.sessionData.startsWith(`${userData}${path.sep}`), 'Chromium session escaped test directory');
  await waitFor(() => evaluate(running.cdp, `document.readyState === 'complete'
    && Boolean(document.querySelector('[data-testid="mvp-room"]'))
    && Boolean(window.electronAPI?.bridge)`), 'React MVP and sandboxed preload');
  const surface = await evaluate(running.cdp, `({
    frozen: Object.isFrozen(window.electronAPI), require: typeof window.require,
    send: typeof window.electronAPI.bridge.send, platform: window.electronAPI.platform,
  })`);
  assert.deepEqual(surface, { frozen: true, require: 'undefined', send: 'function', platform: process.platform });
  running.connection = await waitFor(async () => {
    requireAlive(running);
    const value = await evaluate(running.cdp, 'window.electronAPI.bridge.getConnectionConfig()');
    return value?.transport === 'electron-ipc' && value?.protocolVersion === 4 ? value : null;
  }, `cycle ${cycle} authenticated V4 Python host`);
  collectOwned(running);
  // Inspect the actual ChildProcess owned by this Electron main process, not
  // a separately launched Python preflight. No bridge secrets/env are read.
  running.python = await evaluate(running.mainCdp, `(() => {
    const child = process._getActiveHandles().find((handle) =>
      Array.isArray(handle.spawnargs) && handle.spawnargs.includes('--stdio-bridge'));
    return child ? { pid: child.pid, parentPid: process.pid,
      command: child.spawnfile, arguments: child.spawnargs.slice(1) } : null;
  })()`);
  assert.ok(running.python?.pid, 'No real stdio Python ChildProcess observed');
  assert.equal(running.python.parentPid, running.child.pid, 'Python belongs to a different Electron process');
  assert.ok(running.owned.has(running.python.pid), 'Python missing from actual process ancestry');
  if (process.platform === 'darwin') {
    const expectedPython = path.resolve(frontendRoot, '..', '.venv', 'bin', 'python');
    assert.equal(path.resolve(running.python.command), expectedPython, 'Desktop did not launch through the project virtual environment');
    running.python.resolvedCommand = fs.realpathSync(running.python.command);
    assert.equal(running.python.resolvedCommand, fs.realpathSync(expectedPython), 'Project Python runtime target changed');
  }
  return running;
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

async function normalQuit(running) {
  collectOwned(running);
  // Execute the normal application quit path, including before-quit and Python
  // stopAndWait. Close the inspector before exit so it cannot hold Node open.
  await evaluate(running.mainCdp, `setTimeout(() => process.mainModule.require('electron').app.quit(), 100); true`);
  running.mainCdp.close(); running.cdp.close();
  await waitFor(() => running.child.exitCode !== null || running.child.signalCode !== null, 'normal Electron quit', 15_000, true);
  assert.equal(running.child.exitCode, 0, `Electron exit signal: ${running.child.signalCode}`);
  assert.ok(!running.logs.join('').includes('Bridge did not stop cleanly'), 'Python graceful shutdown failed');
  await waitFor(() => remainingOwned(running).length === 0, 'Electron/Python descendants to exit', 10_000, true);
  running.gracefulExit = true;
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

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-desktop-core-')));
  const env = cleanEnvironment();
  const active = [];
  const report = { passed: false, platform: process.platform, arch: process.arch, userData,
    scope: 'Development desktop core: real UI chat, V4 Python host, encrypted history and restart',
    excluded: ['Live2D rendering', 'onboarding interaction', 'packaged application', 'real model quality'], cycles: [] };
  let fake;
  let failure;
  let vite;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const stage = (value) => { report.stage = value; process.stdout.write(`[desktop-core] ${value}\n`); };
  try {
    fake = await startFakeProvider();
    const config = { llm: { provider: 'ollama', model: 'reverie-core-smoke', base_url: `http://127.0.0.1:${fake.port}/v1` },
      chat: { reply_delay_min: 1, reply_delay_max: 1, split_messages: false },
      ui: { mode: 'mvp', experience_mode: 'core', onboarding_completed: true,
        onboarding_version: 3, onboarding_state: 'complete', onboarding_last_step: 'finish' } };
    fs.mkdirSync(path.join(userData, 'data'));
    fs.writeFileSync(path.join(userData, 'data', 'config.json'), JSON.stringify(config));
    stage('Starting isolated Vite');
    vite = startProcess('Vite', process.execPath, [path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', 'localhost', '--port', '5173', '--strictPort'], env);
    active.push(vite);
    await waitFor(async () => {
      requireAlive(vite);
      const response = await fetch(devUrl, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    }, 'owned Vite');
    // A strict-port startup failure may arrive just after an existing listener
    // answered. Require our Vite's own ready log before launching Electron.
    await waitFor(() => { requireAlive(vite); return vite.logs.join('').includes('Local:'); }, 'owned Vite ready log');
    let running = await startApp(userData, 1, env, active);
    stage('Cycle 1: V4 authenticated; testing and committing loopback model');
    const provider = await evaluate(running.cdp, `(async () => {
      const config = { llm: { provider: 'ollama', baseUrl: 'http://127.0.0.1:${fake.port}/v1', model: 'reverie-core-smoke' } };
      const tested = await window.electronAPI.providerConfig.test(config, {});
      if (!tested.ok) return { tested };
      const committed = await window.electronAPI.providerConfig.commit(config, {}, 'persistent', tested.receipt);
      return { tested: { ok: tested.ok }, provider: committed.config.llm.provider, writeError: committed.status.writeError || null };
    })()`);
    assert.equal(provider.tested.ok, true, JSON.stringify(provider));
    assert.equal(provider.provider, 'ollama'); assert.equal(provider.writeError, null);
    await waitFor(() => evaluate(running.cdp, `Boolean(document.querySelector('[data-testid="mvp-room"] textarea[placeholder^="给 "]:not(:disabled)'))`), 'connected chat composer');
    await evaluate(running.cdp, `window.__coreSmokeFrames = [];
      window.__coreSmokeDispose = window.electronAPI.bridge.onMessage((frame) => window.__coreSmokeFrames.push(frame));
      document.querySelector('[data-testid="mvp-room"] textarea[placeholder^="给 "]').focus(); true`);
    await running.cdp.call('Input.insertText', { text: userMessage });
    await waitFor(() => evaluate(running.cdp, `document.querySelector('[data-testid="mvp-room"] textarea[placeholder^="给 "]').value === ${JSON.stringify(userMessage)}`), 'React draft input');
    await running.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await running.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(() => fake.requests.some((request) => request.body.messages?.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(userMessage))), 'actual user message dispatched to loopback model');
    stage('Actual UI chat reached the fake model');
    const terminal = await waitFor(async () => {
      const frames = await evaluate(running.cdp, 'window.__coreSmokeFrames');
      const error = frames.find((frame) => frame.type === 'chat:error'
        || (frame.type === 'error' && String(frame.request_id || frame.payload?.request_id || '').startsWith('chat_')));
      if (error) throw Object.assign(new Error(JSON.stringify(error)), { fatal: true });
      return frames.find((frame) => frame.type === 'chat:done' || frame.payload?.state === 'ready_waiting');
    }, 'reply readiness');
    if (terminal.type !== 'chat:done') {
      const id = terminal.payload?.request_id || terminal.request_id;
      assert.ok(id, 'Reply readiness omitted correlation ID');
      await evaluate(running.cdp, `window.electronAPI.bridge.send({ type: 'chat:reveal', request_id: 'core-reveal-${token}', payload: { request_id: ${JSON.stringify(id)} } })`);
    }
    await waitFor(() => evaluate(running.cdp, 'window.__coreSmokeFrames.some((frame) => frame.type === "chat:done")'), 'chat:done');
    report.chatFrames = await evaluate(running.cdp, 'window.__coreSmokeFrames.filter((frame) => ["chat:done", "chat:bubble", "chat:chunk", "chat:retract"].includes(frame.type))');
    report.historyBeforeRestart = await chatHistory(running.cdp);
    const before = assertMessages(report.historyBeforeRestart);
    report.displayedBeforeRestart = await waitForDisplayedMessages(running.cdp, before);
    report.messages = before;
    stage('Messages persisted; normal quit and cold restart');
    await normalQuit(running);
    const database = fs.readFileSync(path.join(userData, 'data', 'runtime', 'kernel.sqlite3'));
    assert.ok(database.length >= 4096, 'Persisted kernel database missing');
    assert.notEqual(database.subarray(0, 16).toString('ascii'), 'SQLite format 3\0', 'Kernel database unexpectedly uses a plaintext SQLite header');
    assert.equal(database.includes(Buffer.from(userMessage)), false, 'Plaintext user message leaked into the kernel database');
    report.encryptedDatabaseHeader = true;
    report.cycles.push({ cycle: 1, protocolVersion: running.connection.protocolVersion,
      python: running.python, gracefulExit: true });
    const requestsBeforeRestart = fake.requests.length;
    running = await startApp(userData, 2, env, active);
    const after = assertMessages(await chatHistory(running.cdp));
    assert.deepEqual(after, before, 'Restored messages changed identity or content');
    report.displayedAfterRestart = await waitForDisplayedMessages(running.cdp, after);
    assert.equal(fake.requests.length, requestsBeforeRestart, 'History restore unexpectedly called the model');
    report.modelCallsDuringRestart = 0;
    await normalQuit(running);
    report.cycles.push({ cycle: 2, protocolVersion: running.connection.protocolVersion,
      python: running.python, gracefulExit: true, messagesRestored: true });
    report.fakeProviderRequests = fake.requests.map((request) => ({ method: request.method, path: request.url }));
    stage('Both Electron cycles exited normally; stopping Vite');
    collectOwned(vite); vite.child.kill('SIGTERM');
    await waitFor(() => vite.child.exitCode !== null || vite.child.signalCode !== null, 'Vite stop', 10_000, true);
    await waitFor(() => remainingOwned(vite).length === 0, 'Vite descendants stop', 10_000, true);
    report.passed = true;
  } catch (error) {
    failure = error; report.error = error.stack || String(error);
  } finally {
    for (const running of active.reverse()) {
      try { await forceCleanup(running); } catch (error) { failure ||= error; report.cleanupError = String(error); report.passed = false; }
      fs.writeFileSync(path.join(outputRoot, `${running.cycle ? `electron-${running.cycle}` : 'vite'}.log`), running.logs.join(''));
    }
    if (fake) { fake.server.closeAllConnections(); await new Promise((resolve) => fake.server.close(resolve)); }
    report.forcedCleanup = active.filter((running) => running.forcedCleanup).map((running) => running.label);
    if (report.passed && report.forcedCleanup.length) {
      failure = new Error('A passing smoke must not require forced process cleanup'); report.passed = false;
    }
    report.noResidualProcesses = !report.cleanupError;
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) {
      failure ||= error; report.cleanupError = String(error); report.passed = false;
    }
    report.userDataRemoved = !fs.existsSync(userData);
    fs.writeFileSync(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
