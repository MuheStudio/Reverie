'use strict';

// Streams stored chat videos to <video> elements over reverie-video://asset/
// URLs. Unlike sticker/image assets, videos can be hundreds of MB, so this
// protocol supports HTTP Range requests: the renderer's <video> element seeks
// by asking for byte ranges, and inlining a whole video as a base64 data URL
// would blow up renderer memory. Files are read from the content-addressed
// chat-media/video store; the sha256 filename is validated so a crafted URL
// cannot escape the store directory.

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'reverie-video';
const ASSET_RE = /^[a-f0-9]{64}\.(?:mp4|webm)$/;
const MIME = Object.freeze({
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
});
// Matches the Python HARD_MAX_BYTES ceiling (src/chat/video_media.py).
const MAX_VIDEO_BYTES = 4096 * 1024 * 1024;

function response(status, message = '') {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function parseVideoAssetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'asset'
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid video asset URL');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1 || !ASSET_RE.test(segments[0])) {
    throw new Error('Invalid video asset identifier');
  }
  return segments[0];
}

// Parse a single "bytes=start-end" range against a known size. Returns null
// (=> serve the whole file) when there is no valid, satisfiable single range.
// Multi-range requests are intentionally not supported (a <video> never needs
// them); such a request falls back to the full body.
function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  let start;
  let end;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;
  if (end > size - 1) end = size - 1;
  return { start, end };
}

function installVideoAssetProtocol(protocol, videoRoot, options = {}) {
  const root = path.resolve(videoRoot);
  fs.mkdirSync(root, { recursive: true });
  const allowedOrigins = new Set(options.allowedOrigins || []);

  protocol.handle(SCHEME, (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return response(405, 'Method not allowed');
    let fd = null;
    try {
      const filename = parseVideoAssetUrl(request.url);
      const target = path.join(root, filename);
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      if (path.dirname(realTarget) !== realRoot) throw new Error('Asset escaped root');
      fd = fs.openSync(realTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 12 || stat.size > MAX_VIDEO_BYTES) {
        throw new Error('Invalid video asset');
      }
      const contentType = MIME[path.extname(filename)];
      const baseHeaders = {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
      };
      const origin = request.headers.get('Origin');
      if (origin && allowedOrigins.has(origin)) {
        baseHeaders['Access-Control-Allow-Origin'] = origin;
        baseHeaders.Vary = 'Origin';
      }

      const range = parseRange(request.headers.get('Range'), stat.size);
      const start = range ? range.start : 0;
      const end = range ? range.end : stat.size - 1;
      const length = end - start + 1;
      const status = range ? 206 : 200;
      const headers = { ...baseHeaders, 'Content-Length': String(length) };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;

      if (request.method === 'HEAD') {
        fs.closeSync(fd);
        return new Response(null, { status, headers });
      }
      const stream = fs.createReadStream(null, { fd, autoClose: true, start, end });
      fd = null;
      return new Response(Readable.toWeb(stream), { status, headers });
    } catch {
      if (fd !== null) fs.closeSync(fd);
      return response(404, 'Video asset not found');
    }
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  ASSET_RE,
  MAX_VIDEO_BYTES,
  MIME,
  SCHEME,
  installVideoAssetProtocol,
  parseRange,
  parseVideoAssetUrl,
};
