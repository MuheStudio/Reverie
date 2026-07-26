'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const frontendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(frontendRoot, '..');
const outputRoot = path.join(frontendRoot, '.desktop-smoke');
const debuggingPort = 9371;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function startFakeProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const body = JSON.stringify({
        id: 'desktop-smoke',
        object: 'chat.completion',
        created: 1,
        model: 'reverie-smoke',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
      });
    });
  });
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression, options = {}) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: options.userGesture === true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'renderer evaluation failed');
  }
  return result.result.value;
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  const fake = await startFakeProvider();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-desktop-smoke-'));
  const vite = spawn(
    process.execPath,
    [path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'],
    {
      cwd: frontendRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const electronLogs = [];
  let electron;
  let cdp;
  try {
    await waitFor(async () => {
      const response = await fetch('http://127.0.0.1:5173/');
      return response.ok;
    }, 'Vite');
    electron = spawn(
      path.join(frontendRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
      [`--remote-debugging-port=${debuggingPort}`, '.'],
      {
        cwd: frontendRoot,
        windowsHide: true,
        env: {
          ...process.env,
          REVERIE_USER_DATA_DIR: userDataDir,
          REVERIE_OPEN_DEVTOOLS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    electron.stdout.on('data', (chunk) => electronLogs.push(String(chunk)));
    electron.stderr.on('data', (chunk) => electronLogs.push(String(chunk)));

    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.includes('localhost:5173'));
    }, 'Electron renderer');
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await waitFor(
      () => evaluate(cdp, 'document.readyState === "complete" && Boolean(window.electronAPI)'),
      'sandboxed preload',
    );

    const apiSurface = await evaluate(cdp, `({
      providerTest: typeof window.electronAPI?.providerConfig?.test,
      providerCommit: typeof window.electronAPI?.providerConfig?.commit,
      focusStart: typeof window.electronAPI?.focus?.start,
      soundList: typeof window.electronAPI?.focusSound?.list,
    })`);
    assert.deepEqual(apiSurface, {
      providerTest: 'function',
      providerCommit: 'function',
      focusStart: 'function',
      soundList: 'function',
    });
    await waitFor(
      () => evaluate(cdp, `(async () => {
        try {
          const value = await window.electronAPI.bridge.getConnectionConfig();
          return value?.transport === 'electron-ipc' || value?.transport === 'stdio-framed';
        } catch {
          return false;
        }
      })()`),
      'Python authority',
      45_000,
    );

    const provider = await evaluate(cdp, `(async () => {
      const config = { llm: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:${fake.port}/v1',
        model: 'reverie-smoke',
      }};
      const tested = await window.electronAPI.providerConfig.test(config, {});
      if (!tested.ok) return { tested };
      const committed = await window.electronAPI.providerConfig.commit(
        config, {}, 'session', tested.receipt
      );
      return {
        tested: { ok: tested.ok, model: tested.model, latencyMs: tested.latencyMs },
        committed: {
          provider: committed.config.llm.provider,
          writeError: committed.status.writeError || null,
        },
      };
    })()`);
    assert.equal(provider.tested.ok, true, JSON.stringify(provider));
    assert.equal(provider.committed.provider, 'ollama');
    assert.equal(provider.committed.writeError, null);
    assert.equal(fake.requests.length, 1);
    assert.match(fake.requests[0].url, /\/v1\/chat\/completions$/);

    await evaluate(cdp, `document.querySelector('[data-testid="primary-companion-action"]').click()`, {
      userGesture: true,
    });
    await waitFor(
      () => evaluate(cdp, `Boolean(document.querySelector('[data-focus-phase]'))`),
      'Companion panel',
    );

    const focusStarted = await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-testid="companion-duration"]');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
      ).set;
      setter.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="companion-start"]').click();
      return true;
    })()`, { userGesture: true });
    assert.equal(focusStarted, true);
    const initialTimer = await waitFor(
      () => evaluate(cdp, `(() => {
        const panel = document.querySelector('[data-focus-phase="running"]');
        const timer = document.querySelector('[data-testid="companion-timer"]');
        return panel && timer ? timer.textContent.trim() : '';
      })()`),
      'Companion UI timer start',
    );
    await delay(1_250);
    const tickingTimer = await waitFor(
      () => evaluate(cdp, `(() => {
        const timer = document.querySelector('[data-testid="companion-timer"]');
        const value = timer?.textContent.trim() || '';
        return value && value !== '${initialTimer}' ? value : '';
      })()`),
      'Companion UI timer tick',
      5_000,
    );
    await evaluate(cdp, `document.querySelector('[data-testid="companion-stop"]').click()`, {
      userGesture: true,
    });
    const stoppedPhase = await waitFor(
      () => evaluate(cdp, `document.querySelector('[data-focus-phase]')?.getAttribute('data-focus-phase') === 'stopped' ? 'stopped' : ''`),
      'Companion UI timer stop',
    );
    const focus = { initialTimer, tickingTimer, stoppedPhase };

    await evaluate(cdp, `document.querySelector('[data-testid="companion-sound-toggle"]').click()`, {
      userGesture: true,
    });
    try {
      await waitFor(
        () => evaluate(cdp, `document.querySelector('[data-focus-phase]')?.getAttribute('data-sound-playing') === 'true'`),
        'Companion rain playback',
      );
    } catch (error) {
      const diagnostics = await evaluate(cdp, `({
        phase: document.querySelector('[data-focus-phase]')?.getAttribute('data-focus-phase') || '',
        playing: document.querySelector('[data-focus-phase]')?.getAttribute('data-sound-playing') || '',
        pressed: document.querySelector('[data-testid="companion-sound-toggle"]')?.getAttribute('aria-pressed') || '',
        alert: document.querySelector('[role="alert"]')?.textContent?.trim() || '',
        resources: Array.from(performance.getEntriesByType('resource'))
          .map((entry) => entry.name)
          .filter((value) => value.includes('focus-')),
      })`);
      throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
    }
    const sound = await evaluate(cdp, `(async () => {
      const records = await window.electronAPI.focusSound.list();
      const url = Array.from(performance.getEntriesByType('resource'))
        .map((entry) => entry.name)
        .find((value) => value.includes('focus-rain') && value.endsWith('.wav'));
      if (!url) throw new Error('bundled rain asset was not requested');
      const context = new AudioContext({ latencyHint: 'playback' });
      await context.resume();
      const decoded = await context.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const stateWhileActive = context.state;
      await context.close();
      return {
        managerAvailable: records.available,
        uiPlaying: document.querySelector('[data-focus-phase]')
          ?.getAttribute('data-sound-playing') === 'true',
        contextState: stateWhileActive,
        assetUrl: url,
        duration: decoded.duration,
        channels: decoded.numberOfChannels,
      };
    })()`, { userGesture: true });
    assert.equal(sound.managerAvailable, true);
    assert.equal(sound.uiPlaying, true);
    assert.equal(sound.contextState, 'running');
    assert.ok(sound.duration > 0);
    assert.ok(sound.channels > 0);
    await evaluate(cdp, `document.querySelector('[data-testid="companion-sound-toggle"]').click()`, {
      userGesture: true,
    });
    await waitFor(
      () => evaluate(cdp, `document.querySelector('[data-focus-phase]')?.getAttribute('data-sound-playing') === 'false'`),
      'Companion rain stop',
    );

    let lastLive2d = null;
    let live2d;
    try {
      live2d = await waitFor(async () => {
        const value = await evaluate(cdp, `(async () => ({
          core: Boolean(window.Live2DCubismCore),
          status: document.querySelector('[data-avatar-status]')?.getAttribute('data-avatar-status') || '',
          canvasCount: document.querySelectorAll('canvas').length,
          liveCanvas: Boolean(document.querySelector('[data-avatar-status="ready"] canvas')),
          notice: (document.querySelector('[data-avatar-status]')?.textContent || '').trim().slice(0, 500),
          avatar: await window.electronAPI.avatar.list(),
        }))()`);
        lastLive2d = value;
        return value.core && value.status === 'ready' && value.liveCanvas ? value : null;
      }, 'Yumi Live2D render', 45_000);
    } catch (error) {
      const failedShot = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      fs.writeFileSync(
        path.join(outputRoot, 'desktop-live2d-failed.png'),
        Buffer.from(failedShot.data, 'base64'),
      );
      throw new Error(`${error.message}: ${JSON.stringify(lastLive2d)}`);
    }
    await evaluate(cdp, `window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: innerWidth - 20,
      clientY: 40,
      bubbles: true,
    })); true`, { userGesture: true });
    await delay(500);
    const screenshot = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const screenshotPath = path.join(outputRoot, 'desktop-live2d.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const report = {
      apiSurface,
      provider,
      focus,
      sound,
      live2d,
      screenshotPath,
      electronLogTail: electronLogs.join('').split(/\r?\n/).filter(Boolean).slice(-12),
    };
    fs.writeFileSync(
      path.join(outputRoot, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.writeFileSync(
      path.join(outputRoot, 'electron.log'),
      electronLogs.join(''),
      'utf8',
    );
    cdp?.close();
    fake.server.close();
    electron?.kill();
    vite.kill();
    await delay(400);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
