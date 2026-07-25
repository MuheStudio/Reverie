'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const { registerDesktopSchemes } = require('./desktop-schemes.cjs');

const SCHEME = 'reverie-avatar';
const APP_SCHEME = 'reverie-app';
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

function statusResponse(status, message) {
  return new Response(String(message || ''), {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function parseAvatarUrl(value) {
  if (/%2e/i.test(String(value)) || /\/\.{1,2}(?:\/|[?#]|$)/.test(String(value))) {
    throw new Error('Dot segments are not allowed');
  }
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || !['asset', 'preview'].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid avatar asset URL');
  }
  if (/%2f|%5c/i.test(url.pathname)) throw new Error('Encoded path separators are not allowed');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error('Avatar asset URL is incomplete');
  const [id, ...relative] = segments;
  return { type: url.hostname, id, encodedRelative: relative.join('/') };
}

function parseAssetUrl(value) {
  const parsed = parseAvatarUrl(value);
  if (parsed.type !== 'asset') throw new Error('Invalid registered avatar asset URL');
  return { id: parsed.id, encodedRelative: parsed.encodedRelative };
}

function installAvatarProtocol(protocol, avatarManager, options = {}) {
  if (!protocol || !avatarManager) throw new TypeError('protocol and avatarManager are required');
  const allowedOrigins = new Set(options.allowedOrigins || []);
  protocol.handle(SCHEME, (request) => {
    if (!ALLOWED_METHODS.has(request.method)) return statusResponse(405, 'Method not allowed');
    let asset;
    let type;
    try {
      const parsed = parseAvatarUrl(request.url);
      type = parsed.type;
      asset = type === 'preview'
        ? avatarManager.openPreviewAsset(parsed.id, parsed.encodedRelative)
        : avatarManager.openAsset(parsed.id, parsed.encodedRelative);
    } catch {
      return statusResponse(404, 'Avatar asset not found');
    }
    const headers = {
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.size),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': type === 'preview'
        ? 'no-store'
        : 'private, max-age=31536000, immutable',
      ETag: `"sha256-${asset.cacheKey}"`,
    };
    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }
    if (request.method === 'HEAD') {
      fs.closeSync(asset.fd);
      return new Response(null, { status: 200, headers });
    }
    const nodeStream = fs.createReadStream(null, {
      fd: asset.fd,
      autoClose: true,
      start: 0,
      end: Math.max(0, asset.size - 1),
    });
    return new Response(Readable.toWeb(nodeStream), { status: 200, headers });
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  ALLOWED_METHODS,
  SCHEME,
  installAvatarProtocol,
  parseAvatarUrl,
  parseAssetUrl,
  registerAvatarScheme: registerDesktopSchemes,
  registerDesktopSchemes,
  statusResponse,
};
