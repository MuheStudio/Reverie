'use strict';

/*
 * New implementation from the supplied public data contract and RFC 8216,
 * https://www.rfc-editor.org/rfc/rfc8216.html (consulted 2026-10-05), principally
 * sections 4.1, 4.2, 4.3.2, 4.3.3 and 4.3.4.2. Tests use synthetic fixtures.
 * No prior/upstream download implementation was consulted. This provenance
 * note is not a legal clean-room claim; the repository remains GPL pending
 * completion of its license migration.
 *
 * This pure text parser performs no network or filesystem operations. It
 * tolerates one leading BOM for the public contract (unlike strict RFC 8216).
 * It rejects duplicate variant URI lines and integers outside JS's exact
 * range. Repeated media URIs remain distinct, ordered segment entries.
 * Missing TARGETDURATION is tolerated for inspection, but not downloading.
 * Unknown extension tags remain inspectable and fail the download gate.
 * URI resolution/protocol policy and actual MPEG-TS bytes MUST be checked by
 * the downloader. A .ts suffix alone never establishes the container format.
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 10000;
const analyses = new WeakSet();

const MASTER_TAGS = new Set([
  'EXT-X-STREAM-INF', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-MEDIA',
  'EXT-X-SESSION-DATA', 'EXT-X-SESSION-KEY',
]);
const MEDIA_TAGS = new Set([
  'EXTINF', 'EXT-X-BYTERANGE', 'EXT-X-DISCONTINUITY', 'EXT-X-KEY',
  'EXT-X-MAP', 'EXT-X-PROGRAM-DATE-TIME', 'EXT-X-DATERANGE',
  'EXT-X-TARGETDURATION', 'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE', 'EXT-X-ENDLIST', 'EXT-X-PLAYLIST-TYPE',
  'EXT-X-I-FRAMES-ONLY', 'EXT-X-GAP', 'EXT-X-PART', 'EXT-X-PART-INF',
  'EXT-X-SERVER-CONTROL', 'EXT-X-PRELOAD-HINT', 'EXT-X-SKIP',
  'EXT-X-RENDITION-REPORT',
]);
const SINGLETON_TAGS = new Set([
  'EXT-X-VERSION', 'EXT-X-TARGETDURATION', 'EXT-X-MEDIA-SEQUENCE',
  'EXT-X-DISCONTINUITY-SEQUENCE', 'EXT-X-ENDLIST', 'EXT-X-PLAYLIST-TYPE',
  'EXT-X-I-FRAMES-ONLY', 'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START',
]);

function fail(message, line) {
  const error = new Error(`Invalid HLS playlist${line ? ` at line ${line}` : ''}: ${message}`);
  error.code = 'ERR_HLS_INVALID';
  throw error;
}

function unsupported(message, features) {
  const error = new Error(`Unsupported HLS download: ${message}`);
  error.code = 'ERR_HLS_UNSUPPORTED';
  error.features = Object.freeze(features);
  throw error;
}

function integer(value, name, line, positive = false) {
  if (!/^[0-9]+$/.test(value || '')) fail(`${name} must be an unsigned integer`, line);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (positive && number === 0)) {
    fail(`${name} is outside the supported integer range`, line);
  }
  return number;
}

function decimal(value, name, line, signed = false) {
  const grammar = signed ? /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/ : /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;
  if (!grammar.test(value || '')) fail(`${name} must be a finite decimal`, line);
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${name} must be finite`, line);
  return number;
}

function attributes(value, line) {
  if (!value) fail('empty attribute list', line);
  const result = new Map();
  let position = 0;
  while (position < value.length) {
    const start = position;
    while (position < value.length && /[A-Z0-9-]/.test(value[position])) position++;
    const name = value.slice(start, position);
    if (!name || value[position++] !== '=') fail('malformed attribute name', line);
    if (result.has(name)) fail(`duplicate ${name} attribute`, line);
    const quoted = value[position] === '"';
    let text;
    if (quoted) {
      const end = value.indexOf('"', ++position);
      if (end === -1) fail('unterminated quoted attribute', line);
      text = value.slice(position, end);
      position = end + 1;
    } else {
      const startValue = position;
      while (position < value.length && value[position] !== ',') position++;
      text = value.slice(startValue, position);
      if (!text || /[\s"=]/u.test(text)) fail('malformed attribute value', line);
    }
    result.set(name, { value: text, quoted });
    if (position === value.length) break;
    if (value[position++] !== ',' || position === value.length) fail('malformed attribute separator', line);
  }
  return result;
}

function attribute(list, name, line, quoted, required = false) {
  const entry = list.get(name);
  if (!entry) {
    if (required) fail(`missing ${name} attribute`, line);
    return undefined;
  }
  if (entry.quoted !== quoted) fail(`${name} must be ${quoted ? 'quoted' : 'unquoted'}`, line);
  return entry.value;
}

function uri(value, line) {
  if (!value || /[\s"<>\\]/u.test(value) || /%(?![0-9a-fA-F]{2})/.test(value)) {
    fail('malformed or ambiguous URI', line);
  }
  return value;
}

function byteRange(value, line) {
  if (!/^[0-9]+(?:@[0-9]+)?$/.test(value || '')) fail('malformed byte range', line);
  const [length, offset] = value.split('@');
  integer(length, 'byte-range length', line, true);
  if (offset !== undefined) integer(offset, 'byte-range offset', line);
}

function noValue(value, tag, line) {
  if (value !== undefined) fail(`${tag} must not have a value`, line);
}

/**
 * Return frozen, internal analysis alongside the exact legacy public shape.
 * The result can be passed directly to assertDownloadablePlaylist without
 * reparsing. It must not be reconstructed from renderer-controlled metadata.
 */
function analyzePlaylist(content, { maxBytes = DEFAULT_MAX_BYTES, maxSegments = DEFAULT_MAX_SEGMENTS } = {}) {
  for (const [name, limit] of Object.entries({ maxBytes, maxSegments })) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  }
  if (typeof content !== 'string') throw new TypeError('HLS playlist content must be a string');
  if (content.length > maxBytes || Buffer.byteLength(content, 'utf8') > maxBytes) fail('playlist byte limit exceeded');
  if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(content) || /\r(?!\n)/.test(content)) {
    fail('invalid control character or line ending');
  }
  if (/[\uD800-\uDFFF]/u.test(content)) fail('invalid Unicode text');
  if (content.startsWith('\uFEFF')) content = content.slice(1);
  if (content.includes('\uFEFF')) fail('unexpected byte order mark');
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '#EXTM3U') fail('first line must be #EXTM3U', 1);

  const segments = [];
  const seenURIs = new Set();
  const seenTags = new Set();
  const unsupportedFeatures = new Set();
  let kind = null;
  let pending = null;
  let totalDuration = 0;
  let mediaSequence = 0;
  let targetDuration = null;
  let endList = false;
  let playlistType = null;
  let version = null;
  let discontinuitySeen = false;

  function setKind(next, line) {
    if (kind && kind !== next) fail('mixed master and media structures', line);
    kind = next;
  }

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line === '') continue;
    if (!line.startsWith('#')) {
      if (!pending) fail('URI has no EXTINF or EXT-X-STREAM-INF declaration', lineNumber);
      const url = uri(line, lineNumber);
      // Fragments do not identify distinct downloaded resources.
      const duplicateKey = url.split('#', 1)[0];
      if (kind === 'master' && seenURIs.has(duplicateKey)) fail('duplicate variant URI', lineNumber);
      seenURIs.add(duplicateKey);
      if (segments.length >= maxSegments) fail('playlist segment limit exceeded', lineNumber);
      if (url.includes('{$')) unsupportedFeatures.add('uri-variables');
      if (kind === 'media') {
        const pathname = url.split(/[?#]/, 1)[0];
        if (/\.(?:m4s|mp4|m4a|cmfv|cmfa|aac|mp3|ac3|ec3|vtt|webvtt)$/i.test(pathname)) unsupportedFeatures.add('non-ts-container');
      }
      segments.push(Object.freeze({ url, ...pending }));
      totalDuration += pending.duration;
      if (!Number.isFinite(totalDuration)) fail('total duration is not finite', lineNumber);
      pending = null;
      continue;
    }
    if (!line.startsWith('#EXT')) continue;
    const colon = line.indexOf(':');
    const tag = line.slice(1, colon === -1 ? undefined : colon);
    const value = colon === -1 ? undefined : line.slice(colon + 1);
    if (!/^[A-Z0-9-]+$/.test(tag)) fail('malformed extension tag', lineNumber);
    if (tag === 'EXTM3U') fail('duplicate #EXTM3U', lineNumber);
    if (pending && kind === 'master') fail('expected variant URI after EXT-X-STREAM-INF', lineNumber);
    if (MASTER_TAGS.has(tag)) setKind('master', lineNumber);
    if (MEDIA_TAGS.has(tag)) setKind('media', lineNumber);
    if (SINGLETON_TAGS.has(tag)) {
      if (seenTags.has(tag)) fail(`duplicate ${tag}`, lineNumber);
      seenTags.add(tag);
    }

    switch (tag) {
      case 'EXTINF': {
        if (pending) fail('segment declaration has no URI', lineNumber);
        const comma = (value || '').indexOf(',');
        if (comma < 0) fail('EXTINF must include a duration and comma', lineNumber);
        pending = { duration: decimal(value.slice(0, comma), 'duration', lineNumber), bandwidth: 0, resolution: '', title: value.slice(comma + 1) };
        break;
      }
      case 'EXT-X-STREAM-INF': {
        const list = attributes(value, lineNumber);
        if (list.has('URI')) fail('variant URI must be on the following line', lineNumber);
        const bandwidth = integer(attribute(list, 'BANDWIDTH', lineNumber, false, true), 'BANDWIDTH', lineNumber, true);
        if (list.has('AVERAGE-BANDWIDTH')) integer(attribute(list, 'AVERAGE-BANDWIDTH', lineNumber, false), 'AVERAGE-BANDWIDTH', lineNumber, true);
        if (list.has('FRAME-RATE')) decimal(attribute(list, 'FRAME-RATE', lineNumber, false), 'FRAME-RATE', lineNumber);
        const resolution = attribute(list, 'RESOLUTION', lineNumber, false) ?? '';
        if (list.has('RESOLUTION')) {
          if (!/^[0-9]+x[0-9]+$/.test(resolution)) fail('malformed RESOLUTION', lineNumber);
          for (const dimension of resolution.split('x')) integer(dimension, 'RESOLUTION dimension', lineNumber, true);
        }
        for (const name of ['CODECS', 'AUDIO', 'VIDEO', 'SUBTITLES']) attribute(list, name, lineNumber, true);
        pending = { duration: 0, bandwidth, resolution, title: '' };
        break;
      }
      case 'EXT-X-VERSION':
        version = integer(value, tag, lineNumber, true);
        break;
      case 'EXT-X-TARGETDURATION':
        targetDuration = integer(value, tag, lineNumber, true);
        break;
      case 'EXT-X-MEDIA-SEQUENCE':
        if (segments.length || pending) fail('MEDIA-SEQUENCE must precede segments', lineNumber);
        mediaSequence = integer(value, tag, lineNumber);
        break;
      case 'EXT-X-DISCONTINUITY-SEQUENCE':
        if (segments.length || pending || discontinuitySeen) fail('DISCONTINUITY-SEQUENCE must precede segments and discontinuities', lineNumber);
        integer(value, tag, lineNumber);
        unsupportedFeatures.add('discontinuity');
        break;
      case 'EXT-X-ENDLIST':
        noValue(value, tag, lineNumber);
        endList = true;
        break;
      case 'EXT-X-PLAYLIST-TYPE':
        if (!['VOD', 'EVENT'].includes(value)) fail('invalid PLAYLIST-TYPE', lineNumber);
        playlistType = value;
        break;
      case 'EXT-X-KEY':
      case 'EXT-X-SESSION-KEY': {
        const list = attributes(value, lineNumber);
        const method = attribute(list, 'METHOD', lineNumber, false, true);
        if (method === 'NONE') {
          if (tag === 'EXT-X-SESSION-KEY' || list.size !== 1) fail('invalid METHOD=NONE declaration', lineNumber);
        } else {
          uri(attribute(list, 'URI', lineNumber, true, true), lineNumber);
          const keyFormat = attribute(list, 'KEYFORMAT', lineNumber, true);
          if (keyFormat !== undefined && keyFormat !== 'identity') unsupportedFeatures.add('drm');
          if (list.has('IV') && !/^0[xX][0-9A-Fa-f]{1,32}$/.test(attribute(list, 'IV', lineNumber, false))) fail('invalid encryption IV', lineNumber);
          if (list.has('KEYFORMATVERSIONS') && !/^[0-9]+(?:\/[0-9]+)*$/.test(attribute(list, 'KEYFORMATVERSIONS', lineNumber, true))) fail('invalid KEYFORMATVERSIONS', lineNumber);
          unsupportedFeatures.add('encryption');
        }
        break;
      }
      case 'EXT-X-MAP': {
        const list = attributes(value, lineNumber);
        uri(attribute(list, 'URI', lineNumber, true, true), lineNumber);
        if (list.has('BYTERANGE')) byteRange(attribute(list, 'BYTERANGE', lineNumber, true), lineNumber);
        unsupportedFeatures.add('initialization-map');
        break;
      }
      case 'EXT-X-BYTERANGE':
        byteRange(value, lineNumber);
        unsupportedFeatures.add('byte-range');
        break;
      case 'EXT-X-DISCONTINUITY':
        noValue(value, tag, lineNumber);
        discontinuitySeen = true;
        unsupportedFeatures.add('discontinuity');
        break;
      case 'EXT-X-I-FRAMES-ONLY':
      case 'EXT-X-GAP':
        noValue(value, tag, lineNumber);
        unsupportedFeatures.add(tag === 'EXT-X-GAP' ? 'gap' : 'iframe-only');
        break;
      case 'EXT-X-INDEPENDENT-SEGMENTS':
        noValue(value, tag, lineNumber);
        break;
      case 'EXT-X-PROGRAM-DATE-TIME':
        if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid PROGRAM-DATE-TIME', lineNumber);
        break;
      case 'EXT-X-START': {
        const list = attributes(value, lineNumber);
        decimal(attribute(list, 'TIME-OFFSET', lineNumber, false, true), 'TIME-OFFSET', lineNumber, true);
        const precise = attribute(list, 'PRECISE', lineNumber, false);
        if (precise !== undefined && !['YES', 'NO'].includes(precise)) fail('invalid PRECISE value', lineNumber);
        break;
      }
      default:
        // Inspection can expose variants even if the downloader cannot honor
        // all of the presentation's tags. Never silently approve these tags.
        unsupportedFeatures.add(`tag:${tag}`);
        break;
    }
  }
  if (pending) fail('final declaration has no URI');
  if (kind !== 'master' && !Number.isSafeInteger(mediaSequence + Math.max(0, segments.length - 1))) fail('media sequence exceeds the supported integer range');
  if (targetDuration !== null && segments.some(segment => Math.round(segment.duration) > targetDuration)) fail('segment duration exceeds TARGETDURATION');
  const playlist = Object.freeze({
    segments: Object.freeze(segments), totalDuration,
    segmentCount: segments.length, isMaster: kind === 'master',
  });
  const analysis = Object.freeze({
    playlist, mediaSequence, targetDuration, endList, playlistType, version,
    unsupportedFeatures: Object.freeze([...unsupportedFeatures]),
  });
  analyses.add(analysis);
  return analysis;
}

function parsePlaylist(content, options) {
  return analyzePlaylist(content, options).playlist;
}

/** Require finite, ordinary, unencrypted MPEG-TS VOD before any segment I/O. */
function assertDownloadablePlaylist(contentOrAnalysis, options) {
  const analysis = typeof contentOrAnalysis === 'string' ? analyzePlaylist(contentOrAnalysis, options) : contentOrAnalysis;
  if (!analysis || !analyses.has(analysis)) throw new TypeError('Expected playlist text or an authentic analyzePlaylist result');
  const { playlist, endList, targetDuration, unsupportedFeatures } = analysis;
  if (playlist.isMaster) unsupported('select a media playlist before downloading', ['master-playlist']);
  if (!playlist.segmentCount) unsupported('playlist contains no media segments', ['empty-playlist']);
  if (!endList) unsupported('live or unfinished playlists are not supported (ENDLIST required)', ['live-playlist']);
  if (targetDuration === null) unsupported('TARGETDURATION is required', ['missing-target-duration']);
  if (unsupportedFeatures.length) unsupported(unsupportedFeatures.join(', '), [...unsupportedFeatures]);
  return playlist;
}

module.exports = { parsePlaylist, analyzePlaylist, assertDownloadablePlaylist };
