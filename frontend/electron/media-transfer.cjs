'use strict';

// Independently authored from the requested interface, synthetic fixtures, and
// public Node API / IANA registry documentation. No legacy downloader bodies
// were consulted. This file is distributed under the repository's GPL-3.0 terms.
// References: https://nodejs.org/api/{http,https,dns,fs}.html
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Transport stream terminology: https://www.itu.int/rec/T-REC-H.222.0

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_TEXT_BYTES = 1024 * 1024;
const DEFAULT_MEDIA_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError() {
  const error = failure('ABORT_ERR', 'Media transfer was cancelled');
  error.name = 'AbortError';
  return error;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw failure('ERR_MEDIA_OPTIONS', `${name} must be a positive safe integer within its supported range`);
  }
  return value;
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0);
}

const IPV4_DENIED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, bits]) => [ipv4Number(address), 2 ** (32 - bits)]);

function ipv6Number(address) {
  // isIP has already validated the syntax. Embedded IPv4 forms are denied below.
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function prefix6(value, base, bits) {
  return (value >> BigInt(128 - bits)) === (ipv6Number(base) >> BigInt(128 - bits));
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !IPV4_DENIED.some(([base, size]) => value >= base && value < base + size);
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const value = ipv6Number(address);
  // Fail closed for IPv4 mapping/translation, local scopes, multicast, 6to4,
  // documentation, and special-purpose assignments (including Teredo/ORCHID).
  // The broad special-purpose exclusions deliberately also reject rare global
  // anycast exceptions. They must never become a route to local addresses.
  return prefix6(value, '2000::', 3)
    && !prefix6(value, '2001::', 23)
    && !prefix6(value, '2001:db8::', 32)
    && !prefix6(value, '2002::', 16)
    && !prefix6(value, '3fff::', 20);
}

function validatedUrl(input, base) {
  let url;
  try {
    if (typeof input !== 'string' || input.length > 16384 || /[\\\s\u0000-\u001f\u007f]/.test(input)) {
      throw new Error('Invalid URL');
    }
    if ((!base || /^[a-z][a-z0-9+.-]*:/i.test(input)) && !/^https?:\/\/[^/]/i.test(input)) {
      throw new Error('Invalid absolute URL');
    }
    if (input.startsWith('///')) throw new Error('Invalid authority');
    // Reject even empty userinfo, which URL normalizes away (https://@host/).
    const authority = input.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i);
    if (authority && authority[1].includes('@')) throw new Error('Userinfo');
    url = new URL(input, base);
  } catch {
    throw failure('ERR_MEDIA_URL', 'Media URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw failure('ERR_MEDIA_URL', 'Media URL must use HTTP(S) without credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const normalized = hostname.replace(/\.+$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')
      || normalized === 'local' || normalized.endsWith('.local')) {
    throw failure('ERR_MEDIA_ADDRESS', 'Media URL must address a public host');
  }
  if (net.isIP(hostname) && !isPublicAddress(hostname)) {
    throw failure('ERR_MEDIA_ADDRESS', 'Media URL must address a public host');
  }
  url.hash = '';
  return { url, hostname };
}

function notify(callback, progress) {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(progress);
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  } catch { /* Observers cannot interrupt a transfer. */ }
}

function validateTransportPacket(packet) {
  const invalid = () => { throw failure('ERR_MEDIA_SEGMENT', 'HLS segment contains an invalid or scrambled MPEG transport packet'); };
  if (packet[0] !== 0x47 || (packet[1] & 0x80) !== 0 || (packet[3] & 0xc0) !== 0) invalid();
  const adaptation = (packet[3] >> 4) & 3;
  if (adaptation === 0) invalid();
  if (adaptation === 1) return;
  const length = packet[4];
  if ((adaptation === 2 && length !== 183) || (adaptation === 3 && length > 182)) invalid();
  if (length === 0) return;
  const end = 5 + length;
  const flags = packet[5];
  let cursor = 6;
  if (flags & 0x10) cursor += 6; // PCR
  if (flags & 0x08) cursor += 6; // OPCR
  if (flags & 0x04) cursor += 1; // Splice countdown
  if (cursor > end) invalid();
  if (flags & 0x02) {
    if (cursor >= end) invalid();
    cursor += 1 + packet[cursor];
    if (cursor > end) invalid();
  }
  if (flags & 0x01) {
    if (cursor >= end) invalid();
    const extensionLength = packet[cursor++];
    const extensionEnd = cursor + extensionLength;
    if (extensionEnd > end) invalid();
    if (extensionLength > 0) {
      const extensionFlags = packet[cursor++];
      if (extensionFlags & 0x80) cursor += 2; // Legal time window
      if (extensionFlags & 0x40) cursor += 3; // Piecewise rate
      if (extensionFlags & 0x20) cursor += 5; // Seamless splice
      if (cursor > extensionEnd) invalid();
    }
  }
}

function createOperation(options, requireRemote) {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 2147483647);
  const signal = options.signal;
  if (signal != null && (typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw failure('ERR_MEDIA_OPTIONS', 'signal must be an AbortSignal');
  }
  const controller = new AbortController();
  const resources = new Set();
  let stopped = null;
  function stop(error) {
    if (stopped) return;
    stopped = error;
    controller.abort(error);
    for (const resource of resources) resource.destroy(error);
  }
  function check() {
    if (stopped) throw stopped;
    try {
      const allowed = requireRemote();
      if (allowed === false || (allowed && typeof allowed.then === 'function')) {
        if (allowed && typeof allowed.then === 'function') Promise.resolve(allowed).catch(() => {});
        throw failure('ERR_MEDIA_REMOTE_DISABLED', 'Remote media access is unavailable');
      }
    } catch (error) {
      stop(error instanceof Error ? error : failure('ERR_MEDIA_REMOTE_DISABLED', 'Remote media access is unavailable'));
      throw stopped;
    }
  }
  const onAbort = () => stop(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const deadline = setTimeout(() => stop(failure('ERR_MEDIA_TIMEOUT', 'Media transfer deadline exceeded')), timeoutMs);
  // The explicit signal is immediate; polling also closes an idle connection
  // when a caller changes its synchronous permission guard without aborting.
  const poll = setInterval(() => { try { check(); } catch { /* stop already applied */ } }, 100);
  poll.unref?.();
  return {
    check,
    get error() { return stopped; },
    track(resource) {
      // Requests and responses retain an error listener even during teardown.
      resource.on('error', () => {});
      resources.add(resource);
      resource.once('close', () => resources.delete(resource));
      if (stopped) resource.destroy(stopped);
      return resource;
    },
    wait(promise) {
      if (stopped) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(stopped);
      }
      return new Promise((resolve, reject) => {
        const onStop = () => { cleanup(); reject(stopped); };
        const cleanup = () => controller.signal.removeEventListener('abort', onStop);
        controller.signal.addEventListener('abort', onStop, { once: true });
        Promise.resolve(promise).then(
          value => { cleanup(); resolve(value); },
          error => { cleanup(); reject(stopped || error); },
        );
      });
    },
    dispose() {
      clearTimeout(deadline);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      for (const resource of resources) resource.destroy();
      resources.clear();
    },
  };
}

/**
 * resolver(hostname, {all:true, verbatim:true}) returns every DNS address.
 * request(options, callback) has the Node http.request interface. These are
 * trusted construction-time test seams, never renderer-controlled settings.
 * Their defaults always apply the public-address policy and verified TLS.
 * requireRemote is synchronous, may throw or return false, and is rechecked
 * before each request, for every body chunk, and every 100ms while waiting.
 * The deadline bounds DNS, response headers and the streamed body. In-flight
 * filesystem calls are awaited before cleanup; a slow filesystem may therefore
 * delay rejection beyond the network deadline, but cannot publish after it.
 * Publication is a no-clobber hard link. If both temporary-removal attempts
 * fail after commit, success includes cleanupPending with that exact owned path.
 * fetchTextResponse returns {text, url}, where url is the final validated URL
 * after redirects, so playlist references can be resolved against the right base.
 */
function createMediaTransport({ requireRemote = () => {}, resolver = dns.lookup.bind(dns), request } = {}) {
  if (typeof requireRemote !== 'function' || typeof resolver !== 'function'
      || (request !== undefined && typeof request !== 'function')) {
    throw failure('ERR_MEDIA_OPTIONS', 'Invalid media transport hooks');
  }
  const makeRequest = request || ((options, callback) => (
    options.protocol === 'https:' ? https : http
  ).request(options, callback));

  async function openResponse(input, operation, redirects = 0, base) {
    operation.check();
    const { url, hostname } = validatedUrl(input, base);
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await operation.wait(resolver(hostname, { all: true, verbatim: true }));
    operation.check();
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(record => (
      !record || typeof record.address !== 'string' || !isPublicAddress(record.address)
      || record.family !== net.isIP(record.address)
    ))) {
      throw failure('ERR_MEDIA_ADDRESS', 'DNS must resolve exclusively to public addresses');
    }
    const pinned = addresses[0];
    const response = await operation.wait(new Promise((resolve, reject) => {
      // Check immediately before the network side effect, after asynchronous DNS.
      operation.check();
      const req = operation.track(makeRequest({
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        family: pinned.family,
        autoSelectFamily: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16384,
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
        lookup(_host, lookupOptions, callback) {
          if (typeof lookupOptions === 'function') {
            callback = lookupOptions;
            lookupOptions = {};
          }
          // Do not perform a second DNS resolution at socket creation.
          if (lookupOptions?.all) callback(null, [{ ...pinned }]);
          else callback(null, pinned.address, pinned.family);
        },
      }, incoming => resolve(operation.track(incoming))));
      req.once('error', reject);
      req.end();
    }));
    operation.check();
    if (REDIRECT_CODES.has(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (redirects >= 5 || typeof location !== 'string') {
        throw failure('ERR_MEDIA_REDIRECT', 'Media redirect limit exceeded or redirect is invalid');
      }
      return openResponse(location, operation, redirects + 1, url);
    }
    if (response.statusCode < 200 || response.statusCode >= 300 || response.statusCode === 206) {
      response.destroy();
      throw failure('ERR_MEDIA_HTTP', 'Media server returned an unsuccessful or partial response');
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && String(encoding).toLowerCase() !== 'identity') {
      response.destroy();
      throw failure('ERR_MEDIA_ENCODING', 'Encoded media responses are unsupported');
    }
    return { response, url: url.href };
  }

  async function consume(input, operation, budget, write, onProgress, validateTransportStream = false) {
    const { response, url: finalUrl } = await openResponse(input, operation);
    const lengthHeader = response.headers['content-length'];
    const total = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader) : 0;
    if (!Number.isSafeInteger(total) || total > budget.maximum - budget.bytes) {
      response.destroy();
      throw failure('ERR_MEDIA_LIMIT', 'Media response exceeds its byte limit');
    }
    let received = 0;
    const packet = validateTransportStream ? Buffer.alloc(188) : null;
    let packetBytes = 0;
    notify(onProgress, { current: 0, total, percentage: 0 });
    try {
      for await (const chunk of response) {
        operation.check();
        if (chunk.length > budget.maximum - budget.bytes) {
          throw failure('ERR_MEDIA_LIMIT', 'Media response exceeds its byte limit');
        }
        if (validateTransportStream) {
          // Keep at most one transport packet across arbitrary chunk boundaries.
          for (let offset = 0; offset < chunk.length;) {
            const copied = Math.min(188 - packetBytes, chunk.length - offset);
            chunk.copy(packet, packetBytes, offset, offset + copied);
            packetBytes += copied;
            offset += copied;
            if (packetBytes === 188) {
              validateTransportPacket(packet);
              packetBytes = 0;
            }
          }
        }
        budget.bytes += chunk.length;
        received += chunk.length;
        await write(chunk);
        operation.check();
        notify(onProgress, { current: received, total, percentage: total ? (received / total) * 100 : 0 });
      }
      operation.check();
      if (!response.complete || (lengthHeader !== undefined && received !== total)) {
        throw failure('ERR_MEDIA_TRUNCATED', 'Media response ended before completion');
      }
      if (validateTransportStream && (received === 0 || received % 188 !== 0)) {
        throw failure('ERR_MEDIA_SEGMENT', 'HLS segment contains an incomplete MPEG transport packet');
      }
    } catch (error) {
      response.destroy();
      throw operation.error || error;
    }
    return finalUrl;
  }

  async function run(options, defaultMaximum, work) {
    if (!options || typeof options !== 'object') throw failure('ERR_MEDIA_OPTIONS', 'Invalid media options');
    const maximum = positiveInteger(options.maxBytes ?? defaultMaximum, 'maxBytes');
    const operation = createOperation(options, requireRemote);
    try {
      operation.check();
      return await work(operation, { maximum, bytes: 0 });
    } catch (error) {
      throw operation.error || error;
    } finally {
      operation.dispose();
    }
  }

  async function fetchTextResponse(url, options = {}) {
    return run(options, DEFAULT_TEXT_BYTES, async (operation, budget) => {
      const chunks = [];
      const finalUrl = await consume(url, operation, budget, chunk => { chunks.push(chunk); });
      return { text: Buffer.concat(chunks, budget.bytes).toString('utf8'), url: finalUrl };
    });
  }

  async function fetchText(url, options = {}) {
    return (await fetchTextResponse(url, options)).text;
  }

  async function fileTransfer(urls, destination, options, segmented) {
    return run(options, DEFAULT_MEDIA_BYTES, async (operation, budget) => {
      if (options.segmentValidation !== undefined
          && (!segmented || options.segmentValidation !== 'mpeg-ts')) {
        throw failure('ERR_MEDIA_OPTIONS', 'Unsupported segment validation mode');
      }
      if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
        throw failure('ERR_MEDIA_DESTINATION', 'Media destination must be an absolute file path');
      }
      const forbidApp = value => value.split(/[\\/]+/).some(part => /\.app$/i.test(part));
      if (forbidApp(destination)) throw failure('ERR_MEDIA_DESTINATION', 'Media cannot be written into an app bundle');
      const parent = await fsp.realpath(path.dirname(destination));
      operation.check();
      if (forbidApp(parent)) throw failure('ERR_MEDIA_DESTINATION', 'Media cannot be written into an app bundle');
      const target = path.join(parent, path.basename(destination));
      try {
        await fsp.lstat(target);
        throw failure('EEXIST', 'Media destination already exists');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      operation.check();
      const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.part`);
      let handle;
      let owned = false;
      let result;
      try {
        handle = await fsp.open(temporary, 'wx', 0o600);
        owned = true;
        operation.check();
        const write = async chunk => {
          let offset = 0;
          while (offset < chunk.length) {
            operation.check();
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            operation.check();
            if (bytesWritten === 0) throw failure('ERR_MEDIA_WRITE', 'Media file write made no progress');
            offset += bytesWritten;
          }
        };
        if (segmented) notify(options.onProgress, { current: 0, total: urls.length, percentage: 0 });
        for (let index = 0; index < urls.length; index += 1) {
          await consume(urls[index], operation, budget, write, segmented ? undefined : options.onProgress,
            options.segmentValidation === 'mpeg-ts');
          if (segmented) notify(options.onProgress, {
            current: index + 1, total: urls.length, percentage: ((index + 1) / urls.length) * 100,
          });
        }
        await handle.sync();
        operation.check();
        await handle.close();
        handle = undefined;
        operation.check();
        // rename() can replace a concurrently-created target on POSIX. A hard
        // link publishes the complete sibling atomically and exclusively. No
        // async gap is allowed between the final cancellation check and commit.
        fs.linkSync(temporary, target);
        result = { path: target, bytes: budget.bytes };
        // Commit succeeded: cancellation or cleanup cannot turn the published
        // complete file into a reported failed download. Retrying unlink in
        // finally preserves the exact owned path and never removes the target.
        operation.dispose();
        try {
          fs.unlinkSync(temporary);
          owned = false;
        } catch { /* Retry through the awaited cleanup below. */ }
        return result;
      } finally {
        try {
          if (handle) await handle.close();
        } finally {
          if (owned) {
            try { await fsp.unlink(temporary); } catch (error) {
              if (!result) throw error;
              result.cleanupPending = temporary;
            }
          }
        }
      }
    });
  }

  function downloadToFile(url, destination, options = {}) {
    return fileTransfer([url], destination, options, false);
  }

  async function downloadSegmentsToFile(urls, destination, options = {}) {
    if (!Array.isArray(urls) || urls.length === 0 || urls.some(url => typeof url !== 'string')) {
      throw failure('ERR_MEDIA_OPTIONS', 'Media segments must be a nonempty list of URLs');
    }
    return fileTransfer([...urls], destination, options, true);
  }

  return { fetchText, fetchTextResponse, downloadToFile, downloadSegmentsToFile };
}

module.exports = { createMediaTransport };
