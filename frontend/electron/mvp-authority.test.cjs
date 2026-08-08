'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('production IPC registration is an exact MVP allowlist', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const downloadStart = source.indexOf('function registerDownloadHandlers(');
  const registrarStart = source.indexOf('function registerIpcHandlers()');
  const start = downloadStart >= 0 && downloadStart < registrarStart
    ? downloadStart
    : registrarStart;
  const end = source.indexOf('\nfunction createTray()', start);
  assert.ok(start >= 0 && end > start, 'MVP IPC registrar was not found');
  const registrar = source.slice(start, end);
  const channels = [...registrar.matchAll(/\bhandle\('([^']+)'/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(channels, [
    'app:getVersion',
    'bridge:getConnectionConfig',
    'bridge:send',
    'character:getBundled',
    'credentials:clear',
    'credentials:status',
    'download:direct',
    'download:m3u8',
    'localMode:get',
    'localMode:set',
    'providerConfig:commit',
    'providerConfig:get',
    'providerConfig:test',
    'sniff:m3u8',
    'sniff:resources',
  ]);
  assert.equal(source.includes('registerLegacyIpcHandlers();'), false);
  // The cat-catch download handlers are the only non-MVP surface and they
  // must remain fail-closed: disabled until features.download_service_enabled.
  assert.match(source, /REVERIE_DOWNLOAD_SERVICE_DISABLED/);
});

test('production dependencies are the exact renderer MVP closure', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    '@pixi/unsafe-eval',
    '@pixiv/three-vrm',
    '@pixiv/three-vrm-animation',
    '@sabaki/go-board',
    'chess.js',
    'elephantops',
    'i18next',
    'lucide-react',
    'pixi-live2d-display',
    'pixi.js',
    'react',
    'react-dom',
    'react-i18next',
    'tetris-engine',
    'three',
  ]);
});
