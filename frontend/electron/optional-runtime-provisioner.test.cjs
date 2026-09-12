'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MANIFEST_SCHEMA,
  OptionalRuntimeProvisioner,
  STATES,
  validateManifest,
} = require('./optional-runtime-provisioner.cjs');
const releaseStatus = require('./gpt-sovits-runtime-release-status.cjs');

const payload = Buffer.from('verified optional runtime payload');
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

function root(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `reverie-runtime-${name}-`));
}

function manifest(overrides = {}) {
  const artifact = {
    id: 'runtime',
    url: 'https://assets.example.test/releases/1.2.3/runtime.bin',
    sha256,
    size: payload.length,
    kind: 'file',
    destination: 'bin/runtime.bin',
    maxExtractedFiles: 1,
    maxExtractedBytes: payload.length,
    ...overrides,
  };
  return {
    schema: MANIFEST_SCHEMA,
    recipeVersion: '1.2.3',
    platform: 'win32',
    arch: 'x64',
    policy: { allowedHosts: ['assets.example.test'] },
    artifacts: [artifact],
  };
}

function response(body = payload, status = 200, headers = { etag: '"fixed"' }) {
  return { status, headers, body };
}

function provisioner(name, seams = {}) {
  const storageRoot = seams.storageRoot || root(name);
  const calls = [];
  const instance = new OptionalRuntimeProvisioner({
    storageRoot,
    runtime: { platform: 'win32', arch: 'x64' },
    freeDisk: async () => Number.MAX_SAFE_INTEGER,
    httpRequest: async (request) => { calls.push(request); return response(); },
    safeExtract: async () => { throw new Error('file artifacts do not require extraction'); },
    validateRuntime: async (installRoot) => fs.existsSync(path.join(installRoot, 'bin', 'runtime.bin')),
    ...seams,
  });
  return { instance, storageRoot, calls };
}

test('publishes no unverified default artifact manifest', () => {
  assert.deepEqual(releaseStatus, {
    available: false,
    manifest: null,
    reason: 'Optional GPT-SoVITS runtime release assets are not yet published.',
  });
  assert.deepEqual(STATES, ['idle', 'preflight', 'downloading', 'verifying', 'extracting', 'validating', 'ready', 'failed', 'paused']);
});

test('successful install verifies, validates, and atomically activates app-owned content', async () => {
  const states = [];
  const { instance, storageRoot } = provisioner('success', { onState: ({ state }) => states.push(state) });
  const result = await instance.install(manifest());
  assert.equal(fs.readFileSync(path.join(result.installDir, 'bin', 'runtime.bin'), 'utf8'), payload.toString());
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, 'active.json'))).manifestFingerprint, result.manifestFingerprint);
  assert.deepEqual(states, ['preflight', 'downloading', 'verifying', 'extracting', 'validating', 'ready']);
});

test('rejects concurrent installs and preserves cancellation ownership', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { instance } = provisioner('concurrent', {
    httpRequest: async () => { await gate; return response(); },
  });
  const first = instance.install(manifest());
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    instance.install(manifest()),
    (error) => error.code === 'REVERIE_OPERATION_IN_PROGRESS',
  );
  release();
  await first;
});

test('resumes a partial download only with valid 206 Content-Range and stable ETag', async () => {
  const storageRoot = root('resume');
  const partial = payload.subarray(0, 9);
  const downloadDir = path.join(storageRoot, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  // Obtain the deterministic download directory by letting a first interrupted request journal it.
  let first = true;
  const initial = provisioner('resume-initial', {
    storageRoot,
    httpRequest: async () => {
      if (first) {
        first = false;
        return { status: 200, headers: { etag: '"fixed"' }, body: (async function* () { yield partial; throw new Error('simulated process crash'); })() };
      }
      throw new Error('unexpected');
    },
  });
  await assert.rejects(initial.instance.install(manifest()), /simulated process crash/);
  let request;
  const resumed = provisioner('resume-second', {
    storageRoot,
    httpRequest: async (value) => {
      request = value;
      return response(payload.subarray(partial.length), 206, {
        etag: '"fixed"',
        'content-range': `bytes ${partial.length}-${payload.length - 1}/${payload.length}`,
      });
    },
  });
  await resumed.instance.install(manifest());
  assert.equal(request.headers.Range, `bytes=${partial.length}-`);
  assert.equal(request.headers['If-Range'], '"fixed"');
});

test('restarts from zero when a server ignores Range with 200', async () => {
  const storageRoot = root('ignored-range');
  let attempt = 0;
  const first = provisioner('ignored-first', {
    storageRoot,
    httpRequest: async () => ({ status: 200, headers: { etag: '"one"' }, body: (async function* () { yield payload.subarray(0, 4); throw new Error('drop'); })() }),
  });
  await assert.rejects(first.instance.install(manifest()), /drop/);
  let request;
  const second = provisioner('ignored-second', {
    storageRoot,
    httpRequest: async (value) => { attempt += 1; request = value; return response(payload, 200, { etag: '"two"' }); },
  });
  const installed = await second.instance.install(manifest());
  assert.equal(attempt, 1);
  assert.equal(request.headers.Range, 'bytes=4-');
  assert.equal(fs.readFileSync(path.join(installed.installDir, 'bin', 'runtime.bin')).equals(payload), true);
});

test('restarts a partial file that has no strong ETag instead of attempting Range', async () => {
  const storageRoot = root('weak-etag');
  const first = provisioner('weak-first', {
    storageRoot,
    httpRequest: async () => ({ status: 200, headers: { etag: 'W/"weak"' }, body: (async function* () { yield payload.subarray(0, 5); throw new Error('drop'); })() }),
  });
  await assert.rejects(first.instance.install(manifest()), /drop/);
  let request;
  const second = provisioner('weak-second', {
    storageRoot,
    httpRequest: async (value) => { request = value; return response(); },
  });
  await second.instance.install(manifest());
  assert.deepEqual(request.headers, {});
});

test('rejects hash mismatch before extraction or validation', async () => {
  let extracted = false;
  let validated = false;
  const bad = Buffer.alloc(payload.length, 1);
  const { instance } = provisioner('hash', {
    httpRequest: async () => response(bad),
    safeExtract: async () => { extracted = true; return []; },
    validateRuntime: async () => { validated = true; return true; },
  });
  await assert.rejects(instance.install(manifest()), (error) => error.code === 'HASH_MISMATCH');
  assert.equal(extracted, false);
  assert.equal(validated, false);
});

function archiveManifest(overrides = {}) {
  const data = Buffer.from('archive placeholder');
  return {
    data,
    value: manifest({
      url: 'https://assets.example.test/releases/1.2.3/runtime.zip',
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      size: data.length,
      kind: 'zip',
      destination: 'runtime',
      maxExtractedFiles: 4,
      maxExtractedBytes: 32,
      ...overrides,
    }),
  };
}

test('rejects traversal, links, and bomb inventories independently of extractor claims', async (context) => {
  const cases = [
    ['traversal', [{ path: '../escape', type: 'file', size: 1 }], 'UNSAFE_ARCHIVE'],
    ['link', [{ path: 'linked', type: 'symlink', size: 0 }], 'UNSAFE_ARCHIVE'],
    ['bomb', Array.from({ length: 5 }, (_, index) => ({ path: `f${index}`, type: 'file', size: 1 })), 'ARCHIVE_BOMB'],
  ];
  for (const [name, inventory, code] of cases) await context.test(name, async () => {
    const archive = archiveManifest();
    const { instance } = provisioner(`inventory-${name}`, {
      httpRequest: async () => response(archive.data),
      safeExtract: async ({ outputDir }) => {
        for (const entry of inventory) {
          if (entry.path.includes('..') || entry.type === 'symlink') continue;
          fs.writeFileSync(path.join(outputDir, entry.path), Buffer.alloc(entry.size));
        }
        return inventory;
      },
    });
    await assert.rejects(instance.install(archive.value), (error) => error.code === code);
  });
});

test('fails peak disk preflight with ENOSPC before network access', async () => {
  let requested = false;
  const { instance } = provisioner('disk', {
    freeDisk: async () => payload.length * 2 - 1,
    httpRequest: async () => { requested = true; return response(); },
  });
  await assert.rejects(instance.install(manifest()), (error) => error.code === 'ENOSPC');
  assert.equal(requested, false);
});

test('cancellation durably pauses an install for later resume', async () => {
  const storageRoot = root('cancel');
  const controller = new AbortController();
  const { instance } = provisioner('cancel-run', {
    storageRoot,
    httpRequest: async () => ({
      status: 200,
      headers: { etag: '"cancel"' },
      body: (async function* () {
        yield payload.subarray(0, 3);
        controller.abort();
        yield payload.subarray(3);
      })(),
    }),
  });
  await assert.rejects(instance.install(manifest(), controller.signal), { name: 'AbortError' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, 'provision-journal.json'))).state, 'paused');
});

test('validator failure retains the old active runtime', async () => {
  const storageRoot = root('old-active');
  const old = path.join(storageRoot, 'installs', 'old');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'healthy'), 'old');
  fs.writeFileSync(path.join(storageRoot, 'active.json'), JSON.stringify({ installDir: old }));
  const { instance } = provisioner('validator', { storageRoot, validateRuntime: async () => false });
  await assert.rejects(instance.install(manifest()), (error) => error.code === 'VALIDATOR_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(storageRoot, 'active.json'))).installDir, old);
  assert.equal(fs.readFileSync(path.join(old, 'healthy'), 'utf8'), 'old');
});

test('durable failed journal allows a new process to resume after a crash', async () => {
  const storageRoot = root('crash');
  const chunk = payload.subarray(0, 7);
  const crashing = provisioner('crash-one', {
    storageRoot,
    httpRequest: async () => ({ status: 200, headers: { etag: '"crash-etag"' }, body: (async function* () { yield chunk; throw new Error('power loss'); })() }),
  });
  await assert.rejects(crashing.instance.install(manifest()), /power loss/);
  const journal = JSON.parse(fs.readFileSync(path.join(storageRoot, 'provision-journal.json')));
  assert.equal(journal.state, 'failed');
  assert.equal(journal.artifacts.runtime.downloaded, chunk.length);
  const recovering = provisioner('crash-two', {
    storageRoot,
    httpRequest: async ({ headers }) => {
      assert.equal(headers.Range, `bytes=${chunk.length}-`);
      return response(payload.subarray(chunk.length), 206, {
        etag: '"crash-etag"',
        'content-range': `bytes ${chunk.length}-${payload.length - 1}/${payload.length}`,
      });
    },
  });
  assert.equal((await recovering.instance.install(manifest())).state, 'ready');
});

test('strict manifest rejects mutable latest URLs and unallowlisted hosts', () => {
  assert.throws(() => validateManifest(manifest({
    url: 'https://assets.example.test/releases/latest/1.2.3-runtime.bin',
  }), { platform: 'win32', arch: 'x64' }), /mutable latest/i);
  assert.throws(() => validateManifest(manifest({
    url: 'https://other.example.test/releases/1.2.3/runtime.bin',
  }), { platform: 'win32', arch: 'x64' }), /not allowlisted/i);
});
