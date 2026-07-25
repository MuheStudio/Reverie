'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'reverie-live2d-core';
const EXPECTED_URL = `${SCHEME}://runtime/core.js`;
const MAX_CORE_BYTES = 16 * 1024 * 1024;

function installLive2DCoreProtocol(protocol, corePath) {
  const source = path.resolve(String(corePath || ''));
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()
    || sourceStat.size < 1 || sourceStat.size > MAX_CORE_BYTES) {
    throw new Error('Live2D Cubism Core must be a bounded regular file');
  }
  const expectedRealPath = fs.realpathSync(source);
  protocol.handle(SCHEME, (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405 });
    }
    if (request.url !== EXPECTED_URL) {
      return new Response('Not found', { status: 404 });
    }
    let fd = null;
    try {
      const currentRealPath = fs.realpathSync(source);
      if (currentRealPath !== expectedRealPath) throw new Error('Core path changed');
      fd = fs.openSync(currentRealPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== sourceStat.size) throw new Error('Core file changed');
      const headers = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(stat.size),
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'private, no-cache',
      };
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
      return new Response('Not found', { status: 404 });
    }
  });
  return () => protocol.unhandle(SCHEME);
}

module.exports = {
  EXPECTED_URL,
  MAX_CORE_BYTES,
  SCHEME,
  installLive2DCoreProtocol,
};
