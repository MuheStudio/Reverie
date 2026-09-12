'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('desktop pet preload exposes only character and narrow pet capabilities', () => {
  const exposed = new Map();
  const invokes = [];
  const listeners = new Map();
  const context = vm.createContext({
    console,
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
        ipcRenderer: {
          invoke: (channel, value) => { invokes.push({ channel, value }); return Promise.resolve({}); },
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel) => listeners.delete(channel),
        },
      };
    },
  });
  const source = fs.readFileSync(path.join(__dirname, 'pet-preload.js'), 'utf8');
  new vm.Script(source, { filename: 'pet-preload.js' }).runInContext(context);
  const api = exposed.get('electronAPI');
  assert.deepEqual(Object.keys(api).sort(), ['character', 'pet']);
  assert.deepEqual(Object.keys(api.character), ['get']);
  assert.deepEqual(Object.keys(api.pet).sort(), [
    'cancelChat', 'dragEnd', 'dragMove', 'dragStart', 'hide', 'importSticker',
    'listStickers', 'onChatEvent', 'sendChat', 'sendSticker',
  ]);
  for (const forbidden of ['bridge', 'providerConfig', 'credentials', 'places', 'backup', 'avatar', 'voicePack', 'ttsRuntime']) {
    assert.equal(api[forbidden], undefined);
  }
  return api.pet.sendChat('你好').then(() => {
    assert.equal(invokes.at(-1).channel, 'pet:sendChat');
    assert.equal(invokes.at(-1).value.text, '你好');
    assert.throws(() => api.pet.sendChat('x'.repeat(2001)), /invalid/);
  });
});

test('main and pet windows use different preload entrypoints', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const mainStart = source.indexOf('function createWindow()');
  const petStart = source.indexOf('function createPetWindow()');
  assert.ok(mainStart >= 0 && petStart > mainStart);
  assert.match(source.slice(mainStart, petStart), /preload: path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(source.slice(petStart), /preload: path\.join\(__dirname, 'pet-preload\.js'\)/);
});
