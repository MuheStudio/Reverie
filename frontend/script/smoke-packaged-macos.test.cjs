'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildInventory, treeManifest, verifySuccessfulBuild, resolvePackageInputs,
  appendApplicationLog, summarizeDebuggerTargets, detachOwnedMount, finalizePackageAcceptance, validateReportDestination, modelMessageText, fakeProviderReply,
  archiveRequest, worldbookBaseArchive, worldbookFixture, assertWorldbookPrompt, worldbookRecordIdentity, assertWorldbookWorkers,
  summaryRequest, assertMessages, waitForDisplayedMessages, startFakeProvider, summaryValidatorRevision } = require('./smoke-packaged-macos.cjs');
const summaryContract = require('./summary-package-contract.cjs');

function fixture(t, { withSymlink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-build-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'Reverie macOS Test.app');
  const resources = path.join(appRoot, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const candidate = { head: 'synthetic-test-commit', files: [{ path: 'src/main.py', sha256: 'a'.repeat(64), bytes: 1 }] };
  candidate.sha256 = crypto.createHash('sha256').update(JSON.stringify(candidate.files)).digest('hex');
  const embedded = { schema: 'reverie.macos-build-candidate.v1', sourceSha256: candidate.sha256,
    gitHead: candidate.head, transport: 'framed-stdio-v4', profile: 'independent-core-local-test', live2dCoreBundled: false };
  fs.writeFileSync(path.join(resources, 'BUILD-CANDIDATE.json'), JSON.stringify(embedded));
  fs.writeFileSync(path.join(resources, 'payload.bin'), 'abc');
  fs.writeFileSync(path.join(resources, 'other.bin'), 'xyz');
  if (withSymlink) fs.symlinkSync('payload.bin', path.join(resources, 'alias'));
  const manifestPath = path.join(root, 'macos-build.json');
  const manifest = { schema: 'reverie.macos-build.v1', architecture: 'arm64', appPath: appRoot,
    startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
    timings: [{ name: 'Build', passed: true }], runtimeAudit: { ok: true }, appNativeAudit: { ok: true },
    signing: { identity: 'ad-hoc', hardenedRuntime: true }, candidate,
    bundle: buildInventory(treeManifest(appRoot)) };
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  write();
  const identity = { appRoot, resources, appId: 'com.muhe.reverie.macos.test' };
  return { root, appRoot, resources, candidate, embedded, manifestPath, manifest, identity, write,
    verify: () => verifySuccessfulBuild(identity, manifestPath, treeManifest(appRoot)) };
}

test('accepts only the exact successful bundle, including when relocated', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().matched, true);
  const moved = path.join(f.root, '仓库外 目录', 'Renamed Test.app');
  fs.cpSync(f.appRoot, moved, { recursive: true, verbatimSymlinks: true });
  const identity = { ...f.identity, appRoot: moved, resources: path.join(moved, 'Contents', 'Resources') };
  assert.equal(verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)).sourceSha256, f.candidate.sha256);
});

test('rejects an app left by a failed build with no successful manifest', (t) => {
  const f = fixture(t); fs.unlinkSync(f.manifestPath);
  assert.throws(f.verify, /ENOENT/);
});

for (const [label, change] of [
  ['unfinished manifest', (m) => { delete m.completedAt; }],
  ['failed phase', (m) => { m.timings[0].passed = false; }],
  ['failed result', (m) => { m.success = false; }],
  ['failed runtime audit', (m) => { m.runtimeAudit.ok = false; }],
  ['failed whole-app audit', (m) => { m.appNativeAudit.ok = false; }],
  ['source inventory digest mismatch', (m) => { m.candidate.sha256 = 'b'.repeat(64); }],
  ['signed bundle digest mismatch', (m) => { m.bundle.sha256 = 'b'.repeat(64); }],
]) {
  test(`rejects ${label}`, (t) => { const f = fixture(t); change(f.manifest); f.write(); assert.throws(f.verify); });
}

test('rejects a different embedded source candidate even with a self-consistent build manifest', (t) => {
  const f = fixture(t);
  f.embedded.sourceSha256 = 'c'.repeat(64);
  fs.writeFileSync(path.join(f.resources, 'BUILD-CANDIDATE.json'), JSON.stringify(f.embedded));
  assert.throws(f.verify, /different source candidate/);
});

for (const [label, mutate] of [
  ['changed bytes with unchanged length', (f) => fs.writeFileSync(path.join(f.resources, 'payload.bin'), 'def')],
  ['changed file length', (f) => fs.appendFileSync(path.join(f.resources, 'payload.bin'), 'more')],
  ['unexpected file', (f) => fs.writeFileSync(path.join(f.resources, 'unexpected'), 'new')],
  ['missing file', (f) => fs.unlinkSync(path.join(f.resources, 'other.bin'))],
]) {
  test(`rejects stale build inventory: ${label}`, (t) => {
    const f = fixture(t); mutate(f); assert.throws(f.verify, /differ from the successful signed build/);
  });
}

test('preserves POSIX symlinks on relocation and rejects a changed target', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t, { withSymlink: true });
  assert.equal(f.verify().matched, true);
  const moved = path.join(f.root, '仓库外 链接目录', 'Renamed Test.app');
  fs.cpSync(f.appRoot, moved, { recursive: true, verbatimSymlinks: true });
  const identity = { ...f.identity, appRoot: moved, resources: path.join(moved, 'Contents', 'Resources') };
  assert.equal(verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)).matched, true);
  const alias = path.join(identity.resources, 'alias');
  assert.equal(fs.readlinkSync(alias), 'payload.bin');
  fs.unlinkSync(alias);
  fs.symlinkSync('other.bin', alias);
  assert.throws(() => verifySuccessfulBuild(identity, f.manifestPath, treeManifest(moved)),
    /differ from the successful signed build/);
});

test('rejects a different application identity', (t) => {
  const f = fixture(t); f.identity.appId = 'example.unrelated'; assert.throws(f.verify);
});

test('default input uses the successful package pointer outside Documents', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.package-smoke-macos'));
  const latest = { appPath: path.resolve('/Users/example/Library/Developer/Reverie/LocalBuilds/test/mac-arm64/Reverie macOS Test.app'),
    buildManifest: path.join(f.root, 'release-macos', 'macos-build.json') };
  fs.writeFileSync(path.join(f.root, '.package-smoke-macos', 'latest-package.json'), JSON.stringify(latest));
  assert.deepEqual(resolvePackageInputs([], f.root), { appPath: latest.appPath, manifestPath: latest.buildManifest });
  assert.deepEqual(resolvePackageInputs(['--manifest', f.manifestPath], f.root), { appPath: latest.appPath, manifestPath: f.manifestPath });
});

test('missing latest pointer does not fall back to a leftover Documents app', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'release-macos', 'mac-arm64', 'Reverie macOS Test.app'), { recursive: true });
  assert.throws(() => resolvePackageInputs([], f.root), /ENOENT/);
});

test('explicit relocated app binds the repo manifest or an explicit manifest', (t) => {
  const f = fixture(t);
  const relocated = path.join(f.root, '含空格 目录', 'Reverie macOS Test.app');
  assert.deepEqual(resolvePackageInputs(['--app', relocated], f.root), {
    appPath: relocated, manifestPath: path.join(f.root, 'release-macos', 'macos-build.json'),
  });
  assert.deepEqual(resolvePackageInputs(['--app', relocated, '--manifest', f.manifestPath], f.root), {
    appPath: relocated, manifestPath: f.manifestPath,
  });
});

test('relative or incomplete latest package pointers are rejected', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.package-smoke-macos'));
  const pointer = path.join(f.root, '.package-smoke-macos', 'latest-package.json');
  fs.writeFileSync(pointer, JSON.stringify({ appPath: 'old/Test.app', buildManifest: f.manifestPath }));
  assert.throws(() => resolvePackageInputs([], f.root), /absolute app path/);
  fs.writeFileSync(pointer, JSON.stringify({ appPath: f.appRoot }));
  assert.throws(() => resolvePackageInputs([], f.root), /absolute build manifest/);
});

test('owned application output is available during startup and keeps the original stream', (t) => {
  const f = fixture(t), logPath = path.join(f.root, 'normal-1.log');
  const running = { logs: [], logPath };
  appendApplicationLog(running, Buffer.from('DevTools listening\n'));
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'DevTools listening\n');
  appendApplicationLog(running, 'main-ready\n');
  assert.equal(fs.readFileSync(logPath, 'utf8'), running.logs.join(''));
  assert.equal(running.logError, undefined);
});

test('live log failure stays observable without throwing from stream callbacks', () => {
  const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const running = { logs: [], logPath: '/synthetic/log' }; let calls = 0;
  const write = () => { calls += 1; throw error; };
  assert.doesNotThrow(() => appendApplicationLog(running, 'first', write));
  appendApplicationLog(running, 'second', write);
  assert.equal(running.logError, error); assert.equal(calls, 1);
  assert.deepEqual(running.logs, ['first', 'second']);
});

test('startup target diagnostics omit titles, credentials, URL paths and secrets and bound the list', () => {
  const targets = [{ type: 'page', url: 'reverie-app://app/index.html', title: 'private title' },
    { type: 'page', url: 'https://name:password@example.test/private/token?secret=secret#fragment', title: 'other private title' },
    ...Array.from({ length: 20 }, () => ({ type: 'worker', url: 'not a URL' }))];
  const summary = summarizeDebuggerTargets(targets);
  assert.equal(summary.length, 10); assert.equal(summary[0].productionUrl, true);
  assert.deepEqual(summary[1], { type: 'page', scheme: 'https:', origin: 'https://example.test', productionUrl: false });
  assert.doesNotMatch(JSON.stringify(summary), /password|private|secret|fragment|token/);
});

test('detach retries the exact owned mount with bounded backoff and never forces', async () => {
  const target = path.resolve('/synthetic/owned mount'), calls = [], waits = [], attempts = [];
  await detachOwnedMount(target, { attempts, wait: async ms => waits.push(ms), invoke: (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length < 3) throw new Error('resource busy');
  } });
  assert.equal(calls.length, 3); assert.deepEqual(waits, [1000, 2000]);
  for (const call of calls) assert.deepEqual(call, { command: '/usr/bin/hdiutil', args: ['detach', target], options: { timeout: 30_000 } });
  assert.deepEqual(attempts.map(item => item.passed), [false, false, true]);
});

test('detach stops after its third failure and never retries a successful detach', async () => {
  const target = path.resolve('/synthetic/owned mount'), attempts = [];
  const error = new Error('resource busy'); let calls = 0;
  await assert.rejects(detachOwnedMount(target, { attempts, wait: async () => {}, invoke: () => { calls += 1; throw error; } }),
    value => value === error);
  assert.equal(calls, 3); assert.equal(attempts.length, 3);
  calls = 0;
  await detachOwnedMount(target, { invoke: () => { calls += 1; }, wait: () => { throw new Error('unexpected wait'); } });
  assert.equal(calls, 1);
  await assert.rejects(detachOwnedMount('relative', { invoke: () => { throw new Error('must not run'); } }), /exact owned mount/);
});

test('package report failures cannot skip remaining processes, provider close, integrity or detach', async () => {
  const calls = [], report = { passed: true }; let mounted = true;
  const result = await finalizePackageAcceptance({ active: [{ label: 'first', logs: ['first'] }, { label: 'second', logs: ['second'] }],
    session: {}, mount: { get mounted() { return mounted; }, detach() { calls.push('detach'); mounted = false; } },
    runRoot: '/synthetic/scratch', outputRoot: '/synthetic/report', report, started: Date.now(),
    verifyIntegrity: () => calls.push('integrity'),
  }, {
    cleanupApplication: async running => calls.push(`stop:${running.label}`), closeSession: async () => calls.push('close-provider'),
    writeFile: file => { calls.push(`write:${path.basename(file)}`); throw new Error('disk full'); },
    removeScratch: () => calls.push('remove-scratch'), exists: () => false,
  });
  assert.deepEqual(calls, ['stop:second', 'write:second.log', 'stop:first', 'write:first.log',
    'close-provider', 'integrity', 'detach', 'remove-scratch', 'write:report.json']);
  assert.equal(report.passed, false); assert.equal(report.noResidualMounts, true);
  assert.equal(report.noResidualProcesses, true); assert.equal(report.scratchRemoved, true);
  assert.equal(result.reportWritten, false);
  assert.deepEqual(result.errors.map(item => item.name), ['log:second', 'log:first', 'final-report-write']);
});

test('a recovered report filesystem does not hide an earlier live-log failure', async () => {
  const report = { passed: true }, logError = new Error('earlier disk full');
  const result = await finalizePackageAcceptance({ active: [{ label: 'app', logs: ['kept in memory'], logError }], session: null,
    mount: { mounted: false, detach() {} }, runRoot: '/synthetic/scratch', outputRoot: '/synthetic/report', report,
    started: Date.now(), verifyIntegrity() {},
  }, { cleanupApplication: async () => {}, closeSession: async () => {}, writeFile() {}, removeScratch() {}, exists: () => false });
  assert.equal(report.passed, false); assert.equal(result.reportWritten, true);
  assert.deepEqual(result.errors.map(item => item.name), ['live-log:app']);
  assert.equal(result.errors[0].error, logError);
});

for (const failedResource of ['process', 'mount']) test(`${failedResource} cleanup failure preserves scratch and continues all other cleanup`, async () => {
  const calls = [], report = { passed: true }; let mounted = true;
  const result = await finalizePackageAcceptance({ active: [{ label: 'app', logs: [] }], session: {},
    mount: { get mounted() { return mounted; }, detach() {
      calls.push('detach'); if (failedResource === 'mount') throw new Error('busy volume'); mounted = false;
    } }, runRoot: '/synthetic/scratch', outputRoot: '/synthetic/report', report, started: Date.now(),
    verifyIntegrity: () => calls.push('integrity'),
  }, {
    cleanupApplication: async () => { calls.push('stop'); if (failedResource === 'process') throw new Error('process remains'); },
    closeSession: async () => calls.push('close-provider'), writeFile: file => calls.push(`write:${path.basename(file)}`),
    removeScratch: () => calls.push('must-not-remove'), exists: () => true,
  });
  assert.equal(report.passed, false); assert.equal(result.reportWritten, true);
  assert.equal(report.noResidualProcesses, failedResource !== 'process');
  assert.equal(report.noResidualMounts, failedResource !== 'mount');
  assert.deepEqual(calls, ['stop', 'write:app.log', 'close-provider', 'integrity', 'detach', 'write:report.json']);
});


test('package reports cannot be written into an application or case-variant bundle', t => {
  const f = fixture(t);
  for (const suffix of ['Reverie.app', 'Reverie.APP', 'Reverie.App']) {
    const destination = path.join(f.root, suffix, 'Contents', 'reports', 'new-run');
    assert.throws(() => validateReportDestination(destination), /inside an application/);
    assert.equal(fs.existsSync(destination), false);
  }
});

test('package report output cannot use a link into an application', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), link = path.join(f.root, 'report-alias');
  fs.symlinkSync(f.appRoot, link);
  const destination = path.join(link, 'reports', 'new-run');
  assert.throws(() => validateReportDestination(destination), /resolves through an application/);
  assert.equal(fs.existsSync(path.join(f.appRoot, 'reports')), false);
});

test('ordinary external package report paths remain valid without preflight creating files', t => {
  const f = fixture(t), destination = path.join(f.root, 'new-report-parent', 'new-run');
  assert.doesNotThrow(() => validateReportDestination(destination));
  assert.equal(fs.existsSync(destination), false);
});


test('worldbook fixture replies depend only on the current user turn, preserving the baseline token reply', () => {
  const baseline = fakeProviderReply({ messages: [{ role: 'user', content: 'ordinary baseline' }] });
  assert.match(baseline, /^\d{12}$/);
  assert.equal(fakeProviderReply({ messages: [{ role: 'user', content: 'WB fixture: earlier' },
    { role: 'assistant', content: 'WB fixture reply' }, { role: 'user', content: 'ordinary baseline' }] }), baseline);
  assert.equal(fakeProviderReply({ messages: [{ role: 'user', content: [{ type: 'text', text: 'WB fixture: current' }] }] }), 'WB fixture reply');
  assert.equal(modelMessageText([{ type: 'image_url', image_url: { url: 'private' } }, { text: 'text' }]), '\ntext');
});

test('worldbook prompt checks examine the actual system prompt, never a marker in conversation history', () => {
  const body = { messages: [{ role: 'system', content: 'normal instructions' }, { role: 'user', content: 'WB_CURRENT_A' }] };
  assert.throws(() => assertWorldbookPrompt({ body }, ['WB_CURRENT_A']), /marker missing/);
  body.messages[0].content = [{ type: 'text', text: 'World: WB_CURRENT_A' }];
  assert.doesNotThrow(() => assertWorldbookPrompt({ body }, ['WB_CURRENT_A'], ['WB_CURRENT_B']));
  assert.throws(() => assertWorldbookPrompt({ body }, [], ['WB_CURRENT_A']), /Stale\/failed/);
});

test('fixture uses stable book and entry identities, single-message scanning and a deterministic restart fingerprint', () => {
  const book = worldbookFixture();
  assert.equal(book.scanDepth, 1); assert.equal(book.recursiveScanning, false);
  assert.equal(book.entries[0].scanDepth, 1); assert.equal(book.entries[0].alwaysActive, false);
  const record = { ok: true, persona_id: 'test-persona', revision: 7, checksum: 'a'.repeat(64), archive: { worldBooks: [book] } };
  const identity = worldbookRecordIdentity(record, book.id);
  assert.deepEqual(worldbookRecordIdentity(structuredClone(record), book.id), identity);
  record.archive.worldBooks[0].entries[0].content = 'changed';
  assert.notDeepEqual(worldbookRecordIdentity(record, book.id), identity);
  record.revision = undefined;
  assert.throws(() => worldbookRecordIdentity(record, book.id));
});

test('packaged worker evidence requires a real timeout, subsequent reaps and package-contained executables', () => {
  const pythonRoot = path.resolve('/synthetic/package/python'), executable = path.join(pythonRoot, 'bin', 'python3.12');
  const logs = [
    `INFO worldbook_regex_spawn pid=123 executable=${executable}`,
    `WARNING worldbook_regex_timeout pid=123 executable=${executable}`,
    `INFO worldbook_regex_reap pid=123 executable=${executable}`,
    `INFO worldbook_regex_spawn pid=124 executable=${executable}`,
    `INFO worldbook_regex_reap pid=124 executable=${executable}`,
  ].join('\n');
  assert.deepEqual(assertWorldbookWorkers(logs, pythonRoot, []), {
    spawned: 2, timeoutRecorded: true, allReaped: true, externalInterpreter: false, pids: [123, 124],
  });
  assert.throws(() => assertWorldbookWorkers(logs, pythonRoot, [{ pid: 123, name: executable }]), /still running/);
  assert.throws(() => assertWorldbookWorkers(logs.replace('worldbook_regex_reap pid=123', 'missing_reap pid=123'), pythonRoot, []), /not reaped/);
  assert.throws(() => assertWorldbookWorkers(logs.replace('worldbook_regex_timeout', 'other_timeout'), pythonRoot, []), /Timed-out regex worker/);
  assert.throws(() => assertWorldbookWorkers(logs.replaceAll(executable, path.resolve('/system/python')), pythonRoot, []), /external interpreter/);
});

test('archive requests correlate the real V4 request ID and dispose subscriptions after success or error', async () => {
  const vm = require('node:vm');
  for (const fail of [false, true]) {
    let listener, disposed = 0, sent;
    const context = vm.createContext({ setTimeout, clearTimeout, window: { electronAPI: { bridge: {
      onMessage(callback) { listener = callback; return () => { disposed += 1; listener = null; }; },
      async send(frame) {
        sent = frame;
        listener({ type: 'archive:result', request_id: 'unrelated', payload: { ok: true, revision: 999 } });
        listener({ type: 'archive:result', request_id: frame.request_id, payload: fail
          ? { ok: false, code: 'conflict' } : { ok: true, revision: 3 } });
      },
    } } } });
    const cdp = { async call(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      const value = await vm.runInContext(params.expression, context);
      return { result: { value } };
    } };
    if (fail) await assert.rejects(archiveRequest(cdp, 'archive:put', { archive: {}, expected_revision: 2 }), /conflict/);
    else assert.equal((await archiveRequest(cdp, 'archive:get')).revision, 3);
    assert.match(sent.request_id, /^worldbook-archive-/); assert.equal(disposed, 1);
  }
});


test('an uninitialized authoritative archive starts the isolated fixture at revision zero without replacing invalid existing data', () => {
  const uninitialized = { ok: true, exists: false, revision: 0, archive: null };
  assert.deepEqual(worldbookBaseArchive(uninitialized), { characters: [], activeCharacterIds: [], worldBooks: [] });
  assert.equal(uninitialized.revision, 0); assert.equal(uninitialized.archive, null);
  for (const record of [{ ok: false, exists: false, archive: null }, { ok: true, exists: true, archive: null },
    { ok: true, exists: true, archive: {} }]) assert.throws(() => worldbookBaseArchive(record));
  const present = { ok: true, exists: true, archive: { characters: [], activeCharacterIds: [], worldBooks: [worldbookFixture()] } };
  const copied = worldbookBaseArchive(present); copied.worldBooks[0].name = 'changed fixture';
  assert.notEqual(copied.worldBooks[0].name, present.archive.worldBooks[0].name);
});

function summaryStatusFixture() {
  return { ok: true, persona_id: 'synthetic-persona', status: 'ready', running: false, enabled: true, authorized: true,
    attempts: { completed: 1 }, lastAttempt: { status: 'completed' }, activeCount: 1, summaryTotal: 1, hasMore: false, legacyInactiveCount: 0,
    summaries: [{ summary_id: 'summary-fixture', sourceDigest: 'a'.repeat(64), firstSequence: 1, lastSequence: 2,
      messageIds: ['old-user', 'old-assistant'], contractVersion: 'reverie.conversation-summary.v1' }] };
}
function summaryRequestFixture() {
  return { body: { messages: [{ role: 'system', content: '为同一会话的较早消息撰写一段简洁背景摘要。' },
    { role: 'user', content: JSON.stringify({ messages: [
      { id: 'old-user', role: 'user', text: 'older user input' },
      { id: 'old-assistant', role: 'assistant', text: 'older assistant reply' },
    ] }) }] } };
}
function summaryHistoryFixture() {
  return { items: [{ id: 'old-user', role: 'user', content: 'older user input' },
    { id: 'old-assistant', role: 'assistant', content: 'older assistant reply' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `recent-${i}`, role: i % 2 ? 'assistant' : 'user', content: `recent ${i}` }))] };
}

test('package validator revision binds the separate summary assertion helper bytes', () => {
  const revision = summaryValidatorRevision();
  assert.equal(revision.script, 'frontend/script/summary-package-contract.cjs');
  assert.equal(revision.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'summary-package-contract.cjs'))).digest('hex'));
});

test('fake summary provider distinguishes background summaries, fixture chats and the original core token', () => {
  assert.equal(fakeProviderReply(summaryRequestFixture().body), summaryContract.SUMMARY_REPLY);
  assert.equal(fakeProviderReply({ messages: [{ role: 'user', content: 'CS fixture: current input' }] }), summaryContract.CHAT_REPLY);
  assert.equal(summaryContract.isSummaryRequest({ messages: [{ role: 'user', content: '为同一会话的较早消息' }] }), false);
  const baseline = fakeProviderReply({ messages: [{ role: 'user', content: 'ordinary core input' }] });
  assert.match(baseline, /^\d+$/);
  assert.equal(fakeProviderReply({ messages: [{ role: 'user', content: 'CS fixture: old history' },
    { role: 'user', content: 'ordinary core input' }] }), baseline);
});

test('fourteen actual fixture exchanges exceed the unchanged older-history threshold', () => {
  const history = { items: [{ id: 'core-user', role: 'user', content: 'core' }, { id: 'core-assistant', role: 'assistant', content: 'core' }] };
  for (let i = 1; i <= 14; i += 1) history.items.push({ id: `user-${i}`, role: 'user', content: summaryContract.historyTurn(i) },
    { id: `assistant-${i}`, role: 'assistant', content: summaryContract.CHAT_REPLY });
  assert.equal(history.items.length, 30);
  const result = summaryContract.assertEnoughHistory({ pendingBudget: 2401 }, history);
  assert.ok(result.olderCharacters > 4000); assert.equal(result.recentMessagesRetained, 20);
  assert.throws(() => summaryContract.assertEnoughHistory({ pendingBudget: 2000 }, history), /genuine summary threshold/);
  assert.throws(() => summaryContract.assertEnoughHistory({ pendingBudget: 2401 }, { items: history.items.slice(-20) }), /no older messages/);
});

test('default-off and feature-only evidence requires no stored attempt and no observed model call', () => {
  const status = { ok: true, enabled: false, authorized: false, running: false, attempts: {}, activeCount: 0 };
  summaryContract.assertNoSummaryWork(status, { requests: [] }, false);
  summaryContract.assertNoSummaryWork({ ...status, enabled: true }, { requests: [] }, true);
  assert.throws(() => summaryContract.assertNoSummaryWork(status, { requests: [summaryRequestFixture()] }, false), /contacted the model/);
  assert.throws(() => summaryContract.assertNoSummaryWork({ ...status, attempts: { started: 1 } }, { requests: [] }, false));
});

test('actual next-turn system prompt must contain the generated block and exclude all legacy content', () => {
  const request = { body: { messages: [{ role: 'system', content: `<conversation_summaries>\n${summaryContract.SUMMARY_REPLY}\n</conversation_summaries>` }] } };
  summaryContract.assertPrompt(request, true);
  assert.throws(() => summaryContract.assertPrompt(request, false));
  request.body.messages[0].content += summaryContract.LEGACY_MARKER;
  assert.throws(() => summaryContract.assertPrompt(request, true), /legacy summary entered/);
  assert.throws(() => summaryContract.assertPrompt(summaryRequestFixture(), true), /actual next chat request/);
});

test('generated summary source IDs bind to committed history outside the latest twenty messages', () => {
  const status = summaryStatusFixture(), request = summaryRequestFixture(), history = summaryHistoryFixture();
  const result = summaryContract.assertGeneratedSource(status, { requests: [request] }, history);
  assert.deepEqual(result.summaries[0].messageIds, ['old-user', 'old-assistant']);
  assert.deepEqual(result.attempts, { completed: 1 });
  assert.throws(() => summaryContract.assertGeneratedSource(status, { requests: [request, request] }, history), /exactly one/);
});

test('a committed summary remains usable during production cooldown without weakening source or attempt checks', () => {
  const ready = summaryStatusFixture(), cooling = { ...structuredClone(ready), status: 'cooldown',
    cooldownSeconds: 300, cooldownRemainingSeconds: 299.5 };
  assert.deepEqual(summaryContract.summaryIdentity(cooling), summaryContract.summaryIdentity(ready));
  assert.deepEqual(summaryContract.assertGeneratedSource(cooling, { requests: [summaryRequestFixture()] }, summaryHistoryFixture()),
    summaryContract.summaryIdentity(ready));
});

for (const [name, mutate] of [
  ['failed last attempt', status => { status.lastAttempt.status = 'failed'; }],
  ['unknown last attempt', status => { status.lastAttempt.status = 'started'; }],
  ['missing last attempt', status => { delete status.lastAttempt; }],
  ['no active summary', status => { status.activeCount = 0; }],
  ['missing persisted identity', status => { status.summaries = []; }],
  ['running work', status => { status.running = true; }],
]) {
  test(`cooldown cannot conceal ${name}`, () => {
    const status = { ...summaryStatusFixture(), status: 'cooldown' }; mutate(status);
    assert.throws(() => summaryContract.summaryIdentity(status));
  });
}

for (const state of ['failed', 'outcome_unknown', 'unauthorized', 'disabled']) {
  test(`${state} is not accepted merely because an old completed summary is present`, () => {
    assert.throws(() => summaryContract.summaryIdentity({ ...summaryStatusFixture(), status: state }), /No completed summary/);
  });
}

for (const [name, mutate] of [
  ['source message outside ledger', history => { history.items[0].id = 'different'; }],
  ['source message content changed', history => { history.items[0].content = 'changed'; }],
  ['source entered protected recent window', history => { history.items.pop(); }],
]) {
  test(`summary source check rejects ${name}`, () => {
    const history = summaryHistoryFixture(); mutate(history);
    assert.throws(() => summaryContract.assertGeneratedSource(summaryStatusFixture(), { requests: [summaryRequestFixture()] }, history));
  });
}

for (const [name, mutate] of [
  ['unfinished background task', status => { status.running = true; }],
  ['extra generation attempt', status => { status.attempts.completed = 2; }],
  ['unknown attempt outcome', status => { status.attempts.started = 1; }],
  ['missing source IDs', status => { status.summaries[0].messageIds = []; }],
  ['duplicate source IDs', status => { status.summaries[0].messageIds.push('old-user'); }],
  ['truncated identity list', status => { status.hasMore = true; }],
  ['invalid digest', status => { status.summaries[0].sourceDigest = ''; }],
]) {
  test(`restart summary identity refuses ${name}`, () => {
    const status = summaryStatusFixture(); mutate(status); assert.throws(() => summaryContract.summaryIdentity(status));
  });
}

test('legacy UI preview and import remain digest-bound, unattributed and inactive', () => {
  const content = summaryContract.legacyFixture();
  const value = { ok: true, sha256: crypto.createHash('sha256').update(content).digest('hex'),
    total: 1, linked: 0, unattributed: 1, active: 0 };
  summaryContract.assertLegacyResult(value, content, false);
  summaryContract.assertLegacyResult({ ...value, imported: 1, reused: false }, content, true);
  assert.throws(() => summaryContract.assertLegacyResult({ ...value, active: 1 }, content, false));
  assert.throws(() => summaryContract.assertLegacyResult(value, `${content} `, false));
  assert.throws(() => summaryContract.assertLegacyResult({ ...value, linked: 1, unattributed: 0 }, content, false));
  assert.throws(() => summaryContract.assertLegacyResult({ ...value, entries: [{ text: 'internal data' }] }, content, false));
});

test('summary scenario preserves the unique core conversation assertion and captures all restart IDs', () => {
  const token = fakeProviderReply({ messages: [] });
  const history = { items: [{ id: 'core-user', role: 'user', content: `应用包验收 ${token}` },
    { id: 'core-assistant', role: 'assistant', content: token },
    { id: 'summary-chat-user', role: 'user', content: 'CS fixture: input' },
    { id: 'summary-chat-assistant', role: 'assistant', content: summaryContract.CHAT_REPLY }] };
  assert.equal(assertMessages(history).length, 2);
  assert.equal(summaryContract.historyIdentity(history).length, 4);
  assert.throws(() => summaryContract.historyIdentity({ items: [...history.items, history.items[0]] }), /Duplicate persisted/);
  assert.throws(() => assertMessages({ items: [...history.items, { id: 'duplicate', role: 'assistant', content: token }] }), /missing or duplicated/);
});

test('UI restoration checks repeated fixture reply multiplicity without weakening core bubble checks', async () => {
  const vm = require('node:vm');
  const expected = [{ id: '1', role: 'user', content: 'first' }, { id: '2', role: 'assistant', content: summaryContract.CHAT_REPLY },
    { id: '3', role: 'user', content: 'second' }, { id: '4', role: 'assistant', content: summaryContract.CHAT_REPLY }];
  const context = vm.createContext({ document: { querySelectorAll: () => expected.map(item => ({
    dataset: { role: item.role }, querySelector: () => ({ textContent: item.content }),
  })) } });
  const cdp = { async call(method, params) {
    assert.equal(method, 'Runtime.evaluate'); return { result: { value: await vm.runInContext(params.expression, context) } };
  } };
  const result = await waitForDisplayedMessages(cdp, expected);
  assert.equal(result.length, 4);
});

for (const [type, responseType] of [['summary:status', 'summary:result'], ['ai_usage:get', 'ai_usage:result'],
  ['ai_usage:grant', 'ai_usage:result'], ['ai_usage:revoke', 'ai_usage:result'], ['settings:update', 'settings:update:result'],
  ['settings:get', 'settings:get:result'], ['api:budget:get', 'api:budget:result']]) {
  test(`summary acceptance ${type} uses the real preload V4 envelope`, async () => {
    const vm = require('node:vm'); let listener, sent, disposed = 0;
    const context = vm.createContext({ setTimeout, clearTimeout, window: { electronAPI: { bridge: {
      onMessage(callback) { listener = callback; return () => { disposed++; }; },
      async send(frame) { sent = frame; listener({ type: responseType, request_id: frame.request_id, payload: { ok: true, fixture: true } }); },
    } } } });
    const cdp = { async call(method, params) {
      assert.equal(method, 'Runtime.evaluate'); return { result: { value: await vm.runInContext(params.expression, context) } };
    } };
    assert.equal((await summaryRequest(cdp, type, { feature: 'conversation_summary' })).fixture, true);
    assert.equal(sent.type, type); assert.match(sent.request_id, /^package-summary-/); assert.equal(disposed, 1);
  });
}

test('summary request helper refuses direct import so the scenario must use file selection and confirmation UI', async () => {
  await assert.rejects(summaryRequest({ call() { throw new Error('must not reach CDP'); } }, 'summary:legacy:import', {}), /Unsupported summary/);
});

test('budget refusal requires effective consent, a durable failed attempt and zero additional summary calls', () => {
  const fake = { requests: [summaryRequestFixture()] };
  const status = { ok: true, enabled: true, authorized: true, running: false, status: 'failed', errorCode: 'budget_denied',
    attempts: { failed: 1 }, activeCount: 0, summaries: [], cooldownSeconds: 300 };
  summaryContract.assertBudgetDenied(status, fake, 1);
  for (const mutation of [value => { value.errorCode = 'consent_revoked'; }, value => { value.authorized = false; },
    value => { value.attempts = {}; }, value => { value.activeCount = 1; }, value => { value.cooldownSeconds = 0; }]) {
    const changed = structuredClone(status); mutation(changed); assert.throws(() => summaryContract.assertBudgetDenied(changed, fake, 1));
  }
  assert.throws(() => summaryContract.assertBudgetDenied(status, { requests: [summaryRequestFixture(), summaryRequestFixture()] }, 1),
    /Budget-denied summary contacted/);
});

test('the local fake can hold exactly a background summary response while ordinary chat still completes', async (t) => {
  const fake = await startFakeProvider();
  const abort = new AbortController();
  t.after(async () => { fake.releaseSummary(); abort.abort(); fake.server.closeAllConnections(); await new Promise(resolve => fake.server.close(resolve)); });
  fake.holdNextSummary = true;
  let summaryCompleted = false;
  const request = body => fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal,
  }).then(response => response.json());
  const pending = request(summaryRequestFixture().body).then(value => { summaryCompleted = true; return value; });
  for (let i = 0; !fake.summaryResponseHeld && i < 200; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.summaryResponseHeld, true);
  const ordinary = await request({ messages: [{ role: 'user', content: 'CS fixture: independent ordinary chat' }] });
  assert.equal(ordinary.choices[0].message.content, summaryContract.CHAT_REPLY);
  assert.equal(summaryCompleted, false, 'The held background response arrived before explicit release');
  assert.equal(fake.releaseSummary(), true);
  assert.equal((await pending).choices[0].message.content, summaryContract.SUMMARY_REPLY);
  assert.equal(fake.summaryResponseHeld, false); assert.equal(fake.releaseSummary(), false);
});

test('fixture submission requires the controlled draft and an enabled actual send button', () => {
  const { composerReadyExpression } = require('./smoke-packaged-macos.cjs');
  const vm = require('node:vm');
  const expected='synthetic next turn';
  for (const [draft, present, disabled, valid] of [
    ['',true,false,false], [expected,false,false,false], [expected,true,true,false], [expected,true,false,true],
  ]) {
    const document = {querySelector:()=>({value:draft}),querySelectorAll:()=>present?[{textContent:'发送',disabled}]:[{textContent:'停止',disabled:false}]};
    assert.equal(vm.runInNewContext(composerReadyExpression(expected),{document}),valid);
  }
});

test('synthetic Xiangqi provider recognizes the system contract and returns the fixed legal reply', () => {
  const {isXiangqiModelRequest,fakeProviderReply}=require('./smoke-packaged-macos.cjs');
  const body={messages:[{role:'system',content:'你是合成角色，正在陪用户下xiangqi。你执黑棋。'},{role:'user',content:'y=9 黑车 黑马'}]};
  assert.equal(isXiangqiModelRequest(body),true);
  assert.deepEqual(JSON.parse(fakeProviderReply(body)),{move:'0,6,0,5',comment:'合成对手走一步'});
  assert.equal(isXiangqiModelRequest({messages:[{role:'user',content:'正在陪用户下xiangqi。'}]}),false);
});
