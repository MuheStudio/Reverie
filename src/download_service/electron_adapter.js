/**
 * cat-catch → Electron 下载适配器。
 *
 * 将浏览器扩展的嗅探逻辑适配到 Electron 桌面环境：
 *   - 替换 chrome.* API → Electron IPC + Node.js
 *   - 提取 m3u8/mpd 解析核心逻辑
 *   - 集成 Electron downloadItem API
 *
 * 原始项目: cat-catch (GPL-3.0) by xifangczy
 * 适配修改: Muhe Studio 2026
 */
const { ipcMain, BrowserWindow } = require('electron');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

// ── 资源嗅探结果 ──────────────────────────────────────

class SniffResult {
  constructor() {
    /** @type {Array<{url: string, type: string, size: number, title: string}>} */
    this.resources = [];
  }

  add(url, type, size = 0, title = '') {
    this.resources.push({ url, type, size, title });
  }

  toJSON() {
    return this.resources;
  }
}

// ── MIME 类型推断 ─────────────────────────────────────

const MIME_MAP = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.mov': 'video/quicktime',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/x-rar-compressed',
};

function guessType(url, contentType = '') {
  if (contentType && contentType !== 'application/octet-stream') {
    return contentType.split(';')[0].trim();
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const [ext, mime] of Object.entries(MIME_MAP)) {
      if (pathname.endsWith(ext)) return mime;
    }
  } catch {}
  return 'application/octet-stream';
}

function isMediaType(mimeType) {
  return (
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('image/') ||
    mimeType === 'application/vnd.apple.mpegurl' ||
    mimeType === 'application/dash+xml'
  );
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return '0 B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

// ── m3u8 解析 ────────────────────────────────────────

function parseM3U8(content) {
  const lines = content.split('\n');
  const segments = [];
  let currentInfo = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const durMatch = trimmed.match(/#EXTINF:([\d.]+)/);
      currentInfo.duration = durMatch ? parseFloat(durMatch[1]) : 0;
      const titleMatch = trimmed.match(/,(.+)$/);
      currentInfo.title = titleMatch ? titleMatch[1].trim() : '';
    } else if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
      currentInfo.bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      const resMatch = trimmed.match(/RESOLUTION=(\d+x\d+)/);
      currentInfo.resolution = resMatch ? resMatch[1] : '';
    } else if (trimmed && !trimmed.startsWith('#')) {
      segments.push({
        url: trimmed,
        duration: currentInfo.duration || 0,
        bandwidth: currentInfo.bandwidth || 0,
        resolution: currentInfo.resolution || '',
        title: currentInfo.title || '',
      });
      currentInfo = {};
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  return {
    segments,
    totalDuration,
    segmentCount: segments.length,
    isMaster: segments.some((s) => s.url.endsWith('.m3u8')),
  };
}

// ── 资源拦截与嗅探 ────────────────────────────────────

function setupSniffing(mainWindow) {
  const result = new SniffResult();

  // 拦截 webRequest
  const filter = {
    urls: ['*://*/*'],
    types: ['media', 'image', 'xmlhttprequest', 'other'],
  };

  mainWindow.webContents.session.webRequest.onCompleted(filter, (details) => {
    const mimeType = guessType(details.url, details.responseHeaders?.['content-type']?.[0]);
    if (isMediaType(mimeType)) {
      const size = parseInt(details.responseHeaders?.['content-length']?.[0] || '0');
      result.add(details.url, mimeType, size);
    }
  });

  // 监听页面中的媒体元素
  mainWindow.webContents.on('media-started-playing', (_event, media) => {
    result.add(media.src || media.currentSrc, 'media');
  });

  return result;
}

// ── m3u8 下载器 ──────────────────────────────────────

async function downloadM3U8Segments(m3u8Url, baseUrl, m3u8Content, onProgress) {
  const parsed = parseM3U8(m3u8Content);
  const segments = parsed.segments;
  const total = segments.length;
  const buffers = [];

  for (let i = 0; i < total; i++) {
    const seg = segments[i];
    const segUrl = seg.url.startsWith('http')
      ? seg.url
      : new URL(seg.url, baseUrl || m3u8Url).href;

    try {
      const resp = await fetch(segUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      buffers.push(buf);
      if (onProgress) {
        onProgress({ current: i + 1, total, percentage: Math.round(((i + 1) / total) * 100) });
      }
    } catch (err) {
      console.error(`[cat-catch] 下载分段失败 (${i + 1}/${total}):`, err.message);
    }
  }

  return Buffer.concat(buffers);
}

// ── Electron IPC 注册 ────────────────────────────────

function registerDownloadIPC(mainWindow) {
  // 嗅探当前页面的资源
  ipcMain.handle('sniff:resources', () => {
    // 通过 webContents 执行 JavaScript 提取页面中的媒体 URL
    return mainWindow.webContents.executeJavaScript(`
      (() => {
        const resources = [];
        // 提取 video/audio 元素
        document.querySelectorAll('video, audio').forEach(el => {
          const src = el.currentSrc || el.src;
          if (src) resources.push({ url: src, type: el.tagName.toLowerCase(), title: document.title });
          el.querySelectorAll('source').forEach(s => {
            if (s.src) resources.push({ url: s.src, type: s.type || 'media', title: document.title });
          });
        });
        // 提取图片
        document.querySelectorAll('img').forEach(el => {
          if (el.src && el.naturalWidth > 100) {
            resources.push({ url: el.src, type: 'image/' + (el.src.split('.').pop() || 'jpg'), title: el.alt || document.title, size: el.naturalWidth * el.naturalHeight });
          }
        });
        return resources;
      })()
    `).catch(() => []);
  });

  // 嗅探 m3u8 内容
  ipcMain.handle('sniff:m3u8', async (_event, url) => {
    try {
      const resp = await fetch(url);
      const content = await resp.text();
      return parseM3U8(content);
    } catch (err) {
      return { error: err.message };
    }
  });

  // 执行 m3u8 下载
  ipcMain.handle('download:m3u8', async (event, { url, baseUrl, m3u8Content }) => {
    const onProgress = (progress) => {
      mainWindow.webContents.send('download:progress', progress);
    };
    const buffer = await downloadM3U8Segments(url, baseUrl, m3u8Content, onProgress);
    // 暂存到临时文件
    const tmpDir = path.join(require('os').tmpdir(), 'reverie-downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `m3u8_${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, buffer);
    return { path: tmpFile, size: buffer.length };
  });

  // 通用下载（使用 Electron 内置下载管理器）
  ipcMain.handle('download:direct', async (_event, { url, filename }) => {
    const { dialog } = require('electron');
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: filename || path.basename(new URL(url).pathname) || 'download',
    });
    if (!savePath) return { cancelled: true };

    mainWindow.webContents.downloadURL(url);

    // 监听下载完成
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

// ── 导出 ──────────────────────────────────────────────

module.exports = {
  SniffResult,
  parseM3U8,
  guessType,
  isMediaType,
  formatSize,
  setupSniffing,
  downloadM3U8Segments,
  registerDownloadIPC,
};
