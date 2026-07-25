/**
 * Legacy preload retained outside packaged and corresponding-source directories for source
 * archaeology only. It is not loaded by the desktop host.
 * Electron 预加载脚本 — 安全地暴露 IPC API 给渲染进程。
 *
 * 通过 contextBridge 将有限的 API 暴露到 window.electronAPI，
 * 渲染进程不能直接访问 Node.js API。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── 下载 ──────────────────────────────────────────
  downloadStart: (url, filename) =>
    ipcRenderer.invoke('download:start', { url, filename }),

  downloadDirect: (url, filename) =>
    ipcRenderer.invoke('download:direct', { url, filename }),

  downloadM3u8: (url, baseUrl, m3u8Content) =>
    ipcRenderer.invoke('download:m3u8', { url, baseUrl, m3u8Content }),

  onDownloadProgress: (callback) => {
    ipcRenderer.on('download:progress', (_event, progress) => callback(progress));
  },

  // ── 资源嗅探 ──────────────────────────────────────
  sniffResources: () => ipcRenderer.invoke('sniff:resources'),

  sniffM3u8: (url) => ipcRenderer.invoke('sniff:m3u8', url),

  // ── 对话框 ────────────────────────────────────────
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (defaultPath, content) =>
    ipcRenderer.invoke('dialog:saveFile', { defaultPath, content }),

  // ── 应用信息 ──────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  showNotification: (title, body) =>
    ipcRenderer.invoke('notification:show', { title, body }),

  getNotificationStatus: () => ipcRenderer.invoke('notification:status'),

  onAppLifecycle: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:lifecycle', listener);
    return () => ipcRenderer.removeListener('app:lifecycle', listener);
  },

  // ── 外部链接 ──────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ── 平台 ──────────────────────────────────────────
  platform: process.platform,
});
