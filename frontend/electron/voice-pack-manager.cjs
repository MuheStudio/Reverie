'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MANIFEST_SCHEMA = 'reverie.voice-pack.v1';
const ACTIVE_SCHEMA = 'reverie.voice-pack-active.v1';
const RUNTIME_FAMILY = 'gpt-sovits';
const RUNTIME_VERSION = 'v2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_BY_EXTENSION = new Map([
  ['.ckpt', 'gptCheckpoint'],
  ['.pth', 'sovitsCheckpoint'],
  ['.wav', 'referenceAudio'],
  ['.txt', 'transcript'],
  ['.lab', 'transcript'],
]);
const FORBIDDEN_EXTENSIONS = new Set([
  '.app', '.apk', '.bat', '.bin', '.cmd', '.com', '.command', '.cpl', '.crx',
  '.dll', '.dmg', '.exe', '.gadget', '.hta', '.inf', '.ins', '.ipa', '.iso',
  '.jar', '.js', '.jse', '.lnk', '.mjs', '.cjs', '.msi', '.msp', '.mst', '.ocx',
  '.pif', '.ps1', '.ps2', '.psc1', '.psc2', '.py', '.pyc', '.rb', '.reg', '.scr',
  '.sh', '.sys', '.vb', '.vbe', '.vbs', '.ws', '.wsc', '.wsf', '.wsh',
]);
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 128,
  maxDepth: 2,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFileBytes: 768 * 1024 * 1024,
  maxWavBytes: 32 * 1024 * 1024,
  maxTranscriptBytes: 64 * 1024,
  maxTranscriptCharacters: 10000,
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateOriginalName(name) {
  // Trailing dots/spaces are silently stripped by the Win32 namespace, which
  // would desync the stored payload name from the manifest entry forever.
  if (!name || name.length > 255 || /[ .]$/.test(name) || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw fail('VOICE_PACK_INVALID_NAME', 'Voice-pack file name is invalid');
  }
}

function identity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF', 'EACCES'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function writeJsonDurably(filePath, value) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function replaceJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`);
  try {
    writeJsonDurably(temporary, value);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readStrictTranscript(filePath, limits) {
  const stat = fs.statSync(filePath, { bigint: true });
  if (stat.size < 1n || stat.size > BigInt(limits.maxTranscriptBytes)) {
    throw fail('VOICE_PACK_TRANSCRIPT_SIZE', 'Transcript size is outside the allowed range');
  }
  const bytes = fs.readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail('VOICE_PACK_TRANSCRIPT_UTF8', 'Transcript must be strict UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim() || text.length > limits.maxTranscriptCharacters
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw fail('VOICE_PACK_TRANSCRIPT_CONTENT', 'Transcript is empty, too long, or contains control characters');
  }
  return { bytes: Number(stat.size), characters: text.length };
}

function validateWav(filePath, limits) {
  const stat = fs.statSync(filePath, { bigint: true });
  if (stat.size < 44n || stat.size > BigInt(limits.maxWavBytes)) {
    throw fail('VOICE_PACK_WAV_SIZE', 'Reference WAV size is outside the allowed range');
  }
  const wav = fs.readFileSync(filePath);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.readUInt32LE(4) + 8 !== wav.length) {
    throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference audio is not a complete RIFF/WAVE file');
  }

  let offset = 12;
  let format = null;
  let dataSize = null;
  while (offset < wav.length) {
    if (offset + 8 > wav.length) throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV has a truncated chunk header');
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkSize;
    if (end > wav.length) throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV has a truncated chunk');
    if (chunkId === 'fmt ') {
      if (format || chunkSize < 16) throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV has an invalid fmt chunk');
      format = {
        audioFormat: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        byteRate: wav.readUInt32LE(start + 8),
        blockAlign: wav.readUInt16LE(start + 12),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (chunkId === 'data') {
      if (dataSize !== null) throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV has multiple data chunks');
      dataSize = chunkSize;
    }
    offset = end + (chunkSize % 2);
    if (offset > wav.length) throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV has invalid chunk padding');
  }
  if (offset !== wav.length || !format || dataSize === null || dataSize < 1) {
    throw fail('VOICE_PACK_WAV_STRUCTURE', 'Reference WAV is missing required PCM chunks');
  }
  const bytesPerSample = format.bitsPerSample / 8;
  const expectedAlign = format.channels * bytesPerSample;
  if (format.audioFormat !== 1 || ![1, 2].includes(format.channels)
    || format.sampleRate < 8000 || format.sampleRate > 192000
    || ![8, 16, 24, 32].includes(format.bitsPerSample)
    || format.blockAlign !== expectedAlign
    || format.byteRate !== format.sampleRate * expectedAlign
    || dataSize % expectedAlign !== 0) {
    throw fail('VOICE_PACK_WAV_FORMAT', 'Reference WAV must use sane mono/stereo integer PCM');
  }
  const durationSeconds = dataSize / format.byteRate;
  if (durationSeconds < 1 || durationSeconds > 30) {
    throw fail('VOICE_PACK_WAV_DURATION', 'Reference WAV duration must be between 1 and 30 seconds');
  }
  return { ...format, durationSeconds };
}

function openVerifiedSource(file, rootRealPath) {
  const before = fs.lstatSync(file.absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(identity(before), file.identity)) {
    throw fail('VOICE_PACK_SOURCE_CHANGED', `Source changed after preview: ${file.relativePath}`);
  }
  const canonical = fs.realpathSync.native(file.absolutePath);
  if (!isContained(rootRealPath, canonical) || canonical !== file.realPath) {
    throw fail('VOICE_PACK_SOURCE_ESCAPE', `Source path escaped or changed: ${file.relativePath}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(file.absolutePath, flags);
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || !sameIdentity(identity(opened), file.identity)) {
    fs.closeSync(descriptor);
    throw fail('VOICE_PACK_SOURCE_CHANGED', `Source changed while opening: ${file.relativePath}`);
  }
  return descriptor;
}

function hashVerifiedSource(file, rootRealPath) {
  const descriptor = openVerifiedSource(file, rootRealPath);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0n;
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      total += BigInt(count);
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(identity(after), file.identity) || total !== BigInt(file.identity.size)) {
      throw fail('VOICE_PACK_SOURCE_CHANGED', `Source changed while reading: ${file.relativePath}`);
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyVerifiedSource(file, rootRealPath, destination) {
  const source = openVerifiedSource(file, rootRealPath);
  let target;
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0n;
  try {
    target = fs.openSync(destination, 'wx', 0o600);
    for (;;) {
      const count = fs.readSync(source, buffer, 0, buffer.length, null);
      if (!count) break;
      total += BigInt(count);
      let written = 0;
      while (written < count) written += fs.writeSync(target, buffer, written, count - written);
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(source, { bigint: true });
    const digest = hash.digest('hex');
    if (!sameIdentity(identity(after), file.identity) || total !== BigInt(file.identity.size)
      || digest !== file.sha256) {
      throw fail('VOICE_PACK_SOURCE_CHANGED', `Source changed while copying: ${file.relativePath}`);
    }
    fs.fsyncSync(target);
    return { sha256: digest, size: Number(total) };
  } finally {
    if (target !== undefined) fs.closeSync(target);
    fs.closeSync(source);
  }
}

class VoicePackManager {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('VoicePackManager requires an app-owned storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.root = path.join(this.storageDir, 'voice-packs');
    this.partialRoot = path.join(this.root, '.partial');
    this.activePath = path.join(this.root, 'active.json');
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.previews = new Map();
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid voice-pack limit: ${name}`);
    }
    this._ensureStorage();
  }

  _ensureStorage() {
    fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    for (const directory of [this.storageDir, this.root, this.partialRoot]) {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw fail('VOICE_PACK_STORAGE_UNSAFE', 'Voice-pack storage must be an app-owned real directory');
      }
    }
    this._sweepStalePartials();
  }

  // Crash windows can leave staging/removal partials behind. Anything older
  // than a day cannot belong to a live import (commit timeout is 10 minutes),
  // so reclaim the disk instead of leaking it forever.
  _sweepStalePartials(maxAgeMs = 24 * 60 * 60 * 1000) {
    let entries;
    try {
      entries = fs.readdirSync(this.partialRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const entry of entries) {
      const target = path.join(this.partialRoot, entry.name);
      try {
        const stat = fs.statSync(target);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  _scan(sourceDirectory) {
    if (typeof sourceDirectory !== 'string' || !sourceDirectory) throw new TypeError('Source directory is required');
    const sourcePath = path.resolve(sourceDirectory);
    const rootStat = fs.lstatSync(sourcePath, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw fail('VOICE_PACK_SOURCE_UNSAFE', 'Selected source must be a real directory');
    }
    const rootRealPath = fs.realpathSync.native(sourcePath);
    const files = [];
    const directories = new Set();
    let totalBytes = 0n;

    const walk = (directory, segments) => {
      let hasContent = false;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '__MACOSX' && entry.isDirectory()) continue;
        if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue;
        validateOriginalName(entry.name);
        const nextSegments = [...segments, entry.name];
        if (nextSegments.length > this.limits.maxDepth) {
          throw fail('VOICE_PACK_DEPTH_LIMIT', 'Voice pack exceeds the directory-depth limit');
        }
        const absolutePath = path.join(directory, entry.name);
        const stat = fs.lstatSync(absolutePath, { bigint: true });
        if (stat.isSymbolicLink()) throw fail('VOICE_PACK_LINK_REJECTED', `Links are not allowed: ${nextSegments.join('/')}`);
        if (stat.isDirectory()) {
          if (walk(absolutePath, nextSegments)) {
            directories.add(nextSegments.join('/'));
            hasContent = true;
          }
          continue;
        }
        if (!stat.isFile()) throw fail('VOICE_PACK_NON_FILE', `Non-file entry is not allowed: ${nextSegments.join('/')}`);
        if (files.length + 1 > this.limits.maxFiles) throw fail('VOICE_PACK_FILE_LIMIT', 'Voice pack has too many files');
        if (stat.size > BigInt(this.limits.maxFileBytes)) throw fail('VOICE_PACK_FILE_SIZE', 'A voice-pack file is too large');
        totalBytes += stat.size;
        if (totalBytes > BigInt(this.limits.maxTotalBytes)) throw fail('VOICE_PACK_TOTAL_SIZE', 'Voice pack is too large');
        const extension = path.extname(entry.name).toLowerCase();
        if (FORBIDDEN_EXTENSIONS.has(extension)) {
          throw fail('VOICE_PACK_EXECUTABLE', `Executable or script content is not allowed: ${nextSegments.join('/')}`);
        }
        const realPath = fs.realpathSync.native(absolutePath);
        if (!isContained(rootRealPath, realPath)) throw fail('VOICE_PACK_SOURCE_ESCAPE', 'Voice-pack file escapes the selected directory');
        files.push({
          absolutePath,
          extension,
          identity: identity(stat),
          originalName: entry.name,
          realPath,
          relativePath: nextSegments.join('/'),
          role: ROLE_BY_EXTENSION.get(extension) || null,
        });
        hasContent = true;
      }
      return hasContent;
    };
    walk(sourcePath, []);

    const roleFiles = files.filter((file) => file.role);
    const counts = new Map();
    for (const file of roleFiles) counts.set(file.role, (counts.get(file.role) || 0) + 1);
    for (const role of ['gptCheckpoint', 'sovitsCheckpoint', 'referenceAudio', 'transcript']) {
      if (counts.get(role) !== 1) throw fail('VOICE_PACK_REQUIRED_FILES', `Voice pack must contain exactly one ${role} file`);
    }
    if (roleFiles.length !== 4) throw fail('VOICE_PACK_REQUIRED_FILES', 'Voice pack has duplicate required assets');
    const parents = new Set(roleFiles.map((file) => path.posix.dirname(file.relativePath)));
    if (parents.size !== 1) throw fail('VOICE_PACK_LAYOUT', 'Required voice-pack files must share one directory');
    const wrapper = [...parents][0];
    if (wrapper !== '.' && wrapper.includes('/')) throw fail('VOICE_PACK_LAYOUT', 'Only one wrapper directory is supported');
    if (wrapper === '.' && directories.size > 0) throw fail('VOICE_PACK_LAYOUT', 'Unexpected directory in an unwrapped voice pack');
    if (wrapper !== '.' && (directories.size !== 1 || !directories.has(wrapper))) {
      throw fail('VOICE_PACK_LAYOUT', 'Voice pack may contain only one wrapper directory');
    }
    return { rootIdentity: identity(rootStat), rootRealPath, sourcePath, wrapper: wrapper === '.' ? null : wrapper, files: roleFiles };
  }

  preview(sourceDirectory) {
    const candidate = this._scan(sourceDirectory);
    const wav = candidate.files.find((file) => file.role === 'referenceAudio');
    const transcript = candidate.files.find((file) => file.role === 'transcript');
    candidate.wav = validateWav(wav.absolutePath, this.limits);
    candidate.transcript = readStrictTranscript(transcript.absolutePath, this.limits);
    for (const file of candidate.files) file.sha256 = hashVerifiedSource(file, candidate.rootRealPath);
    const previewId = crypto.randomUUID();
    candidate.previewId = previewId;
    this.previews.set(previewId, candidate);
    return {
      previewId,
      format: 'legacy-gpt-sovits',
      runtimeFamily: RUNTIME_FAMILY,
      runtimeVersion: RUNTIME_VERSION,
      wrapperDirectory: candidate.wrapper,
      files: candidate.files.map((file) => ({
        role: file.role,
        originalName: file.originalName,
        sourceRelativePath: file.relativePath,
        sha256: file.sha256,
        size: Number(file.identity.size),
      })),
      referenceAudio: candidate.wav,
      transcript: candidate.transcript,
    };
  }

  commit(preview, confirmation = {}) {
    const previewId = typeof preview === 'string' ? preview : preview?.previewId;
    if (!UUID_PATTERN.test(previewId || '') || !this.previews.has(previewId)) {
      throw fail('VOICE_PACK_PREVIEW_INVALID', 'Voice-pack preview is invalid or expired');
    }
    if (confirmation.rightsAttested !== true || confirmation.runtimeFamily !== RUNTIME_FAMILY
      || confirmation.runtimeVersion !== RUNTIME_VERSION) {
      throw fail('VOICE_PACK_CONFIRMATION_REQUIRED', 'Local-use rights and exact GPT-SoVITS v2 runtime confirmation are required');
    }
    const candidate = this.previews.get(previewId);
    this.previews.delete(previewId);
    const currentRoot = fs.lstatSync(candidate.sourcePath, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()
      || !sameIdentity(identity(currentRoot), candidate.rootIdentity)
      || fs.realpathSync.native(candidate.sourcePath) !== candidate.rootRealPath) {
      throw fail('VOICE_PACK_SOURCE_CHANGED', 'Selected source directory changed after preview');
    }

    this._ensureStorage();
    const id = crypto.randomUUID();
    const stage = path.join(this.partialRoot, `${id}.partial`);
    const payload = path.join(stage, 'payload');
    const record = path.join(this.root, id);
    let renamed = false;
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      fs.mkdirSync(payload, { mode: 0o700 });
      const manifestFiles = [];
      for (const file of candidate.files) {
        const destination = path.join(payload, file.originalName);
        const copied = copyVerifiedSource(file, candidate.rootRealPath, destination);
        manifestFiles.push({
          role: file.role,
          originalName: file.originalName,
          sourceRelativePath: file.relativePath,
          storedPath: `payload/${file.originalName}`,
          sha256: copied.sha256,
          size: copied.size,
        });
      }
      fsyncDirectory(payload);
      const manifest = {
        schema: MANIFEST_SCHEMA,
        id,
        format: 'legacy-gpt-sovits',
        runtime: { family: RUNTIME_FAMILY, version: RUNTIME_VERSION },
        createdAt: new Date().toISOString(),
        wrapperDirectory: candidate.wrapper,
        files: manifestFiles,
        referenceAudio: candidate.wav,
        transcript: candidate.transcript,
        rightsAttestation: {
          attested: true,
          scope: 'local-use import',
          attestedAt: new Date().toISOString(),
        },
      };
      writeJsonDurably(path.join(stage, `${MANIFEST_SCHEMA}.json`), manifest);
      fsyncDirectory(stage);
      fs.renameSync(stage, record);
      renamed = true;
      fsyncDirectory(this.root);
      return { ...manifest, recordPath: record, active: this._readActiveId() === id };
    } catch (error) {
      if (renamed) {
        try { fs.renameSync(record, stage); } catch {}
      }
      throw error;
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    }
  }

  _readManifest(id) {
    if (!UUID_PATTERN.test(id)) throw fail('VOICE_PACK_ID_INVALID', 'Voice-pack id is invalid');
    const record = path.join(this.root, id);
    const recordStat = fs.lstatSync(record);
    if (!recordStat.isDirectory() || recordStat.isSymbolicLink()) throw fail('VOICE_PACK_RECORD_CORRUPT', 'Voice-pack record is unsafe');
    const manifestPath = path.join(record, `${MANIFEST_SCHEMA}.json`);
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw fail('VOICE_PACK_RECORD_CORRUPT', 'Voice-pack manifest is unsafe');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schema !== MANIFEST_SCHEMA || manifest.id !== id
      || manifest.runtime?.family !== RUNTIME_FAMILY || manifest.runtime?.version !== RUNTIME_VERSION
      || manifest.rightsAttestation?.attested !== true || !Array.isArray(manifest.files)
      || manifest.files.length !== 4) {
      throw fail('VOICE_PACK_RECORD_CORRUPT', 'Voice-pack manifest is corrupt');
    }
    for (const file of manifest.files) {
      if (!ROLE_BY_EXTENSION.has(path.extname(file.originalName || '').toLowerCase())
        || !/^[0-9a-f]{64}$/.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || file.size < 1
        || file.storedPath !== `payload/${file.originalName}`) {
        throw fail('VOICE_PACK_RECORD_CORRUPT', 'Voice-pack manifest file entry is corrupt');
      }
      validateOriginalName(file.originalName);
      const payloadPath = path.join(record, 'payload', file.originalName);
      const payloadStat = fs.lstatSync(payloadPath);
      if (!payloadStat.isFile() || payloadStat.isSymbolicLink() || payloadStat.size !== file.size) {
        throw fail('VOICE_PACK_RECORD_CORRUPT', 'Voice-pack payload is missing or unsafe');
      }
    }
    return { ...manifest, recordPath: record };
  }

  _verifyPayloadHashes(manifest) {
    for (const file of manifest.files) {
      const payloadPath = path.join(manifest.recordPath, 'payload', file.originalName);
      const descriptor = fs.openSync(payloadPath, 'r');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      try {
        let count;
        while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          hash.update(buffer.subarray(0, count));
        }
      } finally { fs.closeSync(descriptor); }
      if (hash.digest('hex') !== file.sha256) {
        throw fail('VOICE_PACK_RECORD_CORRUPT', `Voice-pack payload hash mismatch: ${file.originalName}`);
      }
    }
  }

  _readActiveId() {
    try {
      const stat = fs.lstatSync(this.activePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('unsafe active record');
      const active = JSON.parse(fs.readFileSync(this.activePath, 'utf8'));
      if (active.schema !== ACTIVE_SCHEMA || (active.id !== null && !UUID_PATTERN.test(active.id))) throw new Error('invalid active record');
      return active.id;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail('VOICE_PACK_ACTIVE_CORRUPT', 'Active voice-pack metadata is corrupt');
    }
  }

  list() {
    this._ensureStorage();
    const activeId = this._readActiveId();
    const records = [];
    const corrupt = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!UUID_PATTERN.test(entry.name)) continue;
      try {
        const manifest = this._readManifest(entry.name);
        records.push({ ...manifest, active: entry.name === activeId });
      } catch (error) {
        // One damaged record must never brick the whole library view; surface
        // it so the UI can offer cleanup instead of hiding the problem.
        corrupt.push({ id: entry.name, reason: error?.message || 'record is corrupt' });
      }
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { records, corrupt };
  }

  setActive(id) {
    this._ensureStorage();
    if (id !== null) {
      const manifest = this._readManifest(id);
      this._verifyPayloadHashes(manifest);
    }
    replaceJsonAtomically(this.activePath, { schema: ACTIVE_SCHEMA, id });
    return id;
  }

  remove(id) {
    this._ensureStorage();
    this._readManifest(id);
    const record = path.join(this.root, id);
    const tombstone = path.join(this.partialRoot, `${id}.remove-${crypto.randomBytes(8).toString('hex')}.partial`);
    const previousActive = this._readActiveId();
    fs.renameSync(record, tombstone);
    try {
      if (previousActive === id) replaceJsonAtomically(this.activePath, { schema: ACTIVE_SCHEMA, id: null });
    } catch (error) {
      fs.renameSync(tombstone, record);
      throw error;
    }
    fsyncDirectory(this.root);
    fs.rmSync(tombstone, { recursive: true });
    fsyncDirectory(this.partialRoot);
    return true;
  }
}

module.exports = {
  DEFAULT_LIMITS,
  MANIFEST_SCHEMA,
  RUNTIME_FAMILY,
  RUNTIME_VERSION,
  VoicePackManager,
  validateWav,
};
