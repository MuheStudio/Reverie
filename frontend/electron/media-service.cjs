'use strict';

// First-party host coordination written from the download capability contract.
// Parsing/transport/DOM discovery are independent modules; no legacy adapter
// or browser-extension runtime is loaded. Repository licensing remains in force.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMediaTransport } = require('./media-transfer.cjs');
const { parsePlaylist, analyzePlaylist, assertDownloadablePlaylist } = require('./media-playlist.cjs');
const { collectResourcesScript } = require('./media-resources.cjs');

const MANIFEST_BYTES = 1024 * 1024;
const INPUT_BYTES = 8 * 1024 * 1024;
const MANIFEST_TIMEOUT_MS = 15000;
const TRANSFER_TIMEOUT_MS = 300000;
const MIB = 1024 * 1024;

function problem(code, message = code) { return Object.assign(new Error(message), { code }); }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Download input must be an object');
  return value;
}
function text(value, name, maximum, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}
function mediaUrl(value, name = 'Download URL') {
  const raw = text(value, name, 2048);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${name} is invalid`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || /[\\\s\u0000-\u001f\u007f]/.test(raw)) throw new TypeError(`${name} must use HTTP(S) without credentials`);
  return raw;
}
function integerSetting(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}
function limits(features) {
  return {
    maxBytes: integerSetting(features.video_max_size_mb, 500, 4096) * MIB,
    duration: integerSetting(features.video_max_duration_seconds, 1800, 21600),
    quotaBytes: integerSetting(features.video_total_quota_mb, 4096, 51200) * MIB,
  };
}
function cacheUsage(directory) {
  let total = 0, count = 0;
  for (const entry of fs.readdirSync(directory)) {
    if (++count > 10000) throw problem('REVERIE_DOWNLOAD_QUOTA', 'Download cache has too many entries');
    const stat = fs.lstatSync(path.join(directory, entry));
    if (!stat.isFile() || stat.isSymbolicLink()) throw problem('REVERIE_DOWNLOAD_CACHE', 'Unsafe download cache entry');
    total += stat.size;
    if (!Number.isSafeInteger(total)) throw problem('REVERIE_DOWNLOAD_QUOTA');
  }
  return total;
}
function safeDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw problem('REVERIE_DOWNLOAD_CACHE');
  const resolved = path.resolve(directory);
  if (resolved.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) {
    throw problem('REVERIE_DOWNLOAD_CACHE', 'Downloads cannot write into an application');
  }
  // Check ancestors before mkdir; do not create anything through a redirected path.
  for (let current = resolved; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw problem('REVERIE_DOWNLOAD_CACHE', 'Download cache path is redirected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return fs.realpathSync(resolved);
}

function cancellable(pending, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || problem('ABORT_ERR'));
    signal.addEventListener('abort', abort, { once: true });
    // Observe late native dialog completion/rejection, but never use its path
    // after the owning operation has been cancelled.
    Promise.resolve(pending).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

function createMediaService(options) {
  for (const name of ['getWindow', 'getFeatures', 'getGate', 'getCacheDirectory', 'chooseSavePath']) {
    if (typeof options?.[name] !== 'function') throw new TypeError(`Media service requires ${name}`);
  }
  let active = null;
  let disposed = false;
  function guard(network = true) {
    if (disposed) throw problem('REVERIE_SHUTDOWN');
    if (options.getFeatures()?.download_service_enabled !== true) throw problem('REVERIE_DOWNLOAD_SERVICE_DISABLED');
    if (network) {
      const gate = options.getGate();
      if (!gate || typeof gate.snapshot !== 'function') throw problem('REVERIE_NETWORK_GATE_UNAVAILABLE');
      if (gate.snapshot().active) throw problem('REVERIE_LOCAL_MODE', 'Downloads are disabled during local focus mode');
    }
  }
  const transport = options.transport || createMediaTransport({ requireRemote: () => guard() });
  function windowFor(event) {
    const window = options.getWindow();
    if (!window || window.isDestroyed?.() || !event?.sender || window.webContents !== event.sender || event.sender.isDestroyed?.()) {
      throw problem('REVERIE_DOWNLOAD_SENDER', 'Downloads require the active main window');
    }
    return window;
  }
  function warning(result) {
    if (!result.cleanupPending) return {};
    try { options.onDiagnostic?.({ code: 'REVERIE_DOWNLOAD_CLEANUP_PENDING', path: result.cleanupPending }); } catch {}
    return { warning: '下载已完成，但临时文件清理未完成。' };
  }
  async function networkJob(event, operation) {
    guard();
    const window = windowFor(event);
    if (active) throw problem('REVERIE_DOWNLOAD_BUSY', 'Another media request is still active');
    const controller = new AbortController();
    const job = { controller, sender: event.sender, promise: null };
    active = job;
    const cancel = () => controller.abort(problem('ABORT_ERR', 'Download owner closed'));
    event.sender.once?.('destroyed', cancel);
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason || problem('ABORT_ERR');
      guard(); windowFor(event);
    };
    const timer = setInterval(() => { try { check(); } catch (error) { controller.abort(error); } }, 100);
    timer.unref?.();
    const onProgress = (progress) => {
      try { check(); event.sender.send('download:progress', progress); }
      catch (error) { controller.abort(error); }
    };
    job.promise = Promise.resolve().then(() => {
      check();
      return operation({ window, signal: controller.signal, check, onProgress });
    });
    try { return await job.promise; }
    finally {
      clearInterval(timer);
      event.sender.removeListener?.('destroyed', cancel);
      if (active === job) active = null;
    }
  }

  return {
    async sniffResources(event) {
      guard(false);
      const window = options.getWindow();
      if (!window || window.isDestroyed?.()) return [];
      windowFor(event);
      try {
        const result = await window.webContents.executeJavaScript(collectResourcesScript);
        guard(false); windowFor(event);
        if (!Array.isArray(result) || result.length > 1000) return [];
        return result.filter(item => item && typeof item.url === 'string' && item.url.length <= 2048
          && typeof item.type === 'string' && item.type.length <= 256
          && typeof item.title === 'string' && item.title.length <= 4096
          && (item.size == null || Number.isFinite(item.size) && item.size >= 0))
          .map(({ url, type, title, size }) => ({ url, type, title, ...(size == null ? {} : { size }) }));
      } catch (error) {
        // A renderer that vanished is equivalent to an empty DOM snapshot;
        // policy failures remain refusals rather than silently becoming data.
        guard(false);
        if (options.getWindow()?.webContents !== event.sender || event.sender.isDestroyed?.()) return [];
        return [];
      }
    },
    async sniffM3u8(event, value) {
      guard(); windowFor(event);
      const url = mediaUrl(value, 'Playlist URL');
      try {
        return await networkJob(event, async ({ signal, check }) => {
          const response = await transport.fetchTextResponse(url, { signal, maxBytes: MANIFEST_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS });
          check();
          return { ...parsePlaylist(response.text, { maxBytes: MANIFEST_BYTES }), sourceUrl: response.url };
        });
      } catch (error) {
        return { error: String(error?.message || 'Playlist request failed') };
      }
    },
    async downloadM3u8(event, value) {
      guard(); windowFor(event);
      const input = record(value), url = mediaUrl(input.url);
      const base = input.baseUrl == null || input.baseUrl === '' ? url : mediaUrl(input.baseUrl, 'Playlist base URL');
      const content = text(input.m3u8Content, 'Playlist content', INPUT_BYTES);
      const analysis = analyzePlaylist(content, { maxBytes: INPUT_BYTES });
      const playlist = assertDownloadablePlaylist(analysis);
      const budget = limits(options.getFeatures());
      if (playlist.totalDuration > budget.duration) throw problem('REVERIE_DOWNLOAD_DURATION', 'Playlist exceeds the duration limit');
      const urls = playlist.segments.map(segment => mediaUrl(new URL(segment.url, base).href, 'Segment URL'));
      return networkJob(event, async ({ signal, check, onProgress }) => {
        check();
        const directory = safeDirectory(options.getCacheDirectory());
        const available = budget.quotaBytes - cacheUsage(directory);
        if (available <= 0) throw problem('REVERIE_DOWNLOAD_QUOTA', 'Download cache quota is exhausted');
        const destination = path.join(directory, `media-${randomUUID()}.ts`);
        const result = await transport.downloadSegmentsToFile(urls, destination, { signal,
          maxBytes: Math.min(budget.maxBytes, available), timeoutMs: TRANSFER_TIMEOUT_MS, onProgress, segmentValidation: 'mpeg-ts' });
        // Transport commits synchronously after its final policy check. A later
        // cancellation cannot turn a completed publication into a false failure.
        return { path: result.path, size: result.bytes, ...warning(result) };
      });
    },
    async downloadDirect(event, value) {
      guard(); windowFor(event);
      const input = record(value), url = mediaUrl(input.url);
      const requestedName = input.filename == null ? path.basename(new URL(url).pathname) || 'download'
        : text(input.filename, 'Download filename', 512);
      const defaultPath = requestedName.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
      return networkJob(event, async ({ window, signal, check, onProgress }) => {
        const destination = await cancellable(options.chooseSavePath(window, { defaultPath }), signal);
        if (!destination) return { cancelled: true };
        check();
        const result = await transport.downloadToFile(url, destination, { signal,
          maxBytes: limits(options.getFeatures()).maxBytes, timeoutMs: TRANSFER_TIMEOUT_MS, onProgress });
        return { path: result.path, size: result.bytes, state: 'completed', cancelled: false, ...warning(result) };
      });
    },
    async dispose() {
      disposed = true;
      const current = active;
      current?.controller.abort(problem('REVERIE_SHUTDOWN'));
      try { await current?.promise; } catch { /* The caller observes its own failure. */ }
    },
  };
}

module.exports = { createMediaService, MANIFEST_BYTES, INPUT_BYTES, MANIFEST_TIMEOUT_MS, TRANSFER_TIMEOUT_MS };
