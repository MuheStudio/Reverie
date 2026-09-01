'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const packageRoot = path.resolve(process.env.PACKAGE_ROOT || '');
const outputRoot = path.resolve(process.env.REVERIE_E2E_OUT || path.join(__dirname, '..', '.packaged-restarts'));
const markerText = `phase-b-user-message-${Date.now()}`;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(check, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
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
      server.close(() => resolve(port));
    });
  });
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
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

async function chatHistory(cdp) {
  const historyId = `history_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return evaluate(cdp, `(async () => new Promise(async (resolve, reject) => {
    const timer=setTimeout(() => { dispose(); reject(new Error('history timeout')); }, 15000);
    const dispose=window.electronAPI.bridge.onMessage((frame) => {
      if(frame?.request_id!==${JSON.stringify(historyId)} || frame.type!=='chat:history:result')return;
      clearTimeout(timer); dispose(); resolve(frame.payload);
    });
    await window.electronAPI.bridge.send({type:'chat:history',request_id:${JSON.stringify(historyId)},payload:{conversation_id:'dream-room',limit:100}});
  }))()`);
}

async function startApp(userData, cycle) {
  const port = await freePort();
  const logs = [];
  const child = spawn(path.join(packageRoot, 'Reverie.exe'), [`--remote-debugging-port=${port}`], {
    cwd: packageRoot,
    windowsHide: true,
    env: { ...process.env, REVERIE_TEST_USER_DATA_DIR: userData, REVERIE_OPEN_DEVTOOLS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const target = await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Reverie exited early (${child.exitCode}): ${logs.join('').slice(-1000)}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && item.url === 'reverie-app://app/index.html');
  }, `cycle ${cycle} renderer`);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await waitFor(() => evaluate(cdp, 'document.readyState === "complete" && Boolean(window.electronAPI)'), `cycle ${cycle} preload`);
  const connection = await waitFor(async () => {
    const value = await evaluate(cdp, 'window.electronAPI.bridge.getConnectionConfig()');
    return value?.transport === 'electron-ipc' && value?.protocolVersion === 4 ? value : null;
  }, `cycle ${cycle} bridge`);
  const page = await waitFor(async () => evaluate(cdp, `({
    mvp: Boolean(document.querySelector('[data-testid="mvp-room"]')),
    dream: Boolean(document.querySelector('[data-testid="dream-room"]')),
    splash: Boolean(document.querySelector('[data-testid="boot-splash"]')),
  })`).then((value) => value.mvp ? value : null), `cycle ${cycle} MvpRoom`);
  return { child, cdp, port, logs, connection, page };
}

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

async function stopApp(running, cycle) {
  running.cdp.close();
  killTree(running.child.pid);
  await waitFor(() => running.child.exitCode !== null, `cycle ${cycle} process-tree cleanup`, 10_000);
  await delay(3_000);
  return false;
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) { lastError = error; }
    await delay(500);
  }
  throw lastError;
}

async function waitForProcessExit(child, label) {
  if (!child || child.exitCode !== null) return;
  await waitFor(() => child.exitCode !== null, label, 15_000);
}

async function main() {
  assert.ok(fs.existsSync(path.join(packageRoot, 'Reverie.exe')), 'packaged executable missing');
  const marker = JSON.parse(fs.readFileSync(path.join(packageRoot, 'TEST-BUILD-DO-NOT-RELEASE.json'), 'utf8'));
  assert.equal(marker.distribution, 'TEST_ONLY_DO_NOT_RELEASE');
  fs.mkdirSync(outputRoot, { recursive: true });
  const userData = path.join(outputRoot, 'user-data');
  if (fs.existsSync(userData)) throw new Error('restart E2E user-data directory already exists');
  fs.mkdirSync(userData, { recursive: true });
  const cycles = [];
  const writeProgress = (stage) => {
    fs.writeFileSync(path.join(outputRoot, 'progress.json'), `${JSON.stringify({ stage, markerText, cycles }, null, 2)}\n`);
    process.stdout.write(`${stage}\n`);
  };
  let running;
  try {
    running = await startApp(userData, 1);
    writeProgress('phase-b cycle 1 ready');
    const requestId = `crash_${Date.now()}`;
    await evaluate(running.cdp, `window.electronAPI.bridge.send({
      type: 'chat:send', request_id: ${JSON.stringify(requestId)}, payload: {
        text: ${JSON.stringify(markerText)}, request_id: ${JSON.stringify(requestId)},
        conversation_id: 'dream-room', sent_at_utc: new Date().toISOString()
      }
    })`);
    writeProgress('phase-b message accepted');
    await waitFor(async () => {
      const history = await chatHistory(running.cdp);
      const items = Array.isArray(history?.items) ? history.items : [];
      return items.some((item) => item.role === 'user' && item.content === markerText);
    }, 'durable user message before crash');
    writeProgress('phase-b message durable');
    running.cdp.close();
    killTree(running.child.pid);
    await waitForProcessExit(running.child, 'phase-b forced crash exit');
    await delay(3_000);
    cycles.push({ cycle: 1, forcedCrash: true, ...running.page, generation: running.connection.generation });
    writeProgress('phase-b process killed');
    running = null;

    for (let cycle = 2; cycle <= 11; cycle += 1) {
      running = await startApp(userData, cycle);
      writeProgress(`phase-c cycle ${cycle} ready`);
      if (cycle === 2) {
        const history = await chatHistory(running.cdp);
        const items = Array.isArray(history?.items) ? history.items : [];
        assert.ok(items.some((item) => item.role === 'user' && item.content === markerText), 'crash-recovered user message missing');
        writeProgress('phase-b history recovered');
      }
      const record = { cycle, forcedCrash: false, ...running.page, generation: running.connection.generation };
      const gracefulExit = await stopApp(running, cycle);
      record.gracefulExit = gracefulExit;
      cycles.push(record);
      writeProgress(`phase-c cycle ${cycle} stopped`);
      await waitFor(async () => {
        try { await fetch(`http://127.0.0.1:${running.port}/json/list`); return false; } catch { return true; }
      }, `cycle ${cycle} CDP release`, 10_000);
      running = null;
    }
    assert.equal(cycles.length, 11);
    assert.ok(cycles.every((entry) => entry.mvp && !entry.dream && !entry.splash));
    const report = { markerText, crashRecovery: true, coldStartsAfterCrash: 10, cycles };
    fs.writeFileSync(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    try { running?.cdp?.close(); } catch {}
    if (running?.logs) {
      fs.writeFileSync(path.join(outputRoot, 'electron-last.log'), running.logs.join(''));
    }
    if (running?.child?.exitCode === null) {
      killTree(running.child.pid);
      try { await waitForProcessExit(running.child, 'final process cleanup'); } catch {}
    }
    await delay(1_000);
    try {
      await removeWithRetry(userData);
    } catch (cleanupError) {
      process.stderr.write(`Cleanup warning: ${cleanupError.message}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
