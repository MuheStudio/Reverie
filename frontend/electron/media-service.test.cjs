'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createMediaService } = require('./media-service.cjs');
const { createMediaTransport } = require('./media-transfer.cjs');

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,One\na.ts\n#EXTINF:2,Two\nb.ts\n#EXT-X-ENDLIST\n';
function harness(t, custom = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-media-service-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sender = new EventEmitter(); sender.gone = false; sender.isDestroyed = () => sender.gone;
  const events = []; sender.send = (...args) => events.push(args);
  sender.executeJavaScript = async () => [{ url: 'https://public.example/a.ts', type: 'video', title: 'Synthetic', extra: 'discard' }];
  const state = { features: { download_service_enabled: true }, local: false, saves: 0 };
  state.window = { webContents: sender, isDestroyed: () => false };
  const calls = [];
  const transport = {
    fetchTextResponse: async (...args) => { calls.push(['text', ...args]); return { text: playlist, url: 'https://cdn.example/new/list.m3u8' }; },
    downloadSegmentsToFile: async (urls, target, options) => {
      calls.push(['segments', urls, target, options]); options.onProgress({ current: 2, total: 2, percentage: 100 });
      fs.writeFileSync(target, 'test transfer'); return { path: target, bytes: 13 };
    },
    downloadToFile: async (url, target, options) => {
      calls.push(['direct', url, target, options]); options.onProgress({ current: 4, total: 4, percentage: 100 });
      fs.writeFileSync(target, 'data'); return { path: target, bytes: 4 };
    },
    ...custom.transport,
  };
  const options = {
    getFeatures: () => state.features,
    getGate: () => ({ snapshot: () => ({ active: state.local }) }),
    getWindow: () => state.window,
    getCacheDirectory: () => path.join(root, 'cache'),
    chooseSavePath: async (_window, spec) => { state.saves++; state.saveOptions = spec; return state.savePath ?? null; },
    transport, ...custom.options,
  };
  const service = createMediaService(options); t.after(() => service.dispose());
  return { root, sender, events, state, transport, calls, service, options, event: { sender } };
}

test('disabled download capabilities cannot invoke DOM, transport, picker or create cache', async (t) => {
  const h = harness(t); h.state.features = {};
  for (const op of [() => h.service.sniffResources(h.event), () => h.service.sniffM3u8(h.event, 'https://public.example/a'),
    () => h.service.downloadDirect(h.event, { url: 'https://public.example/a' }),
    () => h.service.downloadM3u8(h.event, { url: 'https://public.example/list.m3u8', m3u8Content: playlist })]) {
    await assert.rejects(op, { code: 'REVERIE_DOWNLOAD_SERVICE_DISABLED' });
  }
  assert.deepEqual(h.calls, []); assert.equal(h.state.saves, 0); assert.equal(fs.existsSync(path.join(h.root, 'cache')), false);
});

test('only the current main-window sender can use the service', async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.downloadDirect({ sender: new EventEmitter() }, { url: 'https://public.example/a' }), { code: 'REVERIE_DOWNLOAD_SENDER' });
  await assert.rejects(h.service.sniffResources({ sender: null }), { code: 'REVERIE_DOWNLOAD_SENDER' });
  assert.equal(h.calls.length, 0); assert.equal(h.state.saves, 0);
});

test('local mode blocks even configured downloads before any network request', async (t) => {
  const h = harness(t); h.state.local = true;
  await assert.rejects(h.service.sniffM3u8(h.event, 'https://public.example/list'), { code: 'REVERIE_LOCAL_MODE' });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.service.sniffResources(h.event)).length, 1, 'Local DOM inspection must remain available offline');
});

test('DOM snapshot returns only bounded public resource fields', async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.service.sniffResources(h.event), [{ url: 'https://public.example/a.ts', type: 'video', title: 'Synthetic' }]);
  h.sender.executeJavaScript = async () => Array.from({ length: 1001 }, () => ({}));
  assert.deepEqual(await h.service.sniffResources(h.event), []);
});

test('playlist inspection preserves legacy fields and exposes validated redirect source URL', async (t) => {
  const h = harness(t); const result = await h.service.sniffM3u8(h.event, 'https://public.example/list');
  assert.equal(result.segmentCount, 2); assert.equal(result.totalDuration, 3); assert.equal(result.isMaster, false);
  assert.deepEqual(result.segments.map(s => s.url), ['a.ts', 'b.ts']);
  assert.equal(result.sourceUrl, 'https://cdn.example/new/list.m3u8');
  assert.equal(h.calls[0][2].maxBytes, 1024 * 1024); assert.equal(h.calls[0][2].timeoutMs, 15000);
});

test('HLS inspection failures retain the error object contract', async (t) => {
  const h = harness(t, { transport: { fetchTextResponse: async () => { throw new Error('HTTP 404'); } } });
  assert.deepEqual(await h.service.sniffM3u8(h.event, 'https://public.example/a'), { error: 'HTTP 404' });
});

test('HLS resolves ordered relative URLs against explicit final base and requires real TS validation', async (t) => {
  const h = harness(t);
  const result = await h.service.downloadM3u8(h.event, { url: 'https://public.example/old/list', baseUrl: 'https://cdn.example/new/list.m3u8', m3u8Content: playlist });
  assert.deepEqual(h.calls[0][1], ['https://cdn.example/new/a.ts', 'https://cdn.example/new/b.ts']);
  assert.equal(h.calls[0][3].segmentValidation, 'mpeg-ts');
  assert.equal(h.calls[0][3].maxBytes, 500 * 1024 * 1024);
  assert.equal(result.size, 13); assert.ok(result.path.startsWith(path.join(h.root, 'cache') + path.sep));
  assert.deepEqual(h.events, [['download:progress', { current: 2, total: 2, percentage: 100 }]]);
  assert.equal(h.sender.listenerCount('destroyed'), 0);
});

test('unsupported or over-duration HLS refuses before transfer or creating output', async (t) => {
  const h = harness(t); h.state.features.video_max_duration_seconds = 2;
  await assert.rejects(h.service.downloadM3u8(h.event, { url: 'https://public.example/a', m3u8Content: playlist }), { code: 'REVERIE_DOWNLOAD_DURATION' });
  h.state.features.video_max_duration_seconds = 30;
  await assert.rejects(h.service.downloadM3u8(h.event, { url: 'https://public.example/a', m3u8Content: playlist.replace('#EXTINF:1', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1') }), { code: 'ERR_HLS_UNSUPPORTED' });
  assert.equal(h.calls.length, 0); assert.equal(fs.existsSync(path.join(h.root, 'cache')), false);
});

test('cache quota bounds current transfer without deleting previous files', async (t) => {
  const h = harness(t); h.state.features.video_total_quota_mb = 1;
  const cache = path.join(h.root, 'cache'); fs.mkdirSync(cache); const old = path.join(cache, 'earlier.ts');
  fs.writeFileSync(old, Buffer.alloc(1024 * 1024 - 188));
  await h.service.downloadM3u8(h.event, { url: 'https://public.example/list', m3u8Content: playlist });
  assert.equal(h.calls[0][3].maxBytes, 188); assert.equal(fs.statSync(old).size, 1024 * 1024 - 188);
});

test('native save cancellation makes no network or file changes', async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.service.downloadDirect(h.event, { url: 'https://public.example/file', filename: '../file' }), { cancelled: true });
  assert.equal(h.calls.length, 0); assert.equal(h.state.saveOptions.defaultPath, '.._file');
});

test('direct save preserves the completed result contract and byte progress', async (t) => {
  const h = harness(t); h.state.savePath = path.join(h.root, 'chosen.txt');
  assert.deepEqual(await h.service.downloadDirect(h.event, { url: 'https://public.example/file' }),
    { path: h.state.savePath, size: 4, state: 'completed', cancelled: false });
  assert.deepEqual(h.events[0], ['download:progress', { current: 4, total: 4, percentage: 100 }]);
});

for (const cause of ['focus', 'feature', 'owner', 'shutdown']) {
  test(`${cause} cancels an active transfer and releases job ownership`, async (t) => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const h = harness(t, { transport: { downloadToFile: async (_url, _target, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }); started();
    }) } });
    h.state.savePath = path.join(h.root, 'chosen.txt');
    const promise = h.service.downloadDirect(h.event, { url: 'https://public.example/a' });
    const rejection = assert.rejects(promise); await ready;
    await assert.rejects(h.service.downloadDirect(h.event, { url: 'https://public.example/b' }), { code: 'REVERIE_DOWNLOAD_BUSY' });
    let watchdog; const deadline = new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Cancellation did not finish')), 1000); });
    if (cause === 'focus') h.state.local = true;
    if (cause === 'feature') h.state.features.download_service_enabled = false;
    if (cause === 'owner') { h.sender.gone = true; h.sender.emit('destroyed'); }
    if (cause === 'shutdown') await h.service.dispose();
    try { await Promise.race([rejection, deadline]); } finally { clearTimeout(watchdog); }
    assert.equal(h.sender.listenerCount('destroyed'), 0); assert.equal(fs.existsSync(h.state.savePath), false);
  });
}

test('a committed download with cleanup warning remains success and reports the warning', async (t) => {
  const diagnostics = [];
  const h = harness(t, { options: { onDiagnostic: item => diagnostics.push(item) }, transport: {
    downloadToFile: async (_u, target) => ({ path: target, bytes: 10, cleanupPending: target + '.part' }),
  } });
  h.state.savePath = path.join(h.root, 'file'); const result = await h.service.downloadDirect(h.event, { url: 'https://public.example/a' });
  assert.equal(result.state, 'completed'); assert.ok(result.warning); assert.equal(diagnostics[0].code, 'REVERIE_DOWNLOAD_CLEANUP_PENDING');
});

for (const cause of ['focus', 'feature', 'owner', 'shutdown']) {
  test(`${cause} cancels a pending native picker and never uses its late result`, async (t) => {
    let selected, opened;
    const shown = new Promise(resolve => { opened = resolve; });
    const picker = new Promise(resolve => { selected = resolve; });
    const h = harness(t, { options: { chooseSavePath: () => { opened(); return picker; } } });
    const operation = h.service.downloadDirect(h.event, { url: 'https://public.example/a' });
    const rejected = assert.rejects(operation);
    await shown;
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Picker prevented cancellation')), 1000); });
    if (cause === 'focus') h.state.local = true;
    if (cause === 'feature') h.state.features.download_service_enabled = false;
    if (cause === 'owner') { h.sender.gone = true; h.sender.emit('destroyed'); }
    try {
      const stopped = cause === 'shutdown' ? h.service.dispose() : rejected;
      await Promise.race([Promise.all([stopped, rejected]), deadline]);
    } finally { clearTimeout(timeout); }
    selected(path.join(h.root, 'must-not-write'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 0);
    assert.equal(fs.existsSync(path.join(h.root, 'must-not-write')), false);
    assert.equal(h.sender.listenerCount('destroyed'), 0);
  });
}

test('service with real streaming transport downloads synthetic TS and preserves existing destinations', async (t) => {
  const packets = Array.from({ length: 2 }, (_, index) => { const bytes = Buffer.alloc(188, index + 1); bytes.set([0x47, 0x1f, 0xff, 0x10]); return bytes; });
  const server = http.createServer((req, res) => {
    if (req.url === '/list.m3u8') { res.end(playlist); return; }
    res.end(req.url === '/a.ts' ? packets[0] : packets[1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const transport = createMediaTransport({
    resolver: async () => [{ address: '1.1.1.1', family: 4 }],
    // Only the test connector remaps the already validated public address.
    request: (opts, callback) => http.request({ ...opts, hostname: '127.0.0.1', port,
      lookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4) }, callback),
  });
  const h = harness(t, { options: { transport } });
  const inspection = await h.service.sniffM3u8(h.event, `http://media.example/list.m3u8`);
  assert.equal(inspection.segmentCount, 2);
  const result = await h.service.downloadM3u8(h.event, { url: inspection.sourceUrl, m3u8Content: playlist });
  assert.equal(result.size, 376); assert.deepEqual(fs.readFileSync(result.path), Buffer.concat(packets));
  assert.deepEqual(fs.readdirSync(path.join(h.root, 'cache')), [path.basename(result.path)]);
  h.state.savePath = path.join(h.root, 'existing.txt'); fs.writeFileSync(h.state.savePath, 'keep');
  await assert.rejects(h.service.downloadDirect(h.event, { url: 'http://media.example/file' }));
  assert.equal(fs.readFileSync(h.state.savePath, 'utf8'), 'keep');
});
