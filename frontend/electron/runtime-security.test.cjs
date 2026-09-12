'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  createRendererTrustPolicy,
  createSecureIpcRegistrar,
  installPermissionPolicy,
  installWebContentsSecurity,
} = require('./runtime-security.cjs');

test('https window-open goes to the system browser, everything else is denied', () => {
  const listeners = new Map();
  const app = {
    on(event, handler) { listeners.set(event, handler); },
    removeListener(event) { listeners.delete(event); },
  };
  const policy = createRendererTrustPolicy({
    isDev: false,
    packagedUrl: 'reverie-app://app/index.html',
  });
  const opened = [];
  const handlers = [];
  const contents = {
    setWindowOpenHandler(handler) { handlers.push(handler); },
    on(event, handler) {
      if (event === 'will-navigate') handlers.push(handler);
    },
  };
  installWebContentsSecurity(app, policy, {
    openExternal: (url) => { opened.push(url); },
  });
  listeners.get('web-contents-created')(null, contents);

  const openHandler = handlers[0];
  assert.equal(openHandler({ url: 'https://platform.deepseek.com/' }).action, 'deny');
  assert.deepEqual(opened, ['https://platform.deepseek.com/']);
  assert.equal(openHandler({ url: 'http://platform.deepseek.com/' }).action, 'deny');
  assert.equal(openHandler({ url: 'file:///C:/Windows/System32/calc.exe' }).action, 'deny');
  assert.equal(openHandler({ url: 'javascript:alert(1)' }).action, 'deny');
  assert.equal(openHandler({}).action, 'deny');
  assert.equal(opened.length, 1, 'only https is ever opened externally');

  const navigateHandler = handlers[1];
  const event = { preventDefault() { event.prevented = true; } };
  navigateHandler(event, 'https://platform.deepseek.com/');
  assert.equal(event.prevented, true, 'will-navigate keeps locking in-app navigation');
});

test('a throwing openExternal never crashes the window and no channel means plain deny', () => {
  const listeners = new Map();
  const app = {
    on(event, handler) { listeners.set(event, handler); },
    removeListener() {},
  };
  const policy = createRendererTrustPolicy({ isDev: false, packagedUrl: 'reverie-app://app/index.html' });
  const contents = { setWindowOpenHandler(handler) { contents.handler = handler; }, on() {} };

  installWebContentsSecurity(app, policy, {
    openExternal: () => { throw new Error('boom'); },
  });
  listeners.get('web-contents-created')(null, contents);
  assert.equal(contents.handler({ url: 'https://example.com/' }).action, 'deny');

  const contentsNoChannel = { setWindowOpenHandler(handler) { contentsNoChannel.handler = handler; }, on() {} };
  installWebContentsSecurity(app, policy);
  listeners.get('web-contents-created')(null, contentsNoChannel);
  assert.equal(contentsNoChannel.handler({ url: 'https://example.com/' }).action, 'deny');
});

test('renderer trust policy rejects subframes, foreign senders, and lookalike origins', () => {
  const policy = createRendererTrustPolicy({
    isDev: true,
    devUrl: 'http://localhost:5173',
  });
  assert.equal(policy.isTrustedUrl('http://localhost:5173/#/home'), true);
  assert.equal(policy.isTrustedUrl('http://localhost.evil:5173/'), false);
  assert.equal(policy.isTrustedUrl('https://localhost:5173/'), false);
  const mainFrame = { url: 'http://localhost:5173/', parent: null };
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents };
  assert.equal(policy.assertTrustedEvent({ sender: webContents, senderFrame: mainFrame }, window), true);
  assert.throws(
    () => policy.assertTrustedEvent({
      sender: webContents,
      senderFrame: { url: mainFrame.url, parent: mainFrame },
    }, window),
    /main frame/i,
  );
  assert.throws(
    () => policy.assertTrustedEvent({ sender: {}, senderFrame: mainFrame }, window),
    /sender/i,
  );
});

test('packaged trust policy accepts only the exact index file regardless of hash', () => {
  const index = path.resolve('C:/Program Files/Reverie/dist/index.html');
  const policy = createRendererTrustPolicy({ isDev: false, packagedIndex: index });
  const url = pathToFileURL(index);
  url.hash = '#/dream';
  assert.equal(policy.isTrustedUrl(url.href), true);
  assert.equal(policy.isTrustedUrl(pathToFileURL(path.join(path.dirname(index), 'other.html')).href), false);
});

test('packaged custom app URL is exact and does not trust sibling resources for IPC', () => {
  const policy = createRendererTrustPolicy({
    isDev: false,
    packagedUrl: 'reverie-app://app/index.html',
  });
  assert.equal(policy.isTrustedUrl('reverie-app://app/index.html#/dream'), true);
  assert.equal(policy.isTrustedUrl('reverie-app://app/asset.js'), false);
  assert.equal(policy.isTrustedUrl('reverie-app://evil/index.html'), false);
});

test('secure IPC registrar registers once and validates every invocation', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const frame = { url: 'http://localhost:5173/', parent: null };
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents };
  const policy = createRendererTrustPolicy({ isDev: true, devUrl: 'http://localhost:5173' });
  const registrar = createSecureIpcRegistrar(ipcMain, () => window, policy);
  registrar.handle('safe:test', (_event, value) => value + 1);
  assert.throws(() => registrar.handle('safe:test', () => null), /Duplicate/i);
  assert.equal(
    await handlers.get('safe:test')({ sender: webContents, senderFrame: frame }, 2),
    3,
  );
  await assert.rejects(
    handlers.get('safe:test')({ sender: {}, senderFrame: frame }, 2),
    /sender/i,
  );
  registrar.dispose();
  assert.equal(handlers.size, 0);
});

test('secure IPC does not expose unexpected filesystem errors to the renderer', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler() {},
  };
  const frame = { url: 'http://localhost:5173/', parent: null };
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  const policy = createRendererTrustPolicy({ isDev: true, devUrl: 'http://localhost:5173' });
  const registrar = createSecureIpcRegistrar(ipcMain, () => ({ webContents }), policy);
  registrar.handle('safe:error', () => {
    throw new Error('ENOENT C:\\Users\\alice\\secret.txt');
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      handlers.get('safe:error')({ sender: webContents, senderFrame: frame }),
      (error) => error.code === 'REVERIE_OPERATION_FAILED' && !error.message.includes('alice'),
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('permission policy allows geolocation only for the trusted main frame', () => {
  let checkHandler;
  let requestHandler;
  let deviceHandler;
  const electronSession = {
    setPermissionCheckHandler(handler) { checkHandler = handler; },
    setPermissionRequestHandler(handler) { requestHandler = handler; },
    setDevicePermissionHandler(handler) { deviceHandler = handler; },
  };
  const policy = createRendererTrustPolicy({ isDev: true, devUrl: 'http://localhost:5173' });
  const mainFrame = { url: 'http://localhost:5173/#/dream', parent: null };
  const webContents = { mainFrame, isDestroyed: () => false };
  const mainWindow = { webContents, isDestroyed: () => false };
  installPermissionPolicy(electronSession, policy, () => mainWindow);

  // Trusted main frame geolocation is granted for user-triggered immersion.
  assert.equal(checkHandler(webContents, 'geolocation', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  }), true);
  // Everything else stays denied.
  assert.equal(checkHandler(webContents, 'notifications', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  }), false);
  // Untrusted sender, destroyed webContents, and subframes stay denied.
  assert.equal(checkHandler({}, 'geolocation', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  }), false);
  const auxiliaryWebContents = { mainFrame, isDestroyed: () => false };
  assert.equal(checkHandler(auxiliaryWebContents, 'geolocation', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  }), false);
  mainWindow.webContents = auxiliaryWebContents;
  assert.equal(checkHandler(webContents, 'geolocation', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  }), false);
  mainWindow.webContents = webContents;
  assert.equal(checkHandler(webContents, 'geolocation', '', {
    requestingUrl: 'http://localhost.evil:5173/',
    isMainFrame: true,
  }), false);
  assert.equal(checkHandler(webContents, 'geolocation', '', {
    requestingUrl: mainFrame.url,
    isMainFrame: false,
  }), false);

  let allowed = null;
  requestHandler(webContents, 'geolocation', (value) => { allowed = value; }, {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  });
  assert.equal(allowed, true);
  let mediaDenied = null;
  requestHandler(webContents, 'media', (value) => { mediaDenied = value; }, {
    requestingUrl: mainFrame.url,
    isMainFrame: true,
  });
  assert.equal(mediaDenied, false);
  assert.equal(deviceHandler({ deviceType: 'usb' }), false);
});

test('secure IPC trusts the main window and the desktop pet window only', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  const mainFrame = { url: 'reverie-app://app/index.html', parent: null };
  const petFrame = { url: 'reverie-app://app/index.html#pet', parent: null };
  const mainWebContents = { mainFrame, isDestroyed: () => false };
  const petWebContents = { mainFrame: petFrame, isDestroyed: () => false };
  const policy = createRendererTrustPolicy({
    isDev: false,
    packagedUrl: 'reverie-app://app/index.html',
  });
  const registrar = createSecureIpcRegistrar(
    ipcMain,
    () => [{ webContents: mainWebContents }, { webContents: petWebContents }],
    policy,
  );
  registrar.handle('pet:test', (_event, value) => value);

  // Main window and pet window (same trusted origin, hash-only difference) pass.
  assert.equal(
    await handlers.get('pet:test')({ sender: mainWebContents, senderFrame: mainFrame }, 1),
    1,
  );
  assert.equal(
    await handlers.get('pet:test')({ sender: petWebContents, senderFrame: petFrame }, 2),
    2,
  );
  // A window outside the trusted set is rejected.
  const foreignWebContents = { mainFrame: { url: mainFrame.url, parent: null }, isDestroyed: () => false };
  await assert.rejects(
    handlers.get('pet:test')({ sender: foreignWebContents, senderFrame: foreignWebContents.mainFrame }, 3),
    /sender/i,
  );
  const deadPet = { webContents: { mainFrame: petFrame, isDestroyed: () => true } };
  const registrarWithDead = createSecureIpcRegistrar(
    ipcMain,
    () => [{ webContents: mainWebContents }, deadPet],
    policy,
  );
  registrarWithDead.handle('pet:dead', () => 'ok');
  await assert.rejects(
    handlers.get('pet:dead')({ sender: petWebContents, senderFrame: petFrame }, 5),
    /sender/i,
  );
  registrar.dispose();
});
