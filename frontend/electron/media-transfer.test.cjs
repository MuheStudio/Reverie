'use strict';

// Synthetic fixtures only. Public DNS identities are mapped to a loopback
// server by a construction-time connector; production policy stays unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { createMediaTransport } = require('./media-transfer.cjs');

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:4700:4700::1111';

async function fixture(t, handler, hooks = {}) {
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'reverie-media-test-')));
  const server = http.createServer(handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const requests = [];
  const resolutions = [];
  const transport = createMediaTransport({
    ...hooks,
    resolver: async (hostname, options) => {
      resolutions.push({ hostname, options });
      return hooks.resolver ? hooks.resolver(hostname, options) : [{ address: PUBLIC_V4, family: 4 }];
    },
    request(options, callback) {
      requests.push(options);
      let pinned;
      options.lookup(options.hostname, {}, (error, address, family) => {
        assert.equal(error, null);
        pinned = { address, family };
      });
      options.lookup(options.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [pinned]);
      });
      assert.equal(options.family, pinned.family);
      assert.equal(options.agent, false);
      assert.equal(options.autoSelectFamily, false);
      assert.equal(options.rejectUnauthorized, true);
      assert.ok([PUBLIC_V4, PUBLIC_V6, '8.8.8.8'].includes(pinned.address));
      return http.request({
        ...options,
        protocol: 'http:',
        hostname: '127.0.0.1',
        port: server.address().port,
        family: 4,
        lookup: undefined,
        headers: { ...options.headers, Host: options.hostname },
      }, callback);
    },
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return { directory, requests, resolutions, transport, target: path.join(directory, 'movie.bin') };
}

async function assertEmpty(directory) {
  assert.deepEqual(await fsp.readdir(directory), []);
}

test('production URL policy rejects local and non-global literal hosts before any request', async () => {
  let calls = 0;
  const transport = createMediaTransport({
    resolver: async () => { calls += 1; return [{ address: PUBLIC_V4, family: 4 }]; },
    request() { calls += 1; throw new Error('Unexpected network access'); },
  });
  const forbidden = [
    'file:///tmp/a', 'ftp://example.test/a', 'http://user:secret@example.test/',
    'https://@example.test/', 'https:////@example.test/', 'https:\\\\@example.test/', 'http://localhost/',
    'http://LOCALHOST./', 'http://one.localhost/', 'http://thing.local/',
    'http://0.0.0.0/', 'http://10.0.0.1/', 'http://100.64.0.1/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://169.254.1.1/', 'http://172.16.0.1/', 'http://192.0.0.1/',
    'http://192.0.2.1/', 'http://192.88.99.1/', 'http://192.168.1.1/',
    'http://198.18.0.1/', 'http://198.51.100.1/', 'http://203.0.113.1/',
    'http://224.0.0.1/', 'http://255.255.255.255/', 'http://[::]/',
    'http://[::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/',
    'http://[ff02::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::7f00:1]/',
    'http://[2001::1]/', 'http://[2001:db8::1]/', 'http://[2002:7f00:1::]/',
    'http://[3fff::1]/', 'http://example.test/\nsecret',
  ];
  for (const url of forbidden) await assert.rejects(transport.fetchText(url), /Media URL/);
  assert.equal(calls, 0);
});

test('all DNS answers are validated, including mixed public and private results', async () => {
  for (const records of [
    [], [{ address: '127.0.0.1', family: 4 }],
    [{ address: PUBLIC_V4, family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: PUBLIC_V4, family: 4 }, { address: '::ffff:7f00:1', family: 6 }],
    [{ address: PUBLIC_V4, family: 6 }], [{ address: 'invalid', family: 4 }],
  ]) {
    let calls = 0;
    const transport = createMediaTransport({ resolver: async () => records,
      request() { calls += 1; throw new Error('Unexpected request'); } });
    await assert.rejects(transport.fetchText('http://media.example.test/'), { code: 'ERR_MEDIA_ADDRESS' });
    assert.equal(calls, 0);
  }
});

test('DNS is resolved once per request and the public answer is pinned into lookup', async t => {
  const f = await fixture(t, (_req, res) => res.end('hello'), {
    resolver: async () => [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }],
  });
  assert.equal(await f.transport.fetchText('https://media.example.test/a?b=1#ignored'), 'hello');
  assert.equal(f.resolutions.length, 1);
  assert.deepEqual(f.resolutions[0].options, { all: true, verbatim: true });
  assert.equal(f.requests[0].protocol, 'https:');
  assert.equal(f.requests[0].path, '/a?b=1');
  assert.equal(f.requests[0].family, 6);
});

test('public IP literals skip DNS and remain validated', async t => {
  const f = await fixture(t, (_req, res) => res.end('ip'));
  assert.equal(await f.transport.fetchText('http://8.8.8.8/a'), 'ip');
  assert.equal(await f.transport.fetchText(`http://[${PUBLIC_V6}]/a`), 'ip');
  assert.equal(f.resolutions.length, 0);
});

test('relative and public-host redirects work without forwarding cookies or credentials', async t => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    seen.push({ path: req.url, host: req.headers.host, cookies: req.headers.cookie,
      authorization: req.headers.authorization });
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/middle', 'Set-Cookie': 'private=secret' });
      res.end();
    } else if (req.url === '/middle') {
      res.writeHead(307, { Location: 'https://other.example.test/end' });
      res.end();
    } else res.end('redirected');
  });
  assert.equal(await f.transport.fetchText('http://media.example.test/start'), 'redirected');
  assert.deepEqual(seen.map(item => item.path), ['/start', '/middle', '/end']);
  assert.equal(seen[2].host, 'other.example.test');
  assert.ok(seen.every(item => !item.cookies && !item.authorization));
  assert.equal(f.resolutions.length, 3);
});

test('text response exposes the validated final redirect URL for playlist base resolution', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/original') {
      res.writeHead(302, { Location: 'https://cdn.example.test/nested/list.m3u8?token=synthetic#ignored' });
      res.end();
    } else res.end('#EXTM3U\nsegment.ts\n');
  });
  assert.deepEqual(await f.transport.fetchTextResponse('http://media.example.test/original'), {
    text: '#EXTM3U\nsegment.ts\n',
    url: 'https://cdn.example.test/nested/list.m3u8?token=synthetic',
  });
});

test('each redirect is revalidated, including private DNS and credential destinations', async t => {
  for (const location of ['http://127.0.0.1/secret', 'http://[::ffff:7f00:1]/secret',
    'http://user:secret@other.example.test/', 'file:///tmp/secret', 'http://private.example.test/']) {
    await t.test(location, async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: location }); res.end(); }, {
        resolver: async hostname => [{ address: hostname === 'private.example.test' ? '10.1.2.3' : PUBLIC_V4, family: 4 }],
      });
      await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target));
      assert.equal(f.requests.length, 1);
      await assertEmpty(f.directory);
    });
  }
});

test('redirects stop after five and leave no files', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target), { code: 'ERR_MEDIA_REDIRECT' });
  assert.equal(f.requests.length, 6);
  await assertEmpty(f.directory);
});

test('same-host redirects cannot reuse a newly private DNS answer', async t => {
  let lookups = 0;
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); }, {
    resolver: async () => [{ address: ++lookups === 1 ? PUBLIC_V4 : '127.0.0.1', family: 4 }],
  });
  await assert.rejects(f.transport.fetchText('http://media.example.test/'), { code: 'ERR_MEDIA_ADDRESS' });
  assert.equal(lookups, 2);
  assert.equal(f.requests.length, 1);
});

test('downloads stream to a private sibling and publish only complete bytes', async t => {
  let inspected = false;
  const f = await fixture(t, async (_req, res) => {
    const entries = await fsp.readdir(f.directory);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^\.movie\.bin\.[a-f0-9-]+\.part$/);
    const stat = await fsp.stat(path.join(f.directory, entries[0]));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.existsSync(f.target), false);
    inspected = true;
    res.setHeader('Content-Length', '6');
    res.write('abc');
    setTimeout(() => res.end('def'), 20);
  });
  const progress = [];
  assert.deepEqual(await f.transport.downloadToFile('http://media.example.test/', f.target,
    { onProgress: value => progress.push(value) }), { path: f.target, bytes: 6 });
  assert.equal(inspected, true);
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'abcdef');
  assert.deepEqual(progress.at(-1), { current: 6, total: 6, percentage: 100 });
  assert.deepEqual(await fsp.readdir(f.directory), ['movie.bin']);
});

test('unknown totals stay zero and progress observer exceptions are ignored', async t => {
  const f = await fixture(t, (_req, res) => { res.write('abc'); res.end('def'); });
  const progress = [];
  await f.transport.downloadToFile('http://media.example.test/', f.target, { onProgress(value) {
    progress.push(value); throw new Error('observer failed');
  } });
  assert.equal(progress.at(-1).current, 6);
  assert.ok(progress.every(value => value.total === 0 && value.percentage === 0));
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'abcdef');
});

test('asynchronous progress observer rejection does not fail the transfer', async t => {
  const f = await fixture(t, (_req, res) => res.end('complete'));
  await f.transport.downloadToFile('http://media.example.test/', f.target, {
    async onProgress() { throw new Error('async observer failed'); },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'complete');
});

test('chunked bodies are bounded independently of Content-Length and text is also bounded', async t => {
  const f = await fixture(t, (_req, res) => { res.write('1234'); res.end('5678'); });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { maxBytes: 7 }),
    { code: 'ERR_MEDIA_LIMIT' });
  await assertEmpty(f.directory);
  await assert.rejects(f.transport.fetchText('http://media.example.test/', { maxBytes: 7 }), { code: 'ERR_MEDIA_LIMIT' });
});

test('declared oversize and prematurely closed responses never publish', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.write('abc');
    if (req.url === '/truncated') setTimeout(() => res.destroy(), 15);
    else res.end();
  });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/oversize', f.target, { maxBytes: 10 }),
    { code: 'ERR_MEDIA_LIMIT' });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/truncated', f.target));
  await assertEmpty(f.directory);
});

test('errors, encoded responses, and unsolicited partial responses are rejected', async t => {
  for (const [status, headers] of [[500, {}], [206, {}], [200, { 'Content-Encoding': 'gzip' }]]) {
    await t.test(`${status} ${JSON.stringify(headers)}`, async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(status, headers); res.end('bad'); });
      await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target));
      await assertEmpty(f.directory);
    });
  }
});

test('the total deadline covers DNS without allowing a late request', async () => {
  let finishDns;
  let calls = 0;
  const transport = createMediaTransport({
    resolver: () => new Promise(resolve => { finishDns = resolve; }),
    request() { calls += 1; throw new Error('Unexpected late request'); },
  });
  await assert.rejects(transport.fetchText('http://media.example.test/', { timeoutMs: 25 }), { code: 'ERR_MEDIA_TIMEOUT' });
  finishDns([{ address: PUBLIC_V4, family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('cancellation during DNS prevents a late resolution from issuing a request', async () => {
  let finishDns;
  let calls = 0;
  const controller = new AbortController();
  const transport = createMediaTransport({
    resolver: () => new Promise(resolve => { finishDns = resolve; }),
    request() { calls += 1; throw new Error('Unexpected late request'); },
  });
  const pending = transport.fetchText('http://media.example.test/', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  finishDns([{ address: PUBLIC_V4, family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('the total deadline covers both missing headers and a stalled response body', async t => {
  for (const sendBody of [false, true]) {
    await t.test(sendBody ? 'body' : 'headers', async t => {
      let closed = false;
      const f = await fixture(t, (req, res) => {
        req.socket.once('close', () => { closed = true; });
        if (sendBody) res.write('first');
      });
      await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { timeoutMs: 60 }),
        { code: 'ERR_MEDIA_TIMEOUT' });
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(closed, true);
      await assertEmpty(f.directory);
    });
  }
});

test('a slow drip cannot reset the full transfer deadline', async t => {
  const f = await fixture(t, (_req, res) => {
    const timer = setInterval(() => res.write('x'), 10);
    res.once('close', () => clearInterval(timer));
  });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { timeoutMs: 75 }),
    { code: 'ERR_MEDIA_TIMEOUT' });
  await assertEmpty(f.directory);
});

test('pre-aborted transfers make no request and body cancellation removes only owned temporary files', async t => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t, (_req, res) => { res.write('first'); });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { signal: controller.signal }),
    { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(f.requests.length, 0);
  const unrelated = path.join(f.directory, '.unrelated.part');
  await fsp.writeFile(unrelated, 'keep');
  const live = new AbortController();
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, {
    signal: live.signal,
    onProgress(value) { if (value.current > 0) live.abort(); },
  }), { code: 'ABORT_ERR' });
  assert.deepEqual(await fsp.readdir(f.directory), ['.unrelated.part']);
  assert.equal(await fsp.readFile(unrelated, 'utf8'), 'keep');
});

test('permission guard is checked after DNS, before requests, on chunks and while idle', async t => {
  let allowed = true;
  const f = await fixture(t, (_req, res) => { res.write('first'); }, { requireRemote: () => allowed });
  allowed = false;
  await assert.rejects(f.transport.fetchText('http://media.example.test/'), { code: 'ERR_MEDIA_REMOTE_DISABLED' });
  assert.equal(f.requests.length, 0);
  allowed = true;
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, {
    timeoutMs: 1000,
    onProgress(value) { if (value.current > 0) allowed = false; },
  }), { code: 'ERR_MEDIA_REMOTE_DISABLED' });
  await assertEmpty(f.directory);
  let calls = 0;
  const afterDns = createMediaTransport({
    requireRemote: () => allowed,
    resolver: async () => { allowed = false; return [{ address: PUBLIC_V4, family: 4 }]; },
    request() { calls += 1; throw new Error('Unexpected request'); },
  });
  allowed = true;
  await assert.rejects(afterDns.fetchText('http://media.example.test/'), { code: 'ERR_MEDIA_REMOTE_DISABLED' });
  assert.equal(calls, 0);
});

test('existing targets, symlinks, and targets created during transfer are never overwritten', async t => {
  const f = await fixture(t, (_req, res) => res.end('download'));
  await fsp.writeFile(f.target, 'original');
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target), { code: 'EEXIST' });
  assert.equal(f.requests.length, 0);
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'original');
  await fsp.unlink(f.target);
  await fsp.symlink(path.join(f.directory, 'absent'), f.target);
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target), { code: 'EEXIST' });
  await fsp.unlink(f.target);
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { onProgress(value) {
    if (value.current > 0) fs.writeFileSync(f.target, 'arrived during transfer', { flag: 'wx' });
  } }), { code: 'EEXIST' });
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'arrived during transfer');
  assert.deepEqual(await fsp.readdir(f.directory), ['movie.bin']);
});

test('temporary unlink is retried after publication without reporting a failed download', async t => {
  const f = await fixture(t, (_req, res) => res.end('complete'));
  const original = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = target => {
    if (String(target).endsWith('.part') && !injected) {
      injected = true;
      throw Object.assign(new Error('Synthetic unlink fault'), { code: 'EACCES' });
    }
    return original(target);
  };
  try {
    assert.deepEqual(await f.transport.downloadToFile('http://media.example.test/', f.target),
      { path: f.target, bytes: 8 });
  } finally {
    fs.unlinkSync = original;
  }
  assert.equal(injected, true);
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'complete');
  assert.deepEqual(await fsp.readdir(f.directory), ['movie.bin']);
});

test('persistent post-commit cleanup failure is reported with the exact owned path', async t => {
  const f = await fixture(t, (_req, res) => res.end('complete'));
  const originalSync = fs.unlinkSync;
  const originalAsync = fsp.unlink;
  const failed = () => { throw Object.assign(new Error('Synthetic unlink fault'), { code: 'EACCES' }); };
  fs.unlinkSync = failed;
  fsp.unlink = async () => failed();
  let result;
  try {
    result = await f.transport.downloadToFile('http://media.example.test/', f.target);
  } finally {
    fs.unlinkSync = originalSync;
    fsp.unlink = originalAsync;
  }
  assert.equal(result.path, f.target);
  assert.equal(result.bytes, 8);
  assert.equal(path.dirname(result.cleanupPending), f.directory);
  assert.match(path.basename(result.cleanupPending), /^\.movie\.bin\.[a-f0-9-]+\.part$/);
  assert.equal(await fsp.readFile(f.target, 'utf8'), 'complete');
  await fsp.unlink(result.cleanupPending);
  assert.deepEqual(await fsp.readdir(f.directory), ['movie.bin']);
});

test('a filesystem operation finishing after the deadline cannot publish or leave a writer behind', async t => {
  const f = await fixture(t, (_req, res) => res.end('complete'));
  const original = fsp.open;
  let syncStarted = false;
  let syncFinished = false;
  fsp.open = async (...args) => {
    const handle = await original(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      syncStarted = true;
      await new Promise(resolve => setTimeout(resolve, 70));
      await originalSync();
      syncFinished = true;
    };
    return handle;
  };
  try {
    await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { timeoutMs: 30 }),
      { code: 'ERR_MEDIA_TIMEOUT' });
  } finally {
    fsp.open = original;
  }
  assert.equal(syncStarted, true);
  assert.equal(syncFinished, true);
  await assertEmpty(f.directory);
  await new Promise(resolve => setTimeout(resolve, 15));
  await assertEmpty(f.directory);
});

test('app bundle destinations are rejected, including a symlink into a bundle', async t => {
  const f = await fixture(t, (_req, res) => res.end('unused'));
  const app = path.join(f.directory, 'Fixture.app');
  await fsp.mkdir(app);
  const alias = path.join(f.directory, 'alias');
  await fsp.symlink(app, alias);
  for (const target of [path.join(app, 'media.ts'), path.join(alias, 'media.ts'), path.join(f.directory, 'new.APP')]) {
    await assert.rejects(f.transport.downloadToFile('http://media.example.test/', target), { code: 'ERR_MEDIA_DESTINATION' });
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fsp.readdir(app), []);
});

test('segments preserve order, share a global byte budget, and emit legacy progress', async t => {
  const f = await fixture(t, (req, res) => res.end(req.url === '/one' ? '1234' : '5678'));
  const urls = ['http://media.example.test/one', 'http://media.example.test/two'];
  const progress = [];
  await f.transport.downloadSegmentsToFile(urls, f.target, { onProgress: value => progress.push(value), maxBytes: 8 });
  assert.equal(await fsp.readFile(f.target, 'utf8'), '12345678');
  assert.deepEqual(progress, [
    { current: 0, total: 2, percentage: 0 },
    { current: 1, total: 2, percentage: 50 },
    { current: 2, total: 2, percentage: 100 },
  ]);
  await fsp.unlink(f.target);
  await assert.rejects(f.transport.downloadSegmentsToFile(urls, f.target, { maxBytes: 7 }), { code: 'ERR_MEDIA_LIMIT' });
  await assertEmpty(f.directory);
});

function tsPackets(count) {
  const bytes = Buffer.alloc(188 * count, 0xff);
  for (let offset = 0; offset < bytes.length; offset += 188) {
    bytes.set([0x47, 0x1f, 0xff, 0x10], offset); // Clear, payload-only null packet.
  }
  return bytes;
}

test('MPEG TS validation checks packet boundaries across chunks for every segment', async t => {
  const bytes = tsPackets(3);
  const f = await fixture(t, (_req, res) => {
    res.write(bytes.subarray(0, 17));
    setTimeout(() => { res.write(bytes.subarray(17, 250)); res.end(bytes.subarray(250)); }, 10);
  });
  await f.transport.downloadSegmentsToFile(['http://media.example.test/one.ts', 'http://media.example.test/two.ts'], f.target,
    { segmentValidation: 'mpeg-ts' });
  assert.deepEqual(await fsp.readFile(f.target), Buffer.concat([bytes, bytes]));
});

test('MPEG TS validation rejects HTML, empty, truncated, and misaligned packet content', async t => {
  const wrongPacket = tsPackets(2);
  wrongPacket[188] = 0;
  for (const [label, bytes] of [['html', Buffer.from('<html>not media</html>')],
    ['empty', Buffer.alloc(0)], ['truncated', tsPackets(1).subarray(0, 187)], ['sync', wrongPacket]]) {
    await t.test(label, async t => {
      const f = await fixture(t, (_req, res) => res.end(bytes));
      await assert.rejects(f.transport.downloadSegmentsToFile(['http://media.example.test/fake.ts'], f.target,
        { segmentValidation: 'mpeg-ts' }), { code: 'ERR_MEDIA_SEGMENT' });
      await assertEmpty(f.directory);
    });
  }
});

test('MPEG TS validation rejects transport errors, scrambling, and malformed adaptation fields', async t => {
  const mutations = [
    ['transport error', bytes => { bytes[1] |= 0x80; }],
    ['scrambled payload', bytes => { bytes[3] |= 0x80; }],
    ['reserved scrambling', bytes => { bytes[3] |= 0x40; }],
    ['reserved adaptation control', bytes => { bytes[3] = 0; }],
    ['adaptation without payload too short', bytes => { bytes[3] = 0x20; bytes[4] = 182; }],
    ['adaptation with payload too long', bytes => { bytes[3] = 0x30; bytes[4] = 183; }],
    ['missing PCR', bytes => { bytes[3] = 0x30; bytes[4] = 1; bytes[5] = 0x10; }],
    ['private data overflow', bytes => { bytes[3] = 0x30; bytes[4] = 2; bytes[5] = 0x02; bytes[6] = 1; }],
    ['extension overflow', bytes => { bytes[3] = 0x30; bytes[4] = 2; bytes[5] = 0x01; bytes[6] = 1; }],
    ['extension field overflow', bytes => {
      bytes[3] = 0x30; bytes[4] = 3; bytes[5] = 0x01; bytes[6] = 1; bytes[7] = 0x80;
    }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async t => {
      const bytes = tsPackets(1);
      mutate(bytes);
      const f = await fixture(t, (_req, res) => res.end(bytes));
      await assert.rejects(f.transport.downloadSegmentsToFile(['http://media.example.test/a.ts'], f.target,
        { segmentValidation: 'mpeg-ts' }), { code: 'ERR_MEDIA_SEGMENT' });
      await assertEmpty(f.directory);
    });
  }
});

test('valid adaptation-only and adaptation-with-payload transport packets are accepted', async t => {
  const bytes = tsPackets(2);
  bytes[3] = 0x20;
  bytes[4] = 183;
  bytes[5] = 0;
  bytes[188 + 3] = 0x30;
  bytes[188 + 4] = 1;
  bytes[188 + 5] = 0;
  const f = await fixture(t, (_req, res) => res.end(bytes));
  await f.transport.downloadSegmentsToFile(['http://media.example.test/a.ts'], f.target, { segmentValidation: 'mpeg-ts' });
  assert.deepEqual(await fsp.readFile(f.target), bytes);
});

test('invalid bounds and timeout values fail before network or file side effects', async t => {
  const f = await fixture(t, (_req, res) => res.end('unused'));
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { maxBytes }),
      { code: 'ERR_MEDIA_OPTIONS' });
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2147483648]) {
    await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { timeoutMs }),
      { code: 'ERR_MEDIA_OPTIONS' });
  }
  await assert.rejects(f.transport.downloadSegmentsToFile([], f.target), { code: 'ERR_MEDIA_OPTIONS' });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { signal: {} }),
    { code: 'ERR_MEDIA_OPTIONS' });
  await assert.rejects(f.transport.downloadToFile('http://media.example.test/', f.target, { segmentValidation: 'mpeg-ts' }),
    { code: 'ERR_MEDIA_OPTIONS' });
  assert.equal(f.requests.length, 0);
  await assertEmpty(f.directory);
});
