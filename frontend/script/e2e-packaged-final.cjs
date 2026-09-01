'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const packageRoot = path.resolve(process.env.PACKAGE_ROOT || '');
const markerPath = path.join(packageRoot, 'TEST-BUILD-DO-NOT-RELEASE.json');
const outputRoot = path.resolve(process.env.REVERIE_E2E_OUT || path.join(__dirname, '..', '.packaged-final'));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(check, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
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

function startFakeProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      const body = JSON.stringify({
        id: 'reverie-final', object: 'chat.completion', created: 1, model: 'reverie-final',
        choices: [{ index: 0, message: { role: 'assistant', content: '看到了，是一张测试图片。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
      });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
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
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function bridgeRequest(cdp, type, payload, expectedType, timeoutMs = 30_000) {
  const requestId = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const effectivePayload = type === 'chat:send' ? { ...payload, request_id: requestId } : payload;
  return evaluate(cdp, `(async () => {
    const requestId = ${JSON.stringify(requestId)};
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => { dispose(); reject(new Error('bridge response timeout')); }, ${timeoutMs});
      const dispose = window.electronAPI.bridge.onMessage((frame) => {
        if (frame?.request_id !== requestId) return;
        if (frame.type !== ${JSON.stringify(expectedType)} && frame.type !== 'error') return;
        clearTimeout(timer); dispose(); resolve({ type: frame.type, payload: frame.payload });
      });
      try {
        await window.electronAPI.bridge.send({ type: ${JSON.stringify(type)}, payload: ${JSON.stringify(effectivePayload)}, request_id: requestId });
      } catch (error) { clearTimeout(timer); dispose(); reject(error); }
    });
  })()`);
}

async function clickCenter(cdp, selector) {
  const rect = await evaluate(cdp, `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  assert.ok(rect, `click target missing: ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function main() {
  assert.ok(fs.existsSync(path.join(packageRoot, 'Reverie.exe')), 'packaged executable missing');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.distribution, 'TEST_ONLY_DO_NOT_RELEASE');
  assert.equal(marker.publishable, false);
  fs.mkdirSync(outputRoot, { recursive: true });
  const userData = path.join(outputRoot, 'user-data');
  if (fs.existsSync(userData)) throw new Error('packaged E2E user-data directory already exists');
  fs.mkdirSync(userData, { recursive: true });
  const port = await freePort();
  const fake = await startFakeProvider();
  const logs = [];
  let child;
  let cdp;
  try {
    child = spawn(path.join(packageRoot, 'Reverie.exe'), [`--remote-debugging-port=${port}`], {
      cwd: packageRoot,
      windowsHide: true,
      env: { ...process.env, REVERIE_TEST_USER_DATA_DIR: userData, REVERIE_OPEN_DEVTOOLS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => logs.push(String(chunk)));
    child.stderr.on('data', (chunk) => logs.push(String(chunk)));
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url === 'reverie-app://app/index.html');
    }, 'packaged renderer');
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await waitFor(() => evaluate(cdp, 'document.readyState === "complete" && Boolean(window.electronAPI)'), 'preload');
    const connection = await waitFor(async () => {
      const value = await evaluate(cdp, 'window.electronAPI.bridge.getConnectionConfig()');
      return value?.transport === 'electron-ipc' && value?.protocolVersion === 4 ? value : null;
    }, 'Python authority');
    const initial = await waitFor(async () => evaluate(cdp, `({
      mvp: Boolean(document.querySelector('[data-testid="mvp-room"]')),
      splash: Boolean(document.querySelector('[data-testid="boot-splash"]')),
      url: location.href,
      title: document.title,
    })`).then((value) => value.mvp ? value : null), 'MvpRoom startup');

    const providerConfig = { llm: { provider: 'ollama', baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'reverie-final' } };
    const provider = await evaluate(cdp, `(async () => {
      const config = ${JSON.stringify(providerConfig)};
      const tested = await window.electronAPI.providerConfig.test(config, {});
      if (!tested.ok) return { tested };
      const committed = await window.electronAPI.providerConfig.commit(config, {}, 'session', tested.receipt);
      return { tested: { ok: tested.ok }, committed: { provider: committed.config.llm.provider, writeError: committed.status.writeError || null } };
    })()`);
    assert.equal(provider.tested.ok, true, JSON.stringify(provider));
    assert.equal(provider.committed.writeError, null);

    await bridgeRequest(cdp, 'settings:update', { section: 'onboarding', completed: true }, 'settings:update:result');
    await bridgeRequest(cdp, 'settings:update', {
      section: 'chat', reply_delay_min: 1, reply_delay_max: 1, typing_indicator: true,
    }, 'settings:update:result');
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const beforeImage = fake.requests.length;
    const imageRequestId = `e2e_image_${Date.now()}`;
    await evaluate(cdp, `(() => {
      window.__reverieE2EFrames = [];
      window.__reverieE2EDispose?.();
      window.__reverieE2EDispose = window.electronAPI.bridge.onMessage((frame) => {
        const correlatedId = frame?.request_id || frame?.payload?.request_id;
        if (correlatedId === ${JSON.stringify(imageRequestId)}) window.__reverieE2EFrames.push(frame);
      });
      return window.electronAPI.bridge.send({ type: 'chat:send', request_id: ${JSON.stringify(imageRequestId)}, payload: ${JSON.stringify({
        text: '[图片]', request_id: imageRequestId, conversation_id: 'dream-room', sent_at_utc: new Date().toISOString(), image_data_url: imageData,
      })} });
    })()`);
    await waitFor(() => fake.requests.length > beforeImage, 'vision provider dispatch', 60_000);
    await waitFor(() => evaluate(cdp, `window.__reverieE2EFrames.some((frame) => ['ready_waiting','delivering','done'].includes(frame?.payload?.state))`), 'image reply readiness', 60_000);
    const alreadyDone = await evaluate(cdp, `window.__reverieE2EFrames.some((frame) => frame.type === 'chat:done')`);
    if (!alreadyDone) {
      await evaluate(cdp, `window.electronAPI.bridge.send({ type: 'chat:reveal', request_id: 'reveal_${Date.now()}', payload: { request_id: ${JSON.stringify(imageRequestId)} } })`);
    }
    await waitFor(() => evaluate(cdp, `window.__reverieE2EFrames.some((frame) => frame.type === 'chat:done')`), 'image chat terminal', 60_000);
    const imageRequests = fake.requests.slice(beforeImage).map((entry) => JSON.parse(entry.body));
    assert.ok(imageRequests.some((body) => JSON.stringify(body).includes('data:image/')), 'vision request omitted image data');

    const stickerPath = path.join(userData, 'e2e-sticker.png');
    fs.writeFileSync(stickerPath, Buffer.from(imageData.split(',')[1], 'base64'));
    const imported = await bridgeRequest(cdp, 'sticker:import', { file_path: stickerPath, style_tags: [' e2e ', ''] }, 'sticker:data');
    assert.ok(imported.payload?.item?.id, JSON.stringify(imported));
    const item = imported.payload.item;
    const stickerPayload = {
      id: item.id, text: item.text || '[表情]', emotions: item.emotions || [],
      style_tags: (item.style_tags || []).map((value) => String(value).trim()).filter(Boolean),
      image_data_url: item.image_data_url, source: item.source,
    };
    const stickerRequestId = `e2e_sticker_${Date.now()}`;
    await evaluate(cdp, `window.electronAPI.bridge.send({ type: 'chat:send', request_id: ${JSON.stringify(stickerRequestId)}, payload: ${JSON.stringify({
      text: '[表情]', request_id: stickerRequestId, conversation_id: 'dream-room', sent_at_utc: new Date().toISOString(), sticker: stickerPayload,
    })} })`);

    const live2d = await waitFor(async () => {
      const value = await evaluate(cdp, 'typeof window.__reverieLive2D === "function" ? window.__reverieLive2D() : null');
      return value?.hasModel && value?.canvasConnected ? value : null;
    }, 'Live2D render', 60_000);
    await clickCenter(cdp, '[aria-label*="点击挥手"]');
    await delay(2_000);
    const wave2s = await evaluate(cdp, 'window.__reverieLive2D()');
    await delay(4_500);
    const wave6s = await evaluate(cdp, 'window.__reverieLive2D()');
    assert.equal(wave6s.motionWatchdogArmed, false);

    await bridgeRequest(cdp, 'settings:update', { section: 'ui', mode: 'dream' }, 'settings:update:result');
    const dream = await waitFor(async () => evaluate(cdp, `({
      visible: Boolean(document.querySelector('[data-testid="dream-room"]')),
      decorationImages: [...document.querySelectorAll('[data-module="room-scene"] img')]
        .map((img) => { const r=img.getBoundingClientRect(); return { className: img.className, width: r.width, height: r.height, display: getComputedStyle(img).display }; })
        .filter((img) => img.width > 10 && img.height > 10 && img.display !== 'none'),
      dockWidth: document.querySelector('[data-module="companion-dock"]')?.getBoundingClientRect().width || 0,
    })`).then((value) => value.visible ? value : null), 'DreamRoom');
    assert.ok(dream.decorationImages.length >= 4, JSON.stringify(dream));
    assert.ok(dream.dockWidth >= 439 && dream.dockWidth <= 521, JSON.stringify(dream));
    await clickCenter(cdp, '[data-testid="primary-chat-action"]');
    dream.composer = await waitFor(async () => evaluate(cdp, `(() => {
      const footer = document.querySelector('section[aria-labelledby="chat-title"] > footer');
      if (!footer) return null;
      const controls = [...footer.children]
        .filter((node) => getComputedStyle(node).display !== 'none')
        .map((node) => { const r=node.getBoundingClientRect(); return { tag: node.tagName, left: r.left, top: r.top, width: r.width, height: r.height }; });
      return { controls, textareaWidth: footer.querySelector('textarea')?.getBoundingClientRect().width || 0 };
    })()`), 'DreamRoom composer');
    assert.equal(dream.composer.controls.length, 4, JSON.stringify(dream));
    assert.ok(dream.composer.textareaWidth >= 200, JSON.stringify(dream));
    assert.ok(
      dream.composer.controls.every((control) => Math.abs(control.top - dream.composer.controls[0].top) < 2),
      JSON.stringify(dream),
    );
    await clickCenter(cdp, '[data-module="companion-dock"] nav button:first-child');
    await clickCenter(cdp, '[data-testid="primary-phone-action"]');
    const phone = await waitFor(async () => evaluate(cdp, `(() => {
      const drawer=document.querySelector('[data-testid="dream-room-panel"]');
      if(!drawer)return null;
      const scrim=drawer.querySelector('button');
      const sheet=drawer.querySelector('section');
      return { align: drawer.getAttribute('data-align'), scrim: getComputedStyle(scrim).backgroundColor, sheetRight: sheet.getBoundingClientRect().right, viewport: innerWidth };
    })()`), 'phone panel');
    assert.equal(phone.align, 'right');
    assert.ok(phone.scrim === 'rgba(0, 0, 0, 0)' || phone.scrim === 'transparent', JSON.stringify(phone));

    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const screenshot = path.join(outputRoot, 'packaged-final.png');
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    const report = {
      package: path.basename(packageRoot), executable: 'Reverie.exe', userDataIsolated: userData.startsWith(outputRoot),
      connection: { transport: connection.transport, protocolVersion: connection.protocolVersion, generation: connection.generation },
      initial, provider, imageProviderRequests: imageRequests.length, stickerImported: true,
      live2d, wave2s, wave6s, dream, phone, screenshot,
    };
    fs.writeFileSync(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    cdp?.close();
    await new Promise((resolve) => fake.server.close(resolve));
    if (child && child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    await delay(1_000);
    fs.writeFileSync(path.join(outputRoot, 'electron.log'), logs.join(''));
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
