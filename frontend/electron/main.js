'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
} = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { installAppProtocol } = require('./app-protocol.cjs');
const { BridgeSupervisor } = require('./bridge-supervisor.cjs');
const { CredentialVault } = require('./credential-vault.cjs');
const { registerDesktopSchemes } = require('./desktop-schemes.cjs');
const { reconcileFocusNetworkGate } = require('./focus-gate-recovery.cjs');
const { enterLocalModeWithDegradedBridge } = require('./focus-local-mode-transition.cjs');
const { LocalNetworkGate } = require('./local-network-gate.cjs');
const { parseNotificationTimestamp } = require('./notification-outbox.cjs');
const { ProviderConfigStore } = require('./provider-config-store.cjs');
const {
  assertPlainObject,
  boundedString,
  createRendererTrustPolicy,
  createSecureIpcRegistrar,
  installPermissionPolicy,
  installWebContentsSecurity,
} = require('./runtime-security.cjs');
const { SafeLogger } = require('./safe-log.cjs');
const { acquireSingleInstance } = require('./single-instance.cjs');

const optionalModuleErrors = [];
function optionalExport(modulePath, exportName) {
  try {
    return require(modulePath)[exportName] || null;
  } catch (error) {
    optionalModuleErrors.push({ modulePath, error });
    return null;
  }
}

const AvatarManager = optionalExport('./avatar-manager.cjs', 'AvatarManager');
const installAvatarProtocol = optionalExport('./avatar-protocol.cjs', 'installAvatarProtocol');
const FocusManager = optionalExport('./focus-manager.cjs', 'FocusManager');
const FocusSoundManager = optionalExport('./focus-sound-manager.cjs', 'FocusSoundManager');
const installFocusSoundProtocol = optionalExport('./focus-sound-protocol.cjs', 'installFocusSoundProtocol');
const evaluateLive2DRuntime = optionalExport('./live2d-release-gate.cjs', 'evaluateLive2DRuntime');
const stageNativeBackupSource = optionalExport('./backup-file-stage.cjs', 'stageNativeBackupSource');

const FRONTEND_DEV_URL = 'http://localhost:5173';
const IS_DEV = !app.isPackaged;
const APP_USER_MODEL_ID = 'studio.muhe.reverie';
const BRIDGE_RESTART_MAX_MS = 30_000;

registerDesktopSchemes(protocol);

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
if (IS_DEV && process.env.REVERIE_USER_DATA_DIR) {
  const override = path.resolve(process.env.REVERIE_USER_DATA_DIR);
  fs.mkdirSync(override, { recursive: true });
  app.setPath('userData', override);
}

const packagedIndex = path.join(__dirname, '..', 'dist', 'index.html');
const packagedRendererUrl = 'reverie-app://app/index.html';
const trustPolicy = createRendererTrustPolicy({
  isDev: IS_DEV,
  devUrl: FRONTEND_DEV_URL,
  packagedIndex,
  packagedUrl: packagedRendererUrl,
});
installWebContentsSecurity(app, trustPolicy);

let mainWindow = null;
let tray = null;
let logger = null;
let restoreConsole = null;
let networkGate = null;
let bridge = null;
let credentialVault = null;
let providerConfigStore = null;
let avatarManager = null;
let focusManager = null;
let focusSoundManager = null;
let unregisterAvatarProtocol = null;
let unregisterFocusSoundProtocol = null;
let unregisterAppProtocol = null;
let ipcRegistrar = null;
let notificationPollTimer = null;
let inactivityTimer = null;
let backendRestartTimer = null;
let backendRestartAttempts = 0;
let isQuitting = false;
let screenLocked = false;
let avatarDialogPending = false;
let focusSoundDialogPending = false;
let backupDialogPending = false;
let jsonSaveDialogPending = false;
let localModeTransitionPending = false;
let focusGateRecovery = { available: true, reason: '', gateState: null };
let shutdownStarted = false;

function getRuntimeRoot() {
  return IS_DEV ? path.join(__dirname, '..', '..') : process.resourcesPath;
}

function isRegularUnlinkedFile(filePath) {
  try {
    const stat = fs.lstatSync(path.resolve(String(filePath || '')));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch {
    return false;
  }
}

function probeLive2DRuntime() {
  const corePath = IS_DEV
    ? process.env.REVERIE_LIVE2D_CORE_PATH
    : path.join(process.resourcesPath, 'Live2DCubismCore.js');
  let rendererAvailable = false;
  try {
    require.resolve('pixi-live2d-display/cubism4', {
      paths: [path.join(__dirname, '..')],
    });
    rendererAvailable = true;
  } catch {}
  return {
    coreAvailable: isRegularUnlinkedFile(corePath),
    rendererAvailable,
  };
}

function getPythonCommand() {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python';
  const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const bundled = path.join(getRuntimeRoot(), 'venv', scriptsDir, executable);
  if (fs.existsSync(bundled)) return bundled;
  if (!IS_DEV) throw new Error('Bundled Python runtime is missing');
  return process.platform === 'win32' ? 'python' : 'python3';
}

function copyMissingData(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing data symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyMissingData(path.join(source, name), path.join(target, name));
  } else if (stat.isFile() && !fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

function prepareWritableDataDir() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!IS_DEV) copyMissingData(path.join(getRuntimeRoot(), 'data'), dataDir);
  return dataDir;
}

function getWindowIconPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'public', 'favicon.jpg')
    : path.join(__dirname, '..', 'dist', 'favicon.jpg');
}

function broadcast(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!trustPolicy.isTrustedUrl(mainWindow.webContents.getURL())) return;
  mainWindow.webContents.send(channel, payload);
}

function sendLifecycle(state) {
  broadcast('app:lifecycle', { state, at: new Date().toISOString() });
}

function publicLocalModeState(extra = {}) {
  const state = networkGate?.snapshot?.() || {
    active: false,
    epoch: 0,
    sessionId: null,
    changedAtUtc: new Date(0).toISOString(),
  };
  return {
    enabled: Boolean(state.active),
    epoch: Number.isInteger(state.epoch) ? state.epoch : 0,
    sessionId: state.sessionId || null,
    changedAtUtc: state.changedAtUtc || new Date(0).toISOString(),
    available: focusGateRecovery.available !== false,
    reason: focusGateRecovery.available === false ? focusGateRecovery.reason : '',
    ...extra,
  };
}

function broadcastLocalMode(extra = {}) {
  const state = publicLocalModeState(extra);
  broadcast('localMode:changed', state);
  return state;
}

function publicCredentialStatus(extra = {}) {
  const status = credentialVault
    ? credentialVault.status()
    : {
        available: false,
        corrupted: false,
        llm: { hasApiKey: false, hasCustomHeaders: false },
        imageGen: { hasApiKey: false, hasCustomHeaders: false },
      };
  return { ...status, ...extra };
}

function broadcastCredentialStatus(extra = {}) {
  const status = publicCredentialStatus(extra);
  broadcast('credentials:changed', status);
  return status;
}

function hasStoredCredentials(status) {
  return Boolean(
    status?.llm?.hasApiKey
    || status?.llm?.hasCustomHeaders
    || status?.imageGen?.hasApiKey
    || status?.imageGen?.hasCustomHeaders,
  );
}

async function syncCredentialVault(options = {}) {
  const status = publicCredentialStatus();
  if (!status.available || status.corrupted) {
    return broadcastCredentialStatus({
      stored: false,
      runtimeApplied: false,
      runtimePending: false,
    });
  }
  // The OS-encrypted vault is the durable source of truth. A bridge process may
  // still be starting (or recovering), so never make a successful local write
  // wait for or depend on Python availability. startBridge() synchronizes the
  // same vault after every authenticated ready handshake.
  if (!bridge?.ready) {
    return broadcastCredentialStatus({
      stored: hasStoredCredentials(status),
      runtimeApplied: false,
      runtimePending: true,
      runtimeAppliedScopes: { llm: false, imageGen: false },
    });
  }
  const runtimeCredentials = credentialVault.readForRuntime();
  for (const scope of options.clearScopes || []) runtimeCredentials[scope] = null;
  const result = await bridge.setCredentials(runtimeCredentials);
  return broadcastCredentialStatus({
    stored: hasStoredCredentials(status),
    runtimeApplied: Object.values(result.applied).every((applied) => applied === true),
    runtimePending: false,
    runtimeAppliedScopes: result.applied,
  });
}

function assertNativeBackupPath(filePath, { mustExist }) {
  const value = path.resolve(String(filePath || ''));
  if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.json') {
    throw new TypeError('Backup selection must be an absolute JSON file path');
  }
  const parent = path.dirname(value);
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory()) throw new TypeError('Backup parent is not a directory');
  if (fs.existsSync(value)) {
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError('Backup selection must be a regular non-symlink file');
    }
  } else if (mustExist) {
    throw new TypeError('Backup file does not exist');
  }
  return value;
}

function atomicWriteJson(filePath, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 * 1024) {
    throw new RangeError('JSON export is too large');
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendLifecycle('active');
}

function safeNotificationText(value, max, fallback = '') {
  return String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function showNativeNotification(title, body, options = {}) {
  if (!Notification.isSupported()) return false;
  const generic = screenLocked || options.forceGeneric;
  const safeTitle = generic ? 'Reverie' : safeNotificationText(title, 80, 'Reverie') || 'Reverie';
  const safeBody = generic
    ? '你有一条本地提醒。'
    : safeNotificationText(body, 500);
  if (!safeBody) return false;
  const notification = new Notification({
    title: safeTitle,
    body: safeBody,
    silent: Boolean(options.silent),
  });
  notification.on('click', showMainWindow);
  notification.show();
  return true;
}

function notificationOutboxDir() {
  return path.join(app.getPath('userData'), 'data', 'notifications', 'outbox');
}

function pollNotificationOutbox() {
  const outbox = notificationOutboxDir();
  try {
    fs.mkdirSync(outbox, { recursive: true });
    const files = fs.readdirSync(outbox)
      .filter((name) => /^[A-Za-z0-9_.-]+\.json$/.test(name))
      .sort()
      .slice(0, 20);
    for (const name of files) {
      const filePath = path.join(outbox, name);
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
          throw new Error('Invalid notification outbox item');
        }
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (payload.schema !== 'reverie.notification.v1') throw new Error('Unknown notification schema');
        const createdAt = parseNotificationTimestamp(payload.created_at);
        if (!Number.isFinite(createdAt)) throw new Error('Invalid notification timestamp');
        const tooOld = Date.now() - createdAt > 12 * 60 * 60 * 1000;
        const localFocus = networkGate?.snapshot().active;
        if (!tooOld && !localFocus) {
          const shouldShow = !payload.only_when_unfocused
            || !mainWindow
            || mainWindow.isDestroyed()
            || !mainWindow.isVisible()
            || !mainWindow.isFocused();
          if (shouldShow) showNativeNotification(payload.title, payload.body);
        }
        // Focus mode intentionally discards queued proactive notifications:
        // there is no post-focus catch-up burst.
        fs.unlinkSync(filePath);
      } catch (error) {
        const rejected = path.join(outbox, '..', 'rejected');
        fs.mkdirSync(rejected, { recursive: true });
        try { fs.renameSync(filePath, path.join(rejected, `${Date.now()}-${name}`)); } catch {}
        console.warn('[Electron] Rejected notification outbox item', name, error);
      }
    }
  } catch (error) {
    console.warn('[Electron] Notification outbox poll failed', error);
  }
}

function setupLogging() {
  logger = new SafeLogger({
    logDir: path.join(app.getPath('userData'), 'logs'),
    filename: 'electron.log',
  });
  restoreConsole = logger.installConsole();
  console.log('[Electron] Starting Reverie desktop host');
  for (const failure of optionalModuleErrors) {
    console.error('[Electron] Optional module is unavailable', failure.modulePath, failure.error);
  }
}

function spawnBridgeChild(context) {
  const dataDir = prepareWritableDataDir();
  const command = getPythonCommand();
  const args = [
    path.join(getRuntimeRoot(), 'src', 'main.py'),
    '--bridge',
    '--host=127.0.0.1',
    '--port=0',
  ];
  logger?.addSecret(context.secret);
  return spawn(command, args, {
    cwd: getRuntimeRoot(),
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      REVERIE_BRIDGE_MODE: '1',
      REVERIE_BRIDGE_PROTOCOL_VERSION: '2',
      REVERIE_BRIDGE_SECRET: context.secret,
      REVERIE_PARENT_PID: String(process.pid),
      REVERIE_DATA_DIR: dataDir,
      REVERIE_LOCAL_MODE: context.localMode.active ? '1' : '0',
      REVERIE_LOCAL_MODE_EPOCH: String(context.localMode.epoch || 0),
      REVERIE_LOCAL_MODE_SESSION_ID: String(context.localMode.sessionId || ''),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function scheduleBridgeRestart(reason) {
  if (isQuitting || backendRestartTimer) return;
  const delay = Math.min(BRIDGE_RESTART_MAX_MS, 1000 * (2 ** Math.min(backendRestartAttempts, 5)));
  backendRestartAttempts += 1;
  console.warn(`[Electron] Local bridge unavailable; retrying in ${delay}ms`, reason);
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    startBridge();
  }, delay);
  backendRestartTimer.unref?.();
}

function startBridge() {
  if (isQuitting || bridge?.child) return;
  let promise;
  try {
    promise = bridge.start({ localMode: networkGate.snapshot() });
  } catch (error) {
    scheduleBridgeRestart(error);
    return;
  }
  promise.then(async () => {
    backendRestartAttempts = 0;
    try {
      await syncCredentialVault();
    } catch (error) {
      console.error('[Electron] Credential runtime synchronization failed', error);
      broadcastCredentialStatus({ runtimeApplied: false });
    }
    broadcast('bridge:changed', { ready: true, generation: bridge.generation });
  }).catch((error) => scheduleBridgeRestart(error));
}

async function killBridgeFailClosed() {
  await bridge?.stopAndWait('SIGKILL');
  broadcast('bridge:changed', { ready: false });
}

function localModeTransitionError() {
  const error = new Error('A local-mode transition is already in progress');
  error.code = 'REVERIE_OPERATION_IN_PROGRESS';
  return error;
}

async function enterFocusLocalModeUnchecked({ epoch, sessionId }) {
  return enterLocalModeWithDegradedBridge({
    networkGate,
    bridge,
    epoch,
    sessionId,
    broadcast: broadcastLocalMode,
    stopBridge: killBridgeFailClosed,
    startBridge,
    onBridgeFailure: (error) => {
      console.error('[Electron] Companion backend entered degraded local mode', error);
    },
  });
}

async function exitLocalModeUnchecked({ epoch, sessionId }) {
  let bridgeError = null;
  try {
    if (bridge.child) {
      await bridge.waitUntilReady();
      await bridge.setLocalMode({ active: false, epoch, sessionId });
    }
  } catch (error) {
    bridgeError = error;
    // A dead process cannot make a remote request. Only after it is killed may
    // the two host-side gates reopen.
    await killBridgeFailClosed();
  }
  const gateState = networkGate.disable({ epoch, sessionId });
  broadcastLocalMode({ transitioning: false });
  if (bridgeError) scheduleBridgeRestart(bridgeError);
  return gateState;
}

async function enterFocusLocalMode(input) {
  if (localModeTransitionPending) throw localModeTransitionError();
  localModeTransitionPending = true;
  try {
    return await enterFocusLocalModeUnchecked(input);
  } finally {
    localModeTransitionPending = false;
  }
}

async function exitFocusLocalMode(input) {
  if (localModeTransitionPending) throw localModeTransitionError();
  localModeTransitionPending = true;
  try {
    return await exitLocalModeUnchecked(input);
  } finally {
    localModeTransitionPending = false;
  }
}

async function setManualLocalMode(enabled) {
  if (localModeTransitionPending) throw localModeTransitionError();
  const current = networkGate.snapshot();
  if (focusGateRecovery.available === false && current.active) {
    const error = new Error(focusGateRecovery.reason || 'Local mode recovery is unavailable');
    error.code = 'REVERIE_MODULE_UNAVAILABLE';
    throw error;
  }
  if (Boolean(current.active) === Boolean(enabled)) return publicLocalModeState();
  if (!enabled && Boolean(focusManager?.getState?.().localModeActive)) {
    const error = new Error('Local mode is owned by the active Focus session');
    error.code = 'REVERIE_FOCUS_OWNS_LOCAL_MODE';
    throw error;
  }
  localModeTransitionPending = true;
  try {
    if (enabled) {
      const sessionId = `manual-${crypto.randomUUID()}`;
      const gateState = networkGate.enable({
        epoch: current.epoch + 1,
        sessionId,
      });
      broadcastLocalMode({ transitioning: true });
      try {
        if (!bridge.child) startBridge();
        await bridge.waitUntilReady();
        const acknowledgement = await bridge.setLocalMode({
          active: true,
          epoch: gateState.epoch,
          sessionId,
        });
        if (!acknowledgement.active || acknowledgement.epoch !== gateState.epoch) {
          throw new Error('Python local-mode acknowledgement was inconsistent');
        }
        return broadcastLocalMode({ transitioning: false });
      } catch (error) {
        // The host gates remain closed. Killing an unacknowledged Python
        // process prevents it from continuing with stale network authority.
        await killBridgeFailClosed();
        scheduleBridgeRestart(error);
        broadcastLocalMode({
          transitioning: false,
          available: false,
          reason: 'The Python network gate could not be verified',
        });
        const wrapped = new Error('Local mode remains fail-closed, but backend acknowledgement failed');
        wrapped.code = 'REVERIE_LOCAL_MODE_SYNC_FAILED';
        throw wrapped;
      }
    }
    await exitLocalModeUnchecked({
      epoch: current.epoch + 1,
      sessionId: current.sessionId,
    });
    return publicLocalModeState();
  } finally {
    localModeTransitionPending = false;
  }
}

function createRuntimeModules() {
  const runtimeDir = path.join(app.getPath('userData'), 'runtime');
  networkGate = new LocalNetworkGate({ storageDir: path.join(runtimeDir, 'network') });
  networkGate.install(session.defaultSession);
  networkGate.installNodeGuards();
  credentialVault = new CredentialVault({
    storageDir: path.join(runtimeDir, 'credentials'),
    safeStorage,
  });
  providerConfigStore = new ProviderConfigStore({
    storageDir: path.join(runtimeDir, 'provider-config'),
  });

  bridge = new BridgeSupervisor({ spawnChild: spawnBridgeChild });
  bridge.on('log', ({ stream, line }) => {
    if (stream === 'stderr') console.warn('[Python]', line);
    else console.log('[Python]', line);
  });
  bridge.on('exit', (error) => {
    broadcast('bridge:changed', { ready: false });
    scheduleBridgeRestart(error);
  });

  if (AvatarManager) {
    try {
      const licensePath = IS_DEV
        ? process.env.REVERIE_LIVE2D_LICENSE_PATH
        : path.join(process.resourcesPath, 'LIVE2D_PUBLICATION_LICENSE.json');
      const live2dRuntime = evaluateLive2DRuntime
        ? evaluateLive2DRuntime({
            ...probeLive2DRuntime(),
            isPackaged: app.isPackaged,
            licensePath,
            buildEnabled: IS_DEV
              ? process.env.REVERIE_LIVE2D_PUBLIC_BUILD
              : fs.existsSync(path.join(process.resourcesPath, 'LIVE2D_RUNTIME_ENABLED')) ? '1' : '0',
            runtimeEnabled: IS_DEV
              ? process.env.REVERIE_LIVE2D_PUBLIC_RUNTIME
              : fs.existsSync(licensePath) ? '1' : '0',
          })
        : {
            available: false,
            licenseAccepted: false,
            reason: 'Live2D release gate module is unavailable',
          };
      avatarManager = new AvatarManager({
        storageDir: path.join(app.getPath('userData'), 'avatars'),
        live2dRuntime,
      });
    } catch (error) {
      avatarManager = null;
      console.error('[Electron] Avatar module initialization failed', error);
    }
  }
  if (FocusSoundManager) {
    try {
      focusSoundManager = new FocusSoundManager({
        storageDir: path.join(app.getPath('userData'), 'focus-sounds'),
      });
    } catch (error) {
      focusSoundManager = null;
      console.error('[Electron] Focus sound module initialization failed', error);
    }
  }
  if (FocusManager) {
    try {
      focusManager = new FocusManager({
        storageDir: path.join(app.getPath('userData'), 'focus'),
        enterLocalMode: enterFocusLocalMode,
        exitLocalMode: exitFocusLocalMode,
        onStateChange: (state) => broadcast('focus:changed', state),
        onCompletion: async (effect, state) => {
          broadcast('focus:completed', { effect, state });
          const appIsBackground = screenLocked
            || !mainWindow
            || mainWindow.isDestroyed()
            || !mainWindow.isVisible()
            || !mainWindow.isFocused();
          if (appIsBackground) {
            showNativeNotification('Reverie', '专注时间结束了。', { forceGeneric: screenLocked });
          }
        },
      });
    } catch (error) {
      focusManager = null;
      console.error('[Electron] Focus module initialization failed', error);
    }
  }
  focusGateRecovery = reconcileFocusNetworkGate(networkGate, focusManager);
}

function validateSessionId(id) {
  if (!focusManager) {
    const error = new Error('Focus module is unavailable');
    error.code = 'REVERIE_MODULE_UNAVAILABLE';
    throw error;
  }
  const value = boundedString(id, { label: 'focus session id', min: 1, max: 64 });
  if (focusManager.getState().id !== value) throw new Error('Focus session identifier does not match');
}

function runAvatarImportWorker(sourcePath, { sourceIsDirectory = false } = {}) {
  if (!avatarManager) {
    const error = new Error('Avatar module is unavailable');
    error.code = 'REVERIE_MODULE_UNAVAILABLE';
    throw error;
  }
  const importId = crypto.randomBytes(24).toString('base64url');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'avatar-import-worker.cjs'), {
      workerData: {
        sourcePath,
        sourceIsDirectory,
        importId,
        storageDir: avatarManager.storageDir,
        live2dRuntime: avatarManager.live2dRuntime,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 1024,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      if (error) {
        avatarManager.discardImport(importId);
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      const error = new Error('Avatar validation timed out');
      error.code = 'AVATAR_IMPORT_TIMEOUT';
      finish(error);
    }, 3 * 60 * 1000);
    timer.unref?.();
    worker.once('message', (message) => {
      if (message?.ok === true) {
        finish(null, message.candidate);
      } else {
        const error = new Error(String(message?.error?.message || 'Avatar import failed'));
        error.code = String(message?.error?.code || 'AVATAR_IMPORT_FAILED');
        finish(error);
      }
    });
    worker.once('error', () => {
      const error = new Error('Avatar validation worker failed');
      error.code = 'AVATAR_IMPORT_FAILED';
      finish(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        const error = new Error('Avatar validation worker stopped unexpectedly');
        error.code = 'AVATAR_IMPORT_FAILED';
        finish(error);
      }
    });
  });
}

function runAvatarMotionWorker(avatarId, sourcePath) {
  if (!avatarManager) {
    const error = new Error('Avatar module is unavailable');
    error.code = 'REVERIE_MODULE_UNAVAILABLE';
    throw error;
  }
  const importId = crypto.randomBytes(24).toString('base64url');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'avatar-import-worker.cjs'), {
      workerData: {
        operation: 'addVrma',
        sourcePath,
        avatarId,
        importId,
        storageDir: avatarManager.storageDir,
        live2dRuntime: avatarManager.live2dRuntime,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 1024,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      if (error) {
        avatarManager.discardMotionImport(importId);
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      const error = new Error('Motion validation timed out');
      error.code = 'AVATAR_IMPORT_TIMEOUT';
      finish(error);
    }, 3 * 60 * 1000);
    timer.unref?.();
    worker.once('message', (message) => {
      if (message?.ok === true && message.motionCandidate?.importId === importId) {
        try {
          finish(null, avatarManager.commitMotionImport(importId));
        } catch (error) {
          finish(error);
        }
      } else {
        const error = new Error(String(message?.error?.message || 'Motion import failed'));
        error.code = String(message?.error?.code || 'AVATAR_IMPORT_FAILED');
        finish(error);
      }
    });
    worker.once('error', () => {
      const error = new Error('Motion validation worker failed');
      error.code = 'AVATAR_IMPORT_FAILED';
      finish(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        const error = new Error('Motion validation worker stopped unexpectedly');
        error.code = 'AVATAR_IMPORT_FAILED';
        finish(error);
      }
    });
  });
}

async function exportNativeBackup() {
  if (backupDialogPending) {
    const error = new Error('A backup operation is already in progress');
    error.code = 'REVERIE_OPERATION_IN_PROGRESS';
    throw error;
  }
  backupDialogPending = true;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: 'Export complete local backup',
      defaultPath: `Reverie-full-backup-${stamp}.reverie-backup.json`,
      buttonLabel: 'Export backup',
      filters: [{ name: 'Reverie backup', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    });
    if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
    const target = assertNativeBackupPath(selection.filePath, { mustExist: false });
    broadcast('backup:progress', { operation: 'export', phase: 'started' });
    const result = await bridge.backupToFile(target);
    const response = {
      ok: true,
      canceled: false,
      operation: result.operation,
      fileName: path.basename(target),
    };
    broadcast('backup:progress', { operation: 'export', phase: 'completed' });
    return response;
  } catch (error) {
    broadcast('backup:progress', { operation: 'export', phase: 'failed' });
    throw error;
  } finally {
    backupDialogPending = false;
  }
}

async function importNativeBackup() {
  if (backupDialogPending) {
    const error = new Error('A backup operation is already in progress');
    error.code = 'REVERIE_OPERATION_IN_PROGRESS';
    throw error;
  }
  backupDialogPending = true;
  let staged = null;
  try {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Restore complete local backup',
      buttonLabel: 'Choose backup',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'Reverie backup', extensions: ['json'] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { ok: false, canceled: true };
    }
    const source = assertNativeBackupPath(selection.filePaths[0], { mustExist: true });
    if (!stageNativeBackupSource) {
      const error = new Error('Secure backup staging is unavailable');
      error.code = 'REVERIE_BACKUP_UNAVAILABLE';
      throw error;
    }
    staged = await stageNativeBackupSource(source, {
      storageDir: path.join(app.getPath('userData'), 'private', 'backup-imports'),
    });
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Restore local world state?',
      message: 'Restore this backup and replace the current local world state?',
      detail: 'Reverie validates the entire backup before committing it. Keep the application open until completion.',
      buttons: ['Cancel', 'Restore'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    broadcast('backup:progress', { operation: 'import', phase: 'started' });
    // Restore the private immutable copy, never the user-selected path.  This
    // closes the selection/confirmation TOCTOU window.
    const result = await bridge.restoreFromFile(staged.filePath);
    const response = {
      ok: true,
      canceled: false,
      operation: result.operation,
      result: result.result,
      fileName: staged.fileName,
    };
    broadcast('backup:progress', {
      operation: 'import',
      phase: 'completed',
      result: result.result,
    });
    return response;
  } catch (error) {
    broadcast('backup:progress', { operation: 'import', phase: 'failed' });
    throw error;
  } finally {
    if (staged) {
      try { await staged.dispose(); } catch (error) {
        logger?.warn?.('Could not remove private backup staging file', {
          code: String(error?.code || 'UNKNOWN'),
        });
      }
    }
    backupDialogPending = false;
  }
}

async function saveRendererJson(input) {
  if (jsonSaveDialogPending) {
    const error = new Error('A JSON save dialog is already open');
    error.code = 'REVERIE_OPERATION_IN_PROGRESS';
    throw error;
  }
  assertPlainObject(input, 'JSON export');
  const suggestedName = boundedString(input.suggestedName, {
    label: 'suggested file name',
    min: 1,
    max: 180,
  });
  if (path.basename(suggestedName) !== suggestedName
    || path.extname(suggestedName).toLowerCase() !== '.json') {
    throw new TypeError('suggested file name must be a plain JSON file name');
  }
  jsonSaveDialogPending = true;
  try {
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: 'Export JSON',
      defaultPath: suggestedName,
      buttonLabel: 'Save',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    });
    if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };
    const target = assertNativeBackupPath(selection.filePath, { mustExist: false });
    atomicWriteJson(target, input.payload);
    return {
      ok: true,
      canceled: false,
      fileName: path.basename(target),
    };
  } finally {
    jsonSaveDialogPending = false;
  }
}

function registerIpcHandlers() {
  if (ipcRegistrar) return;
  ipcRegistrar = createSecureIpcRegistrar(ipcMain, () => mainWindow, trustPolicy);
  const { handle } = ipcRegistrar;

  handle('bridge:getConnectionConfig', () => bridge.getConnectionConfig());
  handle('app:getVersion', () => app.getVersion());
  handle('localMode:get', () => publicLocalModeState());
  handle('localMode:set', async (_event, input = {}) => {
    assertPlainObject(input, 'local mode');
    if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return setManualLocalMode(input.enabled);
  });
  handle('credentials:status', () => publicCredentialStatus());
  handle('credentials:set', async (_event, input = {}) => {
    assertPlainObject(input, 'credentials');
    const scope = boundedString(input.scope, {
      label: 'credential scope',
      min: 1,
      max: 16,
    });
    assertPlainObject(input.value, 'credential value');
    credentialVault.set(scope, input.value);
    try {
      return await syncCredentialVault();
    } catch (error) {
      // Persisted credentials remain valid even if the replaceable Python
      // module is unavailable. Keep retrying in the background and report the
      // truthful split state to the renderer instead of turning a saved key
      // into a generic IPC failure.
      console.error('[Electron] Stored credential runtime synchronization failed', error);
      if (!bridge?.child) startBridge();
      const status = publicCredentialStatus();
      return broadcastCredentialStatus({
        stored: hasStoredCredentials(status),
        runtimeApplied: false,
        runtimePending: true,
        runtimeAppliedScopes: { llm: false, imageGen: false },
      });
    }
  });
  handle('credentials:clear', async (_event, input = {}) => {
    assertPlainObject(input, 'credential clear');
    const scope = boundedString(input.scope, {
      label: 'credential scope',
      min: 1,
      max: 16,
    });
    credentialVault.clear(scope);
    try {
      return await syncCredentialVault({ clearScopes: [scope] });
    } catch (error) {
      console.error('[Electron] Cleared credential runtime synchronization failed', error);
      if (!bridge?.child) startBridge();
      const status = publicCredentialStatus();
      return broadcastCredentialStatus({
        stored: hasStoredCredentials(status),
        runtimeApplied: false,
        runtimePending: true,
        runtimeAppliedScopes: { llm: false, imageGen: false },
      });
    }
  });
  handle('providerConfig:get', () => providerConfigStore.get());
  handle('providerConfig:set', (_event, input) => providerConfigStore.set(input));
  handle('backup:exportNative', () => exportNativeBackup());
  handle('backup:importNative', () => importNativeBackup());
  handle('file:saveJson', (_event, input) => saveRendererJson(input));
  handle('notification:show', (_event, input = {}) => {
    assertPlainObject(input, 'notification');
    return {
      shown: showNativeNotification(
        boundedString(input.title ?? 'Reverie', { label: 'title', max: 80 }),
        boundedString(input.body ?? '', { label: 'body', max: 500 }),
      ),
    };
  });
  handle('notification:status', () => ({
    supported: Notification.isSupported(),
    platform: process.platform,
    permission: process.platform === 'win32' ? 'managed_by_windows' : 'runtime',
    appUserModelId: process.platform === 'win32' ? APP_USER_MODEL_ID : '',
    installedIdentity: app.isPackaged,
  }));
  handle('system:openLocationSettings', async () => {
    if (process.platform !== 'win32') {
      const error = new Error('Windows location settings are unavailable on this platform');
      error.code = 'REVERIE_PLATFORM_UNSUPPORTED';
      throw error;
    }
    await shell.openExternal('ms-settings:privacy-location', { activate: true });
    return { opened: true };
  });
  handle('shell:openExternal', async (_event, input) => {
    const value = boundedString(input, { label: 'URL', min: 1, max: 2048 });
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Only credential-free HTTP(S) links may be opened externally');
    }
    networkGate.assertAllowed(url, 'External link');
    await shell.openExternal(url.href, { activate: true });
    return { opened: true };
  });

  handle('avatar:list', () => avatarManager
    ? avatarManager.list()
    : {
        records: [],
        activeId: null,
        runtime: {
          live2d: {
            available: false,
            licenseAccepted: false,
            reason: 'Avatar module is unavailable',
          },
        },
      });
  handle('avatar:beginImport', async () => {
    if (!avatarManager) {
      const error = new Error('Avatar module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    if (avatarDialogPending) throw new Error('An avatar import is already in progress');
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入本地头像',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          { name: 'Reverie avatar', extensions: ['vrm', 'glb', 'zip'] },
        ],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      const candidate = await runAvatarImportWorker(result.filePaths[0]);
      broadcast('avatar:changed', avatarManager.list());
      return candidate;
    } finally {
      avatarDialogPending = false;
    }
  });
  handle('avatar:beginImportFolder', async () => {
    if (!avatarManager) {
      const error = new Error('Avatar module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    if (avatarDialogPending) throw new Error('An avatar import is already in progress');
    if (!avatarManager.live2dRuntime.available) {
      const error = new Error(avatarManager.live2dRuntime.reason || 'Live2D import is unavailable');
      error.code = 'AVATAR_LIVE2D_DISABLED';
      throw error;
    }
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import a Live2D folder',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      return await runAvatarImportWorker(result.filePaths[0], { sourceIsDirectory: true });
    } finally {
      avatarDialogPending = false;
    }
  });
  handle('avatar:confirmPreview', (_event, input) => {
    if (!avatarManager) throw new Error('Avatar module is unavailable');
    assertPlainObject(input, 'avatar preview confirmation');
    const report = input.report ?? {};
    assertPlainObject(report, 'avatar renderer report');
    if (report.detected != null) assertPlainObject(report.detected, 'avatar detected capabilities');
    if (report.capabilities != null) assertPlainObject(report.capabilities, 'avatar renderer capabilities');
    return avatarManager.markPreviewReady(
      boundedString(input.importId, { label: 'importId', min: 32, max: 32 }),
      report,
    );
  });
  handle('avatar:discardImport', (_event, input) => {
    if (!avatarManager) return { discarded: false };
    assertPlainObject(input, 'avatar import discard');
    return avatarManager.discardImport(
      boundedString(input.importId, { label: 'importId', min: 32, max: 32 }),
    );
  });
  handle('avatar:previewFailed', (_event, input) => {
    if (!avatarManager) return { discarded: false };
    assertPlainObject(input, 'avatar preview failure');
    return avatarManager.discardImport(
      boundedString(input.importId, { label: 'importId', min: 32, max: 32 }),
    );
  });
  handle('avatar:commitImport', (_event, input) => {
    if (!avatarManager) {
      const error = new Error('Avatar module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    assertPlainObject(input, 'avatar commit');
    const record = avatarManager.commitImport({
      importId: boundedString(input.importId, { label: 'importId', min: 32, max: 32 }),
      rightsConfirmed: input.rightsConfirmed === true,
      warningAccepted: input.warningAccepted === true,
    });
    broadcast('avatar:changed', avatarManager.list());
    return record;
  });
  handle('avatar:setActive', (_event, input) => {
    if (!avatarManager) {
      const error = new Error('Avatar module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    assertPlainObject(input, 'avatar activation');
    const result = avatarManager.setActive(
      input.id == null ? null : boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
    );
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });
  handle('avatar:remove', (_event, input) => {
    if (!avatarManager) {
      const error = new Error('Avatar module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    assertPlainObject(input, 'avatar removal');
    const result = avatarManager.remove(
      boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
    );
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });
  handle('avatar:addMotion', async (_event, input) => {
    if (!avatarManager) throw new Error('Avatar module is unavailable');
    assertPlainObject(input, 'avatar motion import');
    const avatarId = boundedString(input.id, { label: 'avatar id', min: 36, max: 36 });
    if (avatarDialogPending) throw new Error('An avatar import is already in progress');
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Attach a VRM animation',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'VRM animation', extensions: ['vrma'] }],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      const motion = await runAvatarMotionWorker(avatarId, result.filePaths[0]);
      broadcast('avatar:changed', avatarManager.list());
      return motion;
    } finally {
      avatarDialogPending = false;
    }
  });
  handle('avatar:removeMotion', (_event, input) => {
    if (!avatarManager) throw new Error('Avatar module is unavailable');
    if (avatarDialogPending) throw new Error('Wait for the current avatar import to finish');
    assertPlainObject(input, 'avatar motion removal');
    const result = avatarManager.removeMotion(
      boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
      boundedString(input.motionId, { label: 'motion id', min: 36, max: 36 }),
    );
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });
  handle('avatar:setMapping', (_event, input) => {
    if (!avatarManager) throw new Error('Avatar module is unavailable');
    if (avatarDialogPending) throw new Error('Wait for the current avatar import to finish');
    assertPlainObject(input, 'avatar mapping');
    const result = avatarManager.setMapping(
      boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
      boundedString(input.category, { label: 'mapping category', min: 6, max: 10 }),
      boundedString(input.key, { label: 'mapping key', min: 1, max: 64 }),
      input.target == null
        ? null
        : boundedString(input.target, { label: 'mapping target', min: 1, max: 128 }),
    );
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });

  handle('focusSound:list', () => focusSoundManager
    ? { available: true, ...focusSoundManager.list() }
    : { available: false, records: [] });
  handle('focusSound:import', async () => {
    if (!focusSoundManager) {
      const error = new Error('Focus sound module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    if (focusSoundDialogPending) throw new Error('A focus sound import is already in progress');
    focusSoundDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import a focus sound',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'Audio', extensions: ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'] }],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      const record = focusSoundManager.import(result.filePaths[0]);
      broadcast('focusSound:changed', { available: true, ...focusSoundManager.list() });
      return record;
    } finally {
      focusSoundDialogPending = false;
    }
  });
  handle('focusSound:open', (_event, input) => {
    if (!focusSoundManager) throw new Error('Focus sound module is unavailable');
    assertPlainObject(input, 'focus sound open');
    return focusSoundManager.get(
      boundedString(input.id, { label: 'focus sound id', min: 36, max: 36 }),
    );
  });
  handle('focusSound:remove', (_event, input) => {
    if (!focusSoundManager) throw new Error('Focus sound module is unavailable');
    if (focusSoundDialogPending) throw new Error('Wait for the current focus sound import to finish');
    assertPlainObject(input, 'focus sound removal');
    const result = focusSoundManager.remove(
      boundedString(input.id, { label: 'focus sound id', min: 36, max: 36 }),
    );
    broadcast('focusSound:changed', { available: true, ...focusSoundManager.list() });
    return result;
  });

  handle('focus:getState', () => focusManager
    ? focusManager.getState()
    : {
        phase: 'idle',
        id: null,
        durationSeconds: 0,
        remainingSeconds: 0,
        startedAtUtc: null,
        endsAtUtc: null,
        pausedAtUtc: null,
        available: false,
      });
  handle('focus:start', (_event, input) => {
    if (!focusManager) {
      const error = new Error('Focus module is unavailable');
      error.code = 'REVERIE_MODULE_UNAVAILABLE';
      throw error;
    }
    assertPlainObject(input, 'focus start');
    if (!Number.isInteger(input.durationSeconds)) throw new TypeError('durationSeconds must be an integer');
    return focusManager.start({ durationSeconds: input.durationSeconds });
  });
  handle('focus:pause', (_event, input) => {
    assertPlainObject(input, 'focus pause');
    validateSessionId(input.id);
    return focusManager.pause();
  });
  handle('focus:resume', (_event, input) => {
    assertPlainObject(input, 'focus resume');
    validateSessionId(input.id);
    return focusManager.resume();
  });
  handle('focus:stop', (_event, input) => {
    assertPlainObject(input, 'focus stop');
    validateSessionId(input.id);
    return focusManager.stop();
  });
  handle('focus:ackAudioRearm', (_event, input) => {
    assertPlainObject(input, 'audio rearm acknowledgement');
    validateSessionId(input.id);
    return focusManager.acknowledgeAudioRearm();
  });
}

function createTray() {
  if (tray) return;
  tray = new Tray(getWindowIconPath());
  tray.setToolTip('Reverie');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Reverie', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
}

function installWindowDiagnostics(windowRef) {
  windowRef.once('ready-to-show', () => windowRef.show());
  windowRef.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error('[Electron] Renderer load failed', { code, description, url });
    dialog.showErrorBox('Reverie 启动失败', '界面资源无法加载。请查看本地 electron.log。');
  });
  windowRef.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] Renderer process ended unexpectedly', details);
  });
  windowRef.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Electron] Preload failed', path.basename(preloadPath), error);
  });
  windowRef.on('unresponsive', () => console.error('[Electron] Window became unresponsive'));
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Reverie',
    icon: getWindowIconPath(),
    show: false,
    frame: true,
    backgroundColor: '#141727',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });
  installWindowDiagnostics(mainWindow);
  // Install the permission boundary before navigation starts. Otherwise a very
  // fast renderer can request geolocation in the small gap before the global
  // handler is registered and receive a false denial.
  installPermissionPolicy(mainWindow.webContents.session, trustPolicy, () => mainWindow);
  mainWindow.webContents.session.on('will-download', (event) => event.preventDefault());
  if (IS_DEV) {
    mainWindow.loadURL(FRONTEND_DEV_URL).catch((error) => {
      console.error('[Electron] Failed to load development renderer', error);
    });
    if (process.env.REVERIE_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadURL(packagedRendererUrl).catch((error) => {
      console.error('[Electron] Failed to load packaged renderer', error);
    });
  }
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    sendLifecycle('hidden');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('minimize', () => sendLifecycle('inactive'));
  mainWindow.on('restore', () => sendLifecycle('active'));
  mainWindow.on('blur', () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => sendLifecycle('inactive'), 30_000);
    inactivityTimer.unref?.();
  });
  mainWindow.on('focus', () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
    sendLifecycle('active');
  });
  return mainWindow;
}

function installPowerEvents() {
  const reconcileFocusAfterWake = () => {
    if (!focusManager?.reconcileAfterResume) return;
    void focusManager.reconcileAfterResume().catch((error) => {
      console.error('[Electron] Focus wake reconciliation failed', error);
    });
  };
  powerMonitor.on('suspend', () => {
    focusManager?.requireAudioRearm();
    sendLifecycle('suspend');
  });
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
    focusManager?.requireAudioRearm();
    sendLifecycle('lock-screen');
  });
  powerMonitor.on('resume', () => {
    reconcileFocusAfterWake();
    const active = mainWindow?.isVisible() && mainWindow?.isFocused();
    sendLifecycle(active ? 'active' : 'hidden');
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    reconcileFocusAfterWake();
    const active = mainWindow?.isVisible() && mainWindow?.isFocused();
    sendLifecycle(active ? 'active' : 'hidden');
  });
}

const hasSingleInstanceLock = acquireSingleInstance(app, showMainWindow);
if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    setupLogging();
    createRuntimeModules();
    if (!IS_DEV) {
      unregisterAppProtocol = installAppProtocol(protocol, path.dirname(packagedIndex));
    }
    if (avatarManager && installAvatarProtocol) {
      unregisterAvatarProtocol = installAvatarProtocol(protocol, avatarManager, {
        allowedOrigins: [IS_DEV ? new URL(FRONTEND_DEV_URL).origin : 'reverie-app://app'],
      });
    }
    if (focusSoundManager && installFocusSoundProtocol) {
      unregisterFocusSoundProtocol = installFocusSoundProtocol(protocol, focusSoundManager, {
        allowedOrigins: [IS_DEV ? new URL(FRONTEND_DEV_URL).origin : 'reverie-app://app'],
      });
    }
    registerIpcHandlers();
    createWindow();
    createTray();
    installPowerEvents();
    startBridge();
    pollNotificationOutbox();
    notificationPollTimer = setInterval(pollNotificationOutbox, 5000);
    notificationPollTimer.unref?.();

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else showMainWindow();
    });
  }).catch((error) => {
    console.error('[Electron] Fatal startup failure', error);
    dialog.showErrorBox('Reverie 启动失败', '安全初始化未完成，应用将退出。');
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  // Windows/Linux keep the local companion in the tray.
  if (process.platform === 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  isQuitting = true;
  clearTimeout(inactivityTimer);
  clearTimeout(backendRestartTimer);
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
  void (async () => {
    ipcRegistrar?.dispose();
    ipcRegistrar = null;
    focusManager?.dispose();
    try {
      await bridge?.stopAndWait('SIGTERM', 5000);
    } catch (error) {
      console.error('[Electron] Bridge did not stop cleanly during shutdown', error);
    }
    // Host-side networking remains fail-closed until the child is confirmed
    // stopped (or the operating system tears down this process).
    networkGate?.dispose();
    unregisterAvatarProtocol?.();
    unregisterAvatarProtocol = null;
    unregisterFocusSoundProtocol?.();
    unregisterFocusSoundProtocol = null;
    unregisterAppProtocol?.();
    unregisterAppProtocol = null;
    tray?.destroy();
    tray = null;
    restoreConsole?.();
    restoreConsole = null;
    app.exit(0);
  })();
});
