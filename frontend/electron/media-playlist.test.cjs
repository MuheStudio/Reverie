'use strict';

// Synthetic fixtures derived from the supplied contract and RFC 8216 semantics;
// no historical or upstream implementation/test fixture was consulted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlaylist, analyzePlaylist, assertDownloadablePlaylist } = require('./media-playlist.cjs');

const media = (...lines) => ['#EXTM3U', '#EXT-X-TARGETDURATION:6', ...lines, '#EXT-X-ENDLIST'].join('\n');
const pair = (duration = '6', url = 'one.ts', title = '') => [`#EXTINF:${duration},${title}`, url];
const basic = media(...pair('6', 'one.ts', 'One'), ...pair('2.5', '../two.ts?token=synthetic', 'Two'));
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhigh/index.m3u8';
const invalid = input => assert.throws(() => parsePlaylist(input), { code: 'ERR_HLS_INVALID' });
const unsupported = (input, feature) => assert.throws(() => assertDownloadablePlaylist(input), error => {
  assert.equal(error.code, 'ERR_HLS_UNSUPPORTED');
  assert.ok(error.features.includes(feature), `${feature} missing from ${error.features}`);
  return true;
});

test('public media result preserves exact shape, order, titles, relative URLs and totals', () => {
  assert.deepEqual(parsePlaylist(basic), {
    segments: [
      { url: 'one.ts', duration: 6, bandwidth: 0, resolution: '', title: 'One' },
      { url: '../two.ts?token=synthetic', duration: 2.5, bandwidth: 0, resolution: '', title: 'Two' },
    ],
    totalDuration: 8.5, segmentCount: 2, isMaster: false,
  });
});

test('public master result preserves the requested variant data', () => {
  assert.deepEqual(parsePlaylist(master), {
    segments: [
      { url: 'low/index.m3u8', duration: 0, bandwidth: 900000, resolution: '640x360', title: '' },
      { url: 'high/index.m3u8', duration: 0, bandwidth: 2000000, resolution: '1280x720', title: '' },
    ],
    totalDuration: 0, segmentCount: 2, isMaster: true,
  });
});

test('CRLF and a leading BOM work, but internal BOM and lone CR do not', () => {
  assert.deepEqual(parsePlaylist('\uFEFF' + basic.replaceAll('\n', '\r\n')), parsePlaylist(basic));
  invalid(basic.replace('One', '\uFEFFOne'));
  invalid(basic.replace('\n', '\r'));
});

test('comments and blank lines do not consume pending declarations', () => {
  const text = '#EXTM3U\n\n# human comment\n#EXTINF:2.5,Title, with commas 中文 😀\n# another comment\n\n../segment.ts';
  assert.equal(parsePlaylist(text).segments[0].title, 'Title, with commas 中文 😀');
  assert.equal(parsePlaylist(text).segments[0].url, '../segment.ts');
});

test('quoted attribute commas do not split the CODECS or AUDIO values', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:CODECS="avc1.synthetic,mp4a.synthetic",AUDIO="stereo, dubbed",BANDWIDTH=900000,RESOLUTION=640x360\nvariant.m3u8';
  assert.equal(parsePlaylist(text).segments[0].bandwidth, 900000);
  assert.equal(parsePlaylist(text).segments[0].resolution, '640x360');
});

test('repeated media URIs remain ordered entries with their own durations', () => {
  const parsed = parsePlaylist(media(...pair('6', 'same.ts', 'First'), ...pair('2.5', 'same.ts', 'Again')));
  assert.deepEqual(parsed.segments.map(segment => segment.url), ['same.ts', 'same.ts']);
  assert.deepEqual(parsed.segments.map(segment => segment.duration), [6, 2.5]);
  assert.equal(parsed.totalDuration, 8.5);
  assert.equal(assertDownloadablePlaylist(media(...pair('6', 'same.ts'), ...pair('2.5', 'same.ts'))).segmentCount, 2);
});

test('analysis is separate from the public result and immutable at every safety boundary', () => {
  const analysis = analyzePlaylist(basic);
  assert.deepEqual(Object.keys(analysis.playlist).sort(), ['isMaster', 'segmentCount', 'segments', 'totalDuration']);
  assert.equal(analysis.mediaSequence, 0);
  assert.equal(analysis.targetDuration, 6);
  assert.equal(analysis.endList, true);
  assert.deepEqual(analysis.unsupportedFeatures, []);
  assert.strictEqual(assertDownloadablePlaylist(analysis), analysis.playlist);
  for (const object of [analysis, analysis.playlist, analysis.playlist.segments, analysis.playlist.segments[0], analysis.unsupportedFeatures]) assert.equal(Object.isFrozen(object), true);
  assert.throws(() => { analysis.endList = false; }, TypeError);
  assert.throws(() => { analysis.playlist.segments[0].url = 'replacement.ts'; }, TypeError);
  assert.throws(() => assertDownloadablePlaylist({ ...analysis }), TypeError);
  assert.throws(() => assertDownloadablePlaylist(analysis.playlist), TypeError);
});

test('metadata retains version, sequence and playlist type without changing the public shape', () => {
  const analysis = analyzePlaylist(media('#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:42', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', ...pair('2.5')));
  assert.equal(analysis.version, 3);
  assert.equal(analysis.mediaSequence, 42);
  assert.equal(analysis.playlistType, 'VOD');
  assert.equal(assertDownloadablePlaylist(analysis).segmentCount, 1);
});

test('ENDLIST may appear before segments and completed EVENT is finite', () => {
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-ENDLIST\n#EXTINF:6,\none.ts';
  assert.equal(assertDownloadablePlaylist(text).segmentCount, 1);
});

test('safe descriptive metadata and METHOD=NONE permit ordinary media', () => {
  const text = media('#EXT-X-KEY:METHOD=NONE', '#EXT-X-PROGRAM-DATE-TIME:2026-10-05T12:00:00.125+08:00', '#EXT-X-START:TIME-OFFSET=-2.5,PRECISE=NO', ...pair());
  assert.equal(assertDownloadablePlaylist(text).segmentCount, 1);
});

test('missing or misplaced format header is rejected', () => {
  for (const text of ['', 'one.ts', '#EXTINF:6,\none.ts', '\n#EXTM3U', ' #EXTM3U', '#extm3u', '#EXTM3U:extra', '#EXTM3U\n#EXTM3U']) invalid(text);
});

test('unpaired Unicode, forbidden controls and malformed URI text are rejected', () => {
  for (const value of ['a b.ts', 'a\tb.ts', 'a\0b.ts', 'a\\b.ts', 'a"b.ts', 'a<b.ts', 'a%xx.ts', 'a\u0085b.ts', 'a\uD800b.ts']) invalid(media(...pair('6', value)));
});

test('every URI requires an unambiguous declaration and every declaration needs a URI', () => {
  for (const text of [
    '#EXTM3U\none.ts',
    '#EXTM3U\n#EXTINF:6,',
    '#EXTM3U\n#EXTINF:6,\n#EXTINF:2,\none.ts',
    '#EXTM3U\n#EXTINF:6,\none.ts\ntwo.ts',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-VERSION:3\none.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,URI="one.m3u8"\none.m3u8',
  ]) invalid(text);
});

test('mixed master and media tags are rejected irrespective of order', () => {
  for (const text of [
    master + '\n#EXTINF:2,\nsegment.ts',
    basic + '\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant.m3u8',
    '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-STREAM-INF:BANDWIDTH=1\none.m3u8',
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO\n#EXTINF:6,\none.ts',
    master + '\n#EXT-X-KEY:METHOD=NONE',
    basic + '\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"',
  ]) invalid(text);
});

test('duplicate structural tags and variant URIs are rejected', () => {
  for (const tag of ['#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-ENDLIST', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']) {
    invalid(['#EXTM3U', tag, tag, ...pair()].join('\n'));
  }
  invalid('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\na.m3u8');
  invalid('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8#one\n#EXT-X-STREAM-INF:BANDWIDTH=2\na.m3u8#two');
});

test('malformed attribute lists fail instead of silently changing meanings', () => {
  for (const list of [
    'BANDWIDTH=1,BANDWIDTH=2', 'BANDWIDTH=1,', ',BANDWIDTH=1', 'BANDWIDTH=1,,RESOLUTION=1x1',
    'BANDWIDTH =1', 'BANDWIDTH= 1', 'BANDWIDTH="1"', 'bandwidth=1', 'BANDWIDTH=',
    'BANDWIDTH=1,CODECS="unterminated', 'BANDWIDTH=1,CODECS="a"junk',
    'BANDWIDTH=1,CODECS=unquoted', 'RESOLUTION=1x1',
  ]) invalid(`#EXTM3U\n#EXT-X-STREAM-INF:${list}\none.m3u8`);
});

test('malformed, negative, nonfinite and exponential durations are rejected', () => {
  for (const duration of ['-1', '-0', '+1', 'Infinity', 'NaN', '1e2', '0x10', '6 seconds', ' 6', '6 ', '1.2.3', '.', '', '9'.repeat(400)]) invalid('#EXTM3U\n' + pair(duration).join('\n'));
  invalid('#EXTM3U\n#EXTINF:6\none.ts');
});

test('finite decimal duration boundary values remain numeric', () => {
  for (const [value, expected] of [['0', 0], ['.25', 0.25], ['6.', 6], ['0006.250', 6.25]]) {
    assert.equal(parsePlaylist('#EXTM3U\n' + pair(value).join('\n')).totalDuration, expected);
  }
});

test('numeric integer fields reject fractions, signs, nonfinite values and loss of precision', () => {
  for (const value of ['-1', '1.5', 'Infinity', 'NaN', '1e3', '9007199254740992', '']) {
    invalid(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${value}\none.m3u8`);
    invalid(`#EXTM3U\n#EXT-X-TARGETDURATION:${value}\n` + pair().join('\n'));
    invalid(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${value}\n` + pair().join('\n'));
  }
  for (const resolution of ['640X360', '640x', '0x360', '-1x360', '640.5x360', '9007199254740992x360']) invalid(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=${resolution}\none.m3u8`);
  invalid('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AVERAGE-BANDWIDTH=-1\none.m3u8');
  invalid('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,FRAME-RATE=NaN\none.m3u8');
});

test('sequence order and exact range remain trustworthy', () => {
  invalid('#EXTM3U\n' + pair().join('\n') + '\n#EXT-X-MEDIA-SEQUENCE:2');
  invalid('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740991\n' + [...pair('1', 'one.ts'), ...pair('1', 'two.ts')].join('\n'));
  assert.equal(analyzePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740991\n' + pair().join('\n')).mediaSequence, Number.MAX_SAFE_INTEGER);
});

test('duration total cannot overflow and target duration uses nearest integer semantics', () => {
  const huge = '1' + '0'.repeat(308);
  invalid('#EXTM3U\n' + [...pair(huge, 'one.ts'), ...pair(huge, 'two.ts')].join('\n'));
  assert.equal(parsePlaylist(media(...pair('6.49'))).totalDuration, 6.49);
  invalid(media(...pair('6.5')));
});

test('byte limit counts UTF-8 bytes, including a leading BOM, at the exact boundary', () => {
  const text = '\uFEFF' + media(...pair('6', 'one.ts', '中文 😀'));
  const length = Buffer.byteLength(text);
  assert.equal(parsePlaylist(text, { maxBytes: length }).segmentCount, 1);
  assert.throws(() => parsePlaylist(text, { maxBytes: length - 1 }), { code: 'ERR_HLS_INVALID' });
  assert.throws(() => parsePlaylist('#EXTM3U', { maxBytes: 0 }), { code: 'ERR_HLS_INVALID' });
});

test('segment limits apply to media and master entries without off-by-one acceptance', () => {
  for (const text of [basic, master]) {
    assert.equal(parsePlaylist(text, { maxSegments: 2 }).segmentCount, 2);
    assert.throws(() => parsePlaylist(text, { maxSegments: 1 }), { code: 'ERR_HLS_INVALID' });
    assert.throws(() => parsePlaylist(text, { maxSegments: 0 }), { code: 'ERR_HLS_INVALID' });
  }
  assert.equal(parsePlaylist('#EXTM3U', { maxSegments: 0 }).segmentCount, 0);
});

test('limits and content types are checked before parsing', () => {
  for (const limit of [-1, 1.5, NaN, Infinity, '10', Number.MAX_SAFE_INTEGER + 1]) {
    for (const name of ['maxBytes', 'maxSegments']) assert.throws(() => parsePlaylist(basic, { [name]: limit }), RangeError);
  }
  for (const value of [null, undefined, 1, {}, Buffer.from(basic)]) assert.throws(() => parsePlaylist(value), TypeError);
});

test('default segment and byte bounds are enforced', () => {
  const many = count => '#EXTM3U\n' + Array.from({ length: count }, () => '#EXTINF:1,\nsame.ts').join('\n');
  assert.equal(parsePlaylist(many(10000)).segmentCount, 10000);
  invalid(many(10001));
  invalid('#EXTM3U\n#' + 'x'.repeat(8 * 1024 * 1024));
});

test('download requires a selected, nonempty, completed media playlist with target duration', () => {
  unsupported(master, 'master-playlist');
  unsupported('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST', 'empty-playlist');
  unsupported(basic.replace('\n#EXT-X-ENDLIST', ''), 'live-playlist');
  unsupported(basic.replace('#EXT-X-TARGETDURATION:6\n', ''), 'missing-target-duration');
  assert.equal(parsePlaylist(basic.replace('#EXT-X-TARGETDURATION:6\n', '')).segmentCount, 2);
});

test('encryption is rejected even after METHOD=NONE resets or with an identity format', () => {
  for (const key of [
    '#EXT-X-KEY:METHOD=AES-128,URI="synthetic.key"',
    '#EXT-X-KEY:METHOD=AES-128,URI="synthetic.key",IV=0x1,KEYFORMAT="identity"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="synthetic.key"',
    '#EXT-X-KEY:METHOD=FUTURE-METHOD,URI="synthetic.key"',
  ]) {
    unsupported(media(key, ...pair()), 'encryption');
    unsupported(media(key, '#EXT-X-KEY:METHOD=NONE', ...pair()), 'encryption');
  }
  unsupported(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://synthetic",KEYFORMAT="com.synthetic.drm"', ...pair()), 'drm');
});

test('malformed encryption and map declarations cannot appear harmless', () => {
  for (const tag of [
    '#EXT-X-KEY:METHOD=NONE,URI="key"', '#EXT-X-KEY:METHOD="NONE"',
    '#EXT-X-KEY:URI="key"', '#EXT-X-KEY:METHOD=AES-128',
    '#EXT-X-KEY:METHOD=AES-128,URI=key', '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0xGG',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",KEYFORMATVERSIONS="1/no"',
    '#EXT-X-MAP:BYTERANGE="100@0"', '#EXT-X-MAP:URI="init.mp4",BYTERANGE="-1"',
    '#EXT-X-BYTERANGE:-1', '#EXT-X-BYTERANGE:100@-1', '#EXT-X-BYTERANGE:0',
  ]) invalid(media(tag, ...pair()));
});

test('unsupported tags and containers are inspectable but fail closed for download', () => {
  for (const [tag, feature] of [
    ['#EXT-X-MAP:URI="init.mp4"', 'initialization-map'],
    ['#EXT-X-BYTERANGE:188@0', 'byte-range'],
    ['#EXT-X-DISCONTINUITY', 'discontinuity'],
    ['#EXT-X-DISCONTINUITY-SEQUENCE:0', 'discontinuity'],
    ['#EXT-X-I-FRAMES-ONLY', 'iframe-only'],
    ['#EXT-X-GAP', 'gap'],
    ['#EXT-X-PART:DURATION=0.5,URI="part.ts"', 'tag:EXT-X-PART'],
    ['#EXT-X-SKIP:SKIPPED-SEGMENTS=2', 'tag:EXT-X-SKIP'],
    ['#EXT-X-UNKNOWN:FEATURE=YES', 'tag:EXT-X-UNKNOWN'],
  ]) {
    const text = media(tag, ...pair());
    assert.equal(parsePlaylist(text).segmentCount, 1);
    unsupported(text, feature);
  }
  for (const extension of ['m4s', 'mp4', 'm4a', 'aac', 'mp3', 'ac3', 'ec3', 'vtt', 'webvtt', 'cmfv', 'cmfa']) unsupported(media(...pair('6', `clip.${extension}?synthetic=1`)), 'non-ts-container');
  unsupported(media(...pair('6', '{$TOKEN}/one.ts')), 'uri-variables');
});

test('opaque endpoints are not misidentified by extension and URI protocol policy is delegated', () => {
  for (const url of ['opaque', '/segment?id=1', 'https://example.invalid/one.ts', 'custom:one.ts']) {
    assert.equal(assertDownloadablePlaylist(media(...pair('6', url))).segments[0].url, url);
  }
});

test('boundary properties hold across synthetic segment counts, durations and repeated URLs', () => {
  for (let count = 1; count <= 64; count++) {
    const lines = [];
    let expectedDuration = 0;
    for (let index = 0; index < count; index++) {
      const duration = (index % 25) / 4;
      lines.push(...pair(String(duration), `segment-${index % 7}.ts`, `Title ${index}`));
      expectedDuration += duration;
    }
    const text = media(...lines);
    const result = assertDownloadablePlaylist(text, { maxSegments: count, maxBytes: Buffer.byteLength(text) });
    assert.equal(result.segmentCount, count);
    assert.equal(result.totalDuration, expectedDuration);
    assert.deepEqual(result.segments.map(segment => segment.title), Array.from({ length: count }, (_, index) => `Title ${index}`));
    assert.throws(() => parsePlaylist(text, { maxSegments: count - 1 }), { code: 'ERR_HLS_INVALID' });
    assert.throws(() => parsePlaylist(text, { maxBytes: Buffer.byteLength(text) - 1 }), { code: 'ERR_HLS_INVALID' });
    assert.deepEqual(parsePlaylist(text.replaceAll('\n', '\r\n')), result);
  }
});
