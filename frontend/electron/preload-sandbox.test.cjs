'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('sandboxed preload exposes only the MVP authority without local require', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const exposed = new Map();
  const handlers = new Map();
  const invokes = [];
  const ipcRenderer = {
    invoke: async (channel, value) => {
      invokes.push({ channel, value });
      return undefined;
    },
    on: (channel, callback) => handlers.set(channel, callback),
    removeListener: (channel) => handlers.delete(channel),
  };
  const contextBridge = {
    exposeInMainWorld: (name, value) => exposed.set(name, value),
  };
  const diskFile = Object.freeze({ name: 'image.png' });
  const webUtils = {
    getPathForFile: (file) => {
      assert.equal(file, diskFile);
      return 'C:\\test\\image.png';
    },
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
      return { contextBridge, ipcRenderer, webUtils };
    },
  });

  new vm.Script(source, { filename: 'preload.js' }).runInContext(context);

  const api = exposed.get('electronAPI');
  assert.ok(api, 'electronAPI was not exposed');
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'appState',
      'avatar',
      'backup',
      'bridge',
      'character',
      'credentials',
      'download',
      'focus',
      'getAppVersion',
      'getPathForFile',
      'localMode',
      'onAppLifecycle',
      'pet',
      'places',
      'platform',
      'providerConfig',
      'showNotification',
      'stickers',
      'ttsRuntime',
      'voicePack',
    ],
  );
  assert.deepEqual(Object.keys(api.stickers).sort(), ['pickImage']);
  assert.deepEqual(Object.keys(api.places).sort(), ['deleteKey', 'nearby', 'resolve', 'setKey', 'status']);
  assert.equal(api.getPathForFile(diskFile), 'C:\\test\\image.png');
  assert.throws(() => api.getPathForFile(null), /file is invalid/);
  assert.deepEqual(Object.keys(api.bridge).sort(), [
    'getConnectionConfig',
    'onChanged',
    'onMessage',
    'send',
  ]);
  assert.deepEqual(Object.keys(api.credentials).sort(), [
    'clear',
    'onChanged',
    'status',
  ]);
  assert.deepEqual(Object.keys(api.providerConfig).sort(), ['commit', 'get', 'test']);
  assert.deepEqual(Object.keys(api.character), ['get']);
  assert.deepEqual(Object.keys(api.focus).sort(), [
    'acknowledgeAudioRearm',
    'getState',
    'onChanged',
    'pause',
    'resume',
    'start',
    'stop',
  ]);
  // The timer input is bounded by the preload boundary: only a positive
  // finite durationSeconds crosses.
  await api.focus.start(25 * 60);
  assert.equal(invokes.at(-1)?.channel, 'focus:start');
  // Field-wise compare: values created inside the preload vm realm carry a
  // foreign Object prototype, so deepStrictEqual would reject them.
  assert.equal(invokes.at(-1)?.value?.durationSeconds, 1500);
  assert.throws(() => api.focus.start(-1), /durationSeconds/);
  assert.throws(() => api.focus.start(Number.NaN), /durationSeconds/);
  await api.focus.pause('session-id');
  assert.equal(invokes.at(-1)?.channel, 'focus:pause');
  assert.deepEqual(Object.keys(api.pet).sort(), [
    'cancelChat', 'hide', 'importSticker', 'isVisible', 'listStickers',
    'onChatEvent', 'sendChat', 'sendSticker', 'show', 'toggle',
  ]);
  assert.deepEqual(Object.keys(api.avatar).sort(), [
    'addMotion', 'beginImport', 'beginImportFolder', 'beginImportLive2DFile', 'commitImport', 'confirmPreview',
    'discardImport', 'failPreview', 'importDropped', 'list', 'onChanged', 'remove',
    'removeMotion', 'setActive', 'setMapping',
  ]);
  assert.deepEqual(Object.keys(api.voicePack).sort(), [
    'beginImport', 'commitImport', 'importDropped', 'list', 'remove', 'setActive',
  ]);
  assert.deepEqual(Object.keys(api.ttsRuntime).sort(), ['cancel', 'start', 'status']);
  assert.deepEqual(Object.keys(api.download).sort(), [
    'downloadDirect',
    'downloadM3u8',
    'onProgress',
    'sniffM3u8',
    'sniffResources',
  ]);
  assert.equal(typeof api.providerConfig.commit, 'function');
  const providers = [
    'openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'kimi', 'glm',
    'ollama', 'custom',
  ];
  for (const provider of providers) {
    await api.providerConfig.test({
      llm: {
        provider,
        baseUrl: provider === 'ollama'
          ? 'http://localhost:11434/v1'
          : 'https://api.example.com/v1',
        model: 'test-model',
      },
    }, { apiKey: 'test-key' });
  }
  assert.deepEqual(
    invokes.slice(-providers.length).map(({ channel, value }) => ({
      channel,
      provider: value.config.llm.provider,
    })),
    providers.map((provider) => ({ channel: 'providerConfig:test', provider })),
  );
  assert.throws(
    () => api.providerConfig.test({
      llm: {
        provider: 'unsupported',
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
      },
    }),
    /不支持的 LLM 供应商/,
  );
  await api.credentials.clear();
  assert.equal(invokes.at(-1)?.channel, 'credentials:clear');
  assert.equal(invokes.at(-1)?.value?.scope, 'llm');
  await api.places.setKey('amap', 'owner-amap-key');
  assert.equal(invokes.at(-1)?.channel, 'places:setKey');
  assert.equal(invokes.at(-1)?.value?.apiKey, 'owner-amap-key');
  await api.places.setKey('google', 'owner-google-key');
  assert.equal(invokes.at(-1)?.value?.provider, 'google');
  await api.places.resolve('auto');
  assert.equal(invokes.at(-1)?.channel, 'places:resolve');
  await api.places.nearby({
    provider: 'amap',
    latitude: 39.9,
    longitude: 116.4,
    radiusM: 1200,
    placeTypes: ['restaurant', 'cafe'],
    consent: true,
  });
  assert.equal(invokes.at(-1)?.channel, 'places:nearby');
  assert.equal(invokes.at(-1)?.value?.latitude, 39.9);
  assert.throws(() => api.places.nearby({
    provider: 'google',
    latitude: 39.9,
    longitude: 116.4,
    radiusM: 1200,
    placeTypes: ['park'],
    consent: true,
  }), /place types/);
  const invokeCount = invokes.length;
  assert.equal((await api.places.nearby({
    provider: 'google',
    latitude: 39.9,
    longitude: 116.4,
    radiusM: 1200,
    placeTypes: ['cafe'],
    consent: false,
  })).code, 'consent');
  assert.equal(invokes.length, invokeCount, 'denied consent must stop before IPC');
  await api.providerConfig.test({
    llm: {
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
    },
  }, { clearCustomHeaders: true });
  assert.equal(invokes.at(-1)?.value?.credential?.clearCustomHeaders, true);
  assert.throws(() => api.providerConfig.test({
    llm: {
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
    },
  }, { apiKey: 'x'.repeat((16 * 1024) + 1) }), /apiKey is invalid/);

  // notification:show and backup:import/export are deliberately re-exposed
  // through the secure IPC registrar (validated payloads, native dialogs).
  assert.deepEqual(Object.keys(api.backup).sort(), ['export', 'import']);
  for (const forbidden of [
    'companionPreferences',
    'files',
    'focusSound',
    'getCurrentWindowsLocation',
    'openLocationSettings',
  ]) {
    assert.equal(api[forbidden], undefined, `${forbidden} must not cross the preload boundary`);
  }
});
