const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Deterministic screenshots are more useful than driver-dependent compositor
// frames. This applies only to the QA process, never the packaged application.
app.disableHardwareAcceleration();

const frontendRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(frontendRoot, '.visual-check');
const indexPath = path.join(frontendRoot, 'dist', 'index.html');
const distRoot = path.dirname(indexPath);
let staticOrigin = '';

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const target = path.resolve(distRoot, relative);
    if (target !== distRoot && !target.startsWith(`${distRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(target, (error, stat) => {
      const file = !error && stat.isFile() ? target : indexPath;
      const extension = path.extname(file).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
      };
      response.setHeader('Content-Type', types[extension] || 'application/octet-stream');
      fs.createReadStream(file)
        .on('error', () => response.destroy())
        .pipe(response);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      staticOrigin = `http://127.0.0.1:${address.port}/`;
      resolve(server);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureCompositorPaint(windowRef) {
  windowRef.setPosition(-20_000, -20_000, false);
  windowRef.showInactive();
  if (typeof windowRef.webContents.invalidate === 'function') {
    windowRef.webContents.invalidate();
  }
  await delay(350);
}

async function waitForSelector(windowRef, selector, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await windowRef.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      true,
    );
    if (found) return;
    await delay(100);
  }
  const diagnostic = await windowRef.webContents.executeJavaScript(`({
    href: location.href,
    readyState: document.readyState,
    body: (document.body?.innerText || '').slice(0, 800),
    html: (document.body?.innerHTML || '').slice(0, 800),
  })`, true).catch((error) => ({ evaluationError: String(error) }));
  throw new Error(`Timed out waiting for ${selector}: ${JSON.stringify(diagnostic)}`);
}

async function clickButtonWithText(windowRef, label) {
  const clicked = await windowRef.webContents.executeJavaScript(`(() => {
    const label = ${JSON.stringify(label)};
    const button = Array.from(document.querySelectorAll('button'))
      .find((node) => (node.textContent || '').trim().includes(label));
    if (!button) return false;
    button.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`Could not find button containing ${label}`);
  await delay(250);
}

async function clickSelector(windowRef, selector) {
  const clicked = await windowRef.webContents.executeJavaScript(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`, true);
  if (!clicked) throw new Error(`Could not click ${selector}`);
  await delay(250);
}

async function capture(windowRef, name) {
  await ensureCompositorPaint(windowRef);
  const image = await windowRef.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
  const target = path.join(outputRoot, name);
  fs.writeFileSync(target, image.toPNG());
  windowRef.hide();
  return target;
}

async function captureElement(windowRef, name, selector) {
  await ensureCompositorPaint(windowRef);
  await delay(500);
  const rect = await windowRef.webContents.executeJavaScript(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return {
      x: Math.max(0, Math.floor(value.x)),
      y: Math.max(0, Math.floor(value.y)),
      width: Math.max(1, Math.ceil(value.width)),
      height: Math.max(1, Math.ceil(value.height)),
    };
  })()`, true);
  if (!rect) throw new Error(`Could not capture missing element ${selector}`);
  const image = await windowRef.webContents.capturePage(rect, { stayHidden: false, stayAwake: true });
  const target = path.join(outputRoot, name);
  fs.writeFileSync(target, image.toPNG());
  windowRef.hide();
  return target;
}

async function inspectInteractiveLayout(windowRef, panelSelector = '[data-panel="personalitySettings"]') {
  return windowRef.webContents.executeJavaScript(`(() => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const violations = Array.from(document.querySelectorAll('button,input,select,textarea,[role="dialog"]'))
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          text: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      })
      .filter((item) => item.left < -2 || item.right > innerWidth + 2);
    const panelSelector = ${JSON.stringify(panelSelector)};
    const scrollViolations = Array.from(document.querySelectorAll(panelSelector + ' *'))
      .filter(visible)
      .filter((node) => !node.closest('[aria-hidden="true"]'))
      .filter((node) => getComputedStyle(node).clipPath !== 'inset(50%)')
      .filter((node) => node.scrollWidth > node.clientWidth + 2)
      .map((node) => ({
        tag: node.tagName,
        className: typeof node.className === 'string' ? node.className : '',
        text: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 60),
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
      }))
      .slice(0, 20);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      bodyWidth: document.body.scrollWidth,
      rootWidth: document.documentElement.scrollWidth,
      violations,
      scrollViolations,
    };
  })()`, true);
}

async function inspectDreamShell(windowRef) {
  windowRef.show();
  windowRef.focus();
  windowRef.webContents.focus();
  await delay(50);
  return windowRef.webContents.executeJavaScript(`(() => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const testIds = ['primary-chat-action', 'primary-diary-action', 'primary-phone-action'];
    const actionCounts = Object.fromEntries(testIds.map((id) => [
      id,
      Array.from(document.querySelectorAll('[data-testid="' + id + '"]')).filter(visible).length,
    ]));
    const undersizedTargets = Array.from(document.querySelectorAll(
      '[data-dream-shell-content] button, [data-dream-shell-content] input, [data-dream-shell-content] select, [data-dream-shell-content] textarea'
    ))
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          label: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44);
    const atmosphere = document.querySelector('[class*="_atmosphere_"]');
    const atmosphereStyle = atmosphere ? getComputedStyle(atmosphere) : null;
    const chat = document.querySelector('[data-testid="primary-chat-action"]');
    chat?.focus();
    const focusStyle = chat ? getComputedStyle(chat) : null;
    const scene = document.querySelector('[data-module="room-scene"]');
    const sceneRect = scene?.getBoundingClientRect();
    const centerNode = sceneRect
      ? document.elementFromPoint(sceneRect.left + sceneRect.width / 2, sceneRect.top + sceneRect.height / 2)
      : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      zoom: window.devicePixelRatio,
      language: document.documentElement.lang,
      actionCounts,
      undersizedTargets,
      bodyHorizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      bodyCanScrollVertically: document.documentElement.scrollHeight > innerHeight,
      atmospherePointerEvents: atmosphereStyle?.pointerEvents || null,
      decorativeAnimations: atmosphere?.getAnimations({ subtree: true }).length || 0,
      focusOutline: focusStyle
        ? { style: focusStyle.outlineStyle, width: focusStyle.outlineWidth }
        : null,
      focusProbe: {
        activeIsChat: document.activeElement === chat,
        matchesFocus: Boolean(chat?.matches(':focus')),
        documentHasFocus: document.hasFocus(),
        shellInert: Boolean(document.querySelector('[data-dream-shell-content]')?.hasAttribute('inert')),
      },
      sceneCenterCoveredByDock: Boolean(centerNode?.closest('[data-module="companion-dock"]')),
    };
  })()`, true);
}

async function inspectPersonalityPanel(windowRef) {
  return windowRef.webContents.executeJavaScript(`(() => {
    const sheet = document.querySelector('[data-panel="personalitySettings"]');
    return {
      mounted: Boolean(sheet),
      title: (sheet?.querySelector('header strong')?.textContent || '').trim(),
      controls: sheet?.querySelectorAll('input,select,textarea,button').length || 0,
      textLength: (sheet?.textContent || '').trim().length,
    };
  })()`, true);
}

async function inspectGroupPanel(windowRef) {
  return windowRef.webContents.executeJavaScript(`(() => {
    const sheet = document.querySelector('[data-panel="group"]');
    return {
      mounted: Boolean(sheet),
      title: (sheet?.querySelector('header strong')?.textContent || '').trim(),
      notice: (sheet?.querySelector('[aria-label="本地角色群聊"]')?.textContent || sheet?.textContent || '')
        .includes('本机'),
      controls: sheet?.querySelectorAll('input,button').length || 0,
    };
  })()`, true);
}

async function loadRoom(windowRef, width, height) {
  windowRef.setContentSize(width, height);
  await windowRef.loadURL(staticOrigin);
  await waitForSelector(windowRef, '[data-testid="dream-room"]');
  await windowRef.webContents.executeJavaScript(
    `localStorage.setItem('reverie:first-run-guide:v2', 'done')`,
    true,
  );
  await windowRef.webContents.reload();
  await waitForSelector(windowRef, '[data-testid="dream-room"]');
  await delay(300);
}

async function run() {
  if (!fs.existsSync(indexPath)) throw new Error('Run the production build before visual smoke testing');
  const staticServer = await startStaticServer();
  fs.mkdirSync(outputRoot, { recursive: true });
  const rendererErrors = [];
  const windowRef = new BrowserWindow({
    width: 1440,
    height: 1000,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  windowRef.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      rendererErrors.push(event.message);
      process.stderr.write(`[renderer] ${event.message}\n`);
    }
  });
  windowRef.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push(`renderer gone: ${details.reason}`);
  });

  const report = [];
  await loadRoom(windowRef, 1440, 1000);
  report.push({ name: 'room-desktop', layout: await inspectInteractiveLayout(windowRef) });
  await capture(windowRef, 'room-desktop.png');
  await clickSelector(windowRef, '[data-testid="primary-settings-action"]');
  await clickButtonWithText(windowRef, '人格设置');
  await waitForSelector(windowRef, '[data-panel="personalitySettings"]');
  const personalityDesktop = await inspectPersonalityPanel(windowRef);
  report.push({
    name: 'personality-desktop',
    layout: await inspectInteractiveLayout(windowRef),
    panel: personalityDesktop,
  });
  await captureElement(windowRef, 'personality-desktop.png', '[data-panel="personalitySettings"]');

  await loadRoom(windowRef, 1440, 1000);
  await clickSelector(windowRef, '[data-testid="primary-phone-action"]');
  await clickButtonWithText(windowRef, '群聊');
  await waitForSelector(windowRef, '[data-panel="group"]');
  const groupDesktop = await inspectGroupPanel(windowRef);
  report.push({
    name: 'group-desktop',
    layout: await inspectInteractiveLayout(windowRef, '[data-panel="group"]'),
    panel: groupDesktop,
  });
  await captureElement(windowRef, 'group-desktop.png', '[data-panel="group"]');

  await loadRoom(windowRef, 390, 844);
  report.push({ name: 'room-mobile', layout: await inspectInteractiveLayout(windowRef) });
  await capture(windowRef, 'room-mobile.png');
  await clickSelector(windowRef, '[data-testid="primary-settings-action"]');
  await clickButtonWithText(windowRef, '人格设置');
  await waitForSelector(windowRef, '[data-panel="personalitySettings"]');
  const personalityMobile = await inspectPersonalityPanel(windowRef);
  report.push({
    name: 'personality-mobile',
    layout: await inspectInteractiveLayout(windowRef),
    panel: personalityMobile,
  });
  await captureElement(windowRef, 'personality-mobile.png', '[data-panel="personalitySettings"]');

  await loadRoom(windowRef, 390, 844);
  await clickSelector(windowRef, '[data-testid="primary-phone-action"]');
  await clickButtonWithText(windowRef, '群聊');
  await waitForSelector(windowRef, '[data-panel="group"]');
  const groupMobile = await inspectGroupPanel(windowRef);
  report.push({
    name: 'group-mobile',
    layout: await inspectInteractiveLayout(windowRef, '[data-panel="group"]'),
    panel: groupMobile,
  });
  await captureElement(windowRef, 'group-mobile.png', '[data-panel="group"]');

  const viewportMatrix = [
    [800, 600],
    [1024, 768],
    [1200, 800],
    [1366, 768],
    [1440, 900],
    [1920, 1080],
    [390, 844],
  ];
  const zoomMatrix = [1, 1.25, 1.5, 2];
  for (const [width, height] of viewportMatrix) {
    for (const zoom of zoomMatrix) {
      windowRef.webContents.setZoomFactor(zoom);
      await loadRoom(windowRef, width, height);
      report.push({
        name: `matrix-${width}x${height}-${Math.round(zoom * 100)}`,
        layout: await inspectInteractiveLayout(windowRef, '[data-dream-shell-content]'),
        shell: await inspectDreamShell(windowRef),
      });
    }
  }
  windowRef.webContents.setZoomFactor(1);

  const failures = report.flatMap((item) => item.layout.violations.map((violation) => ({
    screen: item.name,
    ...violation,
  })));
  for (const item of report) {
    for (const violation of item.layout.scrollViolations || []) {
      failures.push({ screen: item.name, text: '抽屉内部横向溢出', ...violation });
    }
    if (item.name.startsWith('group') && (
      !item.panel?.mounted || item.panel.title !== '群聊' || item.panel.controls < 2
    )) {
      failures.push({ screen: item.name, text: '群聊面板控件未完整挂载' });
    }
  }
  for (const item of report) {
    if (!item.shell) continue;
    const counts = Object.values(item.shell.actionCounts);
    if (counts.some((count) => count !== 1)) {
      failures.push({ screen: item.name, text: '聊天/日记/手机主动作不是唯一可聚焦入口', counts });
    }
    if (item.shell.bodyHorizontalOverflow) {
      failures.push({ screen: item.name, text: '页面出现横向裁切或溢出' });
    }
    if (item.shell.atmospherePointerEvents !== 'none' || item.shell.decorativeAnimations !== 0) {
      failures.push({
        screen: item.name,
        text: '装饰层必须不可交互且不得有持续动画',
        pointerEvents: item.shell.atmospherePointerEvents,
        animations: item.shell.decorativeAnimations,
      });
    }
    if (item.shell.sceneCenterCoveredByDock) {
      failures.push({ screen: item.name, text: '右侧 Dock 遮挡了人物舞台中心' });
    }
    if (!item.shell.focusOutline || item.shell.focusOutline.style === 'none' || item.shell.focusOutline.width === '0px') {
      failures.push({ screen: item.name, text: '键盘焦点不可见' });
    }
    if (item.shell.undersizedTargets.length) {
      failures.push({
        screen: item.name,
        text: '存在小于 44px 的核心交互目标',
        targets: item.shell.undersizedTargets.slice(0, 12),
      });
    }
  }
  for (const item of report) {
    if (item.name.startsWith('personality') && (
      !item.panel?.mounted || item.panel.title !== '人格设置' || item.panel.controls < 30
    )) {
      failures.push({ screen: item.name, text: '人格设置控件未完整挂载' });
    }
  }
  const result = { report, rendererErrors, failures };
  fs.writeFileSync(path.join(outputRoot, 'report.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  windowRef.destroy();
  staticServer.close();
  if (rendererErrors.length || failures.length) process.exitCode = 1;
}

let finalExitCode = 0;
app.whenReady()
  .then(run)
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    finalExitCode = 1;
  })
  .finally(() => app.exit(finalExitCode || process.exitCode || 0));
