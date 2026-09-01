'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* BEGIN GENERATED PROTOCOL V4 COMMANDS */
const COMMAND_NAMES = Object.freeze(new Set([
  "ai_usage:get",
  "ai_usage:grant",
  "ai_usage:revoke",
  "ambient:get",
  "anti_ai:status",
  "api:budget:get",
  "archive:get",
  "archive:migrate",
  "archive:put",
  "backup:export",
  "backup:import",
  "chat:cancel",
  "chat:history",
  "chat:media",
  "chat:reveal",
  "chat:send",
  "chat:stop",
  "diary:request",
  "diary:write",
  "emotion:get",
  "game:move",
  "game_state:get",
  "game_state:put",
  "group:request",
  "group:send",
  "image:random",
  "immersion:closeup",
  "immersion:nearby",
  "immersion:smart_home",
  "keepsake:add",
  "keepsake:list",
  "memory:candidates:confirm",
  "memory:candidates:list",
  "memory:candidates:reject",
  "memory:delete",
  "memory:edit",
  "memory:list",
  "memory:query",
  "memory:settings:get",
  "memory:store",
  "module:control",
  "module:list",
  "persona:activate",
  "persona:get",
  "persona:import",
  "relationship:get",
  "settings:get",
  "settings:update",
  "sticker:collect",
  "sticker:import",
  "sticker:list",
  "sticker:react",
  "timeline:request",
  "tts:list",
  "tts:synthesize",
  "user:profile:get",
  "user:profile:update"
]));
/* END GENERATED PROTOCOL V4 COMMANDS */

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  let active = true;
  const listener = (_event, payload) => {
    if (active) callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(channel, listener);
  };
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function optionalCredentialValue(value = {}) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('credential value is invalid');
  }
  const result = {};
  for (const field of ['apiKey', 'customHeaders']) {
    if (value[field] == null || value[field] === '') continue;
    if (typeof value[field] !== 'string' || value[field].length > 16 * 1024
      || value[field].includes('\u0000')) {
      throw new TypeError(`${field} is invalid`);
    }
    result[field] = value[field];
  }
  for (const field of ['clearApiKey', 'clearCustomHeaders']) {
    if (value[field] == null || value[field] === false) continue;
    if (value[field] !== true) throw new TypeError(`${field} is invalid`);
    result[field] = true;
  }
  return Object.keys(result).length ? result : undefined;
}

function boundedUrl(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048
    || !/^https?:\/\//i.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('download url is invalid');
  }
  return value;
}

function bridgeFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('bridge frame is invalid');
  }
  const type = boundedText(value.type, 'bridge frame type', 80);
  if (!/^[A-Za-z0-9:_-]+$/.test(type) || type.startsWith('bridge:auth')) {
    throw new TypeError('bridge frame type is forbidden');
  }
  if (!COMMAND_NAMES.has(type)) {
    throw new TypeError('bridge frame command is not declared by protocol V4');
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw new TypeError('bridge frame payload is invalid');
  }
  const requestId = value.request_id == null ? '' : boundedText(
    value.request_id,
    'bridge request id',
    128,
  );
  if (requestId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw new TypeError('bridge request id is invalid');
  }
  return {
    type,
    payload: value.payload,
    ...(requestId ? { request_id: requestId } : {}),
  };
}

// Closed-world provider surface. Must stay in sync with LLM_PROVIDERS in
// provider-config-store.cjs and SUPPORTED_PROVIDER_NAMES in src/config/settings.py.
// The sandboxed preload cannot require local modules, so the list is inlined.
const SUPPORTED_LLM_PROVIDERS = Object.freeze([
  'openai', 'anthropic', 'gemini', 'grok', 'deepseek', 'kimi', 'glm',
  'ollama', 'custom',
]);

function publicProviderConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.llm || typeof value.llm !== 'object' || Array.isArray(value.llm)) {
    throw new TypeError('provider config is invalid');
  }
  if (Object.keys(value.llm).some(
    (key) => !['provider', 'baseUrl', 'model', 'customProviderName'].includes(key),
  )) {
    throw new TypeError('LLM provider config contains a forbidden field');
  }
  const llm = {
    provider: boundedText(value.llm.provider, 'LLM provider', 32),
    baseUrl: boundedText(value.llm.baseUrl, 'LLM base URL', 2048),
    model: boundedText(value.llm.model, 'LLM model', 512),
  };
  if (!SUPPORTED_LLM_PROVIDERS.includes(llm.provider)) {
    throw new TypeError('不支持的 LLM 供应商');
  }
  if (value.llm.customProviderName) {
    llm.customProviderName = boundedText(
      value.llm.customProviderName,
      'custom provider name',
      160,
    );
  }
  if (Object.keys(value).some((key) => key !== 'llm')) {
    throw new TypeError('provider config contains a non-MVP section');
  }
  return { llm };
}

const api = Object.freeze({
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPathForFile: (file) => {
    if (!file || typeof file !== 'object') throw new TypeError('file is invalid');
    return webUtils.getPathForFile(file);
  },
  onAppLifecycle: (callback) => subscribe('app:lifecycle', callback),
  showNotification: (title, body) => ipcRenderer.invoke('notification:show', {
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
  }),

  backup: Object.freeze({
    export: () => ipcRenderer.invoke('backup:nativeExport'),
    import: () => ipcRenderer.invoke('backup:nativeImport'),
  }),

  bridge: Object.freeze({
    getConnectionConfig: () => ipcRenderer.invoke('bridge:getConnectionConfig'),
    send: (frame) => ipcRenderer.invoke('bridge:send', bridgeFrame(frame)),
    onMessage: (callback) => subscribe('bridge:message', callback),
    onChanged: (callback) => subscribe('bridge:changed', callback),
  }),

  localMode: Object.freeze({
    get: () => ipcRenderer.invoke('localMode:get'),
    set: (enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      return ipcRenderer.invoke('localMode:set', { enabled });
    },
    onChanged: (callback) => subscribe('localMode:changed', callback),
  }),

  credentials: Object.freeze({
    status: () => ipcRenderer.invoke('credentials:status'),
    clear: () => ipcRenderer.invoke('credentials:clear', { scope: 'llm' }),
    onChanged: (callback) => subscribe('credentials:changed', callback),
  }),

  places: Object.freeze({
    status: () => ipcRenderer.invoke('places:status'),
    setKey: (provider, apiKey) => {
      if (!['amap', 'google'].includes(provider)) throw new TypeError('Places provider is invalid');
      return ipcRenderer.invoke('places:setKey', {
        provider,
        apiKey: boundedText(apiKey, 'Places API key', 256),
      });
    },
    deleteKey: (provider) => {
      if (!['amap', 'google'].includes(provider)) throw new TypeError('Places provider is invalid');
      return ipcRenderer.invoke('places:deleteKey', { provider });
    },
    resolve: (selection) => {
      if (!['auto', 'amap', 'google'].includes(selection)) {
        throw new TypeError('Places provider selection is invalid');
      }
      return ipcRenderer.invoke('places:resolve', { selection });
    },
    nearby: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => ![
          'provider', 'latitude', 'longitude', 'radiusM', 'placeTypes', 'consent',
        ].includes(key))
        || !['amap', 'google'].includes(value.provider)
        || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
        || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180
        || !Number.isInteger(value.radiusM) || value.radiusM < 300 || value.radiusM > 5000
        || typeof value.consent !== 'boolean' || !Array.isArray(value.placeTypes)) {
        throw new TypeError('Places nearby request is invalid');
      }
      const allowed = new Set([
        'restaurant', 'cafe', 'bakery', 'dessert', 'convenience', 'snacks', 'supermarket',
      ]);
      const placeTypes = [...new Set(value.placeTypes)];
      if (!placeTypes.length || placeTypes.length > 7
        || placeTypes.some((item) => typeof item !== 'string' || !allowed.has(item))) {
        throw new TypeError('Places place types are invalid');
      }
      if (!value.consent) {
        return Promise.resolve({
          ok: false,
          code: 'consent',
          items: [],
          provider: value.provider === 'google' ? 'Google' : 'Amap',
        });
      }
      return ipcRenderer.invoke('places:nearby', {
        provider: value.provider,
        latitude: value.latitude,
        longitude: value.longitude,
        radiusM: value.radiusM,
        placeTypes,
        consent: true,
      });
    },
  }),

  /*
   * Place keys are write/delete-only from the renderer. Runtime plaintext and
   * provider networking remain in Electron main.
   */
  providerConfig: Object.freeze({
    get: () => ipcRenderer.invoke('providerConfig:get'),
    test: (value, credential) => ipcRenderer.invoke('providerConfig:test', {
      config: publicProviderConfig(value),
      credential: optionalCredentialValue(credential),
    }),
    commit: (value, credential, mode = 'persistent', testReceipt) => {
      if (!['persistent', 'session'].includes(mode)) {
        throw new TypeError('credential storage mode is invalid');
      }
      return ipcRenderer.invoke('providerConfig:commit', {
        config: publicProviderConfig(value),
        credential: optionalCredentialValue(credential),
        mode,
        testReceipt: boundedText(testReceipt, 'provider test receipt', 128),
      });
    },
  }),

  character: Object.freeze({
    get: () => ipcRenderer.invoke('character:getBundled'),
  }),

  focus: Object.freeze({
    getState: () => ipcRenderer.invoke('focus:getState'),
    start: (durationSeconds) => {
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new TypeError('durationSeconds must be a positive number');
      }
      return ipcRenderer.invoke('focus:start', { durationSeconds });
    },
    // Single-session manager: the session id is display state on the
    // renderer side and is deliberately not forwarded.
    pause: (_id) => ipcRenderer.invoke('focus:pause'),
    resume: (_id) => ipcRenderer.invoke('focus:resume'),
    stop: (_id) => ipcRenderer.invoke('focus:stop'),
    acknowledgeAudioRearm: (_id) => ipcRenderer.invoke('focus:acknowledgeAudioRearm'),
    onChanged: (callback) => subscribe('focus:changed', callback),
  }),

  pet: Object.freeze({
    toggle: () => ipcRenderer.invoke('pet:toggle'),
    show: () => ipcRenderer.invoke('pet:show'),
    hide: () => ipcRenderer.invoke('pet:hide'),
    isVisible: () => ipcRenderer.invoke('pet:isVisible'),
  }),

  stickers: Object.freeze({
    // Opens the native image picker; validation and storage happen on the
    // Python side once the renderer forwards the path via sticker:import.
    pickImage: () => ipcRenderer.invoke('stickers:pickImage'),
  }),

  download: Object.freeze({
    sniffResources: () => ipcRenderer.invoke('sniff:resources'),
    sniffM3u8: (url) => ipcRenderer.invoke('sniff:m3u8', boundedUrl(url)),
    downloadM3u8: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('m3u8 download payload is invalid');
      }
      const url = boundedUrl(value.url);
      const baseUrl = value.baseUrl == null ? '' : boundedUrl(value.baseUrl);
      const m3u8Content = boundedText(value.m3u8Content, 'm3u8 content', 8 * 1024 * 1024);
      return ipcRenderer.invoke('download:m3u8', { url, baseUrl, m3u8Content });
    },
    downloadDirect: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('direct download payload is invalid');
      }
      const url = boundedUrl(value.url);
      const filename = value.filename == null ? undefined : boundedText(value.filename, 'download filename', 512);
      return ipcRenderer.invoke('download:direct', { url, filename });
    },
    onProgress: (callback) => subscribe('download:progress', callback),
  }),
});

if (process.isMainFrame !== false) {
  contextBridge.exposeInMainWorld('electronAPI', api);
}
