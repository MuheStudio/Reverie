'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('sandboxed preload exposes the authority and Companion APIs without local require', () => {
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
  assert.equal(typeof api.providerConfig.commit, 'function');
  assert.equal(typeof api.focus.start, 'function');
  assert.equal(typeof api.focusSound.list, 'function');
});
