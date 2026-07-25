'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'reverie-sticker';
const ASSET_RE = /^[a-f0-9]{64}\.(?:png|jpg|webp|gif|bmp)$/;
const MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
});

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

function parseStickerAssetUrl(value) {
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'asset'
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid sticker asset URL');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1 || !ASSET_RE.test(segments[0])) {
    throw new Error('Invalid sticker asset identifier');
  }
  return segments[0];
}

function installStickerAssetProtocol(protocol, assetsRoot, options = {}) {
  const root = path.resolve(assetsRoot);
  fs.mkdirSync(root, { recursive: true });
  const allowedOrigins = new Set(options.allowedOrigins || []);
  protocol.handle(SCHEME, (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return response(405, 'Method not allowed');
    let fd = null;
    try {
      const filename = parseStickerAssetUrl(request.url);
      const target = path.join(root, filename);
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      if (path.dirname(realTarget) !== realRoot) throw new Error('Asset escaped root');
      fd = fs.openSync(realTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 16 || stat.size > 5_000_000) {
        throw new Error('Invalid sticker asset');
      }
      const headers = {
        'Content-Type': MIME[path.extname(filename)],
        'Content-Length': String(stat.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      };
      const origin = request.headers.get('Origin');
      if (origin && allowedOrigins.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      if (request.method === 'HEAD') {
        fs.closeSync(fd);
        return new Response(null, { status: 200, headers });
      }
      const stream = fs.createReadStream(null, {
        fd,
        autoClose: true,
        start: 0,
        end: stat.size - 1,
      });
      fd = null;
      return new Response(Readable.toWeb(stream), { status: 200, headers });
    } catch {
      if (fd !== null) fs.closeSync(fd);
      return response(404, 'Sticker asset not found');
    }
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  ASSET_RE,
  MIME,
  SCHEME,
  installStickerAssetProtocol,
  parseStickerAssetUrl,
};
