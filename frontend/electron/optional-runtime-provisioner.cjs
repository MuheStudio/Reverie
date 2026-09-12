'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Provisioning flow inspired by Cloning-project/Luna-ts/packages/desktop/src/ttsProvision.ts (MIT).
const MANIFEST_SCHEMA = 'reverie.gpt-sovits-runtime.v1';
const JOURNAL_SCHEMA = 'reverie.optional-runtime-journal.v1';
const STATES = Object.freeze([
  'idle', 'preflight', 'downloading', 'verifying', 'extracting',
  'validating', 'ready', 'failed', 'paused',
]);
const ARTIFACT_KEYS = new Set([
  'id', 'url', 'sha256', 'size', 'kind', 'destination', 'stripPrefix',
  'maxExtractedFiles', 'maxExtractedBytes',
]);

function fail(message, code = 'INVALID_MANIFEST') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactKeys(value, allowed, label, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unknown field ${key}`);
  for (const key of required) if (!(key in value)) fail(`${label} is missing ${key}`);
}

function portableRelative(value, label, allowDot = false, code = 'INVALID_MANIFEST') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(`${label} is invalid`, code);
  const slash = value.replace(/\\/g, '/');
  if (slash.startsWith('/') || /^[a-zA-Z]:/.test(slash)) fail(`${label} must be relative`, code);
  const segments = slash.split('/');
  if (segments.some((part) => part === '..' || part === '' || part === '.')) {
    if (!(allowDot && slash === '.')) fail(`${label} contains traversal or empty segments`, code);
  }
  for (const segment of segments) {
    const stem = segment.split('.')[0];
    if (/[\u0000-\u001f<>:"|?*]/.test(segment) || /[ .]$/.test(segment)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
      fail(`${label} contains a Windows-reserved path segment`, code);
    }
  }
  return slash;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(manifest) {
  return crypto.createHash('sha256').update(canonical(manifest)).digest('hex');
}

function validateManifest(manifest, runtime = { platform: process.platform, arch: process.arch }) {
  const topKeys = new Set(['schema', 'recipeVersion', 'platform', 'arch', 'policy', 'artifacts']);
  exactKeys(manifest, topKeys, 'manifest');
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`manifest schema must be ${MANIFEST_SCHEMA}`);
  if (typeof manifest.recipeVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.recipeVersion)) {
    fail('recipeVersion is invalid');
  }
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64') fail('manifest must target win32/x64');
  if (runtime.platform !== manifest.platform || runtime.arch !== manifest.arch) fail('manifest does not target this runtime', 'UNSUPPORTED_PLATFORM');

  exactKeys(manifest.policy, new Set(['allowedHosts']), 'manifest policy');
  if (!Array.isArray(manifest.policy.allowedHosts) || manifest.policy.allowedHosts.length === 0) {
    fail('manifest policy must contain allowedHosts');
  }
  const hosts = new Set();
  for (const host of manifest.policy.allowedHosts) {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host)) fail('allowedHosts contains an invalid host');
    hosts.add(host);
  }
  if (hosts.size !== manifest.policy.allowedHosts.length) fail('allowedHosts contains duplicates');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('manifest artifacts must be non-empty');

  const ids = new Set();
  const destinations = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const required = new Set(['id', 'url', 'sha256', 'size', 'kind', 'destination', 'maxExtractedFiles', 'maxExtractedBytes']);
    exactKeys(artifact, ARTIFACT_KEYS, `artifact ${index}`, required);
    if (typeof artifact.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(artifact.id)) fail(`artifact ${index} has invalid id`);
    const id = artifact.id.toLowerCase();
    if (ids.has(id)) fail(`duplicate artifact id ${artifact.id}`);
    ids.add(id);
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) fail(`artifact ${artifact.id} has invalid sha256`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail(`artifact ${artifact.id} has invalid size`);
    if (!['zip', 'tar.gz', 'file'].includes(artifact.kind)) fail(`artifact ${artifact.id} has invalid archive kind`);
    if (!Number.isSafeInteger(artifact.maxExtractedFiles) || artifact.maxExtractedFiles <= 0) fail(`artifact ${artifact.id} has invalid file limit`);
    if (!Number.isSafeInteger(artifact.maxExtractedBytes) || artifact.maxExtractedBytes <= 0) fail(`artifact ${artifact.id} has invalid byte limit`);
    if (artifact.kind === 'file' && artifact.stripPrefix !== undefined) fail(`file artifact ${artifact.id} cannot use stripPrefix`);
    if (artifact.kind === 'file' && (artifact.maxExtractedFiles !== 1 || artifact.maxExtractedBytes < artifact.size)) {
      fail(`file artifact ${artifact.id} has inconsistent extraction limits`);
    }
    artifact.destination = portableRelative(artifact.destination, `artifact ${artifact.id} destination`);
    if (artifact.stripPrefix !== undefined) artifact.stripPrefix = portableRelative(artifact.stripPrefix, `artifact ${artifact.id} stripPrefix`);
    const destination = artifact.destination.toLowerCase();
    if ([...destinations].some((other) => other === destination || other.startsWith(`${destination}/`) || destination.startsWith(`${other}/`))) {
      fail(`duplicate or overlapping artifact destination ${artifact.destination}`);
    }
    destinations.add(destination);

    let url;
    try { url = new URL(artifact.url); } catch { fail(`artifact ${artifact.id} URL is invalid`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`artifact ${artifact.id} URL must be credential-free immutable HTTPS without query or fragment`);
    if (!hosts.has(url.hostname.toLowerCase())) fail(`artifact ${artifact.id} URL host is not allowlisted`);
    if (/(^|[/_.-])latest([/_.-]|$)/i.test(decodeURIComponent(url.pathname))) fail(`artifact ${artifact.id} uses a mutable latest URL`);
    const immutableTokens = [manifest.recipeVersion.toLowerCase(), artifact.sha256.toLowerCase()];
    if (!immutableTokens.some((token) => decodeURIComponent(url.pathname).toLowerCase().includes(token))) {
      fail(`artifact ${artifact.id} URL must contain recipeVersion or sha256 as an immutable locator`);
    }
  }
  return manifest;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  try {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Provision journal is corrupt: ${error.message}`);
  }
}

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : null;
}

function strongEtag(headers) {
  const value = header(headers, 'etag');
  return value && /^"[^"\r\n]+"$/.test(value) ? value : null;
}

function assertContained(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${label} escapes staging`, 'UNSAFE_ARCHIVE');
}

function inventoryPath(root, portable) {
  const target = path.join(root, ...portable.split('/'));
  assertContained(root, target, 'inventory path');
  return target;
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function validateInventory(artifact, inventory, rawRoot) {
  if (!Array.isArray(inventory)) fail(`extractor returned no inventory for ${artifact.id}`, 'UNSAFE_ARCHIVE');
  if (inventory.length > artifact.maxExtractedFiles) fail(`archive ${artifact.id} exceeds inventory count limit`, 'ARCHIVE_BOMB');
  let bytes = 0;
  const seen = new Set();
  const normalized = [];
  for (const [index, entry] of inventory.entries()) {
    exactKeys(entry, new Set(['path', 'type', 'size']), `inventory ${artifact.id}[${index}]`);
    const relative = portableRelative(entry.path, `inventory ${artifact.id}[${index}] path`, false, 'UNSAFE_ARCHIVE');
    const key = relative.toLowerCase();
    if (seen.has(key)) fail(`archive ${artifact.id} has a path collision`, 'UNSAFE_ARCHIVE');
    for (const previous of normalized) {
      const previousPath = previous.path.toLowerCase();
      if ((previous.type === 'file' && key.startsWith(`${previousPath}/`))
          || (entry.type === 'file' && previousPath.startsWith(`${key}/`))) {
        fail(`archive ${artifact.id} has a file/directory path collision`, 'UNSAFE_ARCHIVE');
      }
    }
    seen.add(key);
    if (!['file', 'directory'].includes(entry.type)) fail(`archive ${artifact.id} contains a link or unsupported type`, 'UNSAFE_ARCHIVE');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.type === 'directory' && entry.size !== 0)) fail(`archive ${artifact.id} has invalid inventory size`, 'UNSAFE_ARCHIVE');
    const source = inventoryPath(rawRoot, relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || (entry.type === 'file' && !stat.isFile()) || (entry.type === 'directory' && !stat.isDirectory())) {
      fail(`archive ${artifact.id} inventory type does not match extracted content`, 'UNSAFE_ARCHIVE');
    }
    if (entry.type === 'file' && stat.size !== entry.size) fail(`archive ${artifact.id} inventory size does not match extracted content`, 'UNSAFE_ARCHIVE');
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes) || bytes > artifact.maxExtractedBytes) fail(`archive ${artifact.id} exceeds extracted byte limit`, 'ARCHIVE_BOMB');
    normalized.push({ ...entry, path: relative, source });
  }
  return normalized;
}

class OptionalRuntimeProvisioner {
  constructor(options) {
    if (!options || typeof options.storageRoot !== 'string' || !path.isAbsolute(options.storageRoot)) throw new TypeError('storageRoot must be an absolute app-owned path');
    if (typeof options.httpRequest !== 'function') throw new TypeError('httpRequest seam is required');
    if (typeof options.safeExtract !== 'function') throw new TypeError('safeExtract seam is required');
    if (typeof options.validateRuntime !== 'function') throw new TypeError('validateRuntime seam is required');
    if (typeof options.freeDisk !== 'function') throw new TypeError('freeDisk seam is required');
    this.options = options;
    this.root = options.storageRoot;
    this.journalFile = path.join(this.root, 'provision-journal.json');
    this.activeFile = path.join(this.root, 'active.json');
    this.state = 'idle';
    this.controller = null;
    this.inFlight = false;
  }

  status() {
    return { state: this.state, active: readJson(this.activeFile), journal: readJson(this.journalFile) };
  }

  cancel() {
    this.controller?.abort();
  }

  setState(journal, state, detail = null) {
    if (!STATES.includes(state)) throw new Error(`Unknown provision state ${state}`);
    this.state = state;
    journal.state = state;
    journal.detail = detail;
    journal.updatedAt = new Date().toISOString();
    atomicJson(this.journalFile, journal);
    this.options.onState?.({ state, detail });
  }

  async install(inputManifest, externalSignal) {
    const manifest = validateManifest(structuredClone(inputManifest), this.options.runtime || { platform: process.platform, arch: process.arch });
    if (this.inFlight) fail('A runtime installation is already in progress', 'REVERIE_OPERATION_IN_PROGRESS');
    this.inFlight = true;
    fs.mkdirSync(this.root, { recursive: true });
    const digest = fingerprint(manifest);
    let journal = readJson(this.journalFile);
    if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.manifestFingerprint !== digest) {
      journal = { schema: JOURNAL_SCHEMA, manifestFingerprint: digest, recipeVersion: manifest.recipeVersion, state: 'idle', artifacts: {} };
    }
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const signal = controller.signal;
    const downloads = path.join(this.root, 'downloads', digest);
    const installs = path.join(this.root, 'installs');
    const staging = path.join(installs, `.${digest}.staging`);
    const final = path.join(installs, digest);

    try {
      this.setState(journal, 'preflight');
      fs.mkdirSync(downloads, { recursive: true });
      fs.mkdirSync(installs, { recursive: true });
      let downloadBytes = 0;
      let extractedBytes = 0;
      let largestArchiveBytes = 0;
      for (const artifact of manifest.artifacts) {
        const part = path.join(downloads, `${artifact.id}.part`);
        const existing = Math.min(fs.existsSync(part) ? fs.statSync(part).size : 0, artifact.size);
        downloadBytes += artifact.size - existing;
        extractedBytes += artifact.kind === 'file' ? artifact.size : artifact.maxExtractedBytes;
        if (artifact.kind !== 'file') largestArchiveBytes = Math.max(largestArchiveBytes, artifact.maxExtractedBytes);
      }
      // Archives coexist with their copied staged output until each raw extraction is removed.
      const required = downloadBytes + extractedBytes + largestArchiveBytes;
      const available = await this.options.freeDisk(this.root);
      if (!Number.isSafeInteger(available) || available < required) fail(`Insufficient disk space: need ${required}, available ${available}`, 'ENOSPC');

      this.setState(journal, 'downloading');
      for (const artifact of manifest.artifacts) await this.download(artifact, downloads, journal, signal);
      this.setState(journal, 'verifying');
      for (const artifact of manifest.artifacts) {
        if (signal.aborted) throw Object.assign(new Error('Provisioning paused'), { name: 'AbortError' });
        const part = path.join(downloads, `${artifact.id}.part`);
        if (fs.statSync(part).size !== artifact.size || hashFile(part) !== artifact.sha256) fail(`SHA-256 mismatch for ${artifact.id}`, 'HASH_MISMATCH');
        journal.artifacts[artifact.id].verified = true;
        atomicJson(this.journalFile, journal);
      }

      if (fs.existsSync(final)) {
        this.setState(journal, 'validating', 'recovering completed staged install');
        const healthy = await this.options.validateRuntime(final, manifest, signal);
        if (healthy !== true) fail('Runtime semantic validator rejected completed install', 'VALIDATOR_FAILED');
      } else {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        this.setState(journal, 'extracting');
        const outputPaths = new Set();
        for (const artifact of manifest.artifacts) await this.materialize(artifact, downloads, staging, outputPaths, signal);
        this.setState(journal, 'validating');
        const healthy = await this.options.validateRuntime(staging, manifest, signal);
        if (healthy !== true) fail('Runtime semantic validator rejected staged install', 'VALIDATOR_FAILED');
        fs.renameSync(staging, final);
      }

      atomicJson(this.activeFile, { schema: MANIFEST_SCHEMA, recipeVersion: manifest.recipeVersion, manifestFingerprint: digest, installDir: final });
      // The staged install is complete and hash-verified; keep the downloaded
      // archives from doubling the disk footprint of a multi-GB runtime.
      fs.rmSync(path.join(this.root, 'downloads', digest), { recursive: true, force: true });
      this.setState(journal, 'ready');
      return { state: 'ready', installDir: final, manifestFingerprint: digest };
    } catch (error) {
      const paused = signal.aborted || error?.name === 'AbortError';
      this.setState(journal, paused ? 'paused' : 'failed', { code: error.code || null, message: error.message });
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = null;
      this.inFlight = false;
    }
  }

  async download(artifact, directory, journal, signal) {
    const part = path.join(directory, `${artifact.id}.part`);
    if (fs.existsSync(part) && fs.statSync(part).size > artifact.size) fs.truncateSync(part, 0);
    let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (offset === artifact.size) return;
    const record = journal.artifacts[artifact.id] || {};
    if (offset > 0 && !record.etag) {
      fs.truncateSync(part, 0);
      offset = 0;
    }
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    if (offset > 0 && record.etag) headers['If-Range'] = record.etag;
    const response = await this.options.httpRequest({ url: artifact.url, headers, signal });
    let append = false;
    if (offset > 0 && response.status === 206) {
      const range = header(response.headers, 'content-range');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '');
      if (!match || Number(match[1]) !== offset || Number(match[3]) !== artifact.size) fail(`Invalid Content-Range for ${artifact.id}`, 'HTTP_RANGE_INVALID');
      const etag = strongEtag(response.headers);
      if (record.etag && etag !== record.etag) fail(`ETag changed while resuming ${artifact.id}`, 'HTTP_ETAG_CHANGED');
      append = true;
    } else if (response.status === 200) {
      offset = 0;
    } else {
      fail(`Unexpected HTTP ${response.status} for ${artifact.id}`, 'HTTP_STATUS');
    }
    const etag = strongEtag(response.headers);
    journal.artifacts[artifact.id] = { etag: etag || null, downloaded: offset };
    atomicJson(this.journalFile, journal);
    const descriptor = fs.openSync(part, append ? 'a' : 'w', 0o600);
    let downloaded = offset;
    try {
      const body = Buffer.isBuffer(response.body) ? [response.body] : response.body;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function' && typeof body[Symbol.iterator] !== 'function') fail(`HTTP body missing for ${artifact.id}`, 'HTTP_BODY');
      for await (const value of body) {
        if (signal.aborted) throw Object.assign(new Error('Provisioning paused'), { name: 'AbortError' });
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        downloaded += chunk.length;
        if (downloaded > artifact.size) fail(`Download exceeds declared size for ${artifact.id}`, 'SIZE_MISMATCH');
        fs.writeSync(descriptor, chunk);
        journal.artifacts[artifact.id].downloaded = downloaded;
        atomicJson(this.journalFile, journal);
      }
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (downloaded !== artifact.size) fail(`Download size mismatch for ${artifact.id}`, 'SIZE_MISMATCH');
  }

  async materialize(artifact, downloads, staging, outputPaths, signal) {
    const archivePath = path.join(downloads, `${artifact.id}.part`);
    if (artifact.kind === 'file') {
      const key = artifact.destination.toLowerCase();
      if (outputPaths.has(key)) fail(`output collision at ${artifact.destination}`, 'UNSAFE_ARCHIVE');
      outputPaths.add(key);
      const target = inventoryPath(staging, artifact.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(archivePath, target, fs.constants.COPYFILE_EXCL);
      return;
    }
    const rawRoot = path.join(staging, `.extract-${artifact.id}`);
    fs.mkdirSync(rawRoot, { recursive: true });
    const inventory = await this.options.safeExtract({
      archivePath,
      kind: artifact.kind,
      outputDir: rawRoot,
      signal,
      maxExtractedFiles: artifact.maxExtractedFiles,
      maxExtractedBytes: artifact.maxExtractedBytes,
    });
    const entries = validateInventory(artifact, inventory, rawRoot);
    const prefix = artifact.stripPrefix ? `${artifact.stripPrefix}/` : '';
    for (const entry of entries) {
      let relative = entry.path;
      if (artifact.stripPrefix) {
        if (relative === artifact.stripPrefix && entry.type === 'directory') continue;
        if (!relative.startsWith(prefix)) fail(`archive ${artifact.id} escapes stripPrefix`, 'UNSAFE_ARCHIVE');
        relative = relative.slice(prefix.length);
      }
      if (!relative) continue;
      const destination = `${artifact.destination}/${relative}`;
      const key = destination.toLowerCase();
      if (outputPaths.has(key)) fail(`output collision at ${destination}`, 'UNSAFE_ARCHIVE');
      outputPaths.add(key);
      const target = inventoryPath(staging, destination);
      if (entry.type === 'directory') fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(entry.source, target, fs.constants.COPYFILE_EXCL);
      }
    }
    fs.rmSync(rawRoot, { recursive: true, force: true });
  }
}

module.exports = {
  JOURNAL_SCHEMA,
  MANIFEST_SCHEMA,
  OptionalRuntimeProvisioner,
  STATES,
  fingerprint,
  validateManifest,
};
