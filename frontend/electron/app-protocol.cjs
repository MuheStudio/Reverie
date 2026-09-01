'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const SCHEME = 'reverie-app';
const HOST = 'app';
const PRODUCTION_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "script-src 'self' reverie-live2d-core:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: reverie-avatar: reverie-sticker:",
  "font-src 'self' data:",
  "connect-src 'self' reverie-avatar: reverie-focus:",
  "media-src 'self' blob: reverie-avatar: reverie-focus:",
  "worker-src 'self' blob:",
  "form-action 'none'",
].join('; ');
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  // Bundled focus-soundscape ambiences ship as vite-emitted audio assets; a
  // missing entry here made every packaged fetch 404 and silently degrade to
  // the pink-noise fallback.
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
});

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseBundleUrl(value) {
  if (/%2e/i.test(String(value)) || /\/\.{1,2}(?:\/|[?#]|$)/.test(String(value))) {
    throw new Error('Dot segments are not allowed');
  }
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== HOST
    || url.username || url.password || url.port || url.search) {
    throw new Error('Invalid application URL');
  }
  if (/%2f|%5c/i.test(url.pathname)) throw new Error('Encoded path separator');
  const decoded = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (decoded.some((part) => !part || part === '.' || part === '..'
    || /[\\:\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('Unsafe application path');
  }
  return decoded.length ? decoded : ['index.html'];
}

function installAppProtocol(protocol, distRoot) {
  const root = fs.realpathSync(path.resolve(distRoot));
  protocol.handle(SCHEME, (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    let fd = null;
    try {
      const segments = parseBundleUrl(request.url);
      const target = path.join(root, ...segments);
      if (!isInside(root, target)) throw new Error('Path escaped');
      const realTarget = fs.realpathSync(target);
      if (!isInside(root, realTarget)) throw new Error('Resolved path escaped');
      const extension = path.extname(realTarget).toLowerCase();
      const mime = MIME[extension];
      if (!mime) throw new Error('File type is not served');
      fd = fs.openSync(realTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid application asset');
      const headers = {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      };
      if (extension === '.html') headers['Content-Security-Policy'] = PRODUCTION_CSP;
      if (request.method === 'HEAD') {
        fs.closeSync(fd);
        return new Response(null, { status: 200, headers });
      }
      const stream = fs.createReadStream(null, {
        fd,
        autoClose: true,
        start: 0,
        end: Math.max(0, stat.size - 1),
      });
      fd = null;
      return new Response(Readable.toWeb(stream), { status: 200, headers });
    } catch {
      if (fd !== null) fs.closeSync(fd);
      return new Response('Not found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    }
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  HOST,
  MIME,
  PRODUCTION_CSP,
  SCHEME,
  installAppProtocol,
  isInside,
  parseBundleUrl,
};
