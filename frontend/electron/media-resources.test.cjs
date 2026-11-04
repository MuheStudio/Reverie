'use strict';

// Synthetic DOM stubs exercise the independent, self-contained implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { collectResources, collectResourcesScript } = require('./media-resources.cjs');

function media(tagName, { src = '', currentSrc = '', sources = [] } = {}) {
  return {
    tagName, src, currentSrc,
    querySelectorAll(selector) {
      assert.equal(selector, 'source');
      return sources;
    },
  };
}

function documentStub({ title = 'Synthetic page', mediaElements = [], images = [], baseURI = 'https://example.invalid/path/page.html' } = {}) {
  return {
    title, baseURI,
    querySelectorAll(selector) {
      if (selector === 'video,audio') return mediaElements;
      if (selector === 'img') return images;
      throw new Error(`Unexpected DOM selector: ${selector}`);
    },
  };
}

function image(overrides = {}) {
  return { src: 'https://example.invalid/picture.png', alt: '', naturalWidth: 101, width: 40, height: 30, ...overrides };
}

test('media entries use effective sources, lowercase tag names and document title', () => {
  const document = documentStub({
    mediaElements: [
      media('VIDEO', { src: 'https://example.invalid/fallback.mp4', currentSrc: 'https://example.invalid/selected.mp4' }),
      media('AUDIO', { src: 'https://example.invalid/audio.mp3' }),
      media('VIDEO'),
    ],
  });
  assert.deepEqual(collectResources(document), [
    { url: 'https://example.invalid/selected.mp4', type: 'video', title: 'Synthetic page' },
    { url: 'https://example.invalid/audio.mp3', type: 'audio', title: 'Synthetic page' },
  ]);
});

test('nested sources are reported even when the parent has no source', () => {
  const document = documentStub({ mediaElements: [media('VIDEO', { sources: [
    { src: 'https://example.invalid/one.webm', type: 'video/webm' },
    { src: 'https://example.invalid/two.mp4', type: '' },
    { src: '', type: 'video/mp4' },
  ] })] });
  assert.deepEqual(collectResources(document), [
    { url: 'https://example.invalid/one.webm', type: 'video/webm', title: 'Synthetic page' },
    { url: 'https://example.invalid/two.mp4', type: 'media', title: 'Synthetic page' },
  ]);
});

test('duplicate appearances preserve media and source occurrence order', () => {
  const url = 'https://example.invalid/repeated.mp4';
  const document = documentStub({ mediaElements: [media('VIDEO', { src: url, sources: [{ src: url, type: 'video/mp4' }] }), media('VIDEO', { src: url })] });
  assert.deepEqual(collectResources(document).map(entry => entry.type), ['video', 'video/mp4', 'video']);
  assert.deepEqual(collectResources(document).map(entry => entry.url), [url, url, url]);
});

test('image eligibility uses natural width strictly above 100 while size uses rendered dimensions', () => {
  const document = documentStub({ images: [
    image({ naturalWidth: 100 }), image({ naturalWidth: 0 }), image({ naturalWidth: 101, alt: 'Picture caption' }),
  ] });
  assert.deepEqual(collectResources(document), [{ url: 'https://example.invalid/picture.png', type: 'image/png', title: 'Picture caption', size: 1200 }]);
});

test('image subtypes use only pathname suffixes and default to jpg', () => {
  const urls = [
    'https://example.invalid/a.PNG?download=.webp#suffix.gif',
    'https://example.invalid/no-extension?format=png',
    '../relative.webp?x=1',
    'https://example.invalid/dotted.dir/no-extension',
    'http://[malformed',
  ];
  const result = collectResources(documentStub({ images: urls.map(src => image({ src })) }));
  assert.deepEqual(result.map(entry => entry.type), ['image/png', 'image/jpg', 'image/webp', 'image/jpg', 'image/jpg']);
  assert.deepEqual(result.map(entry => entry.url), urls);
  assert.ok(result.every(entry => entry.title === 'Synthetic page'));
});

test('empty image URLs are skipped and nonfinite dimensions never cross IPC', () => {
  const result = collectResources(documentStub({ images: [image({ src: '' }), image({ width: Infinity }), image({ width: -1 }), image({ width: 0 })] }));
  assert.deepEqual(result.map(entry => entry.size), [0, 0, 0]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('URL bounds include the boundary but skip overlong URLs without truncation', () => {
  const prefix = 'https://example.invalid/';
  const boundary = prefix + 'a'.repeat(2048 - prefix.length);
  const tooLong = boundary + 'b';
  const document = documentStub({
    mediaElements: [media('VIDEO', { src: boundary }), media('AUDIO', { src: tooLong, sources: [{ src: tooLong, type: 'audio/mpeg' }] })],
    images: [image({ src: tooLong }), image({ src: boundary })],
  });
  const result = collectResources(document);
  assert.equal(result.length, 2);
  assert.ok(result.every(entry => entry.url === boundary));
});

test('titles and source MIME descriptions remain bounded', () => {
  const long = 'x'.repeat(5000);
  const document = documentStub({ title: long, mediaElements: [media('VIDEO', { src: 'video', sources: [{ src: 'source', type: long }] })], images: [image({ alt: long }), image()] });
  const result = collectResources(document);
  assert.ok(result.every(entry => entry.title.length === 4096));
  assert.equal(result[1].type.length, 256);
});

test('all resource kinds share the 1000 result budget', () => {
  const document = documentStub({
    mediaElements: Array.from({ length: 998 }, (_, index) => media('VIDEO', { src: `video-${index}` })),
    images: [image({ src: 'one.jpg' }), image({ src: 'two.jpg' }), image({ src: 'three.jpg' })],
  });
  const result = collectResources(document);
  assert.equal(result.length, 1000);
  assert.equal(result[999].url, 'two.jpg');
});

test('source-only documents also stop at the result budget', () => {
  const sources = Array.from({ length: 1001 }, (_, index) => ({ src: `source-${index}`, type: '' }));
  const result = collectResources(documentStub({ mediaElements: [media('AUDIO', { sources })] }));
  assert.equal(result.length, 1000);
  assert.equal(result.at(-1).url, 'source-999');
});

test('empty nodes cannot cause unbounded DOM property work', () => {
  let accesses = 0;
  const empty = media('VIDEO');
  Object.defineProperty(empty, 'currentSrc', { get() { accesses++; return ''; } });
  const result = collectResources(documentStub({ mediaElements: Array(20000).fill(empty) }));
  assert.deepEqual(result, []);
  assert.equal(accesses, 10000);
});

test('static browser script is self-contained and produces the same serializable data', () => {
  const document = documentStub({ mediaElements: [media('VIDEO', { currentSrc: 'movie.mp4', sources: [{ src: 'other.webm', type: 'video/webm' }] })], images: [image()] });
  const evaluated = vm.runInNewContext(collectResourcesScript, { document, URL }, { timeout: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(evaluated)), collectResources(document));
});

test('page strings are data and are never interpolated into the browser script', () => {
  const hostileText = '"; globalThis.didExecute = true; // </script>';
  const document = documentStub({ title: hostileText, mediaElements: [media('VIDEO', { src: hostileText })], images: [image({ alt: hostileText })] });
  const context = { document, URL, didExecute: false };
  const result = vm.runInNewContext(collectResourcesScript, context, { timeout: 1000 });
  assert.equal(context.didExecute, false);
  assert.equal(result[0].url, hostileText);
  assert.equal(result[0].title, hostileText);
  assert.equal(result[1].title, hostileText);
  assert.equal(collectResourcesScript.includes(hostileText), false);
});
