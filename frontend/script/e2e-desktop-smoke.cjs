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
      require('electron'),
      [`--remote-debugging-port=${debuggingPort}`, '.'],
      {
        cwd: frontendRoot,
        windowsHide: true,
        env: {
          ...process.env,
          REVERIE_USER_DATA_DIR: userDataDir,
          REVERIE_OPEN_DEVTOOLS: '0',
          REVERIE_YUMI_SOURCE: path.resolve(projectRoot, '..', '..', 'Live-2D-yumi'),
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
      characterGet: typeof window.electronAPI?.character?.get,
      avatarImport: typeof window.electronAPI?.avatar?.beginImportFolder,
      voiceImport: typeof window.electronAPI?.voicePack?.beginImport,
      runtimeStatus: typeof window.electronAPI?.ttsRuntime?.status,
    })`);
    assert.deepEqual(apiSurface, {
      providerTest: 'function',
      providerCommit: 'function',
      characterGet: 'function',
      avatarImport: 'function',
      voiceImport: 'function',
      runtimeStatus: 'function',
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
    const onboarding = await waitFor(
      () => evaluate(cdp, `(() => {
        const dialog = document.querySelector('[aria-label="Reverie 新手引导"]');
        return dialog ? {
          text: (dialog.textContent || '').slice(0, 1200),
          version: (dialog.textContent || '').includes('ONBOARDING V2'),
          deepseek: (dialog.textContent || '').includes('DeepSeek'),
        } : null;
      })()`),
      'Onboarding V2',
    );
    assert.equal(onboarding.version, true, JSON.stringify(onboarding));

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
        tested: {
          ok: tested.ok,
          latencyMs: tested.latencyMs,
          finishReason: tested.finishReason,
        },
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
    const sentProbe = JSON.parse(fake.requests[0].body);
    assert.equal(sentProbe.max_tokens, 64);
    assert.equal(sentProbe.thinking, undefined);

    let lastLive2d = null;
    let live2d;
    try {
      const preflight = await evaluate(cdp, `(async () => ({
        avatar: await window.electronAPI.character.get(),
        room: Boolean(document.querySelector('[data-testid="mvp-room"]')),
      }))()`);
      assert.equal(preflight.room, true);
      if (preflight.avatar?.runtime?.live2d?.available !== true) {
        lastLive2d = preflight;
        throw new Error(
          'Live2D desktop smoke requires an official Cubism Core via REVERIE_LIVE2D_CORE_PATH',
        );
      }
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

    await evaluate(cdp, 'window.electronAPI.pet.show()', { userGesture: true });
    const petTarget = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.includes('#pet'));
    }, 'desktop pet renderer');
    const petCdp = await connectCdp(petTarget.webSocketDebuggerUrl);
    await petCdp.call('Runtime.enable');
    const petSurface = await waitFor(
      () => evaluate(petCdp, `(() => {
        const value = {
          keys: Object.keys(window.electronAPI || {}).sort(),
          petKeys: Object.keys(window.electronAPI?.pet || {}).sort(),
          composer: Boolean(document.querySelector('[aria-label="桌宠聊天"]')),
          provider: typeof window.electronAPI?.providerConfig,
        };
        return value.keys.includes('character') && value.keys.includes('pet') && value.composer
          ? value
          : null;
      })()`),
      'desktop pet narrow surface',
    );
    assert.deepEqual(petSurface.keys, ['character', 'pet']);
    assert.equal(petSurface.composer, true);
    assert.equal(petSurface.provider, 'undefined');
    petCdp.close();
    await evaluate(cdp, 'window.electronAPI.pet.hide()');

    const report = {
      apiSurface,
      onboarding,
      provider,
      live2d,
      petSurface,
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
