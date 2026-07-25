'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MiB = 1024 * 1024;
const MAX_SOUND_BYTES = 100 * MiB;
const MANIFEST_SCHEMA = 'reverie.focus-sound.v1';
const SOUND_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const FORMAT_BY_EXTENSION = Object.freeze({
  '.aac': { format: 'aac', mimeType: 'audio/aac' },
  '.flac': { format: 'flac', mimeType: 'audio/flac' },
  '.m4a': { format: 'm4a', mimeType: 'audio/mp4' },
  '.mp3': { format: 'mp3', mimeType: 'audio/mpeg' },
  '.ogg': { format: 'ogg', mimeType: 'audio/ogg' },
  '.wav': { format: 'wav', mimeType: 'audio/wav' },
});

function soundError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeName(value) {
  const cleaned = String(value || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Focus sound';
}

function atomicWriteJson(filePath, value) {
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function validateMpegFrame(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    return false;
  }
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrate = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRate = (bytes[offset + 2] >> 2) & 0x03;
  return version !== 1 && layer !== 0 && bitrate > 0 && bitrate < 15 && sampleRate < 3;
}

function syncSafeInteger(bytes, offset) {
  const values = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (values.some((value) => (value & 0x80) !== 0)) return -1;
  return (values[0] << 21) | (values[1] << 14) | (values[2] << 7) | values[3];
}

function validateSoundMagic(bytes, expectedFormat, totalSize) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || totalSize < 12) {
    throw soundError('FOCUS_SOUND_MAGIC', 'Audio file is too small');
  }
  let detected = null;
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    detected = 'wav';
  } else if (bytes.toString('ascii', 0, 4) === 'fLaC') {
    detected = 'flac';
  } else if (bytes.toString('ascii', 0, 4) === 'OggS'
    && (bytes.includes(Buffer.from('vorbis')) || bytes.includes(Buffer.from('OpusHead')))) {
    detected = 'ogg';
  } else if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'].includes(brand)) detected = 'm4a';
  } else if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    detected = 'aac';
  } else {
    let frameOffset = 0;
    if (bytes.toString('ascii', 0, 3) === 'ID3') {
      const tagSize = syncSafeInteger(bytes, 6);
      const footerSize = (bytes[5] & 0x10) ? 10 : 0;
      if (tagSize < 0 || tagSize > 4 * MiB) {
        throw soundError('FOCUS_SOUND_MAGIC', 'MP3 ID3 metadata is invalid or too large');
      }
      frameOffset = 10 + tagSize + footerSize;
    }
    if (validateMpegFrame(bytes, frameOffset)) detected = 'mp3';
  }
  if (!detected || detected !== expectedFormat) {
    throw soundError('FOCUS_SOUND_MAGIC', 'Audio extension and verified file format do not match');
  }
  return detected;
}

function copyAndHash(sourcePath, targetPath, maxBytes) {
  const source = path.resolve(String(sourcePath || ''));
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 12 || before.size > maxBytes) {
    throw soundError('FOCUS_SOUND_SOURCE', 'Audio must be a regular file no larger than 100 MiB');
  }
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let output = null;
  const hash = crypto.createHash('sha256');
  const headerChunks = [];
  let headerBytes = 0;
  let total = 0;
  try {
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.size !== before.size
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw soundError('FOCUS_SOUND_CHANGED', 'Audio source changed while it was being opened');
    }
    output = fs.openSync(targetPath, 'wx', 0o600);
    const chunk = Buffer.allocUnsafe(MiB);
    for (;;) {
      const read = fs.readSync(input, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw soundError('FOCUS_SOUND_SIZE', 'Audio grew beyond the 100 MiB limit');
      const slice = chunk.subarray(0, read);
      hash.update(slice);
      if (headerBytes < 4 * MiB + 32) {
        const take = Math.min(slice.length, (4 * MiB + 32) - headerBytes);
        headerChunks.push(Buffer.from(slice.subarray(0, take)));
        headerBytes += take;
      }
      let written = 0;
      while (written < read) written += fs.writeSync(output, chunk, written, read - written);
    }
    if (total !== opened.size) throw soundError('FOCUS_SOUND_CHANGED', 'Audio source changed while it was copied');
    fs.fsyncSync(output);
    return {
      size: total,
      sha256: hash.digest('hex'),
      header: Buffer.concat(headerChunks),
    };
  } catch (error) {
    try { fs.unlinkSync(targetPath); } catch {}
    throw error;
  } finally {
    fs.closeSync(input);
    if (output !== null) fs.closeSync(output);
  }
}

class FocusSoundManager {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('FocusSoundManager requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.recordsDir = path.join(this.storageDir, 'records');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    fs.mkdirSync(this.recordsDir, { recursive: true });
    this.cleanupPartials();
  }

  cleanupPartials() {
    for (const name of fs.readdirSync(this.recordsDir)) {
      if (!name.endsWith('.partial')) continue;
      const target = path.join(this.recordsDir, name);
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
  }

  _readManifest(id) {
    const soundId = String(id || '');
    if (!SOUND_ID_RE.test(soundId)) throw soundError('FOCUS_SOUND_ID', 'Focus sound identifier is invalid');
    const root = path.join(this.recordsDir, soundId);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw soundError('FOCUS_SOUND_RECORD', 'Focus sound record is invalid');
    }
    const manifestPath = path.join(root, 'manifest.json');
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw soundError('FOCUS_SOUND_RECORD', 'Focus sound manifest is invalid');
    }
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const expected = FORMAT_BY_EXTENSION[value?.extension];
    if (value?.schema !== MANIFEST_SCHEMA || value.id !== soundId || !expected
      || value.format !== expected.format || value.mimeType !== expected.mimeType
      || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80
      || !Number.isSafeInteger(value.size) || value.size < 12 || value.size > MAX_SOUND_BYTES
      || !/^[a-f0-9]{64}$/i.test(String(value.sha256 || ''))
      || !Number.isFinite(Date.parse(value.importedAtUtc))) {
      throw soundError('FOCUS_SOUND_RECORD', 'Focus sound manifest schema is invalid');
    }
    return value;
  }

  _record(manifest) {
    return {
      id: manifest.id,
      name: manifest.name,
      url: `reverie-focus://sound/${manifest.id}`,
      format: manifest.format,
      mimeType: manifest.mimeType,
      size: manifest.size,
      importedAtUtc: manifest.importedAtUtc,
    };
  }

  list() {
    const records = [];
    for (const name of fs.readdirSync(this.recordsDir)) {
      if (!SOUND_ID_RE.test(name)) continue;
      try { records.push(this._record(this._readManifest(name))); } catch {}
    }
    records.sort((a, b) => a.name.localeCompare(b.name));
    return { records };
  }

  get(id) {
    return this._record(this._readManifest(id));
  }

  import(sourcePath) {
    const source = path.resolve(String(sourcePath || ''));
    const extension = path.extname(source).toLowerCase();
    const expected = FORMAT_BY_EXTENSION[extension];
    if (!expected) {
      throw soundError('FOCUS_SOUND_FORMAT', 'Choose an AAC, FLAC, M4A, MP3, OGG, or WAV audio file');
    }
    const id = crypto.randomUUID();
    const partial = path.join(this.recordsDir, `${id}.partial`);
    const finalRoot = path.join(this.recordsDir, id);
    fs.mkdirSync(partial, { recursive: false });
    try {
      const payload = path.join(partial, `sound${extension}`);
      const copied = copyAndHash(source, payload, MAX_SOUND_BYTES);
      validateSoundMagic(copied.header, expected.format, copied.size);
      const manifest = {
        schema: MANIFEST_SCHEMA,
        id,
        name: safeName(path.basename(source, extension)),
        extension,
        format: expected.format,
        mimeType: expected.mimeType,
        size: copied.size,
        sha256: copied.sha256,
        importedAtUtc: new Date(this.now()).toISOString(),
      };
      atomicWriteJson(path.join(partial, 'manifest.json'), manifest);
      fs.renameSync(partial, finalRoot);
      return this._record(manifest);
    } catch (error) {
      try { fs.rmSync(partial, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  remove(id) {
    const manifest = this._readManifest(id);
    const target = path.join(this.recordsDir, manifest.id);
    if (!isInside(this.recordsDir, target)) throw soundError('FOCUS_SOUND_ID', 'Focus sound identifier is invalid');
    fs.rmSync(target, { recursive: true, force: false });
    return { removed: true, id: manifest.id };
  }

  open(id) {
    const manifest = this._readManifest(id);
    const root = path.join(this.recordsDir, manifest.id);
    const target = path.join(root, `sound${manifest.extension}`);
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!isInside(realRoot, realTarget)) throw soundError('FOCUS_SOUND_PATH', 'Focus sound path escaped its record');
    const fd = fs.openSync(realTarget, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== manifest.size) {
        throw soundError('FOCUS_SOUND_CHANGED', 'Focus sound changed after import');
      }
      const hash = crypto.createHash('sha256');
      const chunk = Buffer.allocUnsafe(MiB);
      let position = 0;
      while (position < stat.size) {
        const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (read <= 0) throw soundError('FOCUS_SOUND_CHANGED', 'Focus sound became unreadable');
        hash.update(chunk.subarray(0, read));
        position += read;
      }
      if (hash.digest('hex') !== manifest.sha256) {
        throw soundError('FOCUS_SOUND_CHANGED', 'Focus sound integrity check failed');
      }
      return {
        fd,
        size: stat.size,
        mimeType: manifest.mimeType,
        cacheKey: manifest.sha256,
      };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
}

module.exports = {
  FORMAT_BY_EXTENSION,
  FocusSoundManager,
  MANIFEST_SCHEMA,
  MAX_SOUND_BYTES,
  SOUND_ID_RE,
  validateSoundMagic,
};
