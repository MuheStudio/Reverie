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
const { BridgeHostProxy } = require('./bridge-host-proxy.cjs');
const { FramedBridgeSupervisor } = require('./framed-bridge-supervisor.cjs');
const { CredentialVault } = require('./credential-vault.cjs');
const { StorageKeyVault } = require('./storage-key-vault.cjs');
const { registerDesktopSchemes } = require('./desktop-schemes.cjs');
const { reconcileFocusNetworkGate } = require('./focus-gate-recovery.cjs');
const { enterLocalModeWithDegradedBridge } = require('./focus-local-mode-transition.cjs');
const { LocalNetworkGate } = require('./local-network-gate.cjs');
const { parseNotificationTimestamp } = require('./notification-outbox.cjs');
const {
  ProviderConfigStore,
  normalizeProviderConfig,
  providerBinding,
} = require('./provider-config-store.cjs');
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
const FocusManager = null;
const FocusSoundManager = null;
const installFocusSoundProtocol = null;
const evaluateLive2DRuntime = optionalExport('./live2d-release-gate.cjs', 'evaluateLive2DRuntime');
const readRuntimeAssetsManifest = optionalExport(
  './live2d-runtime-assets.cjs',
  'readRuntimeAssetsManifest',
);
const stageNativeBackupSource = null;
const WindowsLocationProvider = null;
const installStickerAssetProtocol = null;
const installLive2DCoreProtocol = optionalExport(
  './live2d-core-protocol.cjs',
  'installLive2DCoreProtocol',
);

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
let petWindow = null;
let tray = null;
let logger = null;
let restoreConsole = null;
let networkGate = null;
let bridge = null;
let bridgeHostProxy = null;
let credentialVault = null;
let storageKeyVault = null;
let providerConfigStore = null;
let avatarManager = null;
let focusManager = null;
let focusSoundManager = null;
let windowsLocationProvider = null;
let unregisterAvatarProtocol = null;
let unregisterFocusSoundProtocol = null;
let unregisterAppProtocol = null;
let unregisterStickerAssetProtocol = null;
let unregisterLive2DCoreProtocol = null;
let stickerAssetsRoot = null;
let live2dCorePath = null;
let live2dRuntimeAvailable = false;
let live2dRuntimeAssets = null;
let ipcRegistrar = null;
let notificationPollTimer = null;
let inactivityTimer = null;
let backendRestartTimer = null;
let backendRestartAttempts = 0;
let isQuitting = false;
let screenLocked = false;
let avatarDialogPending = false;
let focusSoundDialogPending = false;
let stickerDialogPending = false;
let backupDialogPending = false;
let jsonSaveDialogPending = false;
let localModeTransitionPending = false;
let focusGateRecovery = { available: true, reason: '', gateState: null };
let shutdownStarted = false;
const providerTestReceipts = new Map();
const PROVIDER_TEST_RECEIPT_TTL_MS = 5 * 60 * 1000;

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

function getLive2DCorePath() {
  if (!IS_DEV) return path.join(process.resourcesPath, 'Live2DCubismCore.js');
  if (process.env.REVERIE_LIVE2D_CORE_PATH) {
    return path.resolve(process.env.REVERIE_LIVE2D_CORE_PATH);
  }
  // Dev-only convenience: run `pnpm prepare:live2d-dev` to stage the Cubism
  // Core into the gitignored .runtime-cache (see script/prepare-live2d-dev.cjs).
  return path.join(__dirname, '..', '.runtime-cache', 'Live2DCubismCore.js');
}

function probeLive2DRuntime() {
  const corePath = getLive2DCorePath();
  if (!IS_DEV) {
    try {
      live2dRuntimeAssets = readRuntimeAssetsManifest
        ? readRuntimeAssetsManifest(process.resourcesPath)
        : null;
      return {
        coreAvailable: Boolean(live2dRuntimeAssets),
        rendererAvailable: live2dRuntimeAssets?.renderer?.embedded === true,
      };
    } catch (error) {
      live2dRuntimeAssets = null;
      console.error('[Electron] Packaged Live2D assets failed verification', error);
      return { coreAvailable: false, rendererAvailable: false };
    }
  }
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
  if (!IS_DEV) {
    const bundled = path.join(
      getRuntimeRoot(),
      'python',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    if (isRegularUnlinkedFile(bundled)) return bundled;
    throw new Error('Verified bundled Python runtime is missing');
  }
  const developmentRuntime = path.join(
    getRuntimeRoot(),
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  if (isRegularUnlinkedFile(developmentRuntime)) return developmentRuntime;
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

function applyBundledYumiMapping(record) {
  if (!avatarManager || !record || record.kind !== 'live2d') return record;
  const available = new Set(record.detected?.expressions || []);
  const mappings = {
    joy: '爱心眼',
    touched: '爱心眼',
    excitement: '爱心眼',
    sad: '泪汪汪',
    sadness: '泪汪汪',
    angry: '黑脸',
    anger: '黑脸',
    surprised: '星星眼',
  };
  for (const [emotion, expression] of Object.entries(mappings)) {
    if (available.has(expression)) {
      avatarManager.setMapping(record.id, 'expression', emotion, `expression:${expression}`);
    }
  }
  const clips = new Set(record.detected?.animationClips || []);
  const actionMappings = {
    wave: 'wave',
    tear: 'tear',
  };
  for (const [action, clip] of Object.entries(actionMappings)) {
    if (clips.has(clip)) {
      avatarManager.setMapping(record.id, 'action', action, `clip:${clip}`);
    }
  }
  const snapshot = avatarManager.list();
  return snapshot.records.find((item) => item.id === record.id) || record;
}

function getWindowIconPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'public', 'icon.ico')
    : path.join(process.resourcesPath, 'icon.ico');
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
      persistentAvailable: false,
      corrupted: false,
      llm: { hasApiKey: false, hasCustomHeaders: false },
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
    || status?.llm?.hasCustomHeaders,
  );
}

function rendererProviderName(value) {
  return {
    glm: 'z.ai',
  }[String(value || '').toLowerCase()] || String(value || '').toLowerCase();
}

function publicProviderFromRuntime(llm) {
  return {
    provider: rendererProviderName(llm.provider),
    baseUrl: String(llm.baseUrl || ''),
    model: String(llm.model || ''),
  };
}

async function authoritativeProviderConfig() {
  if (!bridge?.ready) {
    const error = new Error('The Python settings authority is not ready');
    error.code = 'REVERIE_BRIDGE_NOT_READY';
    throw error;
  }
  const llm = publicProviderFromRuntime(await bridge.getProviderConfig());
  return { llm };
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
      runtimeAppliedScopes: { llm: false },
    });
  }
  const providers = await authoritativeProviderConfig();
  const bindings = {
    llm: providerBinding('llm', providers),
  };
  const runtimeCredentials = credentialVault.readForRuntime({ bindings });
  for (const scope of options.clearScopes || []) runtimeCredentials[scope] = null;
  const result = await bridge.setCredentials(runtimeCredentials);
  const bindingMismatch = {
    llm: Boolean(
      (status.llm.hasApiKey || status.llm.hasCustomHeaders)
      && !runtimeCredentials.llm,
    ),
  };
  const applied = {
    llm: result.applied.llm === true && !bindingMismatch.llm,
  };
  return broadcastCredentialStatus({
    stored: hasStoredCredentials(status),
    runtimeApplied: Object.values(applied).every((value) => value === true),
    runtimePending: false,
    runtimeAppliedScopes: applied,
    bindingMismatch,
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
  const storageKey = storageKeyVault.getOrCreateKey();
  const args = [
    path.join(getRuntimeRoot(), 'src', 'main.py'),
    '--stdio-bridge',
  ];
  logger?.addSecret(context.secret);
  let child;
  try {
    child = spawn(command, args, {
      cwd: getRuntimeRoot(),
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        REVERIE_BRIDGE_MODE: '1',
        REVERIE_BRIDGE_PROTOCOL_VERSION: '4',
        REVERIE_BRIDGE_SECRET: context.secret,
        REVERIE_PARENT_PID: String(process.pid),
        REVERIE_DATA_DIR: dataDir,
        REVERIE_LOCAL_MODE: context.localMode.active ? '1' : '0',
        REVERIE_LOCAL_MODE_EPOCH: String(context.localMode.epoch || 0),
        REVERIE_LOCAL_MODE_SESSION_ID: String(context.localMode.sessionId || ''),
        REVERIE_REQUIRE_ENCRYPTED_STORAGE: '1',
        // This descriptor number is not secret. The key itself only traverses
        // the inherited anonymous pipe below and is zeroed after the write.
        REVERIE_STORAGE_KEY_FD: '3',
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const bootstrap = child.stdio[3];
    if (!bootstrap) throw new Error('Database key bootstrap pipe was not created');
    let cleared = false;
    const clearKey = () => {
      if (cleared) return;
      cleared = true;
      storageKey.fill(0);
    };
    bootstrap.once('error', (error) => {
      clearKey();
      try { child.kill('SIGKILL'); } catch {}
      console.error('[Electron] Database key bootstrap failed', error);
    });
    child.once('error', clearKey);
    bootstrap.end(storageKey, clearKey);
    return child;
  } catch (error) {
    storageKey.fill(0);
    try { child?.kill('SIGKILL'); } catch {}
    throw error;
  }
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
    await bridgeHostProxy.connect();
    try {
      await syncCredentialVault();
    } catch (error) {
      console.error('[Electron] Credential runtime synchronization failed', error);
      broadcastCredentialStatus({ runtimeApplied: false });
    }
    broadcast('bridge:changed', { ready: true, generation: bridge.generation });
  }).catch(async (error) => {
    try {
      await bridge.stopAndWait('SIGKILL');
    } catch {}
    scheduleBridgeRestart(error);
  });
}

async function killBridgeFailClosed() {
  bridgeHostProxy?.disconnect();
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
  stickerAssetsRoot = path.join(prepareWritableDataDir(), 'stickers', 'assets');
  networkGate = new LocalNetworkGate({ storageDir: path.join(runtimeDir, 'network') });
  networkGate.install(session.defaultSession);
  networkGate.installNodeGuards();
  credentialVault = new CredentialVault({
    storageDir: path.join(runtimeDir, 'credentials'),
    safeStorage,
  });
  storageKeyVault = new StorageKeyVault({
    storageDir: path.join(runtimeDir, 'storage-key'),
    safeStorage,
  });
  // Fail before opening a renderer if DPAPI is unavailable or the existing
  // protected key cannot be decrypted for this Windows user.
  const storageProbe = storageKeyVault.getOrCreateKey();
  storageProbe.fill(0);
  providerConfigStore = new ProviderConfigStore({
    storageDir: path.join(runtimeDir, 'provider-config'),
  });
  if (WindowsLocationProvider) {
    try {
      windowsLocationProvider = new WindowsLocationProvider();
    } catch (error) {
      windowsLocationProvider = null;
      console.error('[Electron] Windows location module initialization failed', error);
    }
  }

  bridge = new FramedBridgeSupervisor({ spawnChild: spawnBridgeChild });
  bridgeHostProxy = new BridgeHostProxy({ supervisor: bridge, broadcast });
  bridgeHostProxy.on('disconnect', (error) => {
    if (isQuitting) return;
    console.error('[Electron] Host-owned bridge transport disconnected', error);
    void bridge.stopAndWait('SIGKILL').catch((stopError) => {
      console.error('[Electron] Failed to stop disconnected bridge', stopError);
    });
  });
  bridge.on('log', ({ stream, line }) => {
    if (stream === 'stderr') console.warn('[Python]', line);
    else console.log('[Python]', line);
  });
  bridge.on('exit', (error) => {
    bridgeHostProxy?.disconnect();
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
            testOnly: !IS_DEV
              && live2dRuntimeAssets?.mode === 'internal-test'
              && fs.existsSync(path.join(path.dirname(process.resourcesPath), 'TEST-BUILD-DO-NOT-RELEASE.json')),
            licensePath,
            developmentEnabled: IS_DEV && isRegularUnlinkedFile(getLive2DCorePath())
              ? '1'
              : process.env.REVERIE_LIVE2D_DEV,
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
      live2dCorePath = getLive2DCorePath();
      live2dRuntimeAvailable = live2dRuntime.available === true;
      avatarManager = new AvatarManager({
        storageDir: path.join(app.getPath('userData'), 'bundled-character'),
        live2dRuntime,
      });
      if (live2dRuntime.available) {
        const yumiSource = IS_DEV
          ? path.resolve(
              process.env.REVERIE_YUMI_SOURCE
                || path.join(getRuntimeRoot(), '..', '..', '皮套-yumi'),
            )
          : path.join(process.resourcesPath, 'character');
        if (fs.existsSync(yumiSource) && avatarManager.list().records.length === 0) {
          const installed = avatarManager.installTrustedDefaultDirectory(yumiSource, {
            name: 'Yumi',
            trustedOwnerAsset: true,
          });
          applyBundledYumiMapping(installed);
        } else if (avatarManager.list().records.length > 0) {
          const current = avatarManager.list();
          const active = current.records.find((record) => record.id === current.activeId)
            || current.records[0];
          applyBundledYumiMapping(active);
        }
      }
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

async function configureAuthoritativeProvider(input) {
  const normalized = normalizeProviderConfig(input);
  if (!bridge?.ready) {
    if (!bridge?.child) startBridge();
    const error = new Error('The Python settings authority is starting; retry after it connects');
    error.code = 'REVERIE_BRIDGE_NOT_READY';
    throw error;
  }
  const configured = await bridge.configureProvider({
    provider: normalized.llm.provider,
    model: normalized.llm.model,
    base_url: normalized.llm.baseUrl,
    ...(normalized.llm.customProviderName
      ? { custom_provider_name: normalized.llm.customProviderName }
      : {}),
  });
  const llm = publicProviderFromRuntime(configured);
  const committed = {
    llm: {
      ...llm,
      ...(normalized.llm.customProviderName
        ? { customProviderName: normalized.llm.customProviderName }
        : {}),
    },
  };
  try {
    // Recovery/migration cache only. Reads shown to the renderer always come
    // from Python's provider:get control.
    providerConfigStore.set(committed);
  } catch (error) {
    console.error('[Electron] Provider recovery cache write failed', error);
  }
  return committed;
}

function effectiveProviderCredential(normalized, submitted) {
  const binding = providerBinding('llm', normalized);
  let stored = {};
  try {
    stored = credentialVault.readForRuntime({
      bindings: { llm: binding },
    }).llm || {};
  } catch (error) {
    const code = String(error?.code || '');
    if (!code.startsWith('REVERIE_')) throw error;
  }
  return {
    ...stored,
    ...(submitted || {}),
  };
}

function providerTestDigest(normalized, credential) {
  return crypto.createHash('sha256').update(JSON.stringify({
    llm: normalized.llm,
    credential: {
      apiKey: String(credential.apiKey || ''),
      customHeaders: String(credential.customHeaders || ''),
    },
  }), 'utf8').digest('hex');
}

function pruneProviderTestReceipts(now = Date.now()) {
  for (const [receipt, record] of providerTestReceipts) {
    if (record.expiresAt <= now) providerTestReceipts.delete(receipt);
  }
  while (providerTestReceipts.size > 64) {
    providerTestReceipts.delete(providerTestReceipts.keys().next().value);
  }
}

async function testProviderConfiguration(input = {}) {
  assertPlainObject(input, 'provider configuration test');
  const normalized = normalizeProviderConfig(input.config);
  const submitted = input.credential == null ? {} : input.credential;
  assertPlainObject(submitted, 'provider credential');
  const credential = effectiveProviderCredential(normalized, submitted);
  if (!bridge?.ready) {
    if (!bridge?.child) startBridge();
    return {
      ok: false,
      code: 'REVERIE_BRIDGE_NOT_READY',
      message: '聊天后端正在启动，请稍后再测试。',
      retryable: true,
    };
  }
  try {
    const result = await bridge.testProvider({
      provider: normalized.llm.provider,
      model: normalized.llm.model,
      base_url: normalized.llm.baseUrl,
    }, credential);
    const now = Date.now();
    pruneProviderTestReceipts(now);
    const receipt = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + PROVIDER_TEST_RECEIPT_TTL_MS;
    providerTestReceipts.set(receipt, {
      digest: providerTestDigest(normalized, credential),
      expiresAt,
    });
    return {
      ok: true,
      receipt,
      latencyMs: result.latencyMs,
      finishReason: typeof result.finishReason === 'string'
        ? result.finishReason
        : typeof result.finish_reason === 'string' ? result.finish_reason : 'stop',
    };
  } catch (error) {
    const code = String(error?.code || 'PROVIDER_FAILURE');
    const messages = {
      PROVIDER_UNAUTHORIZED: 'API 密钥或账户权限未通过验证。',
      PROVIDER_AUTH_FAILED: 'API 密钥或账户权限未通过验证。',
      PROVIDER_RATE_LIMITED: '供应商正在限流，请稍后手动重试测试。',
      PROVIDER_TIMEOUT: '测试请求超时；结果未知，不会自动重试。',
      PROVIDER_UNREACHABLE: '无法连接到供应商，请检查网络、DNS、TLS 和请求地址。',
      PROVIDER_CONNECTION_FAILED: '无法连接到供应商，请检查网络和请求地址。',
      PROVIDER_INVALID_RESPONSE: '供应商返回了无法解析的响应。',
      PROVIDER_INVALID_RESPONSE_SCHEMA: '供应商响应不符合 Chat Completions 协议。',
      PROVIDER_EMPTY_RESPONSE: '供应商返回了空响应。',
      PROVIDER_REASONING_ONLY_RESPONSE: '供应商只返回了思考过程，没有可显示的最终回答。',
      PROVIDER_OUTPUT_TRUNCATED: '供应商输出达到长度上限，请检查模型兼容性。',
      PROVIDER_CONTENT_FILTERED: '供应商过滤了本次测试输出。',
      PROVIDER_TOOL_ONLY_RESPONSE: '供应商只返回了工具调用，当前聊天界面无法显示。',
      REVERIE_LOCAL_MODE: '本地模式已启用，远程 API 测试被底层门禁阻止。',
    };
    return {
      ok: false,
      code,
      message: messages[code] || 'API 测试失败；配置和密钥均未保存。',
    };
  }
}

async function commitProviderConfiguration(input = {}) {
  assertPlainObject(input, 'provider configuration commit');
  const normalized = normalizeProviderConfig(input.config);
  const credential = input.credential;
  const mode = input.mode === 'session' ? 'session' : 'persistent';
  const submitted = credential == null ? {} : credential;
  assertPlainObject(submitted, 'provider credential');
  const effectiveCredential = effectiveProviderCredential(normalized, submitted);
  pruneProviderTestReceipts();
  const receipt = boundedString(input.testReceipt, {
    label: 'provider test receipt',
    min: 32,
    max: 128,
  });
  const tested = providerTestReceipts.get(receipt);
  const digest = providerTestDigest(normalized, effectiveCredential);
  if (!tested || tested.expiresAt <= Date.now()
    || tested.digest.length !== digest.length
    || !crypto.timingSafeEqual(Buffer.from(tested.digest), Buffer.from(digest))) {
    return {
      config: normalized,
      status: {
        ...publicCredentialStatus(),
        writeError: {
          code: 'REVERIE_PROVIDER_TEST_REQUIRED',
          message: '供应商、模型、请求地址或密钥已变化，请重新测试后再保存。',
        },
      },
    };
  }

  let snapshot;
  try {
    snapshot = credentialVault.snapshotScope('llm');
  } catch (error) {
    const code = String(error?.code || 'REVERIE_VAULT_IO');
    return {
      config: normalized,
      status: {
        ...publicCredentialStatus(),
        writeError: {
          code,
          message: '无法读取原有安全凭据，未提交任何设置。',
        },
      },
    };
  }
  if (credential != null) {
    const hasCredential = Boolean(credential.apiKey || credential.customHeaders);
    if (hasCredential) {
      const binding = providerBinding('llm', normalized);
      try {
        if (mode === 'session') {
          credentialVault.setSession('llm', credential, { binding });
        } else {
          credentialVault.set('llm', credential, { binding });
        }
      } catch (error) {
        const code = String(error?.code || '');
        if (!code.startsWith('REVERIE_')) throw error;
        console.error('[Electron] Endpoint-bound credential write failed', code);
        return {
          config: normalized,
          status: {
            ...publicCredentialStatus(),
            writeError: {
              code,
              message: 'Windows 安全存储未完成写入；配置和原有密钥均未更改。',
            },
          },
        };
      }
    }
  }
  let committed;
  try {
    committed = await configureAuthoritativeProvider(normalized);
  } catch (error) {
    try {
      credentialVault.restoreScope('llm', snapshot);
    } catch (rollbackError) {
      console.error('[Electron] Provider credential rollback failed', rollbackError);
    }
    throw error;
  }
  let status;
  try {
    status = await syncCredentialVault();
  } catch (error) {
    console.error('[Electron] Provider commit runtime synchronization failed', error);
    status = broadcastCredentialStatus({
      stored: hasStoredCredentials(publicCredentialStatus()),
      runtimeApplied: false,
      runtimePending: true,
      runtimeAppliedScopes: { llm: false },
    });
  }
  providerTestReceipts.delete(receipt);
  return {
    config: committed,
    status: {
      ...status,
      ...(mode === 'session'
        ? { sessionWarning: '凭据仅保存在本次运行的内存中，退出 Reverie 后会消失。' }
        : {}),
    },
  };
}

function registerLegacyIpcHandlers() {
  if (ipcRegistrar) return;
  ipcRegistrar = createSecureIpcRegistrar(ipcMain, trustedWindows, trustPolicy);
  const { handle } = ipcRegistrar;

  handle('bridge:getConnectionConfig', () => bridgeHostProxy.getRendererConfig());
  handle('bridge:send', (_event, frame) => bridgeHostProxy.sendFromRenderer(frame));
  handle('app:getVersion', () => app.getVersion());
  handle('localMode:get', () => publicLocalModeState());
  handle('localMode:set', async (_event, input = {}) => {
    assertPlainObject(input, 'local mode');
    if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return setManualLocalMode(input.enabled);
  });
  handle('credentials:status', () => publicCredentialStatus());
  handle('companionPreferences:get', () => companionPreferencesStore.get());
  handle('companionPreferences:set', (_event, input = {}) => {
    assertPlainObject(input, 'companion preferences');
    return companionPreferencesStore.set(input);
  });
  handle('credentials:set', async (_event, input = {}) => {
    assertPlainObject(input, 'credentials');
    const scope = boundedString(input.scope, {
      label: 'credential scope',
      min: 1,
      max: 16,
    });
    if (scope === 'llm') {
      const error = new Error('LLM credentials must be tested and committed with their provider settings');
      error.code = 'REVERIE_PROVIDER_TEST_REQUIRED';
      throw error;
    }
    assertPlainObject(input.value, 'credential value');
    try {
      const cached = providerConfigStore.get();
      credentialVault.set(scope, input.value, {
        binding: providerBinding(scope, cached),
      });
    } catch (error) {
      const code = String(error?.code || '');
      if (!code.startsWith('REVERIE_')) throw error;
      console.error('[Electron] Persistent credential write failed', code);
      return broadcastCredentialStatus({
        stored: hasStoredCredentials(publicCredentialStatus()),
        runtimeApplied: false,
        runtimePending: false,
        writeError: {
          code,
          message: 'Windows 安全存储未完成写入；原有密钥未被覆盖。',
        },
      });
    }
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
  handle('credentials:setSession', async (_event, input = {}) => {
    assertPlainObject(input, 'session credentials');
    const scope = boundedString(input.scope, {
      label: 'credential scope',
      min: 1,
      max: 16,
    });
    if (scope === 'llm') {
      const error = new Error('LLM credentials must be tested and committed with their provider settings');
      error.code = 'REVERIE_PROVIDER_TEST_REQUIRED';
      throw error;
    }
    assertPlainObject(input.value, 'credential value');
    const cached = providerConfigStore.get();
    credentialVault.setSession(scope, input.value, {
      binding: providerBinding(scope, cached),
    });
    try {
      const status = await syncCredentialVault();
      return {
        ...status,
        sessionWarning: '凭据仅保存在本次运行的内存中，退出 Reverie 后会消失。',
      };
    } catch (error) {
      console.error('[Electron] Session credential runtime synchronization failed', error);
      if (!bridge?.child) startBridge();
      return broadcastCredentialStatus({
        stored: hasStoredCredentials(publicCredentialStatus()),
        runtimeApplied: false,
        runtimePending: true,
        sessionWarning: '凭据仅保存在本次运行的内存中，退出 Reverie 后会消失。',
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
  handle('providerConfig:get', () => authoritativeProviderConfig());
  handle('providerConfig:test', (_event, input) => testProviderConfiguration(input));
  handle('providerConfig:set', async (_event, input) => {
    const current = await authoritativeProviderConfig();
    const candidate = normalizeProviderConfig(input);
    if (!sameLlmConnection(current, candidate)) {
      const error = new Error('LLM provider, model, or endpoint changes require a successful API test');
      error.code = 'REVERIE_PROVIDER_TEST_REQUIRED';
      throw error;
    }
    const config = {
      llm: current.llm,
      ...(candidate.imageGen ? { imageGen: candidate.imageGen } : {}),
    };
    providerConfigStore.set(config);
    await syncCredentialVault();
    return config;
  });
  handle('providerConfig:commit', (_event, input) => commitProviderConfiguration(input));
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
  handle('location:getCurrent', async () => {
    if (!windowsLocationProvider) {
      return {
        ok: false,
        code: 'REVERIE_LOCATION_DEVICE_UNAVAILABLE',
        status: 'ModuleUnavailable',
        source: 'windows-winrt',
      };
    }
    return windowsLocationProvider.requestCurrent();
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

  handle('sticker:importFile', async (_event, input = {}) => {
    assertPlainObject(input, 'sticker import');
    if (stickerDialogPending) {
      const error = new Error('A sticker import is already in progress');
      error.code = 'REVERIE_OPERATION_IN_PROGRESS';
      throw error;
    }
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 120) : '';
    const normalizeTags = (value) => Array.isArray(value)
      ? value
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().slice(0, 32))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    stickerDialogPending = true;
    try {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: '导入本地表情',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          { name: '图片与 GIF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        ],
      });
      if (selected.canceled || selected.filePaths.length !== 1) {
        return { canceled: true, item: null, items: [] };
      }
      const source = path.resolve(selected.filePaths[0]);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 16 || stat.size > 5_000_000) {
        throw new Error('Sticker file is not a safe regular image under 5 MB');
      }
      const result = await bridge.importStickerFile(source, {
        text,
        emotions: normalizeTags(input.emotions),
        styleTags: normalizeTags(input.styleTags),
      });
      return {
        canceled: false,
        fileName: path.basename(source),
        ...result,
      };
    } finally {
      stickerDialogPending = false;
    }
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

function bundledCharacterSnapshot() {
  const unavailable = {
    record: null,
    runtime: {
      live2d: {
        available: false,
        licenseAccepted: false,
        reason: 'The bundled character is unavailable',
      },
    },
  };
  if (!avatarManager) return unavailable;
  const library = avatarManager.list();
  const record = library.records.find((item) => (
    item.id === library.activeId
    && item.kind === 'live2d'
    && item.status === 'ready'
  )) || null;
  return {
    record,
    runtime: library.runtime,
  };
}

/**
 * The production renderer receives one narrow capability interface. The old
 * platform handlers remain above only as migration reference and are never
 * registered; an XSS therefore cannot reach files, location, notifications,
 * custom avatars, games, backups, focus timers, or image generation.
 */
// ── cat-catch download service (GPL-3.0, Muhe Studio adaptation) ──
// Vendored at src/download_service/electron_adapter.js. Registered through the
// secure IPC registrar only; every handler fails closed unless the owner
// enabled features.download_service_enabled in data/config.json.
let downloadAdapter = null;
function getDownloadAdapter() {
  if (downloadAdapter !== null) return downloadAdapter;
  try {
    downloadAdapter = require(path.join(
      getRuntimeRoot(),
      'src',
      'download_service',
      'electron_adapter.js',
    ));
  } catch (error) {
    downloadAdapter = null;
    console.error('[Electron] cat-catch download adapter unavailable', error);
  }
  return downloadAdapter;
}

function downloadServiceEnabled() {
  if (!getDownloadAdapter()) return false;
  try {
    const configPath = path.join(dataDir, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    return Boolean(JSON.parse(raw)?.features?.download_service_enabled);
  } catch {
    return false;
  }
}

function requireDownloadAdapter() {
  if (!downloadServiceEnabled()) {
    throw new Error('REVERIE_DOWNLOAD_SERVICE_DISABLED');
  }
  return getDownloadAdapter();
}

function registerDownloadHandlers(handle) {
  handle('sniff:resources', () => {
    requireDownloadAdapter();
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    return mainWindow.webContents.executeJavaScript(`
      (() => {
        const resources = [];
        document.querySelectorAll('video, audio').forEach((el) => {
          const src = el.currentSrc || el.src;
          if (src) resources.push({ url: src, type: el.tagName.toLowerCase(), title: document.title });
          el.querySelectorAll('source').forEach((s) => {
            if (s.src) resources.push({ url: s.src, type: s.type || 'media', title: document.title });
          });
        });
        document.querySelectorAll('img').forEach((el) => {
          if (el.src && el.naturalWidth > 100) {
            resources.push({ url: el.src, type: 'image/' + (el.src.split('.').pop() || 'jpg'), title: el.alt || document.title, size: el.naturalWidth * el.naturalHeight });
          }
        });
        return resources;
      })()
    `).catch(() => []);
  });

  handle('sniff:m3u8', async (_event, url) => {
    const adapter = requireDownloadAdapter();
    const target = boundedString(url, { label: 'm3u8 url', max: 2048 });
    if (!/^https?:\/\//i.test(target)) {
      throw new TypeError('m3u8 url must be http(s)');
    }
    // Guard against SSRF-style use of the sniff endpoint: local focus mode
    // blocks outbound fetches (global fetch is gate-wrapped), but outside
    // local mode the URL must still be http(s) and the response bounded.
    if (networkGate?.snapshot?.()?.active && !/^https:\/\//i.test(target)) {
      throw new TypeError('m3u8 sniffing is restricted during local focus mode');
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let response;
      try {
        response = await fetch(target, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        return { error: `m3u8 source returned HTTP ${response.status}` };
      }
      const MAX_M3U8_BYTES = 1 * 1024 * 1024;
      const reader = response.body?.getReader?.();
      let content = '';
      if (reader) {
        // Stream and bound the body so a hostile server cannot make the
        // sniff endpoint buffer unbounded data before the size check.
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          content += decoder.decode(value, { stream: true });
          if (content.length > MAX_M3U8_BYTES) {
            await reader.cancel?.();
            return { error: 'm3u8 manifest exceeds the safe size limit' };
          }
        }
      } else {
        content = await response.text();
      }
      if (content.length > MAX_M3U8_BYTES) {
        return { error: 'm3u8 manifest exceeds the safe size limit' };
      }
      return adapter.parseM3U8(content);
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  });

  handle('download:m3u8', async (event, input) => {
    const adapter = requireDownloadAdapter();
    assertPlainObject(input, 'm3u8 download');
    if (typeof input.url !== 'string' || input.url.length > 2048
      || typeof input.m3u8Content !== 'string' || input.m3u8Content.length > 8 * 1024 * 1024) {
      throw new TypeError('m3u8 download payload is invalid');
    }
    if (!/^https?:\/\//i.test(input.url)) {
      throw new TypeError('m3u8 download url must be http(s)');
    }
    const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : '';
    const onProgress = (progress) => {
      try { event.sender.send('download:progress', progress); } catch {}
    };
    const buffer = await adapter.downloadM3U8Segments(
      input.url,
      baseUrl,
      input.m3u8Content,
      onProgress,
    );
    const tmpDir = path.join(require('os').tmpdir(), 'reverie-downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(
      tmpDir,
      `m3u8_${Date.now()}_${Math.random().toString(16).slice(2)}.ts`,
    );
    fs.writeFileSync(tmpFile, buffer);
    return { path: tmpFile, size: buffer.length };
  });

  handle('download:direct', async (_event, input) => {
    requireDownloadAdapter();
    assertPlainObject(input, 'direct download');
    const url = boundedString(input.url, { label: 'download url', max: 2048 });
    const filename = input.filename == null ? '' : boundedString(input.filename, { label: 'download filename', max: 512 });
    if (!/^https?:\/\//i.test(url)) throw new TypeError('download url must be http(s)');
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: filename || path.basename(new URL(url).pathname) || 'download',
    });
    if (!savePath) return { cancelled: true };
    mainWindow.webContents.downloadURL(url);
    return new Promise((resolve) => {
      mainWindow.webContents.session.once('will-download', (_ev, item) => {
        item.setSavePath(savePath);
        item.on('updated', () => {
          if (item.isPaused()) return;
          mainWindow.webContents.send('download:progress', {
            current: item.getReceivedBytes(),
            total: item.getTotalBytes(),
            percentage: item.getTotalBytes()
              ? Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100)
              : 0,
          });
        });
        item.on('done', (_e, state) => {
          resolve({
            path: savePath,
            size: item.getReceivedBytes(),
            state,
            cancelled: state === 'cancelled',
          });
        });
      });
    });
  });
}

function registerIpcHandlers() {
  if (ipcRegistrar) return;
  ipcRegistrar = createSecureIpcRegistrar(ipcMain, trustedWindows, trustPolicy);
  const { handle } = ipcRegistrar;

  handle('bridge:getConnectionConfig', () => bridgeHostProxy.getRendererConfig());
  handle('bridge:send', (_event, frame) => bridgeHostProxy.sendFromRenderer(frame));
  handle('app:getVersion', () => app.getVersion());
  handle('localMode:get', () => publicLocalModeState());
  handle('localMode:set', async (_event, input = {}) => {
    assertPlainObject(input, 'local mode');
    if (Object.keys(input).some((key) => key !== 'enabled')
      || typeof input.enabled !== 'boolean') {
      throw new TypeError('local mode payload is invalid');
    }
    return setManualLocalMode(input.enabled);
  });
  handle('credentials:status', () => publicCredentialStatus());
  handle('credentials:clear', async (_event, input = {}) => {
    assertPlainObject(input, 'credential clear');
    if (Object.keys(input).some((key) => key !== 'scope') || input.scope !== 'llm') {
      throw new TypeError('only the LLM credential scope may be cleared');
    }
    credentialVault.clear('llm');
    try {
      return await syncCredentialVault({ clearScopes: ['llm'] });
    } catch (error) {
      console.error('[Electron] Cleared credential runtime synchronization failed', error);
      if (!bridge?.child) startBridge();
      return broadcastCredentialStatus({
        stored: false,
        runtimeApplied: false,
        runtimePending: true,
        runtimeAppliedScopes: { llm: false },
      });
    }
  });
  handle('providerConfig:get', () => authoritativeProviderConfig());
  handle('providerConfig:test', (_event, input) => testProviderConfiguration(input));
  handle('providerConfig:commit', (_event, input) => commitProviderConfiguration(input));
  handle('character:getBundled', () => bundledCharacterSnapshot());
  registerDownloadHandlers(handle);
  handle('pet:toggle', () => togglePetWindow());
  handle('pet:show', () => showPetWindow());
  handle('pet:hide', () => hidePetWindow());
  handle('pet:isVisible', () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()));
}

function createTray() {
  if (tray) return;
  tray = new Tray(getWindowIconPath());
  tray.setToolTip('Reverie');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Reverie', click: showMainWindow },
    { type: 'separator' },
    {
      label: petWindow && !petWindow.isDestroyed() && petWindow.isVisible()
        ? '隐藏桌宠'
        : '显示桌宠',
      click: togglePetWindow,
    },
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
  mainWindow.webContents.session.on('will-download', (event) => {
    // Downloads stay blocked unless the owner enabled the vendored cat-catch
    // download service (features.download_service_enabled in config.json).
    if (!downloadServiceEnabled()) event.preventDefault();
  });
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

const PET_WINDOW_SIZE = { width: 260, height: 360 };

function trustedWindows() {
  // The registrar accepts IPC only from these windows. The desktop pet shares
  // the same preload/trusted origin (reverie-app://app/index.html#pet), so it
  // may use the pet:* surface; every other channel stays gated to the main
  // window by the shared sender/frame/URL checks.
  return [mainWindow, petWindow].filter((windowRef) => Boolean(windowRef));
}

function petWindowIsAlive() {
  return Boolean(petWindow && !petWindow.isDestroyed());
}

function createPetWindow() {
  if (petWindowIsAlive()) return petWindow;
  const bounds = mainWindow?.getBounds?.() || { x: 0, y: 0 };
  petWindow = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    x: Math.max(0, bounds.x + bounds.width - PET_WINDOW_SIZE.width - 24),
    y: Math.max(0, bounds.y + 24),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Reverie 桌宠',
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
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  if (IS_DEV) {
    petWindow.loadURL(FRONTEND_DEV_URL + '#pet').catch((error) => {
      console.error('[Electron] Failed to load development pet renderer', error);
    });
  } else {
    petWindow.loadURL(`${packagedRendererUrl}#pet`).catch((error) => {
      console.error('[Electron] Failed to load packaged pet renderer', error);
    });
  }
  petWindow.once('ready-to-show', () => {
    if (petWindowIsAlive()) petWindow.showInactive();
  });
  petWindow.on('closed', () => { petWindow = null; });
  return petWindow;
}

function showPetWindow() {
  const windowRef = createPetWindow();
  if (windowRef.isVisible()) return true;
  // ready-to-show fires only once; a hidden window is shown here directly.
  if (!windowRef.webContents.isLoading()) windowRef.showInactive();
  windowRef.setAlwaysOnTop(true, 'floating');
  return true;
}

function hidePetWindow() {
  if (!petWindowIsAlive()) return true;
  petWindow.hide();
  return true;
}

function togglePetWindow() {
  if (petWindowIsAlive() && petWindow.isVisible()) {
    hidePetWindow();
    return false;
  }
  showPetWindow();
  return true;
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
    if (live2dRuntimeAvailable && live2dCorePath && installLive2DCoreProtocol) {
      unregisterLive2DCoreProtocol = installLive2DCoreProtocol(protocol, live2dCorePath);
    }
    if (focusSoundManager && installFocusSoundProtocol) {
      unregisterFocusSoundProtocol = installFocusSoundProtocol(protocol, focusSoundManager, {
        allowedOrigins: [IS_DEV ? new URL(FRONTEND_DEV_URL).origin : 'reverie-app://app'],
      });
    }
    if (installStickerAssetProtocol && stickerAssetsRoot) {
      unregisterStickerAssetProtocol = installStickerAssetProtocol(
        protocol,
        stickerAssetsRoot,
        {
          allowedOrigins: [IS_DEV ? new URL(FRONTEND_DEV_URL).origin : 'reverie-app://app'],
        },
      );
    }
    registerIpcHandlers();
    createWindow();
    createTray();
    installPowerEvents();
    startBridge();

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
    bridgeHostProxy?.disconnect();
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
    unregisterStickerAssetProtocol?.();
    unregisterStickerAssetProtocol = null;
    unregisterLive2DCoreProtocol?.();
    unregisterLive2DCoreProtocol = null;
    tray?.destroy();
    tray = null;
    restoreConsole?.();
    restoreConsole = null;
    app.exit(0);
  })();
});
