'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const DENIED_PERMISSION = false;

function canonicalOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

function createRendererTrustPolicy(options = {}) {
  const isDev = Boolean(options.isDev);
  const devOrigin = canonicalOrigin(options.devUrl);
  const packagedIndex = options.packagedIndex
    ? path.resolve(options.packagedIndex)
    : '';
  const packagedUrl = options.packagedUrl
    ? String(options.packagedUrl)
    : packagedIndex ? pathToFileURL(packagedIndex).href : '';

  function isTrustedUrl(value) {
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch {
      return false;
    }
    if (isDev) {
      return parsed.origin === devOrigin
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.href === packagedUrl;
  }

  function assertTrustedEvent(event, expectedWindow) {
    const webContents = expectedWindow?.webContents;
    if (!event || !webContents || webContents.isDestroyed?.()) {
      throw securityError('The application window is unavailable');
    }
    if (event.sender !== webContents) {
      throw securityError('IPC sender is not the Reverie window');
    }
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || frame.parent) {
      throw securityError('IPC is only accepted from the trusted main frame');
    }
    if (!isTrustedUrl(frame.url)) {
      throw securityError('IPC sender URL is not trusted');
    }
    return true;
  }

  return Object.freeze({
    isDev,
    devOrigin,
    packagedIndex,
    packagedUrl,
    isTrustedUrl,
    assertTrustedEvent,
  });
}

function securityError(message) {
  const error = new Error(message);
  error.code = 'REVERIE_SECURITY';
  return error;
}

function installWebContentsSecurity(app, trustPolicy) {
  if (!app || !trustPolicy) throw new TypeError('app and trustPolicy are required');
  const listener = (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (!trustPolicy.isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!trustPolicy.isTrustedUrl(url)) event.preventDefault();
    });
  };
  app.on('web-contents-created', listener);
  return () => app.removeListener('web-contents-created', listener);
}

function installPermissionPolicy(electronSession, trustPolicy, getWindow) {
  if (!electronSession || !trustPolicy || typeof getWindow !== 'function') {
    throw new TypeError('Electron session, trust policy, and window getter are required');
  }
  const allow = (webContents, permission, details = {}) => {
    const expected = getWindow()?.webContents;
    if (!expected || webContents !== expected || expected.isDestroyed?.()) return false;
    if (permission !== 'geolocation') return false;
    if (details.isMainFrame === false) return false;
    const mainFrame = expected.mainFrame;
    if (!mainFrame || mainFrame.parent || !trustPolicy.isTrustedUrl(mainFrame.url)) return false;
    const requestingUrl = details.requestingUrl || mainFrame.url;
    return trustPolicy.isTrustedUrl(requestingUrl);
  };
  electronSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    allow(webContents, permission, details)
  ));
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allow(webContents, permission, details));
  });
  if (typeof electronSession.setDevicePermissionHandler === 'function') {
    electronSession.setDevicePermissionHandler(() => DENIED_PERMISSION);
  }
}

function createSecureIpcRegistrar(ipcMain, getWindow, trustPolicy) {
  if (!ipcMain || typeof getWindow !== 'function' || !trustPolicy) {
    throw new TypeError('ipcMain, getWindow, and trustPolicy are required');
  }
  const channels = new Set();

  function handle(channel, handler) {
    if (channels.has(channel)) throw new Error(`Duplicate IPC registration: ${channel}`);
    channels.add(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      trustPolicy.assertTrustedEvent(event, getWindow());
      try {
        return await handler(event, ...args);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (code.startsWith('AVATAR_') || code.startsWith('REVERIE_')
          || error instanceof TypeError || error instanceof RangeError) {
          throw error;
        }
        console.warn(`[Electron] IPC ${channel} failed`, error);
        const publicError = new Error('The requested local operation could not be completed');
        publicError.code = 'REVERIE_OPERATION_FAILED';
        throw publicError;
      }
    });
  }

  function dispose() {
    for (const channel of channels) ipcMain.removeHandler(channel);
    channels.clear();
  }

  return Object.freeze({ handle, dispose, channels });
}

function assertPlainObject(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function boundedString(value, options = {}) {
  const label = options.label || 'value';
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.length < (options.min ?? 0) || value.length > (options.max ?? 1024)) {
    throw new RangeError(`${label} has an invalid length`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return value;
}

module.exports = {
  assertPlainObject,
  boundedString,
  canonicalOrigin,
  createRendererTrustPolicy,
  createSecureIpcRegistrar,
  installPermissionPolicy,
  installWebContentsSecurity,
  securityError,
};
