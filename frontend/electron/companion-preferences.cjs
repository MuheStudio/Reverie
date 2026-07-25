'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 'reverie.companion-preferences.v1';
const DEFAULTS = Object.freeze({ sound: 'rain', volume: 0.2, autoStart: true });
const BUILTIN_SOUNDS = new Set(['rain', 'wind', 'fire', 'library', 'pink']);

function normalizeCompanionPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['schema', 'sound', 'volume', 'autoStart'].includes(key))) {
    throw new TypeError('companion preferences are invalid');
  }
  const sound = String(value.sound || '');
  if (!BUILTIN_SOUNDS.has(sound) && !/^custom:[0-9a-f-]{36}$/i.test(sound)) {
    throw new TypeError('companion sound is invalid');
  }
  if (typeof value.volume !== 'number' || !Number.isFinite(value.volume)
    || value.volume < 0 || value.volume > 1) {
    throw new TypeError('companion volume is invalid');
  }
  if (typeof value.autoStart !== 'boolean') {
    throw new TypeError('companion autoStart is invalid');
  }
  return {
    schema: SCHEMA,
    sound,
    volume: Math.round(value.volume * 1000) / 1000,
    autoStart: value.autoStart,
  };
}

class CompanionPreferencesStore {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('CompanionPreferencesStore requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.filePath = path.join(this.storageDir, 'preferences.json');
  }

  get() {
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 64 * 1024) {
        throw new Error('invalid companion preferences file');
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw.schema !== SCHEMA) throw new Error('invalid companion preferences schema');
      const normalized = normalizeCompanionPreferences(raw);
      delete normalized.schema;
      return normalized;
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULTS };
      const wrapped = new Error('Companion preferences are unavailable or corrupt');
      wrapped.code = 'REVERIE_COMPANION_PREFERENCES_CORRUPT';
      throw wrapped;
    }
  }

  set(value) {
    const normalized = normalizeCompanionPreferences(value);
    fs.mkdirSync(this.storageDir, { recursive: true });
    const temporary = path.join(
      this.storageDir,
      `.preferences.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(temporary); } catch {}
    }
    const result = { ...normalized };
    delete result.schema;
    return result;
  }
}

module.exports = {
  BUILTIN_SOUNDS,
  CompanionPreferencesStore,
  DEFAULTS,
  SCHEMA,
  normalizeCompanionPreferences,
};
