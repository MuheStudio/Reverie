'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const diagnostics = require('./preview-diagnostics.cjs');

const SECRET_CONTENT = 'PRIVATE_BODY_4a4ec03c';
const SECRET_NAME = 'PRIVATE_IMPORT_NAME_a730fd92';
const SECRET_TOKEN = 'PRIVATE_TOKEN_fd711ceb';
const SECRET_URL = 'https://private-response.invalid/secret';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const event = (changes = {}) => ({ schema: diagnostics.EVENT_SCHEMA, event: 'startup', hostPid: 123,
  sequence: 1, timeMs: 1793494800000, elapsedMs: 0, code: 'OK', value: 0, ...changes });
function sortedJson(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ?
    Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-local-diagnostics-test-'));
  fs.chmodSync(scratch, 0o700);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const workspace = path.join(scratch, 'workspace'), output = path.join(scratch, 'diagnostics.json');
  fs.mkdirSync(workspace, { mode: 0o700 });
  function put(relative, value) {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value, { mode: 0o600 });
    return file;
  }
  const runtime = { candidate: 'preview-fixture', sourceHead: 'a'.repeat(40),
    runtimeRoot: path.join(scratch, 'DO_NOT_EXPORT_RUNTIME_PATH'), token: SECRET_TOKEN, endpoint: SECRET_URL };
  const exportReport = (options = {}) => diagnostics.exportDiagnostics({ workspace, output, runtime, ...options });
  function snapshot(options = {}) {
    const from = { candidate: 'previous-candidate', sourceHead: 'b'.repeat(40), buildManifestSha256: 'c'.repeat(64) };
    const to = { candidate: 'current-candidate', sourceHead: 'd'.repeat(40), buildManifestSha256: 'e'.repeat(64) };
    const fromReadyId = 'f'.repeat(32), createdAt = '20261101T010203004Z';
    const transitionSha256 = hash(sortedJson({ fromReadyId, from, to }));
    const name = `snapshot-${createdAt}-${from.candidate}--${to.candidate}-${transitionSha256.slice(0, 32)}-1234abcd`;
    const fileName = options.fileName || `data/${SECRET_NAME}.json`, body = Buffer.from(SECRET_CONTENT);
    const manifest = { schema: 'reverie.preview.snapshot.v1', name, createdAt, fromReadyId, from, to,
      transitionSha256, files: [{ path: fileName, size: String(body.length), sha256: hash(body) }],
      directories: ['data', 'avatars'], totalBytes: String(body.length) };
    options.mutate?.(manifest);
    const directory = path.join(workspace, 'snapshots', name);
    fs.mkdirSync(path.join(directory, 'avatars'), { recursive: true, mode: 0o700 });
    const dataFile = put(`snapshots/${name}/${fileName}`, body);
    const manifestFile = put(`snapshots/${name}/manifest.json`, JSON.stringify(manifest));
    return { name, manifest, directory, dataFile, manifestFile, body };
  }
  return { scratch, workspace, output, put, runtime, exportReport, snapshot };
}
function assertPrivate(report, f) {
  const serialized = JSON.stringify(report);
  for (const value of [SECRET_CONTENT, SECRET_NAME, SECRET_TOKEN, SECRET_URL, f.scratch, f.workspace, f.output])
    assert.ok(!serialized.includes(value), `private marker was exported: ${value}`);
  function strings(value) {
    if (typeof value === 'string') assert.ok(!path.isAbsolute(value), 'absolute path was exported');
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === 'object') Object.values(value).forEach(strings);
  }
  strings(report);
}

test('diagnostics exports only fixed summaries, verified snapshot labels and sanitized events', t => {
  const f = fixture(t), snapshot = f.snapshot();
  const dataFile = f.put(`data/${SECRET_NAME}.json`, SECRET_CONTENT + SECRET_TOKEN + SECRET_URL);
  const logFile = f.put(`logs/${SECRET_NAME}.log`, SECRET_CONTENT + SECRET_TOKEN + SECRET_URL);
  f.put(`avatars/${SECRET_NAME}/profile.json`, SECRET_CONTENT);
  f.put('workspace.lock', String(process.pid));
  f.put(diagnostics.EVENT_FILE, JSON.stringify(event()) + '\n' + JSON.stringify(event({ event: 'not_allowlisted',
    message: SECRET_CONTENT, importedName: SECRET_NAME, token: SECRET_TOKEN, serviceUrl: SECRET_URL })) + '\n');
  const before = [dataFile, logFile, snapshot.dataFile, snapshot.manifestFile].map(file => ({
    file, bytes: fs.readFileSync(file), info: fs.statSync(file) }));
  const report = f.exportReport();
  assert.equal(report.schema, diagnostics.SCHEMA);
  assert.deepEqual(Object.keys(report).sort(), ['directories', 'events', 'logs', 'runtime', 'schema', 'snapshots', 'system']);
  assert.deepEqual(report.runtime, { candidate: 'preview-fixture', sourceShortHash: 'aaaaaaaa', runtimeDirectoryCheck: 'verified' });
  assert.deepEqual(report.directories.map(entry => entry.name), diagnostics.FIXED_DIRECTORIES);
  assert.equal(report.logs.fileCount, 1);
  assert.equal(report.logs.bytes, Buffer.byteLength(SECRET_CONTENT + SECRET_TOKEN + SECRET_URL));
  assert.deepEqual(report.snapshots.entries, [{ name: snapshot.name, bytes: snapshot.body.length,
    fileCount: 1, checkStatus: 'verified' }]);
  assert.equal(report.events.rejectedRecords, 1);
  assert.deepEqual(report.events.entries, [event()]);
  assert.equal(fs.statSync(f.output).mode & 0o7777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')), report);
  assert.ok(fs.statSync(f.output).size <= diagnostics.MAX_OUTPUT_BYTES);
  assertPrivate(report, f);
  for (const item of before) {
    assert.deepEqual(fs.readFileSync(item.file), item.bytes);
    const after = fs.statSync(item.file);
    assert.equal(after.ino, item.info.ino); assert.equal(after.mode, item.info.mode);
    assert.equal(after.mtimeMs, item.info.mtimeMs); assert.equal(after.ctimeMs, item.info.ctimeMs);
  }
  assert.equal(fs.readFileSync(path.join(f.workspace, 'workspace.lock'), 'utf8'), String(process.pid));
});

test('diagnostics rejects overwrite and workspace destinations without changing their bytes', t => {
  const f = fixture(t);
  fs.writeFileSync(f.output, SECRET_CONTENT, { mode: 0o600 });
  assert.throws(() => f.exportReport(), /PREVIEW_DIAGNOSTICS_OUTPUT_EXISTS/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), SECRET_CONTENT);
  for (const output of [path.join(f.workspace, 'report.json'), path.join(f.workspace, 'data', 'report.json')]) {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    assert.throws(() => f.exportReport({ output }), /PREVIEW_DIAGNOSTICS_OUTPUT_INSIDE_WORKSPACE/);
    assert.ok(!fs.existsSync(output));
  }
  assert.throws(() => f.exportReport({ output: 'relative.json' }), /PREVIEW_DIAGNOSTICS_ABSOLUTE_REQUIRED/);
});

test('diagnostics refuses output aliases, dangling links, hardlinks and workspace aliases', t => {
  const f = fixture(t), alias = path.join(f.scratch, 'alias');
  fs.symlinkSync(f.workspace, alias);
  assert.throws(() => f.exportReport({ output: path.join(alias, 'report.json') }), /PREVIEW_DIAGNOSTICS_UNSAFE/);
  assert.throws(() => f.exportReport({ workspace: alias }), /PREVIEW_DIAGNOSTICS_UNSAFE/);
  fs.symlinkSync(path.join(f.scratch, 'missing'), f.output);
  assert.throws(() => f.exportReport(), /PREVIEW_DIAGNOSTICS_OUTPUT_EXISTS/);
  fs.unlinkSync(f.output);
  const original = f.put('data/original', SECRET_CONTENT);
  fs.linkSync(original, f.output);
  assert.throws(() => f.exportReport(), /PREVIEW_DIAGNOSTICS_OUTPUT_EXISTS/);
  assert.equal(fs.readFileSync(original, 'utf8'), SECRET_CONTENT);
});

test('diagnostics never follows fixed-directory, nested-file, event or snapshot links', t => {
  const f = fixture(t), outside = path.join(f.scratch, SECRET_NAME);
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, SECRET_NAME), SECRET_CONTENT);
  fs.symlinkSync(outside, path.join(f.workspace, 'data'));
  fs.mkdirSync(path.join(f.workspace, 'avatars'), { mode: 0o700 });
  fs.symlinkSync(outside, path.join(f.workspace, 'avatars', SECRET_NAME));
  fs.symlinkSync(path.join(outside, SECRET_NAME), path.join(f.workspace, diagnostics.EVENT_FILE));
  fs.mkdirSync(path.join(f.workspace, 'snapshots'), { mode: 0o700 });
  fs.symlinkSync(outside, path.join(f.workspace, 'snapshots', `snapshot-${SECRET_NAME}`));
  const report = f.exportReport();
  assert.equal(report.directories.find(entry => entry.name === 'data').status, 'unsafe');
  assert.equal(report.directories.find(entry => entry.name === 'avatars').fileCount, 0);
  assert.equal(report.directories.find(entry => entry.name === 'avatars').skippedLinks, 1);
  assert.equal(report.events.status, 'unsafe');
  assert.equal(report.snapshots.unmanagedCount, 1);
  assertPrivate(report, f);
});

test('diagnostics withholds unmanaged and malformed snapshot filenames', t => {
  const f = fixture(t), invalid = f.snapshot({ mutate: manifest => {
    manifest.files[0].path = `../${SECRET_NAME}`;
  } });
  fs.mkdirSync(path.join(f.workspace, 'snapshots', SECRET_NAME), { mode: 0o700 });
  f.put(`snapshots/snapshot-${SECRET_NAME}/manifest.json`, SECRET_CONTENT);
  const report = f.exportReport();
  assert.deepEqual(report.snapshots.entries, []);
  assert.equal(report.snapshots.unmanagedCount, 3);
  assert.ok(!JSON.stringify(report).includes(invalid.name));
  assertPrivate(report, f);
});

test('diagnostics reports failed managed snapshot integrity without exporting any payload', t => {
  const f = fixture(t), changed = f.snapshot();
  fs.writeFileSync(changed.dataFile, Buffer.alloc(changed.body.length, 97));
  const report = f.exportReport();
  assert.equal(report.snapshots.rejectedCount, 1);
  assert.equal(report.snapshots.entries[0].checkStatus, 'invalid');
  assertPrivate(report, f);
});

test('diagnostics marks snapshots above the hash budget as limited instead of verified', t => {
  const f = fixture(t), large = f.snapshot({ mutate: manifest => {
    manifest.files[0].size = String(diagnostics.MAX_SNAPSHOT_HASH_BYTES + 1);
    manifest.totalBytes = manifest.files[0].size;
  } });
  // A sparse synthetic file exercises the bound without reading or allocating
  // that many private bytes. Hashing must be skipped and reported as limited.
  fs.truncateSync(large.dataFile, diagnostics.MAX_SNAPSHOT_HASH_BYTES + 1);
  const report = f.exportReport();
  assert.equal(report.snapshots.entries.length, 1);
  assert.equal(report.snapshots.entries[0].checkStatus, 'limit');
  assert.equal(report.snapshots.entries[0].bytes, diagnostics.MAX_SNAPSHOT_HASH_BYTES + 1);
  assertPrivate(report, f);
});

test('diagnostics rejects links inside an otherwise managed snapshot', t => {
  const f = fixture(t), linked = f.snapshot(), saved = path.join(f.scratch, SECRET_NAME);
  fs.renameSync(linked.dataFile, saved); fs.symlinkSync(saved, linked.dataFile);
  const report = f.exportReport();
  assert.equal(report.snapshots.entries[0].checkStatus, 'invalid');
  assert.equal(report.snapshots.rejectedCount, 1);
  assertPrivate(report, f);
});

test('diagnostics verifies legal imported whitespace filenames without exporting their names', t => {
  const f = fixture(t), snapshot = f.snapshot({ fileName: `data/${SECRET_NAME}\n\t.json` });
  const report = f.exportReport();
  assert.deepEqual(report.snapshots.entries, [{ name: snapshot.name, bytes: snapshot.body.length,
    fileCount: 1, checkStatus: 'verified' }]);
  assertPrivate(report, f);
});

test('diagnostics does not trust nonprivate snapshot manifests or host event files', t => {
  const f = fixture(t), snapshot = f.snapshot();
  fs.chmodSync(snapshot.manifestFile, 0o644);
  const eventFile = f.put(diagnostics.EVENT_FILE, JSON.stringify(event()) + '\n');
  fs.chmodSync(eventFile, 0o644);
  const report = f.exportReport();
  assert.equal(report.snapshots.unmanagedCount, 1);
  assert.deepEqual(report.snapshots.entries, []);
  assert.equal(report.events.status, 'unsafe');
  assert.deepEqual(report.events.entries, []);
  assertPrivate(report, f);
});

test('diagnostics bounds nested directory traversal without emitting child names', t => {
  const f = fixture(t);
  f.put('data/' + Array.from({ length: 67 }, () => 'd').join('/') + '/' + SECRET_NAME, SECRET_CONTENT);
  const report = f.exportReport();
  const data = report.directories.find(entry => entry.name === 'data');
  assert.equal(data.status, 'limit');
  assert.equal(data.fileCount, 0);
  assertPrivate(report, f);
});

test('diagnostics validates every snapshot manifest field before disclosing its directory name', t => {
  const f = fixture(t), valid = f.snapshot();
  const bytes = value => Buffer.from(JSON.stringify(value));
  const mutations = [
    value => { value.serviceUrl = SECRET_URL; },
    value => { value.from.extra = SECRET_TOKEN; },
    value => { value.createdAt = '20260230T010203004Z'; },
    value => { value.transitionSha256 = '0'.repeat(64); },
    value => { value.files[0].path = `data/cache/${SECRET_NAME}`; },
    value => { value.files[0].path = `data/../${SECRET_NAME}`; },
    value => { value.files[0].path = `data\\${SECRET_NAME}`; },
    value => { value.files[0].path = `data/${SECRET_NAME}\0`; },
    value => { value.files[0].sha256 = SECRET_TOKEN; },
    value => { value.files[0].size = '01'; },
    value => { value.files[0].size = Number(value.files[0].size); },
    value => { value.totalBytes = '9007199254740992'; },
    value => { value.directories = ['data']; },
    value => { value.directories.push('avatars/child/grandchild'); },
    value => { value.directories.push('data'); },
    value => { value.files.push({ ...value.files[0] }); },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(JSON.stringify(valid.manifest)); mutate(value);
    assert.throws(() => diagnostics.snapshotMetadata(valid.name, bytes(value)), /PREVIEW_DIAGNOSTICS_UNSAFE/);
  }
  assert.throws(() => diagnostics.snapshotMetadata(valid.name + SECRET_NAME, bytes(valid.manifest)), /PREVIEW_DIAGNOSTICS_UNSAFE/);
});

test('diagnostics enforces event input and output caps before parsing oversized private data', t => {
  const f = fixture(t);
  f.put(diagnostics.EVENT_FILE, SECRET_CONTENT.repeat(Math.ceil((diagnostics.MAX_EVENT_BYTES + 1) / SECRET_CONTENT.length)));
  const report = f.exportReport();
  assert.equal(report.events.status, 'limit');
  assert.equal(report.events.truncated, true);
  assert.deepEqual(report.events.entries, []);
  assert.ok(fs.statSync(f.output).size <= diagnostics.MAX_OUTPUT_BYTES);
  assertPrivate(report, f);
});

test('diagnostics counts malformed, oversized and forbidden event records without revealing their text', t => {
  const f = fixture(t);
  f.put(diagnostics.EVENT_FILE, ['{' + SECRET_CONTENT, JSON.stringify(event({ event: SECRET_NAME })),
    JSON.stringify(event({ endpoint: SECRET_URL })),
    JSON.stringify(event({ timeMs: -1 })), JSON.stringify(event({ timeMs: 0.1 })),
    JSON.stringify(event({ token: SECRET_TOKEN })),
    SECRET_CONTENT.repeat(Math.ceil((diagnostics.MAX_EVENT_LINE_BYTES + 1) / SECRET_CONTENT.length))].join('\n') + '\n');
  const report = f.exportReport();
  assert.equal(report.events.rejectedRecords, 7);
  assert.deepEqual(report.events.entries, []);
  assertPrivate(report, f);
});

test('diagnostics accepts every fixed host event and normalizes unknown error text', t => {
  const f = fixture(t), values = diagnostics.EVENT_NAMES.map((name, index) => event({ event: name, sequence: index + 1,
    code: index === 0 ? SECRET_CONTENT + SECRET_URL : diagnostics.EVENT_CODES[index % diagnostics.EVENT_CODES.length],
    value: name === 'service_failure' ? 2 : -index }));
  f.put(diagnostics.EVENT_FILE, values.map(value => JSON.stringify(value)).join('\n') + '\n');
  const report = f.exportReport();
  assert.equal(report.events.entries.length, diagnostics.EVENT_NAMES.length);
  assert.equal(report.events.rejectedRecords, 0);
  assert.equal(report.events.entries[0].code, 'UNKNOWN');
  assert.deepEqual(report.events.entries.map(value => value.event), diagnostics.EVENT_NAMES);
  assertPrivate(report, f);
});

test('diagnostics retains only the most recent bounded host event records', t => {
  const f = fixture(t), values = Array.from({ length: diagnostics.MAX_EVENTS + 5 }, (_unused, index) => event({ sequence: index + 1 }));
  f.put(diagnostics.EVENT_FILE, values.map(value => JSON.stringify(value)).join('\n') + '\n');
  const report = f.exportReport();
  assert.equal(report.events.truncated, true);
  assert.equal(report.events.entries.length, diagnostics.MAX_EVENTS);
  assert.equal(report.events.entries[0].sequence, 6);
  assert.equal(report.events.entries.at(-1).sequence, diagnostics.MAX_EVENTS + 5);
  assert.ok(fs.statSync(f.output).size <= diagnostics.MAX_OUTPUT_BYTES);
  assertPrivate(report, f);
});

test('diagnostics rejects malformed and forbidden event fields instead of echoing them', () => {
  for (const invalid of [null, [], {}, event({ schema: SECRET_NAME }), event({ event: SECRET_NAME }),
    event({ hostPid: 0 }), event({ hostPid: '123' }), event({ sequence: 0 }), event({ sequence: Infinity }),
    event({ timeMs: NaN }), event({ elapsedMs: -1 }), event({ value: 0.1 }), event({ code: null }),
    event({ message: SECRET_CONTENT }), event({ importedName: SECRET_NAME }), event({ token: SECRET_TOKEN }),
    event({ endpoint: SECRET_URL }), event({ path: '/private/path' }),
    event({ event: 'service_failure', value: -1 }), event({ event: 'service_failure', value: 10 })]) {
    assert.equal(diagnostics.sanitizeEvent(invalid), null);
  }
  assert.deepEqual(diagnostics.sanitizeEvent(event({ event: 'service_failure', value: 9 })),
    event({ event: 'service_failure', value: 9 }));
  assert.equal(diagnostics.sanitizeEvent(event({ code: SECRET_TOKEN })).code, 'UNKNOWN');
  for (const code of ['KEY_MISSING_EXISTING_DATABASE', 'PROVIDER_UNAUTHORIZED', 'PROVIDER_AUTH_FAILED',
    'PROVIDER_RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE', 'PROVIDER_CONNECTION_FAILED',
    'PROVIDER_INVALID_RESPONSE', 'PROVIDER_INVALID_RESPONSE_SCHEMA', 'PROVIDER_EMPTY_RESPONSE',
    'PROVIDER_REASONING_ONLY_RESPONSE', 'PROVIDER_OUTPUT_TRUNCATED', 'PROVIDER_CONTENT_FILTERED',
    'PROVIDER_TOOL_ONLY_RESPONSE', 'PROVIDER_REJECTED', 'PROVIDER_FAILURE']) {
    const safe = event({ event: 'service_failure', code, value: 1 });
    assert.deepEqual(diagnostics.sanitizeEvent(safe), safe);
  }
  assert.equal(diagnostics.sanitizeEvent(event({ event: 'service_failure', code: 'provider_timeout', value: 0 })).code, 'UNKNOWN');
});

test('diagnostics fails with fixed codes and no output for unsafe runtime or inaccessible workspace', t => {
  const f = fixture(t);
  for (const runtime of [{ ...f.runtime, candidate: SECRET_URL }, { ...f.runtime, candidate: '.' },
    { ...f.runtime, candidate: '..' }, { ...f.runtime, sourceHead: SECRET_TOKEN }, null]) {
    assert.throws(() => f.exportReport({ runtime }), error => error.message === 'PREVIEW_DIAGNOSTICS_RUNTIME_INVALID');
    assert.ok(!fs.existsSync(f.output));
  }
  assert.throws(() => f.exportReport({ workspace: path.join(f.scratch, SECRET_NAME) }),
    error => error.message === 'PREVIEW_DIAGNOSTICS_FAILED');
  assert.ok(!fs.existsSync(f.output));
});

function promoteSnapshotV2(value, kind = 'upgrade') {
  const manifest = value.manifest;
  manifest.schema = 'reverie.preview.snapshot.v2'; manifest.kind = kind;
  manifest.dataIdentity = { ...manifest.from };
  manifest.files = manifest.files.map(file => ({ ...file, type: 'regular', sourceLinkCount: '2' }));
  if (kind === 'pre-restore') {
    manifest.to = { ...manifest.from };
    manifest.transitionSha256 = hash(sortedJson({ fromReadyId: manifest.fromReadyId, from: manifest.from, to: manifest.to }));
    const name = `pre-restore-${manifest.createdAt}-${manifest.dataIdentity.candidate.slice(0, 32)}-1234abcd`;
    const directory = path.join(path.dirname(value.directory), name);
    fs.renameSync(value.directory, directory);
    value.directory = directory; value.name = name;
    value.dataFile = path.join(directory, manifest.files[0].path); value.manifestFile = path.join(directory, 'manifest.json');
    manifest.name = name;
  }
  fs.writeFileSync(value.manifestFile, JSON.stringify(manifest));
  return value;
}

test('diagnostics verifies v2 upgrade manifests while keeping copied hard links independent', t => {
  const f = fixture(t), value = promoteSnapshotV2(f.snapshot());
  const original = fs.readFileSync(value.dataFile), manifestBytes = fs.readFileSync(value.manifestFile);
  const report = f.exportReport();
  assert.deepEqual(report.snapshots.entries, [{ name: value.name, kind: 'upgrade', bytes: value.body.length,
    fileCount: 1, checkStatus: 'verified' }]);
  assert.equal(fs.statSync(value.dataFile).nlink, 1);
  assert.deepEqual(fs.readFileSync(value.dataFile), original);
  assert.deepEqual(fs.readFileSync(value.manifestFile), manifestBytes);
  assertPrivate(report, f);
});

test('diagnostics recognizes the separate pre-restore snapshot kind and naming contract', t => {
  const f = fixture(t), value = promoteSnapshotV2(f.snapshot(), 'pre-restore');
  const report = f.exportReport();
  assert.equal(report.snapshots.unmanagedCount, 0);
  assert.deepEqual(report.snapshots.entries, [{ name: value.name, kind: 'pre-restore', bytes: value.body.length,
    fileCount: 1, checkStatus: 'verified' }]);
  assertPrivate(report, f);
});

test('diagnostics rejects malformed v2 kind, identity and source-link metadata without disclosing names', t => {
  const f = fixture(t), value = promoteSnapshotV2(f.snapshot());
  for (const mutate of [
    manifest => { manifest.kind = SECRET_NAME; },
    manifest => { manifest.dataIdentity = { ...manifest.to }; },
    manifest => { manifest.files[0].type = 'symlink'; },
    manifest => { manifest.files[0].sourceLinkCount = '0'; },
    manifest => { manifest.files[0].sourceLinkCount = 2; },
    manifest => { manifest.files[0].sourceLinkCount = '18446744073709551616'; },
    manifest => { manifest.schema = 'reverie.preview.snapshot.v3'; },
  ]) {
    const malformed = JSON.parse(JSON.stringify(value.manifest)); mutate(malformed);
    assert.throws(() => diagnostics.snapshotMetadata(value.name, Buffer.from(JSON.stringify(malformed))), /PREVIEW_DIAGNOSTICS_UNSAFE/);
  }
});

test('diagnostics preserves all fixed snapshot failure categories and accepts business source hard links', t => {
  const f = fixture(t), original = f.put(`data/${SECRET_NAME}.json`, SECRET_CONTENT);
  fs.linkSync(original, path.join(f.workspace, 'data', 'synthetic-second-name.json'));
  const codes = ['PREVIEW_SNAPSHOT_NO_SPACE', 'PREVIEW_SNAPSHOT_SPECIAL_FILE', 'PREVIEW_SNAPSHOT_ENTRY_LIMIT',
    'PREVIEW_SNAPSHOT_SOURCE_CHANGED', 'PREVIEW_SNAPSHOT_VERIFY_FAILED', 'PREVIEW_SNAPSHOT_IO_FAILED',
    'PREVIEW_DATA_FORMAT_TOO_NEW', 'PREVIEW_RESTORE_RECOVERY_REQUIRED'];
  f.put(diagnostics.EVENT_FILE, codes.map((code, index) => JSON.stringify(event({ event: 'snapshot_failed', code,
    sequence: index + 1 }))).join('\n') + '\n');
  const report = f.exportReport();
  assert.deepEqual(report.events.entries.map(entry => entry.code), codes);
  const summary = report.directories.find(entry => entry.name === 'data');
  assert.equal(summary.status, 'ok'); assert.equal(summary.fileCount, 2); assert.equal(summary.bytes, Buffer.byteLength(SECRET_CONTENT) * 2);
  assertPrivate(report, f);
});
