/**
 * Legacy host retained outside packaged and corresponding-source directories for source
 * archaeology only. It is not an application entry point.
 * Electron main process for the Reverie desktop shell.
 * It starts the Python bridge, mounts the renderer, and records enough
 * diagnostics to explain a blank window instead of silently showing one.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
  Tray,
  Menu,
  powerMonitor,
} = require('electron');
const { parseNotificationTimestamp } = require('./notification-outbox.cjs');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { registerDownloadIPC } = require('../../src/download_service/electron_adapter');

const WS_PORT = 48913;
const FRONTEND_DEV_URL = 'http://localhost:5173';
const IS_DEV = !app.isPackaged;
const APP_USER_MODEL_ID = 'studio.muhe.reverie';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow = null;
let pythonProcess = null;
let logFilePath = null;
let tray = null;
let isQuitting = false;
let notificationPollTimer = null;
let inactivityTimer = null;
let backendRestartTimer = null;
let backendStableTimer = null;
let backendRestartAttempts = 0;
let backendStopping = false;

const userDataOverride = process.env.REVERIE_USER_DATA_DIR;
if (userDataOverride) {
  const resolvedUserData = path.resolve(userDataOverride);
  fs.mkdirSync(resolvedUserData, { recursive: true });
  app.setPath('userData', resolvedUserData);
}

function formatLogArg(arg) {
  if (arg instanceof Error) {
    return `${arg.stack || arg.message}`;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function setupFileLogging() {
  if (logFilePath) {
    return;
  }

  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'electron-renderer-startup.log');
  fs.appendFileSync(logFilePath, `\n=== Reverie Electron start ${new Date().toISOString()} ===\n`, 'utf-8');

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  const write = (level, args) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogArg).join(' ')}\n`;
    try {
      fs.appendFileSync(logFilePath, line, 'utf-8');
    } catch {}
  };

  console.log = (...args) => {
    originalLog(...args);
    write('INFO', args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    write('WARN', args);
  };
  console.error = (...args) => {
    originalError(...args);
    write('ERROR', args);
  };

  console.log('[Electron] Log file:', logFilePath);
}

function getRuntimeRoot() {
  return IS_DEV ? path.join(__dirname, '..', '..') : process.resourcesPath;
}

function getPythonCommand() {
  const executable = process.platform === 'win32' ? 'python.exe' : 'python';
  const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const bundledPython = path.join(getRuntimeRoot(), 'venv', scriptsDir, executable);
  if (fs.existsSync(bundledPython)) {
    return bundledPython;
  }
  if (!IS_DEV) {
    throw new Error('Bundled Python runtime is missing');
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getPythonArgs() {
  const mainScript = path.join(getRuntimeRoot(), 'src', 'main.py');
  return [mainScript, '--bridge', `--port=${WS_PORT}`];
}

function copyMissingData(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyMissingData(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function prepareWritableDataDir() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!IS_DEV) {
    copyMissingData(path.join(getRuntimeRoot(), 'data'), dataDir);
  }
  return dataDir;
}

function getWindowIconPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'public', 'favicon.jpg')
    : path.join(__dirname, '..', 'dist', 'favicon.jpg');
}

function startPythonBackend() {
  if (pythonProcess || isQuitting) return;
  backendStopping = false;
  let args;
  let pythonCommand;
  let dataDir;
  try {
    args = getPythonArgs();
    pythonCommand = getPythonCommand();
    dataDir = prepareWritableDataDir();
  } catch (error) {
    console.error('[Electron] Could not prepare Python bridge:', error);
    scheduleBackendRestart(error instanceof Error ? error.message : String(error));
    return;
  }
  console.log('[Electron] Starting Python bridge:', pythonCommand, args.join(' '));

  let child;
  try {
    child = spawn(pythonCommand, args, {
      cwd: getRuntimeRoot(),
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        REVERIE_BRIDGE_MODE: '1',
        REVERIE_DATA_DIR: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.error('[Electron] Python bridge spawn failed:', error);
    scheduleBackendRestart(error instanceof Error ? error.message : String(error));
    return;
  }
  pythonProcess = child;

  child.stdout.on('data', (data) => {
    console.log('[Python]', data.toString().trim());
  });

  child.stderr.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      if (/\b(DEBUG|INFO)\b/.test(line)) {
        console.log('[Python]', line);
      } else if (/\b(WARNING|WARN)\b/.test(line)) {
        console.warn('[Python WARN]', line);
      } else {
        console.error('[Python ERR]', line);
      }
    }
  });

  clearTimeout(backendStableTimer);
  backendStableTimer = setTimeout(() => {
    if (pythonProcess === child && child.exitCode === null) backendRestartAttempts = 0;
  }, 60_000);

  child.on('close', (code) => {
    console.log('[Python] Process exited with code:', code);
    clearTimeout(backendStableTimer);
    backendStableTimer = null;
    if (pythonProcess === child) pythonProcess = null;
    scheduleBackendRestart(`exit code ${code}`);
  });

  child.on('error', (err) => {
    console.error('[Python] Failed to start:', err.message);
    clearTimeout(backendStableTimer);
    backendStableTimer = null;
    if (pythonProcess === child) pythonProcess = null;
    scheduleBackendRestart(err.message);
  });
}

function scheduleBackendRestart(reason) {
  if (isQuitting || backendStopping || backendRestartTimer || pythonProcess) return;
  const delayMs = Math.min(30_000, 1000 * (2 ** Math.min(backendRestartAttempts, 5)));
  backendRestartAttempts += 1;
  console.warn(`[Electron] Python bridge unavailable (${reason}); retrying in ${delayMs}ms`);
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    startPythonBackend();
  }, delayMs);
}

function stopPythonBackend() {
  backendStopping = true;
  clearTimeout(backendRestartTimer);
  clearTimeout(backendStableTimer);
  backendRestartTimer = null;
  backendStableTimer = null;
  if (!pythonProcess) {
    return;
  }
  console.log('[Electron] Stopping Python bridge');
  pythonProcess.kill('SIGTERM');
  pythonProcess = null;
}

function sendLifecycle(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:lifecycle', { state, at: new Date().toISOString() });
}

function sendCurrentWindowLifecycle() {
  const active = mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.isVisible()
    && mainWindow.isFocused();
  sendLifecycle(active ? 'active' : 'hidden');
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  sendLifecycle('active');
}

function showNativeNotification(title, body) {
  const safeTitle = String(title || 'Reverie').replace(/[\r\n\0]/g, ' ').trim().slice(0, 80) || 'Reverie';
  const safeBody = String(body || '').replace(/[\0]/g, '').trim().slice(0, 500);
  if (!safeBody || !Notification.isSupported()) return false;
  const notification = new Notification({ title: safeTitle, body: safeBody, silent: false });
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
      .filter((name) => /^[a-zA-Z0-9_.-]+\.json$/.test(name))
      .sort()
      .slice(0, 20);
    for (const name of files) {
      const filePath = path.join(outbox, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('invalid notification file');
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (payload.schema !== 'reverie.notification.v1') throw new Error('unknown notification schema');
        const createdAt = parseNotificationTimestamp(payload.created_at);
        if (!Number.isFinite(createdAt)) throw new Error('invalid notification timestamp');
        if (Date.now() - createdAt > 12 * 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          continue;
        }
        const shouldShow = !payload.only_when_unfocused
          || !mainWindow
          || mainWindow.isDestroyed()
          || !mainWindow.isVisible()
          || !mainWindow.isFocused();
        if (shouldShow) showNativeNotification(payload.title, payload.body);
        fs.unlinkSync(filePath);
      } catch (error) {
        console.warn('[Electron] Quarantining invalid notification outbox item', name, error);
        const rejectedDir = path.join(outbox, '..', 'rejected');
        fs.mkdirSync(rejectedDir, { recursive: true });
        try { fs.renameSync(filePath, path.join(rejectedDir, `${Date.now()}-${name}`)); } catch {}
      }
    }
  } catch (error) {
    console.warn('[Electron] Notification outbox poll failed', error);
  }
}

function startNotificationOutboxPolling() {
  if (notificationPollTimer) return;
  pollNotificationOutbox();
  notificationPollTimer = setInterval(pollNotificationOutbox, 5000);
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

function safeLoadFallback(reason) {
  if (!mainWindow) {
    return;
  }

  const escapedReason = String(reason || 'unknown error')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const fallbackHtml = `
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Reverie startup failed</title></head>
      <body style="margin:0;background:#141727;color:#f0f1f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
        <div style="max-width:720px;padding:24px;line-height:1.6;">
          <h1>Reverie renderer did not mount</h1>
          <p>The Electron host is alive, but the renderer could not be loaded.</p>
          <p>Reason: <code>${escapedReason}</code></p>
          <p>Check <code>electron-renderer-startup.log</code> for did-fail-load, DOM snapshot, and route-hit records.</p>
        </div>
      </body>
    </html>
  `;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml)}`);
  mainWindow.show();
}

function installRendererDiagnostics(windowRef) {
  windowRef.once('ready-to-show', () => {
    console.log('[Electron] BrowserWindow ready-to-show');
    windowRef.show();
  });

  windowRef.webContents.on('did-start-loading', () => {
    console.log('[Electron] Renderer started loading');
  });

  windowRef.webContents.on('dom-ready', () => {
    console.log('[Electron] Renderer DOM ready', windowRef.webContents.getURL());
  });

  windowRef.webContents.on('did-navigate', (_event, url) => {
    console.log('[Electron] Renderer navigated', url);
  });

  windowRef.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    console.log('[Electron] Renderer in-page navigation', { url, isMainFrame });
  });

  windowRef.webContents.on('did-finish-load', async () => {
    console.log('[Electron] Renderer finished load');
    try {
      const snapshot = await windowRef.webContents.executeJavaScript(`
        ({
          href: window.location.href,
          pathname: window.location.pathname,
          hash: window.location.hash,
          bodyClass: document.body.className,
          rootChildren: document.getElementById('root')?.childElementCount ?? -1,
          bodyText: document.body.innerText.slice(0, 160)
        })
      `);
      console.log('[Electron] Renderer DOM snapshot', snapshot);
    } catch (error) {
      console.error('[Electron] Failed to inspect renderer DOM', error);
    }
  });

  windowRef.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[Electron] Renderer failed to load', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    });
  });

  windowRef.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Electron] Renderer process gone', details);
  });

  windowRef.webContents.on('console-message', (details) => {
    const isError = details.level === 'error' || details.level === 'warning';
    const prefix = isError ? '[Renderer ERR]' : '[Renderer]';
    console.log(prefix, details.message, `(${details.sourceId || 'unknown'}:${details.lineNumber || 0})`);
  });

  windowRef.on('unresponsive', () => {
    console.error('[Electron] Window became unresponsive');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Reverie',
    icon: getWindowIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Timers that matter live in Python/Electron. Keep renderer throttling for power use.
      backgroundThrottling: true,
    },
    frame: true,
    backgroundColor: '#141727',
  });

  installRendererDiagnostics(mainWindow);

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn('[Electron] Window was still hidden after startup timeout; showing it for diagnostics');
      mainWindow.show();
    }
  }, 4000);

  if (IS_DEV) {
    mainWindow.loadURL(FRONTEND_DEV_URL).catch((error) => {
      console.error('[Electron] Failed to load dev URL', error);
      safeLoadFallback(error.message);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('[Electron] Loading packaged renderer:', indexPath);
    mainWindow.loadFile(indexPath).catch((error) => {
      console.error('[Electron] Failed to load packaged renderer', error);
      safeLoadFallback(error.message);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    sendLifecycle('hidden');
  });
  mainWindow.on('minimize', () => sendLifecycle('inactive'));
  mainWindow.on('restore', () => sendLifecycle('active'));
  mainWindow.on('blur', () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => sendLifecycle('inactive'), 30_000);
  });
  mainWindow.on('focus', () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
    sendLifecycle('active');
  });
}

ipcMain.handle('download:start', async (_event, { url, filename }) => {
  const savePath = dialog.showSaveDialogSync(mainWindow, {
    defaultPath: filename || 'download',
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (!savePath) {
    return { cancelled: true };
  }

  mainWindow.webContents.downloadURL(url);
  return { path: savePath, cancelled: false };
});

ipcMain.handle('download:progress', (_event, progress) => {
  if (mainWindow) {
    mainWindow.webContents.send('download:progress', progress);
  }
});

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return result.filePaths;
});

ipcMain.handle('dialog:saveFile', async (_event, { defaultPath, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath });
  if (result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { path: result.filePath };
  }
  return { cancelled: true };
});

ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('notification:show', (_event, payload = {}) => ({
  shown: showNativeNotification(payload.title, payload.body),
}));
ipcMain.handle('notification:status', () => ({
  supported: Notification.isSupported(),
  platform: process.platform,
  permission: process.platform === 'win32' ? 'managed_by_windows' : 'runtime',
  appUserModelId: process.platform === 'win32' ? APP_USER_MODEL_ID : '',
  installedIdentity: app.isPackaged,
}));
ipcMain.handle('shell:openExternal', (_event, value) => {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Only HTTP(S) links may be opened externally');
  }
  return shell.openExternal(url.toString());
});

app.whenReady().then(() => {
  setupFileLogging();
  startPythonBackend();
  createWindow();
  createTray();
  startNotificationOutboxPolling();
  registerDownloadIPC(mainWindow);

  powerMonitor.on('suspend', () => sendLifecycle('suspend'));
  powerMonitor.on('lock-screen', () => sendLifecycle('lock-screen'));
  powerMonitor.on('resume', sendCurrentWindowLifecycle);
  powerMonitor.on('unlock-screen', sendCurrentWindowLifecycle);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      registerDownloadIPC(mainWindow);
    } else {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // The tray owns the long-running companion lifecycle on Windows.
  if (process.platform === 'darwin' && isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(inactivityTimer);
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
  stopPythonBackend();
  tray?.destroy();
  tray = null;
});
