'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('sandboxed preload exposes only the MVP authority without local require', () => {
  const source = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const exposed = new Map();
  const handlers = new Map();
  const ipcRenderer = {
    invoke: async () => undefined,
    on: (channel, callback) => handlers.set(channel, callback),
    removeListener: (channel) => handlers.delete(channel),
  };
  const contextBridge = {
    exposeInMainWorld: (name, value) => exposed.set(name, value),
  };

  const context = vm.createContext({
    AbortController,
    Object,
    Set,
    TypeError,
    URL,
    console,
    process: Object.freeze({ platform: 'win32' }),
    require(moduleName) {
      assert.equal(
        moduleName,
        'electron',
        `sandboxed preload attempted to load unsupported module: ${moduleName}`,
      );
      return { contextBridge, ipcRenderer };
    },
  });

  new vm.Script(source, { filename: 'preload.js' }).runInContext(context);

  const api = exposed.get('electronAPI');
  assert.ok(api, 'electronAPI was not exposed');
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'bridge',
      'character',
      'credentials',
      'download',
      'getAppVersion',
      'localMode',
      'onAppLifecycle',
      'pet',
      'platform',
      'providerConfig',
    ],
  );
  assert.deepEqual(Object.keys(api.bridge).sort(), [
    'getConnectionConfig',
    'onChanged',
    'onMessage',
    'send',
  ]);
  assert.deepEqual(Object.keys(api.credentials).sort(), [
    'clear',
    'onChanged',
    'set',
    'setSession',
    'status',
  ]);
  assert.deepEqual(Object.keys(api.providerConfig).sort(), ['commit', 'get', 'test']);
  assert.deepEqual(Object.keys(api.character), ['get']);
  assert.deepEqual(Object.keys(api.pet).sort(), ['hide', 'isVisible', 'show', 'toggle']);
  assert.deepEqual(Object.keys(api.download).sort(), [
    'downloadDirect',
    'downloadM3u8',
    'onProgress',
    'sniffM3u8',
    'sniffResources',
  ]);
  assert.equal(typeof api.providerConfig.commit, 'function');
  for (const forbidden of [
    'avatar',
    'backup',
    'companionPreferences',
    'files',
    'focus',
    'focusSound',
    'getCurrentWindowsLocation',
    'openLocationSettings',
    'showNotification',
    'stickers',
  ]) {
    assert.equal(api[forbidden], undefined, `${forbidden} must not cross the preload boundary`);
  }
});
