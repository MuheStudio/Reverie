'use strict';

// A closed terminal or a dead parent process leaves the inherited stdio pipes
// with no reader. The next console write would then raise EPIPE as an
// uncaught exception and take the whole main process down behind an error
// dialog. Log delivery must never be fatal, so absorb stream errors here.
for (const stdio of [process.stdout, process.stderr]) {
  stdio?.on?.('error', (error) => {
    if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED'
      || error.code === 'ERR_STREAM_WRITE_AFTER_END')) return;
    throw error;
  });
}
const startupStartedAt = process.hrtime.bigint();

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
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
const { resolveMacDevelopmentPython } = require('./python-command.cjs');
const { createPackagedPythonEnvironment, resolveMacPackagedPython } = require('./packaged-python.cjs');
const { CredentialVault } = require('./credential-vault.cjs');
const { StorageKeyVault } = require('./storage-key-vault.cjs');
const {
  ENDPOINT_BINDING: GOOGLE_PLACES_BINDING,
  searchGooglePlaces,
} = require('./google-places.cjs');
const { registerDesktopSchemes } = require('./desktop-schemes.cjs');
const { reconcileFocusNetworkGate } = require('./focus-gate-recovery.cjs');
const { enterLocalModeWithDegradedBridge } = require('./focus-local-mode-transition.cjs');
const { LocalNetworkGate } = require('./local-network-gate.cjs');
const {
  attachNotificationClick,
  nativeNotificationOptions,
  processNotificationOutbox,
} = require('./notification-outbox.cjs');
const {
  ProviderConfigStore,
  normalizeProviderConfig,
  normalizeRecoveryProviderConfig,
  providerBinding,
} = require('./provider-config-store.cjs');
const {
  ProviderTransactionJournal,
  SCHEMA: PROVIDER_TRANSACTION_SCHEMA,
  recoveryAction,
} = require('./provider-transaction-journal.cjs');
const { ProviderMutationQueue } = require('./provider-mutation-queue.cjs');
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
const { MAC_TEST_PRODUCT_NAME, validateMacTestBuild, resolveTestUserDataOverride } = require('./test-user-data.cjs');
const {
  resolveAppUserModelId,
} = require('./windows-app-identity.cjs');

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
const VoicePackManager = optionalExport('./voice-pack-manager.cjs', 'VoicePackManager');
const gptSovitsRuntimeRelease = require('./gpt-sovits-runtime-release-status.cjs');
const { PetBoundsStore, clampBounds } = require('./pet-bounds-store.cjs');
const { createPetDrag } = require('./pet-drag.cjs');
const installAvatarProtocol = optionalExport('./avatar-protocol.cjs', 'installAvatarProtocol');
// The companion timer is Electron-local (no Python bridge involvement), so it
// is part of the MVP surface. FocusSoundManager stays stubbed until its UI
// ships; the renderer treats a missing focusSound as "builtin sounds only".
const FocusManager = optionalExport('./focus-manager.cjs', 'FocusManager');
const FocusSoundManager = null;
const installFocusSoundProtocol = null;
const evaluateLive2DRuntime = optionalExport('./live2d-release-gate.cjs', 'evaluateLive2DRuntime');
const readRuntimeAssetsManifest = optionalExport(
  './live2d-runtime-assets.cjs',
  'readRuntimeAssetsManifest',
);
const stageNativeBackupSource = optionalExport('./backup-file-stage.cjs', 'stageNativeBackupSource');
// Sticker images render in chat bubbles through reverie-sticker://asset URLs;
// without this handler those bubbles silently render empty.
const installStickerAssetProtocol = optionalExport(
  './sticker-asset-protocol.cjs',
  'installStickerAssetProtocol',
);
// Downloaded chat videos stream to <video> bubbles through
// reverie-video://asset URLs (Range-capable); base64 data URLs would blow up
// renderer memory for large videos.
const installVideoAssetProtocol = optionalExport(
  './video-asset-protocol.cjs',
  'installVideoAssetProtocol',
);
const installLive2DCoreProtocol = optionalExport(
  './live2d-core-protocol.cjs',
  'installLive2DCoreProtocol',
);

const FRONTEND_DEV_URL = 'http://localhost:5173';
const IS_DEV = !app.isPackaged;
const BRIDGE_RESTART_MAX_MS = 30_000;

function logStartupStage(stage, startedAt = null, details = {}) {
  const now = process.hrtime.bigint();
  console.log('[Electron] Startup stage', {
    stage,
    elapsedMs: Math.round(Number(now - startupStartedAt) / 1e6),
    ...(startedAt ? { durationMs: Math.round(Number(now - startedAt) / 1e6) } : {}),
    ...details,
  });
}

registerDesktopSchemes(protocol);

const appUserModelId = resolveAppUserModelId({
  platform: process.platform,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
if (appUserModelId) {
  app.setAppUserModelId(appUserModelId);
}
if (IS_DEV && process.env.REVERIE_USER_DATA_DIR) {
  const override = path.resolve(process.env.REVERIE_USER_DATA_DIR);
  fs.mkdirSync(override, { recursive: true });
  app.setPath('userData', override);
}
if (!IS_DEV && process.platform === 'darwin') {
  const identity = validateMacTestBuild(path.resolve(process.resourcesPath, '..', '..'), { required: false });
  if (identity) {
    app.setName(MAC_TEST_PRODUCT_NAME);
    if (!process.env.REVERIE_TEST_USER_DATA_DIR) {
      const isolatedDefault = path.join(app.getPath('appData'), MAC_TEST_PRODUCT_NAME);
      fs.mkdirSync(path.join(isolatedDefault, 'session'), { recursive: true, mode: 0o700 });
      app.setPath('userData', isolatedDefault);
      app.setPath('sessionData', path.join(isolatedDefault, 'session'));
    }
  }
}
if (!IS_DEV && process.env.REVERIE_TEST_USER_DATA_DIR) {
  const packageRoot = process.platform === 'darwin'
    ? path.resolve(process.resourcesPath, '..', '..')
    : path.resolve(__dirname, '..', '..', '..');
  const override = resolveTestUserDataOverride({
    isPackaged: app.isPackaged,
    platform: process.platform,
    packageRoot,
    requestedPath: process.env.REVERIE_TEST_USER_DATA_DIR,
  });
  fs.mkdirSync(override, { recursive: true });
  const sessionData = path.join(override, 'session');
  fs.mkdirSync(sessionData, { recursive: true });
  app.setPath('userData', override);
  app.setPath('sessionData', sessionData);
}
if (!IS_DEV && process.platform === 'darwin') {
  const userData = app.getPath('userData');
  const directories = {
    sessionData: path.join(userData, 'session'),
    cache: path.join(userData, 'runtime', 'cache'),
    crashDumps: path.join(userData, 'crash-dumps'),
    logs: path.join(userData, 'logs'),
  };
  for (const [name, directory] of Object.entries(directories)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    app.setPath(name, directory);
  }
  for (const name of ['tmp', 'data', 'state']) {
    fs.mkdirSync(path.join(userData, 'runtime', name), { recursive: true, mode: 0o700 });
  }
  const privateEnvironment = createPackagedPythonEnvironment(process.resourcesPath, process.env, userData);
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    process.env[name] = privateEnvironment[name];
  }
  app.commandLine.appendSwitch('disk-cache-dir', directories.cache);
}

const packagedIndex = path.join(__dirname, '..', 'dist', 'index.html');
const packagedRendererUrl = 'reverie-app://app/index.html';
const trustPolicy = createRendererTrustPolicy({
  isDev: IS_DEV,
  devUrl: FRONTEND_DEV_URL,
  packagedIndex,
  packagedUrl: packagedRendererUrl,
});
installWebContentsSecurity(app, trustPolicy, {
  // https links opened with target="_blank" go to the system browser; the
  // child window is still denied (onboarding vendor links, docs, etc.).
  openExternal: (url) => shell.openExternal(url),
});

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
let providerTransactionJournal = null;
let avatarManager = null;
let voicePackManager = null;
let petBoundsStore = null;
let focusManager = null;
let focusSoundManager = null;
let unregisterAvatarProtocol = null;
let unregisterFocusSoundProtocol = null;
let unregisterAppProtocol = null;
let unregisterStickerAssetProtocol = null;
let unregisterVideoAssetProtocol = null;
let unregisterLive2DCoreProtocol = null;
let stickerAssetsRoot = null;
let videoAssetsRoot = null;
let live2dCorePath = null;
let live2dRuntimeAvailable = false;
let bundledAvatarInstallError = null;
let live2dRuntimeAssets = null;
let ipcRegistrar = null;
let notificationPollTimer = null;
let inactivityTimer = null;
let backendRestartTimer = null;
let backendRestartAttempts = 0;
let isQuitting = false;
let screenLocked = false;
let avatarDialogPending = false;
let voicePackDialogPending = false;
const voicePackImportSessions = new Map();
let focusSoundDialogPending = false;
let stickerDialogPending = false;
let backupDialogPending = false;
let jsonSaveDialogPending = false;
let localModeTransitionPending = false;
let focusGateRecovery = { available: true, reason: '', gateState: null };
let shutdownStarted = false;
const providerTestReceipts = new Map();
const PROVIDER_TEST_RECEIPT_TTL_MS = 5 * 60 * 1000;
const providerMutationQueue = new ProviderMutationQueue();

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
    if (process.platform === 'darwin') {
      return resolveMacPackagedPython(getRuntimeRoot(), {
        userDataPath: app.getPath('userData'),
        onDiagnostic: ({ elapsedMs, ...details }) => logStartupStage('python-probe', null, { ...details, probeElapsedMs: elapsedMs }),
      });
    }
    const bundled = path.join(
      getRuntimeRoot(),
      'python',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    if (isRegularUnlinkedFile(bundled)) return bundled;
    throw new Error('Verified bundled Python runtime is missing');
  }
  if (process.platform === 'darwin') {
    return resolveMacDevelopmentPython(getRuntimeRoot());
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

// The bundled public skin is displayed under its in-story persona name. The
// model package itself (and YUMI_CHARACTER_RIGHTS.json) keeps the original
// "yumi" identity; LICENSES_CREDITS documents the alias.
const BUNDLED_AVATAR_DISPLAY_NAME = 'Hoshino Yumetsuki';
const BUNDLED_AVATAR_LEGACY_NAMES = new Set(['Yumi']);

function migrateBundledAvatarDisplayName() {
  if (!avatarManager) return;
  try {
    const list = avatarManager.list();
    const stale = list.records.find(
      (record) => record.status === 'ready' && BUNDLED_AVATAR_LEGACY_NAMES.has(record.name),
    );
    if (!stale) return;
    avatarManager.rename(stale.id, BUNDLED_AVATAR_DISPLAY_NAME);
    console.info('[Electron] Bundled avatar display name migrated to', BUNDLED_AVATAR_DISPLAY_NAME);
  } catch (error) {
    console.warn('[Electron] Bundled avatar display name migration failed', error);
  }
}

function getWindowIconPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'public', 'icon.ico')
    : path.join(process.resourcesPath, 'icon.ico');
}

const petBridgeRequests = new Map();
const PET_STICKER_CACHE_TTL_MS = 15 * 60 * 1000;
let petStickerCache = [];
let petStickerCacheAt = 0;
let petActiveRequestId = null;

function sendToTrustedWindow(windowRef, channel, payload) {
  if (!windowRef || windowRef.isDestroyed()) return;
  if (!trustPolicy.isTrustedUrl(windowRef.webContents.getURL())) return;
  windowRef.webContents.send(channel, payload);
}

function observePetBridgeFrame(frame) {
  const payload = frame?.payload && typeof frame.payload === 'object' ? frame.payload : {};
  const requestId = typeof frame?.request_id === 'string' ? frame.request_id : '';
  const pending = requestId ? petBridgeRequests.get(requestId) : null;
  if (pending && pending.expectedTypes.has(frame.type)) {
    petBridgeRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }
  if (frame?.type === 'sticker:data' && Array.isArray(payload.items)) {
    petStickerCache = payload.items;
    petStickerCacheAt = Date.now();
  }

  const chatRequestId = typeof payload.request_id === 'string' ? payload.request_id : '';
  const belongsToPet = Boolean(petActiveRequestId && chatRequestId === petActiveRequestId);
  let event = null;
  if (frame?.type === 'chat:chunk' && typeof payload.text === 'string') {
    if (belongsToPet) event = { type: 'chunk', text: payload.text.slice(0, 12_000) };
  } else if (frame?.type === 'chat:done') {
    if (belongsToPet) {
      const messages = Array.isArray(payload.messages)
        ? payload.messages
            .filter((item) => typeof item === 'string' && item.trim())
            .slice(0, 16)
        : [];
      const text = messages.join('').slice(0, 12_000);
      petActiveRequestId = null;
      event = { type: 'done', text, messages };
    }
  } else if (frame?.type === 'chat:typing') {
    if (belongsToPet) event = { type: 'typing', typing: Boolean(payload.typing) };
  } else if (frame?.type === 'chat:error') {
    if (belongsToPet) {
      petActiveRequestId = null;
      event = { type: 'error', message: '回复生成失败，请在主界面查看详细原因。' };
    }
  } else if (frame?.type === 'error' && (belongsToPet || requestId === petActiveRequestId)) {
    petActiveRequestId = null;
    event = { type: 'error', message: String(payload.error || payload.message || '请求被本地服务拒绝。').slice(0, 500) };
  } else if (frame?.type === 'chat:state'
    && belongsToPet
    && ['done', 'cancelled', 'failed', 'failed_uncertain', 'error'].includes(String(payload.state || payload.status))) {
    petActiveRequestId = null;
  }
  if (event) sendToTrustedWindow(petWindow, 'pet:chatEvent', event);
}

function broadcast(channel, payload) {
  sendToTrustedWindow(mainWindow, channel, payload);
  if (channel === 'bridge:message') observePetBridgeFrame(payload);
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

function publicProviderFromRuntime(llm) {
  return {
    provider: String(llm.provider || '').toLowerCase(),
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
  try {
    const cached = providerConfigStore?.get();
    if (cached?.llm?.customProviderName
      && sameProviderConnection({ llm }, cached)) {
      llm.customProviderName = cached.llm.customProviderName;
    }
  } catch (error) {
    console.error('[Electron] Provider display metadata recovery failed', error);
  }
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
  // Google Places is consumed only by the Electron main-process transport.
  // Never include it in the object synchronized to Python.
  delete runtimeCredentials.googlePlaces;
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
  const notification = new Notification(options.id
    ? nativeNotificationOptions(
      { id: options.id, title: safeTitle, body: safeBody },
      { locked: generic, silent: options.silent },
    )
    : { title: safeTitle, body: safeBody, silent: Boolean(options.silent) });
  attachNotificationClick(notification, showMainWindow);
  notification.show();
  return true;
}

function notificationOutboxDir() {
  return path.join(app.getPath('userData'), 'data', 'notifications', 'outbox');
}

function pollNotificationOutbox() {
  const outbox = notificationOutboxDir();
  try {
    processNotificationOutbox({
      fs,
      path,
      outbox,
      focusActive: () => Boolean(networkGate?.snapshot().active),
      windowFocused: () => Boolean(
        mainWindow
        && !mainWindow.isDestroyed()
        && mainWindow.isVisible()
        && mainWindow.isFocused()
      ),
      showNotification: (payload) => showNativeNotification(payload.title, payload.body, {
        id: payload.id,
      }),
      warn: (name, error) => {
        console.warn('[Electron] Notification outbox item failed', name, error);
      },
    });
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
  const keyStartedAt = process.hrtime.bigint();
  let storageKey;
  try { storageKey = storageKeyVault.getOrCreateKey(); } catch (error) {
    logStartupStage('bridge-key-vault-failed', keyStartedAt, { code: error?.code || 'REVERIE_STORAGE_KEY_UNAVAILABLE' });
    throw error;
  }
  logStartupStage('bridge-key-vault-ready', keyStartedAt, {
    encryption: process.platform === 'darwin' ? 'electron-safeStorage-keychain' : 'electron-safeStorage',
  });
  const isolatedPython = !IS_DEV && process.platform === 'darwin';
  const args = [
    ...(isolatedPython ? ['-I', '-B', '-u', '-X', 'utf8'] : []),
    path.join(getRuntimeRoot(), 'src', 'main.py'),
    '--stdio-bridge',
  ];
  logger?.addSecret(context.secret);
  let child;
  try {
    const spawnStartedAt = process.hrtime.bigint();
    child = spawn(command, args, {
      cwd: getRuntimeRoot(),
      windowsHide: true,
      env: {
        ...(isolatedPython ? createPackagedPythonEnvironment(getRuntimeRoot(), process.env, app.getPath('userData')) : process.env),
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
    logStartupStage('python-spawned', spawnStartedAt, { pid: child.pid || null, transport: 'stdio-framed', protocolVersion: 4 });
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
  const bridgeStartedAt = Date.now();
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
    logStartupStage('v4-authenticated', null, { generation: bridge.generation, protocolVersion: 4 });
    try {
      await enqueueProviderMutation(async () => {
        await recoverProviderTransaction();
        return syncCredentialVault();
      });
    } catch (error) {
      console.error('[Electron] Credential runtime synchronization failed', error);
      broadcastCredentialStatus({ runtimeApplied: false });
    }
    broadcast('bridge:changed', { ready: true, generation: bridge.generation });
    console.log(`[Electron] Local backend authenticated: protocol v4 (${Date.now() - bridgeStartedAt}ms)`);
  }).catch(async (error) => {
    try {
      await bridge.stopAndWait('SIGKILL');
    } catch {}
    scheduleBridgeRestart(error);
  });
}

async function killBridgeFailClosed() {
  if (petActiveRequestId) {
    petActiveRequestId = null;
    sendToTrustedWindow(petWindow, 'pet:chatEvent', {
      type: 'error', message: '本地服务连接已中断，请等待恢复后重试。',
    });
  }
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

function offerStorageKeyReset() {
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: '本地数据库密钥无法解密',
    message: '加密密钥库已损坏，或属于其他 Windows 用户。',
    detail: '“重置密钥库”会把旧密钥文件与现有本地数据库文件改名留档，然后用全新密钥启动；'
      + '历史数据只能通过“完整本地备份恢复”找回。选择“退出”则保持现状，不做任何改动。',
    buttons: ['退出', '重置密钥库并隔离本地数据库'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  return choice === 1;
}

function quarantineUnreadableDatabases() {
  const dataDir = prepareWritableDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const databaseExtensions = new Set(['.sqlite3', '.sqlite', '.db']);
  const sidecarSuffixes = ['-wal', '-shm', '-journal'];
  let quarantined = 0;
  const quarantine = (filePath) => {
    try {
      fs.renameSync(filePath, `${filePath}.unreadable-${stamp}`);
      quarantined += 1;
    } catch (error) {
      console.error('[Electron] Could not quarantine unreadable database file', filePath, error);
    }
  };
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (databaseExtensions.has(path.extname(entry.name).toLowerCase())) {
        quarantine(full);
        for (const sidecar of sidecarSuffixes) {
          quarantine(`${full}${sidecar}`);
        }
      }
    }
  };
  visit(dataDir);
  console.warn(`[Electron] Quarantined ${quarantined} database file(s) after storage-key reset`);
}

function createRuntimeModules() {
  const runtimeDir = path.join(app.getPath('userData'), 'runtime');
  petBoundsStore = new PetBoundsStore(path.join(runtimeDir, 'pet'));
  stickerAssetsRoot = path.join(prepareWritableDataDir(), 'stickers', 'assets');
  // Downloaded chat videos live under chat-media/video (sha256-addressed);
  // served read-only over reverie-video:// with Range support.
  videoAssetsRoot = path.join(prepareWritableDataDir(), 'chat-media', 'video');
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
    ...(process.platform === 'darwin' ? { existingDataDir: prepareWritableDataDir() } : {}),
  });
  // The OS-protected key must be usable before opening a renderer. macOS
  // failures always stop startup and preserve the existing key and databases.
  // Windows retains its existing explicit user-confirmed recovery path.
  let storageProbe;
  const keyVaultStartedAt = process.hrtime.bigint();
  const encryption = process.platform === 'darwin' ? 'electron-safeStorage-keychain' : 'electron-safeStorage';
  logStartupStage('key-vault-start', null, { encryption, appName: app.getName() });
  try {
    storageProbe = storageKeyVault.getOrCreateKey();
  } catch (error) {
    logStartupStage('key-vault-failed', keyVaultStartedAt, { encryption, code: error?.code || 'REVERIE_STORAGE_KEY_UNAVAILABLE' });
    if (process.platform === 'darwin' || String(error?.code || '') !== 'REVERIE_STORAGE_KEY_CORRUPT'
      || !offerStorageKeyReset()) {
      throw error;
    }
    storageKeyVault.reset({ reason: 'corrupt_vault_user_reset' });
    quarantineUnreadableDatabases();
    storageProbe = storageKeyVault.getOrCreateKey();
  }
  storageProbe.fill(0);
  logStartupStage('key-vault-ready', keyVaultStartedAt, { encryption, appName: app.getName() });
  providerConfigStore = new ProviderConfigStore({
    storageDir: path.join(runtimeDir, 'provider-config'),
  });
  providerTransactionJournal = new ProviderTransactionJournal({
    storageDir: path.join(runtimeDir, 'provider-transaction'),
  });
  bridge = new FramedBridgeSupervisor({
    spawnChild: spawnBridgeChild,
    // Development dependencies can load slowly on macOS storage. Keep the
    // process alive long enough to finish; all V4 authority checks still apply.
    ...(IS_DEV && process.platform === 'darwin' ? { readyTimeoutMs: 120_000 } : {}),
  });
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
    if (petActiveRequestId) {
      petActiveRequestId = null;
      sendToTrustedWindow(petWindow, 'pet:chatEvent', {
        type: 'error', message: '本地服务意外退出，Reverie 正在尝试恢复。',
      });
    }
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
        // Packaged builds never auto-install a character. Cubism distribution
        // does not allow shipping a model with the app; users import one in
        // onboarding. Dev may still point REVERIE_YUMI_SOURCE at a local folder.
        const yumiSource = IS_DEV
          ? path.resolve(process.env.REVERIE_YUMI_SOURCE || '')
          : '';
        if (IS_DEV && yumiSource && fs.existsSync(yumiSource) && avatarManager.list().records.length === 0) {
          try {
            const installed = avatarManager.installTrustedDefaultDirectory(yumiSource, {
              name: BUNDLED_AVATAR_DISPLAY_NAME,
              trustedOwnerAsset: true,
            });
            applyBundledYumiMapping(installed);
          } catch (installError) {
            bundledAvatarInstallError = installError instanceof Error
              ? installError.message
              : String(installError);
            console.error('[Electron] Dev Live2D fixture installation failed', installError);
          }
        } else if (avatarManager.list().records.length > 0) {
          migrateBundledAvatarDisplayName();
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
  if (VoicePackManager) {
    try {
      voicePackManager = new VoicePackManager({ storageDir: app.getPath('userData') });
    } catch (error) {
      voicePackManager = null;
      console.error('[Electron] Voice-pack module initialization failed', error);
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

function getLive2DTextureTransformerConfig() {
  const scriptPath = IS_DEV
    ? path.join(__dirname, '..', 'script', 'downscale-live2d-textures.py')
    : path.join(process.resourcesPath, 'downscale-live2d-textures.py');
  if (!isRegularUnlinkedFile(scriptPath)) return null;
  try {
    return {
      pythonPath: getPythonCommand(),
      scriptPath,
      maxDimension: 4096,
    };
  } catch {
    return null;
  }
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
        textureTransformer: getLive2DTextureTransformerConfig(),
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

async function configureAuthoritativeProvider(input, options = {}) {
  const normalized = options.allowUnconfiguredOllama
    ? normalizeRecoveryProviderConfig(input)
    : normalizeProviderConfig(input);
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

function sameProviderConnection(left, right) {
  const first = normalizeRecoveryProviderConfig(left).llm;
  const second = normalizeRecoveryProviderConfig(right).llm;
  return first.provider === second.provider
    && first.baseUrl === second.baseUrl
    && first.model === second.model;
}

async function recoverProviderTransaction() {
  const transaction = providerTransactionJournal?.read();
  if (!transaction || !bridge?.ready) return;
  const current = await authoritativeProviderConfig();
  const action = recoveryAction(
    transaction,
    current,
    credentialVault.snapshotScope('llm'),
  );
  if (action === 'rollback') {
    await configureAuthoritativeProvider(transaction.oldConfig, {
      allowUnconfiguredOllama: true,
    });
  }
  providerTransactionJournal.clear();
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
  const effective = { ...stored };
  if (typeof submitted?.apiKey === 'string' && submitted.apiKey) {
    effective.apiKey = submitted.apiKey;
  }
  if (typeof submitted?.customHeaders === 'string' && submitted.customHeaders) {
    effective.customHeaders = submitted.customHeaders;
  }
  if (submitted?.clearApiKey === true) delete effective.apiKey;
  if (submitted?.clearCustomHeaders === true) delete effective.customHeaders;
  return effective;
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
      model: result.model,
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
      retryable: error?.retryable === true,
    };
  }
}

function commitProviderConfiguration(input = {}) {
  return enqueueProviderMutation(async () => {
    await recoverProviderTransaction();
    return commitProviderConfigurationUnlocked(input);
  });
}

function enqueueProviderMutation(operation) {
  return providerMutationQueue.enqueue(operation);
}

async function commitProviderConfigurationUnlocked(input = {}) {
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
  if (tested.completedResult) return tested.completedResult;
  let oldConfig;
  try {
    credentialVault.snapshotScope('llm');
    oldConfig = await authoritativeProviderConfig();
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
  const transaction = {
    schema: PROVIDER_TRANSACTION_SCHEMA,
    id: crypto.randomUUID(),
    phase: 'prepared',
    credentialAction: credential == null
      ? 'preserve'
      : Object.keys(effectiveCredential).length === 0 ? 'clear' : 'replace',
    newBinding: providerBinding('llm', normalized),
    credentialTransactionId: credential == null ? null : crypto.randomUUID(),
    oldConfig,
    newConfig: normalized,
  };
  providerTransactionJournal.write(transaction);
  let committed;
  try {
    committed = await configureAuthoritativeProvider(normalized);
  } catch (error) {
    try {
      const current = await authoritativeProviderConfig();
      if (sameProviderConnection(current, normalized)) {
        committed = current;
      } else {
        if (sameProviderConnection(current, oldConfig)) providerTransactionJournal.clear();
        throw error;
      }
    } catch (recoveryError) {
      if (recoveryError === error) throw error;
      throw error;
    }
  }
  if (credential != null) {
    const binding = providerBinding('llm', normalized);
    try {
      if (Object.keys(effectiveCredential).length === 0) {
        credentialVault.clear('llm');
      } else if (mode === 'session') {
        credentialVault.setSession('llm', effectiveCredential, {
          binding,
          transactionId: transaction.credentialTransactionId,
        });
      } else {
        credentialVault.set('llm', effectiveCredential, {
          binding,
          transactionId: transaction.credentialTransactionId,
        });
      }
    } catch (error) {
      const code = String(error?.code || 'REVERIE_VAULT_IO');
      try {
        await configureAuthoritativeProvider(oldConfig, {
          allowUnconfiguredOllama: true,
        });
        providerTransactionJournal.clear();
      } catch (rollbackError) {
        providerTestReceipts.delete(receipt);
        console.error('[Electron] Provider metadata rollback is pending recovery', rollbackError);
        throw error;
      }
      console.error('[Electron] Endpoint-bound credential write failed', code);
      return {
        config: oldConfig,
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
  try {
    providerTransactionJournal.clear();
  } catch (error) {
    console.error('[Electron] Completed provider transaction journal cleanup failed', error);
  }
  let status;
  try {
    status = await syncCredentialVault({
      ...(transaction.credentialAction === 'clear' ? { clearScopes: ['llm'] } : {}),
    });
  } catch (error) {
    console.error('[Electron] Provider commit runtime synchronization failed', error);
    status = broadcastCredentialStatus({
      stored: hasStoredCredentials(publicCredentialStatus()),
      runtimeApplied: false,
      runtimePending: true,
      runtimeAppliedScopes: { llm: false },
    });
  }
  const completedResult = {
    config: committed,
    status: {
      ...status,
      ...(mode === 'session'
        ? { sessionWarning: '凭据仅保存在本次运行的内存中，退出 Reverie 后会消失。' }
        : {}),
    },
  };
  tested.completedResult = completedResult;
  return completedResult;
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
    ...(record === null && bundledAvatarInstallError
      ? { installError: bundledAvatarInstallError }
      : {}),
  };
}

/**
 * The production renderer receives one narrow capability interface registered
 * in registerIpcHandlers(); the retired platform handlers were removed so an
 * XSS cannot reach files, location, notifications, custom avatars, games,
 * backups, focus timers, or image generation through ghost channels.
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
    const configPath = path.join(prepareWritableDataDir(), 'config.json');
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

function requestPetBridge(type, payload, expectedTypes, timeoutMs = 15_000) {
  const requestId = `pet_${crypto.randomBytes(18).toString('base64url')}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      petBridgeRequests.delete(requestId);
      const error = new Error('The local companion service did not answer in time');
      error.code = 'REVERIE_BRIDGE_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    petBridgeRequests.set(requestId, { expectedTypes: new Set(expectedTypes), resolve, reject, timer });
    try {
      bridgeHostProxy.sendFromRenderer({ type, payload, request_id: requestId });
    } catch (error) {
      clearTimeout(timer);
      petBridgeRequests.delete(requestId);
      reject(error);
    }
  });
}

function publicVoicePackRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const { recordPath: _recordPath, ...safe } = record;
  return safe;
}

function beginVoicePackWorker(sourcePath) {
  if (!voicePackManager) {
    throw Object.assign(new Error('Voice-pack module is unavailable'), { code: 'REVERIE_MODULE_UNAVAILABLE' });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'voice-pack-import-worker.cjs'), {
      workerData: { storageDir: app.getPath('userData'), sourcePath },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(Object.assign(new Error('Voice-pack validation timed out'), { code: 'VOICE_PACK_IMPORT_TIMEOUT' }));
    }, 5 * 60 * 1000);
    timeout.unref?.();
    const fail = (error) => {
      clearTimeout(timeout);
      void worker.terminate();
      reject(error);
    };
    worker.once('error', () => fail(Object.assign(new Error('Voice-pack worker failed'), { code: 'VOICE_PACK_IMPORT_FAILED' })));
    worker.once('message', (message) => {
      if (message?.type === 'error') {
        fail(Object.assign(new Error(String(message.message)), { code: String(message.code) }));
        return;
      }
      if (message?.type !== 'preview' || typeof message.preview?.previewId !== 'string') return;
      clearTimeout(timeout);
      const previewId = message.preview.previewId;
      const expiry = setTimeout(() => {
        voicePackImportSessions.delete(previewId);
        void worker.terminate();
      }, 15 * 60 * 1000);
      expiry.unref?.();
      voicePackImportSessions.set(previewId, { worker, expiry });
      resolve(message.preview);
    });
  });
}

function commitVoicePackWorker(previewId, confirmation) {
  const session = voicePackImportSessions.get(previewId);
  if (!session) throw Object.assign(new Error('Voice-pack preview is invalid or expired'), { code: 'VOICE_PACK_PREVIEW_INVALID' });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      voicePackImportSessions.delete(previewId);
      void session.worker.terminate();
      reject(Object.assign(new Error('Voice-pack installation timed out'), { code: 'VOICE_PACK_IMPORT_TIMEOUT' }));
    }, 10 * 60 * 1000);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(session.expiry);
      voicePackImportSessions.delete(previewId);
      void session.worker.terminate();
    };
    session.worker.once('error', () => {
      cleanup();
      reject(Object.assign(new Error('Voice-pack worker failed'), { code: 'VOICE_PACK_IMPORT_FAILED' }));
    });
    session.worker.on('message', (message) => {
      if (!['committed', 'error'].includes(message?.type)) return;
      cleanup();
      if (message.type === 'committed') resolve(message.record);
      else reject(Object.assign(new Error(String(message.message)), { code: String(message.code) }));
    });
    session.worker.postMessage({ type: 'commit', previewId, confirmation });
  });
}

function setActiveVoicePackWorker(id) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'voice-pack-import-worker.cjs'), {
      workerData: { storageDir: app.getPath('userData'), operation: 'setActive', id },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(Object.assign(new Error('Voice-pack activation timed out'), { code: 'VOICE_PACK_IMPORT_TIMEOUT' }));
    }, 5 * 60 * 1000);
    timeout.unref?.();
    const finish = (error, value) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    worker.once('error', () => finish(Object.assign(new Error('Voice-pack worker failed'), { code: 'VOICE_PACK_IMPORT_FAILED' })));
    worker.once('message', (message) => {
      if (message?.type === 'active') finish(null, { activeId: message.id });
      else if (message?.type === 'error') finish(Object.assign(new Error(String(message.message)), { code: String(message.code) }));
    });
  });
}

function registerIpcHandlers() {
  if (ipcRegistrar) return;
  ipcRegistrar = createSecureIpcRegistrar(ipcMain, trustedWindows, trustPolicy);
  const { handle } = ipcRegistrar;
  const requireMainWindow = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      const error = new Error('This operation is available only from the main Reverie window');
      error.code = 'REVERIE_SECURITY';
      throw error;
    }
  };
  const requirePetWindow = (event) => {
    if (!petWindow || petWindow.isDestroyed() || event.sender !== petWindow.webContents) {
      const error = new Error('This operation is available only from the desktop pet');
      error.code = 'REVERIE_SECURITY';
      throw error;
    }
  };

  handle('bridge:getConnectionConfig', () => bridgeHostProxy.getRendererConfig());
  handle('bridge:send', (_event, frame) => bridgeHostProxy.sendFromRenderer(frame));
  handle('stickers:pickImage', async () => {
    // The renderer never receives raw bytes here — just the picked path,
    // which it then forwards to Python over the authenticated bridge
    // (sticker:import) for validation and content-addressed storage.
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择表情图片',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
      ],
    });
    if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
  });
  handle('app:getVersion', () => app.getVersion());
  handle('app:getUiSnapshot', () => {
    // Electron can read the durable UI flags without the Python host.
    // Onboarding must appear even if the companion process is still starting.
    try {
      const raw = JSON.parse(fs.readFileSync(
        path.join(prepareWritableDataDir(), 'config.json'),
        'utf8',
      ));
      const ui = raw && typeof raw.ui === 'object' && raw.ui && !Array.isArray(raw.ui)
        ? raw.ui
        : {};
      return {
        onboarding_completed: ui.onboarding_completed === true,
        onboarding_version: Number(ui.onboarding_version) || 0,
        onboarding_state: typeof ui.onboarding_state === 'string' ? ui.onboarding_state : '',
        onboarding_last_step: typeof ui.onboarding_last_step === 'string' ? ui.onboarding_last_step : '',
        experience_mode: ui.experience_mode === 'core' ? 'core' : 'full',
        mode: ui.mode === 'dream' ? 'dream' : 'mvp',
      };
    } catch {
      return {
        onboarding_completed: false,
        onboarding_version: 0,
        onboarding_state: '',
        onboarding_last_step: '',
        experience_mode: 'full',
        mode: 'mvp',
      };
    }
  });
  handle('notification:show', (_event, input) => {
    assertPlainObject(input, 'notification');
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (!title && !body) throw new TypeError('notification requires a title or body');
    const shown = showNativeNotification(title, body);
    return { shown };
  });
  handle('backup:nativeExport', () => exportNativeBackup());
  handle('backup:nativeImport', () => importNativeBackup());
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
  handle('places:status', () => {
    const status = publicCredentialStatus();
    return {
      configured: {
        amap: status.amap?.hasApiKey === true,
        google: status.googlePlaces?.hasApiKey === true && status.googlePlaces?.bindingKnown === true,
      },
      secureStorageAvailable: status.persistentAvailable === true,
    };
  });
  handle('places:setKey', (_event, input = {}) => {
    assertPlainObject(input, 'Places key');
    if (Object.keys(input).some((key) => !['provider', 'apiKey'].includes(key))
      || !['amap', 'google'].includes(input.provider)) {
      throw new TypeError('Places key payload is invalid');
    }
    const apiKey = boundedString(input.apiKey, { label: 'Places API key', min: 1, max: 256 });
    if (input.provider === 'google') {
      credentialVault.set('googlePlaces', { apiKey }, { binding: GOOGLE_PLACES_BINDING });
    } else {
      credentialVault.set('amap', { apiKey });
    }
    return { configured: true, secureStorageAvailable: true };
  });
  handle('places:deleteKey', (_event, input = {}) => {
    assertPlainObject(input, 'Places key deletion');
    if (Object.keys(input).some((key) => key !== 'provider')
      || !['amap', 'google'].includes(input.provider)) {
      throw new TypeError('Places key deletion payload is invalid');
    }
    credentialVault.clear(input.provider === 'google' ? 'googlePlaces' : 'amap');
    return { configured: false, secureStorageAvailable: credentialVault.isAvailable() };
  });
  handle('places:resolve', (_event, input = {}) => {
    assertPlainObject(input, 'Places provider selection');
    if (Object.keys(input).some((key) => key !== 'selection')
      || !['auto', 'amap', 'google'].includes(input.selection)) {
      throw new TypeError('Places provider selection is invalid');
    }
    const status = publicCredentialStatus();
    const configured = {
      amap: status.amap?.hasApiKey === true,
      google: status.googlePlaces?.hasApiKey === true && status.googlePlaces?.bindingKnown === true,
    };
    const provider = input.selection === 'auto'
      ? (configured.amap ? 'amap' : (configured.google ? 'google' : null))
      : input.selection;
    return { provider, configured: provider ? configured[provider] : false };
  });
  handle('places:nearby', async (_event, input = {}) => {
    assertPlainObject(input, 'Places nearby request');
    const allowedTypes = new Set([
      'restaurant', 'cafe', 'bakery', 'dessert', 'convenience', 'snacks', 'supermarket',
    ]);
    if (Object.keys(input).some((key) => ![
      'provider', 'latitude', 'longitude', 'radiusM', 'placeTypes', 'consent',
    ].includes(key)) || !['amap', 'google'].includes(input.provider) || input.consent !== true
      || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90
      || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180
      || !Number.isInteger(input.radiusM) || input.radiusM < 300 || input.radiusM > 5000
      || !Array.isArray(input.placeTypes) || input.placeTypes.length < 1
      || input.placeTypes.length > 7
      || input.placeTypes.some((kind) => typeof kind !== 'string' || !allowedTypes.has(kind))) {
      throw new TypeError('Places nearby request is invalid');
    }
    if (networkGate?.snapshot?.().active) {
      return { ok: false, code: 'local-mode', items: [], provider: input.provider === 'google' ? 'Google' : 'Amap' };
    }
    if (input.provider === 'google') {
      const apiKey = credentialVault.readForRuntime({
        bindings: { googlePlaces: GOOGLE_PLACES_BINDING },
      }).googlePlaces?.apiKey;
      if (!apiKey) return { ok: false, code: 'key-required', items: [], provider: 'Google' };
      return searchGooglePlaces({
        apiKey,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusM: input.radiusM,
        placeTypes: [...new Set(input.placeTypes)],
      });
    }
    const apiKey = credentialVault.readForRuntime().amap?.apiKey;
    if (!apiKey) return { ok: false, code: 'key-required', items: [], provider: 'Amap' };
    if (!bridge?.ready) return { ok: false, code: 'unavailable', items: [], provider: 'Amap' };
    return bridge.requestAmapNearby({
      api_key: apiKey,
      latitude: input.latitude,
      longitude: input.longitude,
      radius_m: input.radiusM,
      place_types: [...new Set(input.placeTypes)],
    });
  });
  handle('credentials:clear', (_event, input = {}) => {
    assertPlainObject(input, 'credential clear');
    if (Object.keys(input).some((key) => key !== 'scope') || input.scope !== 'llm') {
      throw new TypeError('only the LLM credential scope may be cleared');
    }
    return enqueueProviderMutation(async () => {
      try {
        await recoverProviderTransaction();
      } catch (error) {
        if (error?.code !== 'REVERIE_PROVIDER_TRANSACTION_CORRUPT') throw error;
        // Explicit credential deletion is the recovery escape hatch. All
        // non-destructive provider mutations remain blocked by a corrupt journal.
        providerTransactionJournal.clear();
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
  });
  handle('providerConfig:get', () => authoritativeProviderConfig());
  handle('providerConfig:test', (_event, input) => testProviderConfiguration(input));
  handle('providerConfig:commit', (_event, input) => commitProviderConfiguration(input));
  handle('character:getBundled', () => bundledCharacterSnapshot());
  handle('avatar:list', (event) => {
    requireMainWindow(event);
    if (!avatarManager) throw Object.assign(new Error('Avatar module is unavailable'), { code: 'REVERIE_MODULE_UNAVAILABLE' });
    return avatarManager.list();
  });
  handle('avatar:beginImport', async (event) => {
    requireMainWindow(event);
    if (avatarDialogPending) throw Object.assign(new Error('An avatar picker is already open'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择头像包', properties: ['openFile'],
        filters: [{ name: '头像包', extensions: ['vrm', 'glb', 'zip'] }],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      return runAvatarImportWorker(result.filePaths[0]);
    } finally { avatarDialogPending = false; }
  });
  handle('avatar:beginImportFolder', async (event) => {
    requireMainWindow(event);
    if (avatarDialogPending) throw Object.assign(new Error('An avatar picker is already open'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Live2D 模型文件夹', properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      return runAvatarImportWorker(result.filePaths[0], { sourceIsDirectory: true });
    } finally { avatarDialogPending = false; }
  });
  handle('avatar:beginImportLive2DFile', async (event) => {
    requireMainWindow(event);
    if (avatarDialogPending) throw Object.assign(new Error('An avatar picker is already open'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    avatarDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Live2D 的 model3.json 或 zip 包',
        properties: ['openFile'],
        filters: [
          { name: 'Live2D 模型', extensions: ['json', 'zip'] },
        ],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      const sourcePath = result.filePaths[0];
      if (/\.zip$/i.test(sourcePath)) return runAvatarImportWorker(sourcePath);
      if (/\.model3\.json$/i.test(sourcePath)) {
        return runAvatarImportWorker(path.dirname(sourcePath), { sourceIsDirectory: true });
      }
      throw Object.assign(
        new Error('请选择 Cubism 的 *.model3.json，或包含完整模型的 .zip'),
        { code: 'REVERIE_AVATAR_DROPPED_TYPE' },
      );
    } finally { avatarDialogPending = false; }
  });
  // Drag-and-drop entry: the renderer resolves the dropped File to a path via
  // webUtils in the preload and sends only the path string. The same worker
  // validation runs as with the dialog; the dialog stays as the fallback.
  handle('avatar:importDroppedPath', async (event, input = {}) => {
    requireMainWindow(event);
    assertPlainObject(input, 'avatar drop');
    const sourcePath = boundedString(input.path, { label: 'dropped avatar path', min: 2, max: 1024 });
    if (avatarDialogPending) throw Object.assign(new Error('An avatar import is already running'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    avatarDialogPending = true;
    try {
      const stat = await fs.promises.stat(sourcePath);
      const sourceIsDirectory = stat.isDirectory();
      const isModelJson = /\.model3\.json$/i.test(sourcePath);
      if (!sourceIsDirectory && !/\.(zip|vrm|glb)$/i.test(sourcePath) && !isModelJson) {
        throw Object.assign(
          new Error('请选择包含 model3.json 的 Live2D 文件夹、*.model3.json、.zip，或 VRM/GLB 文件'),
          { code: 'REVERIE_AVATAR_DROPPED_TYPE' },
        );
      }
      if (isModelJson) {
        return await runAvatarImportWorker(path.dirname(sourcePath), { sourceIsDirectory: true });
      }
      return await runAvatarImportWorker(sourcePath, sourceIsDirectory ? { sourceIsDirectory: true } : {});
    } finally { avatarDialogPending = false; }
  });
  handle('avatar:confirmPreview', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar preview');
    return avatarManager.markPreviewReady(
      boundedString(input.importId, { label: 'avatar import id', min: 20, max: 128 }),
      { detected: input.detected, capabilities: input.capabilities },
    );
  });
  for (const [channel, operation] of [
    ['avatar:failPreview', 'fail'],
    ['avatar:discardImport', 'discard'],
  ]) {
    handle(channel, (event, input = {}) => {
      requireMainWindow(event); assertPlainObject(input, operation);
      return avatarManager.discardImport(
        boundedString(input.importId, { label: 'avatar import id', min: 20, max: 128 }),
      );
    });
  }
  handle('avatar:commitImport', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar commit');
    const record = avatarManager.commitImport({
      importId: boundedString(input.importId, { label: 'avatar import id', min: 20, max: 128 }),
      rightsConfirmed: input.rightsConfirmed === true,
      warningAccepted: input.warningsAccepted === true,
    });
    broadcast('avatar:changed', avatarManager.list());
    return record;
  });
  handle('avatar:setActive', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar selection');
    const result = avatarManager.setActive(
      input.id == null ? null : boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
    );
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });
  handle('avatar:remove', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar removal');
    const result = avatarManager.remove(boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }));
    broadcast('avatar:changed', avatarManager.list());
    return result;
  });
  handle('avatar:setMapping', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar mapping');
    const category = boundedString(input.category, { label: 'mapping category', min: 1, max: 16 });
    if (!['expression', 'action'].includes(category)) throw new TypeError('avatar mapping category is invalid');
    return avatarManager.setMapping(
      boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
      category,
      boundedString(input.key, { label: 'mapping key', min: 1, max: 64 }),
      input.target == null ? null : boundedString(input.target, { label: 'mapping target', min: 1, max: 256 }),
    );
  });
  handle('avatar:addMotion', async (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar motion');
    const avatarId = boundedString(input.id, { label: 'avatar id', min: 36, max: 36 });
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 VRMA 动作', properties: ['openFile'], filters: [{ name: 'VRMA', extensions: ['vrma'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    return runAvatarMotionWorker(avatarId, result.filePaths[0]);
  });
  handle('avatar:removeMotion', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'avatar motion removal');
    return avatarManager.removeMotion(
      boundedString(input.id, { label: 'avatar id', min: 36, max: 36 }),
      boundedString(input.motionId, { label: 'motion id', min: 36, max: 36 }),
    );
  });

  handle('voicePack:list', (event) => {
    requireMainWindow(event);
    const listing = voicePackManager?.list?.() || { records: [], corrupt: [] };
    return {
      available: Boolean(voicePackManager),
      records: (listing.records || []).map(publicVoicePackRecord),
      corrupt: listing.corrupt || [],
    };
  });
  handle('voicePack:beginImport', async (event) => {
    requireMainWindow(event);
    if (!voicePackManager) throw Object.assign(new Error('Voice-pack module is unavailable'), { code: 'REVERIE_MODULE_UNAVAILABLE' });
    if (voicePackDialogPending) throw Object.assign(new Error('A voice-pack picker is already open'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    voicePackDialogPending = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 GPT-SoVITS 语音包文件夹', properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length !== 1) return null;
      return beginVoicePackWorker(result.filePaths[0]);
    } finally { voicePackDialogPending = false; }
  });
  // Drag-and-drop entry mirroring the dialog flow; copy-only semantics and
  // worker validation are unchanged.
  handle('voicePack:importDroppedPath', async (event, input = {}) => {
    requireMainWindow(event);
    assertPlainObject(input, 'voice pack drop');
    if (!voicePackManager) throw Object.assign(new Error('Voice-pack module is unavailable'), { code: 'REVERIE_MODULE_UNAVAILABLE' });
    const sourcePath = boundedString(input.path, { label: 'dropped voice pack path', min: 2, max: 1024 });
    if (voicePackDialogPending) throw Object.assign(new Error('A voice-pack import is already running'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    voicePackDialogPending = true;
    try {
      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isDirectory()) {
        throw Object.assign(
          new Error('语音包需要以文件夹形式拖入（包含 GPT/SoVITS/参考音频/文本四件）'),
          { code: 'REVERIE_VOICE_PACK_DROPPED_TYPE' },
        );
      }
      return await beginVoicePackWorker(sourcePath);
    } finally { voicePackDialogPending = false; }
  });
  handle('voicePack:commitImport', async (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'voice-pack commit');
    const previewId = boundedString(input.previewId, { label: 'voice-pack preview id', min: 36, max: 36 });
    return commitVoicePackWorker(previewId, {
        rightsAttested: input.rightsAttested === true,
        runtimeFamily: input.runtimeFamily,
        runtimeVersion: input.runtimeVersion,
    });
  });
  handle('voicePack:setActive', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'voice-pack selection');
    if (input.id == null) return { activeId: voicePackManager.setActive(null) };
    return setActiveVoicePackWorker(
      boundedString(input.id, { label: 'voice-pack id', min: 36, max: 36 }),
    );
  });
  handle('voicePack:remove', (event, input = {}) => {
    requireMainWindow(event); assertPlainObject(input, 'voice-pack removal');
    return { removed: voicePackManager.remove(
      boundedString(input.id, { label: 'voice-pack id', min: 36, max: 36 }),
    ) };
  });
  handle('ttsRuntime:status', (event) => {
    requireMainWindow(event);
    return {
      available: gptSovitsRuntimeRelease.available === true,
      state: 'unavailable',
      reason: gptSovitsRuntimeRelease.reason,
      recipeVersion: null,
    };
  });
  handle('ttsRuntime:start', (event) => {
    requireMainWindow(event);
    const error = new Error(gptSovitsRuntimeRelease.reason);
    error.code = 'REVERIE_TTS_RUNTIME_RELEASE_UNAVAILABLE';
    throw error;
  });
  handle('ttsRuntime:cancel', (event) => {
    requireMainWindow(event);
    return { cancelled: false, state: 'unavailable' };
  });
  // Companion timer. The manager is single-session, so pause/resume/stop take
  // no session id on this side; the renderer keeps one for display only.
  const requireFocus = () => {
    if (!focusManager) throw new Error('Focus service is unavailable');
    return focusManager;
  };
  handle('focus:getState', () => requireFocus().getState());
  handle('focus:start', (_event, input) => {
    assertPlainObject(input, 'focus start');
    if (Object.keys(input).some((key) => key !== 'durationSeconds')
      || !Number.isFinite(input.durationSeconds)
      || input.durationSeconds <= 0) {
      throw new TypeError('focus start payload is invalid');
    }
    return requireFocus().start({ durationSeconds: input.durationSeconds });
  });
  handle('focus:pause', () => requireFocus().pause());
  handle('focus:resume', () => requireFocus().resume());
  handle('focus:stop', () => requireFocus().stop());
  handle('focus:acknowledgeAudioRearm', () => requireFocus().acknowledgeAudioRearm());
  registerDownloadHandlers(handle);
  handle('pet:toggle', () => togglePetWindow());
  handle('pet:show', () => showPetWindow());
  handle('pet:hide', () => hidePetWindow());
  handle('pet:isVisible', () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()));
  // Manual window drag (Luna-ts pattern): the renderer streams total
  // screen-space deltas; placement is absolute from the drag start so no
  // rounding drift can accumulate. The debounced bounds persistence stays
  // wired to the window's own 'move' event.
  let petDrag = null;
  handle('pet:drag-start', (event) => {
    requirePetWindow(event);
    if (!petWindow || petWindow.isDestroyed()) return { active: false };
    petDrag = createPetDrag({
      getPosition: () => (petWindow && !petWindow.isDestroyed() ? petWindow.getPosition() : [0, 0]),
      setPosition: (x, y) => {
        if (petWindow && !petWindow.isDestroyed()) petWindow.setPosition(x, y);
      },
    });
    return { active: petDrag.begin() !== null };
  });
  handle('pet:drag-move', (event, input = {}) => {
    requirePetWindow(event);
    assertPlainObject(input, 'pet drag move');
    if (!petDrag || !petDrag.active) return { moved: false };
    const dx = Number(input.dx);
    const dy = Number(input.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)
      || Math.abs(dx) > 100_000 || Math.abs(dy) > 100_000) {
      throw new RangeError('pet drag delta is out of range');
    }
    petDrag.move(dx, dy);
    return { moved: true };
  });
  handle('pet:drag-end', (event) => {
    requirePetWindow(event);
    if (petDrag) {
      petDrag.end();
      petDrag = null;
    }
    return { ended: true };
  });
  handle('pet:sendChat', (event, input = {}) => {
    requirePetWindow(event); assertPlainObject(input, 'pet chat');
    if (petActiveRequestId) throw Object.assign(new Error('A pet chat request is already active'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    const text = boundedString(input.text, { label: 'pet chat text', min: 1, max: 2000 }).trim();
    const requestId = `pet_chat_${crypto.randomBytes(16).toString('base64url')}`;
    bridgeHostProxy.sendFromRenderer({
      type: 'chat:send',
      payload: {
        text,
        request_id: requestId,
        conversation_id: 'dream-room',
        sent_at_utc: new Date().toISOString(),
      },
      request_id: requestId,
    });
    petActiveRequestId = requestId;
    return { accepted: true, requestId };
  });
  handle('pet:cancelChat', (event) => {
    requirePetWindow(event);
    if (!petActiveRequestId) return { cancelled: false };
    bridgeHostProxy.sendFromRenderer({
      type: 'chat:cancel', payload: { request_id: petActiveRequestId },
    });
    return { cancelled: true };
  });
  handle('pet:listStickers', async (event) => {
    requirePetWindow(event);
    const result = await requestPetBridge('sticker:list', { limit: 100 }, ['sticker:data']);
    if (Array.isArray(result.items)) {
      petStickerCache = result.items;
      petStickerCacheAt = Date.now();
    }
    return { items: petStickerCache };
  });
  handle('pet:importSticker', async (event) => {
    requirePetWindow(event);
    const result = await dialog.showOpenDialog(petWindow, {
      title: '选择表情图片', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    if (result.canceled || result.filePaths.length !== 1) return { canceled: true };
    const imported = await requestPetBridge('sticker:import', {
      file_path: result.filePaths[0], style_tags: ['用户导入'],
    }, ['sticker:data'], 30_000);
    return { canceled: false, item: imported.item || null };
  });
  handle('pet:sendSticker', (event, input = {}) => {
    requirePetWindow(event); assertPlainObject(input, 'pet sticker');
    if (petActiveRequestId) throw Object.assign(new Error('A pet chat request is already active'), { code: 'REVERIE_OPERATION_IN_PROGRESS' });
    const id = boundedString(input.id, { label: 'sticker id', min: 1, max: 128 });
    if (Date.now() - petStickerCacheAt > PET_STICKER_CACHE_TTL_MS) {
      throw Object.assign(new Error('The sticker library is stale; reopen the sticker tray first'), {
        code: 'REVERIE_STICKER_CACHE_STALE',
      });
    }
    const sticker = petStickerCache.find((item) => item && String(item.id) === id);
    if (!sticker) throw new TypeError('Sticker is not in the current local library');
    const requestId = `pet_chat_${crypto.randomBytes(16).toString('base64url')}`;
    const wire = {
      id,
      text: typeof sticker.text === 'string' ? sticker.text.slice(0, 80) : '',
      emotions: Array.isArray(sticker.emotions)
        ? sticker.emotions.filter((item) => typeof item === 'string').slice(0, 8) : [],
      image_data_url: typeof sticker.image_data_url === 'string' ? sticker.image_data_url : '',
      style_tags: Array.isArray(sticker.style_tags)
        ? sticker.style_tags.filter((item) => typeof item === 'string').slice(0, 8) : [],
    };
    bridgeHostProxy.sendFromRenderer({
      type: 'chat:send',
      payload: {
        text: wire.text || '[表情]', request_id: requestId, conversation_id: 'dream-room',
        sent_at_utc: new Date().toISOString(), sticker: wire,
      },
      request_id: requestId,
    });
    petActiveRequestId = requestId;
    return { accepted: true, requestId };
  });
}

function createTray() {
  if (tray) return;
  let icon = getWindowIconPath();
  if (process.platform === 'darwin') {
    // AppKit cannot load ICO directly. Reuse its approved embedded PNG frame
    // rather than introducing another logo or modifying the Windows resource.
    const ico = fs.readFileSync(icon);
    let png;
    for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
      const entry = 6 + index * 16;
      if (ico[entry] !== 32 || ico[entry + 1] !== 32) continue;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      png = ico.subarray(offset, offset + length);
      break;
    }
    if (!png) throw new Error('Approved tray icon has no 32px PNG frame');
    icon = nativeImage.createFromBuffer(png);
    if (icon.isEmpty()) throw new Error('Approved tray PNG could not be decoded');
    icon = icon.resize({ width: 18, height: 18 });
  }
  tray = new Tray(icon);
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
  const rendererStartedAt = process.hrtime.bigint();
  windowRef.once('ready-to-show', () => windowRef.show());
  windowRef.webContents.once('did-finish-load', () => {
    logStartupStage('renderer-loaded', rendererStartedAt, { renderer: IS_DEV ? 'development' : 'reverie-app' });
  });
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

const PET_WINDOW_SIZE = { width: 460, height: 680 };

function trustedWindows() {
  // The registrar accepts IPC only from these windows. The desktop pet uses a
  // separate narrow preload; channel handlers still validate the exact sender.
  return [mainWindow, petWindow].filter((windowRef) => Boolean(windowRef));
}

function petWindowIsAlive() {
  return Boolean(petWindow && !petWindow.isDestroyed());
}

function createPetWindow() {
  if (petWindowIsAlive()) return petWindow;
  const bounds = mainWindow?.getBounds?.() || screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const fallback = {
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    x: Math.min(
    workArea.x + workArea.width - PET_WINDOW_SIZE.width,
    Math.max(workArea.x, bounds.x + (bounds.width || 0) - PET_WINDOW_SIZE.width - 24),
    ),
    y: Math.min(
    workArea.y + workArea.height - PET_WINDOW_SIZE.height,
    Math.max(workArea.y, bounds.y + 24),
    ),
  };
  const savedBounds = petBoundsStore?.load?.();
  const initialBounds = clampBounds(savedBounds, screen.getAllDisplays(), fallback);
  petWindow = new BrowserWindow({
    ...initialBounds,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 360,
    minHeight: 520,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Reverie 桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
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
  const createdPetWindow = petWindow;
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
  let saveBoundsTimer = null;
  const persistBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (createdPetWindow.isDestroyed() || petWindow !== createdPetWindow) return;
      const current = createdPetWindow.getBounds();
      const currentDisplay = screen.getDisplayMatching(current);
      try {
        petBoundsStore?.save?.(currentDisplay.id, current, currentDisplay.scaleFactor);
      } catch (error) {
        console.warn('[Electron] Desktop pet bounds could not be saved', error);
      }
    }, 250);
    saveBoundsTimer.unref?.();
  };
  petWindow.on('move', persistBounds);
  petWindow.on('resize', persistBounds);
  petWindow.on('closed', () => {
    clearTimeout(saveBoundsTimer);
    if (petWindow === createdPetWindow) petWindow = null;
  });
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

const hasSingleInstanceLock = acquireSingleInstance(app, showMainWindow, {
  // A redirected second launch must not look like a dead app: raise the
  // existing window and tell the user what happened.
  onRedirected: () => {
    showNativeNotification('Reverie', 'Reverie 已在运行，已为你聚焦现有窗口。');
  },
});
if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    setupLogging();
    logStartupStage('main-ready', null, { isPackaged: app.isPackaged, platform: process.platform, architecture: process.arch });
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
    if (installVideoAssetProtocol && videoAssetsRoot) {
      unregisterVideoAssetProtocol = installVideoAssetProtocol(
        protocol,
        videoAssetsRoot,
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

    // Proactive companion reminders are written to the on-disk outbox by the
    // Python host. Without this poll the files accumulate and no reminder
    // ever reaches the user; each file carries its own 12h TTL.
    pollNotificationOutbox();
    notificationPollTimer = setInterval(pollNotificationOutbox, 15_000);
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
    for (const pending of petBridgeRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('Reverie is shutting down'), { code: 'REVERIE_SHUTDOWN' }));
    }
    petBridgeRequests.clear();
    for (const session of voicePackImportSessions.values()) {
      clearTimeout(session.expiry);
      void session.worker.terminate();
    }
    voicePackImportSessions.clear();
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
    unregisterVideoAssetProtocol?.();
    unregisterVideoAssetProtocol = null;
    unregisterLive2DCoreProtocol?.();
    unregisterLive2DCoreProtocol = null;
    tray?.destroy();
    tray = null;
    restoreConsole?.();
    restoreConsole = null;
    app.exit(0);
  })();
});
