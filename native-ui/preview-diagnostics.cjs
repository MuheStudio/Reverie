'use strict';

// This is a deliberately separate, read-only reader. Never reuse the launcher
// workspace initializer here: diagnostics must also work while its lock is held.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCHEMA = 'reverie.qt.preview-diagnostics.v1';
const SNAPSHOT_SCHEMA = 'reverie.preview.snapshot.v1';
const SNAPSHOT_SCHEMA_V2 = 'reverie.preview.snapshot.v2';
const EVENT_FILE = 'preview-events.jsonl';
const EVENT_SCHEMA = 'reverie.qt.preview-event.v1';
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 1024;
const MAX_EVENTS = 128;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 50000;
const MAX_SCAN_DEPTH = 64;
const MAX_SNAPSHOT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_HASH_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 100000;
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOTS = 100;
const FIXED_DIRECTORIES = Object.freeze(['data', 'avatars', 'qml-cache', 'logs', 'snapshots']);
const EVENT_NAMES = Object.freeze(['startup', 'snapshot_skipped', 'snapshot_created', 'snapshot_reused',
  'snapshot_failed', 'snapshot_warning', 'keychain_read_started', 'keychain_ready', 'backend_starting',
  'ready', 'startup_failed', 'backend_exit', 'restore_state', 'service_failure', 'exit']);
const EVENT_CODES = Object.freeze(['OK', 'UNKNOWN', 'FIRST_LAUNCH', 'UNCHANGED', 'CREATED', 'REUSED',
  'UNMANAGED', 'INVALID_SNAPSHOT', 'KEYCHAIN_UNAVAILABLE', 'KEYCHAIN_KEY_INVALID', 'PREVIEW_SNAPSHOT_FAILED',
  'PREVIEW_READY_RECORD_FAILED', 'CLEAN', 'RECOVERY_REQUIRED', 'READ_ONLY', 'KEY_MISSING_EXISTING_DATABASE',
  'PROVIDER_UNAUTHORIZED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT',
  'PROVIDER_UNREACHABLE', 'PROVIDER_CONNECTION_FAILED', 'PROVIDER_INVALID_RESPONSE', 'PROVIDER_INVALID_RESPONSE_SCHEMA',
  'PROVIDER_EMPTY_RESPONSE', 'PROVIDER_REASONING_ONLY_RESPONSE', 'PROVIDER_OUTPUT_TRUNCATED',
  'PROVIDER_CONTENT_FILTERED', 'PROVIDER_TOOL_ONLY_RESPONSE', 'PROVIDER_REJECTED', 'PROVIDER_FAILURE',
  'PREVIEW_SNAPSHOT_NO_SPACE', 'PREVIEW_SNAPSHOT_SPECIAL_FILE', 'PREVIEW_SNAPSHOT_ENTRY_LIMIT',
  'PREVIEW_SNAPSHOT_SOURCE_CHANGED', 'PREVIEW_SNAPSHOT_VERIFY_FAILED', 'PREVIEW_SNAPSHOT_IO_FAILED',
  'PREVIEW_DATA_FORMAT_TOO_NEW', 'PREVIEW_DATA_FORMAT_INVALID', 'PREVIEW_DATA_FORMAT_WRITE_FAILED',
  'PREVIEW_RESTORE_RECOVERY_REQUIRED', 'PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED']);
const CANDIDATE = /^[A-Za-z0-9._-]{1,128}$/;
const SOURCE = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const candidate = value => typeof value === 'string' && CANDIDATE.test(value) && value !== '.' && value !== '..';
const own = info => info.uid === process.getuid();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const stable = (left, right) => same(left, right) && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function need(value, code = 'PREVIEW_DIAGNOSTICS_UNSAFE') { if (!value) fail(code); }
function canonical(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value &&
    !/[\0\r\n]/.test(value), 'PREVIEW_DIAGNOSTICS_ABSOLUTE_REQUIRED');
  return value;
}
function directory(value, privateMode = false) {
  canonical(value);
  need(fs.realpathSync(value) === value);
  for (let current = value; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    need(info.isDirectory() && !info.isSymbolicLink());
    if (current === path.dirname(current)) break;
  }
  const info = fs.lstatSync(value);
  need(own(info) && (!privateMode || (info.mode & 0o7777) === 0o700));
  return info;
}
function regular(info) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && own(info) && integer(info.size);
}
function readBounded(file, maximum, privateMode = false) {
  const before = fs.lstatSync(file);
  need(regular(before) && (!privateMode || (before.mode & 0o7777) === 0o600));
  need(before.size <= maximum, 'PREVIEW_DIAGNOSTICS_LIMIT');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor);
    need(regular(opened) && stable(before, opened));
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      need(count > 0); offset += count;
    }
    need(stable(before, fs.fstatSync(descriptor)) && stable(before, fs.lstatSync(file)));
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function summarizeDirectory(root, allowSourceLinks = false) {
  const result = { exists: false, bytes: 0, fileCount: 0, directoryCount: 0, skippedLinks: 0, status: 'missing' };
  let entries = 0;
  function walk(file, depth) {
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink()) { result.skippedLinks++; result.status = 'unsafe'; return; }
    if (!own(before)) { result.status = 'unsafe'; return; }
    if (before.isFile()) {
      if (!regular(before) && !(allowSourceLinks && before.isFile() && own(before) && before.nlink >= 1 && integer(before.size))) {
        result.status = 'unsafe'; return;
      }
      need(Number.isSafeInteger(result.bytes + before.size));
      result.bytes += before.size; result.fileCount++; return;
    }
    if (!before.isDirectory()) { result.status = 'unsafe'; return; }
    if (depth > MAX_SCAN_DEPTH) { result.status = 'limit'; return; }
    result.directoryCount++;
    const handle = fs.opendirSync(file);
    try {
      for (let item; (item = handle.readSync()) !== null;) {
        if (++entries > MAX_SCAN_ENTRIES) { result.status = 'limit'; break; }
        walk(path.join(file, item.name), depth + 1);
      }
    } finally { handle.closeSync(); }
    if (!stable(before, fs.lstatSync(file))) result.status = 'changed';
  }
  try {
    const info = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!info) return result;
    result.exists = true; result.status = 'ok';
    if (!info.isDirectory() || info.isSymbolicLink() || !own(info)) {
      if (info.isSymbolicLink()) result.skippedLinks++;
      result.status = 'unsafe'; return result;
    }
    walk(root, 0);
  } catch { result.status = 'changed'; }
  return result;
}
function decimal(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) && integer(Number(value));
}
function sourceIdentity(value) {
  return keysAre(value, ['candidate', 'sourceHead', 'buildManifestSha256']) &&
    candidate(value.candidate) &&
    typeof value.sourceHead === 'string' && SOURCE.test(value.sourceHead) &&
    typeof value.buildManifestSha256 === 'string' && HASH.test(value.buildManifestSha256);
}
function snapshotRelative(value, isDirectory) {
  // Imported filenames may contain whitespace/control characters on disk.
  // Validate containment using components; none of these names are exported.
  if (typeof value !== 'string' || value.length > 1024 || /[\0\\]/.test(value)) return false;
  const parts = value.split('/');
  return (parts[0] === 'data' || parts[0] === 'avatars') && (isDirectory || parts.length > 1) &&
    parts.every(part => part.length > 0 && part !== '.' && part !== '..') &&
    value !== 'data/cache' && !value.startsWith('data/cache/');
}
function sortedJson(value) {
  return JSON.stringify(value, (_key, entry) => object(entry) ?
    Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
function timestampToken(value) {
  if (typeof value !== 'string' || !/^[0-9]{8}T[0-9]{9}Z$/.test(value) || value.startsWith('0000')) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(15, 18)}Z`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso;
}
function snapshotMetadata(name, bytes) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  need(object(manifest));
  const legacy = manifest.schema === SNAPSHOT_SCHEMA, current = manifest.schema === SNAPSHOT_SCHEMA_V2;
  need((legacy || current) && keysAre(manifest, ['schema', 'name', 'createdAt', 'fromReadyId', 'from', 'to', 'transitionSha256',
    'files', 'directories', 'totalBytes', ...(current ? ['kind', 'dataIdentity'] : [])]));
  const kind = legacy ? 'upgrade' : manifest.kind;
  need(['upgrade', 'pre-restore'].includes(kind) && (legacy || sourceIdentity(manifest.dataIdentity)));
  need(manifest.name === name &&
    timestampToken(manifest.createdAt) &&
    typeof manifest.fromReadyId === 'string' && TOKEN.test(manifest.fromReadyId) &&
    sourceIdentity(manifest.from) && sourceIdentity(manifest.to) &&
    typeof manifest.transitionSha256 === 'string' && HASH.test(manifest.transitionSha256));
  if (kind === 'upgrade') {
    need(sortedJson(manifest.from) !== sortedJson(manifest.to));
    if (current) need(sortedJson(manifest.dataIdentity) === sortedJson(manifest.from));
  }
  const digest = crypto.createHash('sha256').update(sortedJson({ fromReadyId: manifest.fromReadyId,
    from: manifest.from, to: manifest.to })).digest('hex');
  const prefix = kind === 'pre-restore'
    ? `pre-restore-${manifest.createdAt}-${manifest.dataIdentity.candidate.slice(0, 32)}-`
    : `snapshot-${manifest.createdAt}-${manifest.from.candidate.slice(0, 32)}--${manifest.to.candidate.slice(0, 32)}-${digest.slice(0, 32)}-`;
  need(manifest.transitionSha256 === digest && name.startsWith(prefix) && /^[0-9a-f]{8}$/.test(name.slice(prefix.length)));
  need(Array.isArray(manifest.files) && Array.isArray(manifest.directories) && decimal(manifest.totalBytes));
  need(manifest.files.length + manifest.directories.length <= MAX_SNAPSHOT_ENTRIES, 'PREVIEW_DIAGNOSTICS_LIMIT');
  const directories = new Set();
  for (const entry of manifest.directories) {
    need(snapshotRelative(entry, true) && !directories.has(entry)); directories.add(entry);
  }
  need(directories.has('data') && directories.has('avatars'));
  for (const entry of directories) need(!entry.includes('/') || directories.has(path.posix.dirname(entry)));
  const files = new Map(); let total = 0;
  for (const entry of manifest.files) {
    need(keysAre(entry, ['path', 'size', 'sha256', ...(current ? ['type', 'sourceLinkCount'] : [])]) && snapshotRelative(entry.path, false) &&
      decimal(entry.size) && typeof entry.sha256 === 'string' && HASH.test(entry.sha256) &&
      !files.has(entry.path) && !directories.has(entry.path) && directories.has(path.posix.dirname(entry.path)));
    if (current) need(entry.type === 'regular' && typeof entry.sourceLinkCount === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(entry.sourceLinkCount) && BigInt(entry.sourceLinkCount) <= 18446744073709551615n);
    files.set(entry.path, entry); total += Number(entry.size); need(integer(total));
  }
  need(total === Number(manifest.totalBytes));
  return { manifest, directories, files, total, kind, legacy };
}
function verifySnapshot(root, metadata, budget) {
  let nodes = 0, total = 0, files = 0, limited = false;
  const seenDirectories = new Set(), seenFiles = new Set();
  function walk(relative, depth) {
    need(depth <= MAX_SNAPSHOT_DEPTH + 1 && ++nodes <= MAX_SNAPSHOT_ENTRIES + 1, 'PREVIEW_DIAGNOSTICS_LIMIT');
    const file = path.join(root, relative), before = fs.lstatSync(file);
    need(own(before) && !before.isSymbolicLink());
    if (before.isDirectory()) {
      need(depth <= MAX_SNAPSHOT_DEPTH, 'PREVIEW_DIAGNOSTICS_LIMIT');
      need((before.mode & 0o7777) === 0o700 && (!relative || metadata.directories.has(relative)));
      if (relative) seenDirectories.add(relative);
      const handle = fs.opendirSync(file);
      try {
        for (let item; (item = handle.readSync()) !== null;) {
          if (!relative && item.name === 'manifest.json') continue;
          walk(relative ? `${relative}/${item.name}` : item.name, depth + 1);
        }
      } finally { handle.closeSync(); }
    } else {
      const expected = metadata.files.get(relative);
      need(regular(before) && (before.mode & 0o7777) === 0o600 && expected && before.size === Number(expected.size));
      seenFiles.add(relative); files++; total += before.size; need(integer(total));
      if (budget.bytes + before.size > MAX_SNAPSHOT_HASH_BYTES) limited = true;
      else {
        budget.bytes += before.size;
        const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          need(stable(before, fs.fstatSync(descriptor)));
          const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
          let offset = 0;
          while (offset < before.size) {
            const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            need(count > 0); hash.update(buffer.subarray(0, count)); offset += count;
          }
          need(hash.digest('hex') === expected.sha256 && stable(before, fs.fstatSync(descriptor)));
        } finally { fs.closeSync(descriptor); }
      }
    }
    need(stable(before, fs.lstatSync(file)));
  }
  walk('', 0);
  need(seenDirectories.size === metadata.directories.size && seenFiles.size === metadata.files.size && total === metadata.total);
  return { bytes: total, fileCount: files, checkStatus: limited ? 'limit' : 'verified' };
}
function snapshots(workspace) {
  const result = { entries: [], unmanagedCount: 0, rejectedCount: 0, truncated: false, status: 'missing' };
  const root = path.join(workspace, 'snapshots');
  try {
    const info = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!info) return result;
    if (!info.isDirectory() || info.isSymbolicLink() || !own(info) || (info.mode & 0o7777) !== 0o700) {
      result.status = 'unsafe'; return result;
    }
    result.status = 'ok'; const budget = { bytes: 0 }, handle = fs.opendirSync(root); let count = 0;
    try {
      for (let item; (item = handle.readSync()) !== null;) {
        if (++count > MAX_SNAPSHOTS) { result.truncated = true; result.status = 'limit'; break; }
        // Do not emit even a plausible managed name until its whole manifest is validated.
        let metadata;
        try {
          need(/^(?:snapshot|pre-restore)-[A-Za-z0-9._-]{1,200}$/.test(item.name));
          const child = path.join(root, item.name), childInfo = fs.lstatSync(child);
          need(childInfo.isDirectory() && !childInfo.isSymbolicLink() && own(childInfo) && (childInfo.mode & 0o7777) === 0o700);
          metadata = snapshotMetadata(item.name, readBounded(path.join(child, 'manifest.json'), MAX_SNAPSHOT_MANIFEST_BYTES, true));
        } catch (error) {
          if (error?.code === 'PREVIEW_DIAGNOSTICS_LIMIT') { result.status = 'limit'; result.truncated = true; }
          else result.unmanagedCount++;
          continue;
        }
        const label = { name: item.name, ...(metadata.legacy ? {} : { kind: metadata.kind }) };
        try { result.entries.push({ ...label, ...verifySnapshot(path.join(root, item.name), metadata, budget) }); }
        catch (error) {
          if (error?.code === 'PREVIEW_DIAGNOSTICS_LIMIT') {
            result.status = 'limit'; result.truncated = true;
            result.entries.push({ ...label, bytes: metadata.total, fileCount: metadata.files.size, checkStatus: 'limit' });
          } else {
            result.rejectedCount++; result.entries.push({ ...label, bytes: metadata.total,
              fileCount: metadata.files.size, checkStatus: 'invalid' });
          }
        }
      }
    } finally { handle.closeSync(); }
    result.entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (!stable(info, fs.lstatSync(root))) result.status = 'changed';
  } catch { result.status = 'changed'; }
  return result;
}

// Event schema is shared with the host's fixed event writer, below. Never copy
// arbitrary properties or error text from a parsed record into an export.
function sanitizeEvent(value) {
  if (!keysAre(value, ['schema', 'event', 'hostPid', 'sequence', 'timeMs', 'elapsedMs', 'code', 'value']) ||
      value.schema !== EVENT_SCHEMA || !EVENT_NAMES.includes(value.event) ||
      !integer(value.hostPid) || value.hostPid < 1 || !integer(value.sequence) || value.sequence < 1 ||
      !integer(value.timeMs) || !integer(value.elapsedMs) || !Number.isSafeInteger(value.value) ||
      typeof value.code !== 'string' || (value.event === 'service_failure' && (value.value < 0 || value.value > 9))) return null;
  return { schema: EVENT_SCHEMA, event: value.event, hostPid: value.hostPid, sequence: value.sequence,
    timeMs: value.timeMs, elapsedMs: value.elapsedMs, code: EVENT_CODES.includes(value.code) ? value.code : 'UNKNOWN',
    value: value.value };
}
function events(workspace) {
  const result = { entries: [], rejectedRecords: 0, truncated: false, status: 'missing' };
  const file = path.join(workspace, EVENT_FILE);
  try {
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info) return result;
    if (!regular(info) || (info.mode & 0o7777) !== 0o600 || info.size > MAX_EVENT_BYTES) {
      result.status = !regular(info) || (info.mode & 0o7777) !== 0o600 ? 'unsafe' : 'limit';
      result.truncated = info.size > MAX_EVENT_BYTES; return result;
    }
    const bytes = readBounded(file, MAX_EVENT_BYTES, true); result.status = 'ok';
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line) continue;
      let value = null;
      if (Buffer.byteLength(line) <= MAX_EVENT_LINE_BYTES) {
        try { value = sanitizeEvent(JSON.parse(line)); } catch { /* Malformed records are counted only. */ }
      }
      if (!value) { result.rejectedRecords++; continue; }
      result.entries.push(value);
      if (result.entries.length > MAX_EVENTS) { result.entries.shift(); result.truncated = true; }
    }
  } catch { result.status = 'changed'; }
  return result;
}
function systemInformation() {
  let macOSVersion = 'unknown';
  if (process.platform === 'darwin') {
    try {
      const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000, maxBuffer: 128 }).trim();
      if (/^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$/.test(version)) macOSVersion = version;
    } catch { /* Only the fixed fallback is exported. */ }
  }
  return { macOSVersion, architecture: ['arm64', 'x64'].includes(os.arch()) ? os.arch() : 'unknown' };
}
function exportDiagnostics({ workspace, output, runtime }) {
  let descriptor, createdIdentity;
  try {
    canonical(workspace); canonical(output); directory(workspace, true); directory(path.dirname(output));
    need(!inside(workspace, output), 'PREVIEW_DIAGNOSTICS_OUTPUT_INSIDE_WORKSPACE');
    need(!fs.lstatSync(output, { throwIfNoEntry: false }), 'PREVIEW_DIAGNOSTICS_OUTPUT_EXISTS');
    need(object(runtime) && candidate(runtime.candidate) &&
      typeof runtime.sourceHead === 'string' && SOURCE.test(runtime.sourceHead), 'PREVIEW_DIAGNOSTICS_RUNTIME_INVALID');
    const directories = FIXED_DIRECTORIES.map(name => ({ name, ...summarizeDirectory(path.join(workspace, name), name === 'data' || name === 'avatars') }));
    const logs = directories.find(entry => entry.name === 'logs');
    const report = { schema: SCHEMA, runtime: { candidate: runtime.candidate, sourceShortHash: runtime.sourceHead.slice(0, 8),
      runtimeDirectoryCheck: 'verified' }, system: systemInformation(), directories, snapshots: snapshots(workspace),
      logs: { fileCount: logs.fileCount, bytes: logs.bytes, skippedLinks: logs.skippedLinks, status: logs.status }, events: events(workspace) };
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    need(bytes.length <= MAX_OUTPUT_BYTES, 'PREVIEW_DIAGNOSTICS_OUTPUT_LIMIT');
    // Recheck the destination after reading: no parent alias or new workspace
    // child can redirect the single exclusive output creation.
    directory(workspace, true); directory(path.dirname(output));
    descriptor = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    createdIdentity = fs.fstatSync(descriptor);
    fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor);
    need(regular(written) && written.size === bytes.length && (written.mode & 0o7777) === 0o600 &&
      same(written, fs.lstatSync(output)), 'PREVIEW_DIAGNOSTICS_OUTPUT_CHANGED');
    fs.closeSync(descriptor); descriptor = undefined;
    return report;
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* Fixed error below. */ } }
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(output, { throwIfNoEntry: false });
        if (current && same(createdIdentity, current)) fs.unlinkSync(output);
      } catch { /* Never expose OS error text. */ }
    }
    const code = typeof error?.code === 'string' && /^PREVIEW_DIAGNOSTICS_[A-Z_]+$/.test(error.code) ?
      error.code : error?.code === 'EEXIST' ? 'PREVIEW_DIAGNOSTICS_OUTPUT_EXISTS' : 'PREVIEW_DIAGNOSTICS_FAILED';
    fail(code);
  }
}

module.exports = { SCHEMA, EVENT_FILE, EVENT_SCHEMA, EVENT_NAMES, EVENT_CODES, FIXED_DIRECTORIES, MAX_EVENT_BYTES, MAX_EVENT_LINE_BYTES, MAX_EVENTS,
  MAX_OUTPUT_BYTES, MAX_SCAN_ENTRIES, MAX_SNAPSHOT_HASH_BYTES, exportDiagnostics, sanitizeEvent, snapshotMetadata };
