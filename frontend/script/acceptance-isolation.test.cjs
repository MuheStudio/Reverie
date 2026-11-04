'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createIsolationContext, createIsolatedDirectory, assertIsolation, snapshotDirectory, disposeIsolationContext,
  registerRoot, collectProcesses, remainingProcesses, guardedAction, signalOwned,
} = require('./acceptance-isolation.cjs');
const { childEnvironment, launchApplication } = require('./smoke-packaged-macos.cjs');
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-isolation-'));
  const { runRoot } = createIsolationContext(parent);
  const userData = createIsolatedDirectory(runRoot, 'user-data');
  for (const name of ['tmp', 'cache', 'crashpad']) createIsolatedDirectory(runRoot, name);
  t.after(() => { try { disposeIsolationContext(runRoot); } catch {} fs.rmSync(parent, { recursive: true, force: true }); });
  return { parent, runRoot, userData };
}
function runningFixture(t) {
  const f = fixture(t), executable = fs.realpathSync(process.execPath);
  const root = { pid: 2345, uid: process.getuid?.() ?? 0, ppid: process.pid, birth: '10:100', name: executable };
  const running = { ...f, child: { pid: root.pid }, identity: { executable, appRoot: f.runRoot,
    appId: 'com.muhe.reverie.macos.test' }, owned: new Map() };
  const live = new Map([[root.pid, root]]);
  const inspect = (_runRoot, pids) => pids.map(pid => live.get(pid)).filter(Boolean);
  registerRoot(running, inspect);
  return { ...f, running, live, root, inspect };
}

test('new context records directory owner/device/inode and provides explicit test environment', t => {
  const f = fixture(t); const records = assertIsolation(f.runRoot, f.userData);
  assert.equal(records.length, 5);
  assert.deepEqual(records[0], snapshotDirectory(f.runRoot));
  const env = childEnvironment(f.runRoot, f.userData);
  assert.equal(env.REVERIE_TEST_USER_DATA_DIR, f.userData);
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('missing, fabricated, escaped and unregistered data contexts reject before any launch', async t => {
  const f = fixture(t), active = [];
  for (const [runRoot, userData] of [[undefined, undefined], [f.parent, f.userData], [f.runRoot, undefined],
    [f.runRoot, f.parent], [f.runRoot, path.join(f.runRoot, 'missing')]]) {
    await assert.rejects(launchApplication({ executable: '/must-not-execute' }, runRoot, userData, 'invalid', 1, active),
      /registered isolation|Unregistered data/);
  }
  assert.deepEqual(active, []);
});

test('data replacement is rejected with no sentinel writes', t => {
  const f = fixture(t), saved = `${f.userData}.saved`;
  fs.renameSync(f.userData, saved); fs.mkdirSync(f.userData);
  fs.writeFileSync(path.join(f.userData, 'sentinel'), 'untouched');
  assert.throws(() => childEnvironment(f.runRoot, f.userData), /identity changed/);
  assert.equal(fs.readFileSync(path.join(f.userData, 'sentinel'), 'utf8'), 'untouched');
});

test('root replacement is rejected even if its nested data has the same name', t => {
  const f = fixture(t); fs.renameSync(f.runRoot, `${f.runRoot}.saved`); fs.mkdirSync(f.runRoot);
  fs.mkdirSync(f.userData);
  assert.throws(() => assertIsolation(f.runRoot, f.userData), /identity changed/);
});

test('symlink data, ancestors and duplicate directory adoption are refused', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  assert.throws(() => createIsolatedDirectory(f.runRoot, 'user-data'), /EEXIST/);
  assert.throws(() => createIsolatedDirectory(f.runRoot, '../outside'), /Invalid isolated/);
  fs.renameSync(f.userData, `${f.userData}.saved`); fs.symlinkSync(`${f.userData}.saved`, f.userData);
  assert.throws(() => assertIsolation(f.runRoot, f.userData), /symlink/);
  fs.symlinkSync(f.parent, `${f.parent}-alias`); t.after(() => fs.unlinkSync(`${f.parent}-alias`));
  assert.throws(() => createIsolationContext(`${f.parent}-alias`), /symlink/);
});

test('root birth, UID and executable are captured, and descendants need a currently verified parent', t => {
  const f = runningFixture(t);
  const owned = { ...f.root, pid: 2346, ppid: f.root.pid, birth: '11:100' };
  const unowned = { ...owned, pid: 3000, ppid: 1, birth: '12:100' };
  f.live.set(owned.pid, owned); f.live.set(unowned.pid, unowned);
  collectProcesses(f.running, [...f.live.values()], f.inspect);
  assert.deepEqual([...f.running.owned.keys()], [2345, 2346]);
  f.live.set(f.root.pid, { ...f.root, birth: '20:200' });
  const recycledChild = { ...owned, pid: 4000, ppid: f.root.pid };
  f.live.set(recycledChild.pid, recycledChild);
  collectProcesses(f.running, [...f.live.values()], f.inspect);
  assert.equal(f.running.owned.has(recycledChild.pid), false);
  assert.deepEqual(remainingProcesses(f.running, f.inspect), [owned]);
});

for (const [name, mutate] of [
  ['process exited', f => f.live.delete(f.root.pid)],
  ['PID reused', f => f.live.set(f.root.pid, { ...f.root, birth: '999:1' })],
  ['executable changed', f => f.live.set(f.root.pid, { ...f.root, name: '/another/application' })],
  ['owner changed', f => f.live.set(f.root.pid, { ...f.root, uid: f.root.uid + 1 })],
]) test(`cleanup does not signal when ${name}`, t => {
  const f = runningFixture(t), calls = []; mutate(f);
  assert.equal(signalOwned(f.running, f.running.rootIdentity, 'SIGKILL', f.inspect, (...args) => calls.push(args)), false);
  assert.deepEqual(calls, []);
});

test('process exit after caller verification is rechecked at the action boundary', t => {
  const f = runningFixture(t), calls = [];
  assert.equal(remainingProcesses(f.running, f.inspect).length, 1);
  f.live.clear();
  assert.throws(() => guardedAction(f.running, 'quit', {}, (_root, request) => {
    calls.push(request.operation);
    assert.equal(f.inspect(_root, [request.expected.pid])[0]?.birth, request.expected.birth, 'process changed; no action');
  }), /process changed/);
  assert.deepEqual(calls, ['quit']);
});

test('same application identity without ownership cannot quit or receive cleanup signals', t => {
  const f = runningFixture(t), other = { ...f.running.rootIdentity, pid: 5000 };
  assert.throws(() => signalOwned(f.running, other, 'SIGKILL', f.inspect, () => assert.fail('unowned signal')), /Unowned process/);
  f.running.owned.clear();
  assert.throws(() => guardedAction(f.running, 'quit', {}, () => assert.fail('unowned action')), /Unowned application/);
});

test('native action request carries birth and all registered directory identities; replacement prevents action', t => {
  const f = runningFixture(t), requests = [];
  guardedAction(f.running, 'check', {}, (_root, request) => requests.push(request));
  assert.equal(requests[0].expected.birth, f.root.birth); assert.equal(requests[0].directories.length, 5);
  fs.renameSync(f.userData, `${f.userData}.saved`); fs.mkdirSync(f.userData);
  assert.throws(() => guardedAction(f.running, 'quit', {}, () => assert.fail('changed directory action')), /identity changed/);
});

test('no isolation directory can be created inside an application bundle', t => {
  const f = fixture(t), appParent = path.join(f.parent, 'Synthetic.app', 'Contents');
  fs.mkdirSync(appParent, { recursive: true });
  assert.throws(() => createIsolationContext(appParent), /inside an application bundle/);
  assert.deepEqual(fs.readdirSync(appParent), []);
});

test('root adoption rejects wrong ancestry or an exited child even with the correct executable', t => {
  const f = runningFixture(t);
  f.running.owned.clear();
  f.live.set(f.root.pid, { ...f.root, ppid: 1 });
  assert.throws(() => registerRoot(f.running, f.inspect), /identity is absent or changed/);
  f.live.set(f.root.pid, f.root); f.running.child.exitCode = 0;
  assert.throws(() => registerRoot(f.running, f.inspect), /already exited/);
  f.running.child.exitCode = null; f.running.child.signalCode = 'SIGTERM';
  assert.throws(() => registerRoot(f.running, f.inspect), /already exited/);
  assert.equal(f.running.owned.size, 0);
});
