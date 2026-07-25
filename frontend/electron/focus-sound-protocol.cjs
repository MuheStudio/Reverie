'use strict';

const fs = require('fs');
const { Readable } = require('stream');

const SCHEME = 'reverie-focus';
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

function statusResponse(status, message, extraHeaders = {}) {
  return new Response(String(message || ''), {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function parseSoundUrl(value) {
  if (/%2e|%2f|%5c/i.test(String(value)) || /\/\.{1,2}(?:\/|[?#]|$)/.test(String(value))) {
    throw new Error('Encoded separators and dot segments are not allowed');
  }
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'sound'
    || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid focus sound URL');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) throw new Error('Focus sound URL must contain exactly one identifier');
  return { id: segments[0] };
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new Error('Invalid range');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error('Invalid suffix range');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= size || end < start) {
      throw new Error('Invalid byte range');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function installFocusSoundProtocol(protocol, soundManager, options = {}) {
  if (!protocol || !soundManager) throw new TypeError('protocol and soundManager are required');
  const allowedOrigins = new Set(options.allowedOrigins || []);
  protocol.handle(SCHEME, (request) => {
    if (!ALLOWED_METHODS.has(request.method)) return statusResponse(405, 'Method not allowed');
    let sound;
    try {
      sound = soundManager.open(parseSoundUrl(request.url).id);
    } catch {
      return statusResponse(404, 'Focus sound not found');
    }
    let range;
    try {
      range = parseByteRange(request.headers.get('Range'), sound.size);
    } catch {
      fs.closeSync(sound.fd);
      return statusResponse(416, 'Range not satisfiable', {
        'Content-Range': `bytes */${sound.size}`,
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? sound.size - 1;
    const status = range ? 206 : 200;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': sound.mimeType,
      'Content-Length': String((end - start) + 1),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"sha256-${sound.cacheKey}"`,
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${sound.size}`;
    const origin = request.headers.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }
    if (request.method === 'HEAD') {
      fs.closeSync(sound.fd);
      return new Response(null, { status, headers });
    }
    const nodeStream = fs.createReadStream(null, {
      fd: sound.fd,
      autoClose: true,
      start,
      end,
    });
    return new Response(Readable.toWeb(nodeStream), { status, headers });
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  ALLOWED_METHODS,
  SCHEME,
  installFocusSoundProtocol,
  parseByteRange,
  parseSoundUrl,
  statusResponse,
};
