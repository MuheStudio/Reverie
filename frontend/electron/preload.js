'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* BEGIN GENERATED PROTOCOL V3 COMMANDS */
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
  "chat:reveal",
  "chat:send",
  "chat:stop",
  "diary:request",
  "emotion:get",
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
  "local_mode:set",
  "memory:query",
  "memory:settings:get",
  "memory:store",
  "module:control",
  "module:list",
  "persona:activate",
  "persona:get",
  "persona:import",
  "persona:list",
  "relationship:get",
  "settings:get",
  "settings:update",
  "sticker:collect",
  "sticker:list",
  "sticker:react",
  "sticker:send",
  "timeline:request",
  "user:profile:get",
  "user:profile:update"
]));
/* END GENERATED PROTOCOL V3 COMMANDS */

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

function stringId(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function finiteInteger(value, label) {
  if (!Number.isInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}

function credentialScope(value) {
  if (!['llm', 'imageGen'].includes(value)) throw new TypeError('credential scope is invalid');
  return value;
}

function credentialValue(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('credential value is invalid');
  }
  const result = {};
  for (const field of ['apiKey', 'customHeaders']) {
    if (value[field] == null || value[field] === '') continue;
    if (typeof value[field] !== 'string' || value[field].length > 64 * 1024
      || value[field].includes('\u0000')) {
      throw new TypeError(`${field} is invalid`);
    }
    result[field] = value[field];
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError('at least one credential value is required');
  }
  return result;
}

function optionalCredentialValue(value = {}) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('credential value is invalid');
  }
  const result = {};
  for (const field of ['apiKey', 'customHeaders']) {
    if (value[field] == null || value[field] === '') continue;
    if (typeof value[field] !== 'string' || value[field].length > 64 * 1024
      || value[field].includes('\u0000')) {
      throw new TypeError(`${field} is invalid`);
    }
    result[field] = value[field];
  }
  return Object.keys(result).length ? result : undefined;
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
    throw new TypeError('bridge frame command is not declared by protocol V3');
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

function publicProviderConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.llm || typeof value.llm !== 'object' || Array.isArray(value.llm)) {
    throw new TypeError('provider config is invalid');
  }
  const llm = {
    provider: boundedText(value.llm.provider, 'LLM provider', 32),
    baseUrl: boundedText(value.llm.baseUrl, 'LLM base URL', 2048),
    model: boundedText(value.llm.model, 'LLM model', 512),
  };
  if (value.llm.customProviderName) {
    llm.customProviderName = boundedText(
      value.llm.customProviderName,
      'custom provider name',
      160,
    );
  }
  const result = { llm };
  if (value.imageGen != null) {
    if (!value.imageGen || typeof value.imageGen !== 'object' || Array.isArray(value.imageGen)) {
      throw new TypeError('image provider config is invalid');
    }
    result.imageGen = {
      provider: boundedText(value.imageGen.provider, 'image provider', 32),
      baseUrl: boundedText(value.imageGen.baseUrl, 'image base URL', 2048),
      model: boundedText(value.imageGen.model, 'image model', 512),
    };
  }
  return result;
}

function previewReport(value = {}) {
  const detected = value?.detected || {};
  const normalizeNames = (items, label) => {
    if (items == null) return [];
    if (!Array.isArray(items) || items.length > 256) throw new TypeError(`${label} is invalid`);
    return items.map((item) => boundedText(item, label, 110));
  };
  return {
    detected: {
      animationClips: normalizeNames(detected.animationClips, 'animation clip'),
      expressions: normalizeNames(detected.expressions, 'expression'),
    },
    capabilities: {
      expressionPlayback: value?.capabilities?.expressionPlayback === true,
      embeddedAnimationPlayback: value?.capabilities?.embeddedAnimationPlayback === true,
      vrmaPlayback: false,
    },
  };
}

function commitAvatar(importId, confirmation = {}) {
  return ipcRenderer.invoke('avatar:commitImport', {
    importId: stringId(importId, 'importId'),
    rightsConfirmed: confirmation?.rightsConfirmed === true,
    warningAccepted: confirmation?.warningsAccepted === true
      || confirmation?.warningAccepted === true,
  });
}

const api = Object.freeze({
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  showNotification: (title, body) => ipcRenderer.invoke('notification:show', { title, body }),
  getNotificationStatus: () => ipcRenderer.invoke('notification:status'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openLocationSettings: () => ipcRenderer.invoke('system:openLocationSettings'),
  getCurrentWindowsLocation: () => ipcRenderer.invoke('location:getCurrent'),
  onAppLifecycle: (callback) => subscribe('app:lifecycle', callback),

  bridge: Object.freeze({
    getConnectionConfig: () => ipcRenderer.invoke('bridge:getConnectionConfig'),
    send: (frame) => ipcRenderer.invoke('bridge:send', bridgeFrame(frame)),
    onMessage: (callback) => subscribe('bridge:message', callback),
    onChanged: (callback) => subscribe('bridge:changed', callback),
  }),

  stickers: Object.freeze({
    importFile: (value = {}) => ipcRenderer.invoke('sticker:importFile', {
      text: typeof value.text === 'string' ? value.text.slice(0, 120) : '',
      emotions: Array.isArray(value.emotions) ? value.emotions.slice(0, 12) : [],
      styleTags: Array.isArray(value.styleTags) ? value.styleTags.slice(0, 12) : [],
    }),
  }),

  companionPreferences: Object.freeze({
    get: () => ipcRenderer.invoke('companionPreferences:get'),
    set: (value = {}) => {
      if (typeof value.volume !== 'number' || !Number.isFinite(value.volume)
        || typeof value.autoStart !== 'boolean') {
        throw new TypeError('companion preferences are invalid');
      }
      return ipcRenderer.invoke('companionPreferences:set', {
        sound: boundedText(value.sound, 'companion sound', 64),
        volume: value.volume,
        autoStart: value.autoStart,
      });
    },
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
    set: (scope, value) => ipcRenderer.invoke('credentials:set', {
      scope: credentialScope(scope),
      value: credentialValue(value),
    }),
    setSession: (scope, value) => ipcRenderer.invoke('credentials:setSession', {
      scope: credentialScope(scope),
      value: credentialValue(value),
    }),
    clear: (scope) => ipcRenderer.invoke('credentials:clear', {
      scope: credentialScope(scope),
    }),
    onChanged: (callback) => subscribe('credentials:changed', callback),
  }),

  providerConfig: Object.freeze({
    get: () => ipcRenderer.invoke('providerConfig:get'),
    set: (value) => ipcRenderer.invoke('providerConfig:set', publicProviderConfig(value)),
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
        testReceipt: stringId(testReceipt, 'provider test receipt'),
      });
    },
  }),

  backup: Object.freeze({
    export: () => ipcRenderer.invoke('backup:exportNative'),
    import: () => ipcRenderer.invoke('backup:importNative'),
    onProgress: (callback) => subscribe('backup:progress', callback),
  }),

  files: Object.freeze({
    saveJson: (suggestedName, payload) => ipcRenderer.invoke('file:saveJson', {
      suggestedName: boundedText(suggestedName, 'suggested file name', 180),
      payload,
    }),
  }),

  avatar: Object.freeze({
    list: () => ipcRenderer.invoke('avatar:list'),
    beginImport: () => ipcRenderer.invoke('avatar:beginImport'),
    beginImportFolder: () => ipcRenderer.invoke('avatar:beginImportFolder'),
    confirmPreview: (importId, report) => ipcRenderer.invoke('avatar:confirmPreview', {
      importId: stringId(importId, 'importId'),
      report: previewReport(report),
    }),
    discardImport: (importId) => ipcRenderer.invoke('avatar:discardImport', {
      importId: stringId(importId, 'importId'),
    }),
    failPreview: (importId) => ipcRenderer.invoke('avatar:previewFailed', {
      importId: stringId(importId, 'importId'),
    }),
    commitImport: commitAvatar,
    remove: (id) => ipcRenderer.invoke('avatar:remove', { id: stringId(id, 'avatar id') }),
    setActive: (id) => ipcRenderer.invoke('avatar:setActive', {
      id: id == null ? null : stringId(id, 'avatar id'),
    }),
    addMotion: (id) => ipcRenderer.invoke('avatar:addMotion', {
      id: stringId(id, 'avatar id'),
    }),
    removeMotion: (id, motionId) => ipcRenderer.invoke('avatar:removeMotion', {
      id: stringId(id, 'avatar id'),
      motionId: stringId(motionId, 'motion id'),
    }),
    setMapping: (id, category, key, target) => {
      if (!['expression', 'action'].includes(category)) {
        throw new TypeError('mapping category is invalid');
      }
      return ipcRenderer.invoke('avatar:setMapping', {
        id: stringId(id, 'avatar id'),
        category,
        key: stringId(key, 'mapping key'),
        target: target == null ? null : boundedText(target, 'mapping target', 128),
      });
    },
    onChanged: (callback) => subscribe('avatar:changed', callback),
  }),

  focusSound: Object.freeze({
    list: () => ipcRenderer.invoke('focusSound:list'),
    import: () => ipcRenderer.invoke('focusSound:import'),
    open: (id) => ipcRenderer.invoke('focusSound:open', {
      id: stringId(id, 'focus sound id'),
    }),
    remove: (id) => ipcRenderer.invoke('focusSound:remove', {
      id: stringId(id, 'focus sound id'),
    }),
    onChanged: (callback) => subscribe('focusSound:changed', callback),
  }),

  focus: Object.freeze({
    getState: () => ipcRenderer.invoke('focus:getState'),
    start: (durationSeconds) => ipcRenderer.invoke('focus:start', {
      durationSeconds: finiteInteger(durationSeconds, 'durationSeconds'),
    }),
    pause: (id) => ipcRenderer.invoke('focus:pause', { id: stringId(id, 'focus id') }),
    resume: (id) => ipcRenderer.invoke('focus:resume', { id: stringId(id, 'focus id') }),
    stop: (id) => ipcRenderer.invoke('focus:stop', { id: stringId(id, 'focus id') }),
    acknowledgeAudioRearm: (id) => ipcRenderer.invoke('focus:ackAudioRearm', {
      id: stringId(id, 'focus id'),
    }),
    onChanged: (callback) => subscribe('focus:changed', callback),
    onCompleted: (callback) => subscribe('focus:completed', callback),
    showNotification: (title, body) => ipcRenderer.invoke('notification:show', { title, body }),
  }),
});

if (process.isMainFrame !== false) {
  contextBridge.exposeInMainWorld('electronAPI', api);
}
