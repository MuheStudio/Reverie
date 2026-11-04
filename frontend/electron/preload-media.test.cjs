'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPreload() {
  const invokes = [];
  let api;
  const context = vm.createContext({
    Buffer,
    TypeError,
    URL,
    process: Object.freeze({ platform: 'darwin', isMainFrame: true }),
    require(name) {
      assert.equal(name, 'electron', 'sandboxed preload must not load a host module');
      return {
        contextBridge: {
          exposeInMainWorld(key, value) {
            assert.equal(key, 'electronAPI');
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (channel, value) => {
            invokes.push({ channel, value });
            return { path: '/isolated/media.ts', size: 188 };
          },
          on() {},
          removeListener() {},
        },
        webUtils: {},
      };
    },
  });
  new vm.Script(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    filename: 'preload.js',
  }).runInContext(context);
  assert.ok(api);
  return { api, invokes };
}

function payload(m3u8Content) {
  return {
    url: 'https://media.example.test/playlist.m3u8',
    baseUrl: 'https://media.example.test/final/playlist.m3u8',
    m3u8Content,
  };
}

const lines = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:1',
  '#EXTINF:1,合成媒体',
  'segment.ts',
  '#EXT-X-ENDLIST',
  '',
];

for (const [name, separator] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`real preload forwards ${name} HLS text unchanged through its fixed channel`, async () => {
    const { api, invokes } = loadPreload();
    const input = payload(lines.join(separator));
    const result = await api.download.downloadM3u8({ ...input, ignored: 'not forwarded' });
    assert.equal(result.path, '/isolated/media.ts');
    assert.equal(result.size, 188);
    assert.equal(invokes.length, 1);
    assert.equal(invokes[0].channel, 'download:m3u8');
    assert.deepEqual(JSON.parse(JSON.stringify(invokes[0].value)), input);
  });
}

test('real preload rejects invalid playlist values and all non-line control characters before IPC', () => {
  const { api, invokes } = loadPreload();
  const invalidValues = [undefined, null, false, 1, {}, [], new String('#EXTM3U'), ''];
  for (const value of invalidValues) {
    assert.throws(() => api.download.downloadM3u8(payload(value)), /m3u8 content is invalid/);
  }
  for (let code = 0; code <= 0x9f; code += 1) {
    if ((code > 0x1f && code < 0x7f) || code === 10 || code === 13) continue;
    const content = lines.join('\n') + String.fromCharCode(code);
    assert.throws(() => api.download.downloadM3u8(payload(content)), /m3u8 content is invalid/,
      `control U+${code.toString(16).padStart(4, '0')} must be rejected`);
  }
  assert.equal(invokes.length, 0, 'invalid playlist text must never cross IPC');
});

test('real preload enforces an inclusive 8 MiB UTF-8 playlist limit', async () => {
  const { api, invokes } = loadPreload();
  const maxBytes = 8 * 1024 * 1024;
  const prefix = '#EXTM3U\n#';
  const exact = prefix + 'a'.repeat(maxBytes - prefix.length);
  await api.download.downloadM3u8(payload(exact));
  assert.equal(invokes.length, 1);
  assert.equal(invokes[0].value.m3u8Content, exact);
  for (const content of [exact + 'a', '#EXTM3U\n' + '中'.repeat(Math.ceil(maxBytes / 3))]) {
    assert.throws(() => api.download.downloadM3u8(payload(content)), /m3u8 content is invalid/);
  }
  assert.equal(invokes.length, 1, 'oversize strings must not invoke IPC');
});

test('allowing HLS line endings does not permit them in URLs, filenames or ordinary text', () => {
  const { api, invokes } = loadPreload();
  for (const control of ['\n', '\r', '\t', '\u0000']) {
    assert.throws(() => api.download.downloadM3u8({
      ...payload(lines.join('\n')),
      url: `https://media.example.test/${control}playlist.m3u8`,
    }), /invalid/);
    assert.throws(() => api.download.downloadM3u8({
      ...payload(lines.join('\n')),
      baseUrl: `https://media.example.test/${control}playlist.m3u8`,
    }), /invalid/);
    assert.throws(() => api.download.downloadDirect({
      url: 'https://media.example.test/media.ts', filename: `media${control}.ts`,
    }), /download filename is invalid/);
    assert.throws(() => api.pet.sendChat(`message${control}text`), /pet chat text is invalid/);
  }
  assert.equal(invokes.length, 0);
});
