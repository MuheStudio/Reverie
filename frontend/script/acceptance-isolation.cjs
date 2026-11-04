'use strict';

// In-process capabilities: a path string alone never authorizes a test launch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const registry = new Map();
const helperSource = path.join(__dirname, 'macos-confirm-error.swift');

function snapshotDirectory(directory) {
  assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'Isolation directory must be absolute');
  const resolved = path.resolve(directory);
  assert.ok(!resolved.split(path.sep).some(part => /\.app$/i.test(part)), 'Isolation directories cannot be inside an application bundle');
  assert.equal(fs.realpathSync(resolved), resolved, 'Isolation directory aliases/symlinks are forbidden');
  let current = resolved;
  while (current !== path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Isolation directory chain contains a symlink or non-directory');
    current = path.dirname(current);
  }
  const stat = fs.lstatSync(resolved, { bigint: true });
  assert.equal(Number(stat.uid), process.getuid?.() ?? Number(stat.uid), 'Isolation directory has another owner');
  return Object.freeze({ path: resolved, device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid) });
}
function verifyDirectory(expected) { assert.deepEqual(snapshotDirectory(expected.path), expected, 'Isolation directory identity changed'); }
function createIsolationContext(parent) {
  snapshotDirectory(parent);
  const runRoot = fs.mkdtempSync(path.join(parent, 'run-'));
  fs.chmodSync(runRoot, 0o700);
  const state = { root: snapshotDirectory(runRoot), directories: new Map(), helper: null };
  registry.set(runRoot, state);
  return Object.freeze({ runRoot });
}
function registered(runRoot) {
  assert.ok(typeof runRoot === 'string' && registry.has(runRoot), 'Missing registered isolation context; launch refused');
  const state = registry.get(runRoot); verifyDirectory(state.root); return state;
}
function createIsolatedDirectory(runRoot, name) {
  const state = registered(runRoot);
  assert.ok(typeof name === 'string' && name && path.basename(name) === name && !['.', '..'].includes(name), 'Invalid isolated directory name');
  const directory = path.join(runRoot, name);
  fs.mkdirSync(directory, { mode: 0o700 }); // Existing paths are not silently adopted.
  state.directories.set(directory, snapshotDirectory(directory));
  return directory;
}
function assertIsolation(runRoot, userData) {
  const state = registered(runRoot);
  assert.ok(typeof userData === 'string' && state.directories.has(userData), 'Unregistered data directory; launch refused');
  for (const directory of state.directories.values()) verifyDirectory(directory);
  return [state.root, ...state.directories.values()];
}
function prepareNativeController(runRoot) {
  const state = registered(runRoot);
  if (state.helper) return state.helper;
  assert.equal(process.platform, 'darwin', 'Native process identity requires macOS');
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-process-controller-'));
  try {
    const source = fs.readFileSync(helperSource);
    const copied = path.join(scratch, 'controller.swift'), executable = path.join(scratch, 'controller');
    fs.writeFileSync(copied, source, { flag: 'wx', mode: 0o600 });
    const result = spawnSync('/usr/bin/swiftc', ['-module-cache-path', path.join(scratch, 'cache'), copied, '-o', executable],
      { cwd: scratch, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `Native controller compilation failed: ${result.error?.message || result.stderr}`);
    state.helper = { scratch, executable, sha256: crypto.createHash('sha256').update(source).digest('hex') };
    return state.helper;
  } catch (error) { fs.rmSync(scratch, { recursive: true, force: true }); throw error; }
}
function nativeControl(runRoot, request) {
  const helper = prepareNativeController(runRoot);
  const requestPath = path.join(helper.scratch, `request-${crypto.randomUUID()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  try {
    const result = spawnSync(helper.executable, [requestPath], { cwd: helper.scratch, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 1024 * 1024, env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' } });
    assert.equal(result.status, 0, `Native process controller refused action: ${result.error?.message || result.stderr}`);
    return JSON.parse(result.stdout);
  } finally { fs.unlinkSync(requestPath); }
}
function inspectProcesses(runRoot, pids) { return nativeControl(runRoot, { operation: 'inspect', pids }); }
function sameIdentity(actual, expected) {
  return Boolean(actual && expected && ['pid', 'uid', 'birth', 'name'].every(key => actual[key] === expected[key]));
}
function registerRoot(running, inspect = inspectProcesses) {
  assertIsolation(running.runRoot, running.userData);
  assert.ok(running.child.exitCode == null && running.child.signalCode == null && !running.error,
    'Spawned process already exited or failed; no identity adoption');
  const actual = inspect(running.runRoot, [running.child.pid])[0];
  assert.ok(actual && actual.ppid === process.pid && actual.uid === (process.getuid?.() ?? actual.uid) && actual.name === fs.realpathSync(running.identity.executable),
    'Spawned process identity is absent or changed');
  running.rootIdentity = Object.freeze(actual); running.owned.set(actual.pid, running.rootIdentity);
}
function collectProcesses(running, snapshot, inspect = inspectProcesses) {
  assertIsolation(running.runRoot, running.userData);
  const all = inspect(running.runRoot, snapshot.map(item => item.pid));
  const live = new Map(all.map(item => [item.pid, item]));
  // A recycled root PID never becomes an ownership seed. Retained descendants
  // are seeds only while their own birth/owner/executable still match.
  const seeds = new Set([...running.owned.values()].filter(item => sameIdentity(live.get(item.pid), item)).map(item => item.pid));
  let changed;
  do {
    changed = false;
    for (const item of all) if (!running.owned.has(item.pid) && seeds.has(item.ppid) && item.uid === running.rootIdentity.uid) {
      running.owned.set(item.pid, Object.freeze(item)); seeds.add(item.pid); changed = true;
    }
  } while (changed);
}
function remainingProcesses(running, inspect = inspectProcesses) {
  const live = new Map(inspect(running.runRoot, [...running.owned.keys()]).map(item => [item.pid, item]));
  return [...running.owned.values()].filter(expected => sameIdentity(live.get(expected.pid), expected));
}
function guardedAction(running, operation, extra = {}, control = nativeControl) {
  const directories = assertIsolation(running.runRoot, running.userData);
  assert.ok(running.rootIdentity && running.owned.get(running.child.pid) === running.rootIdentity, 'Unowned application; no action');
  return control(running.runRoot, { ...extra, operation, expected: running.rootIdentity, directories,
    appRoot: fs.realpathSync(running.identity.appRoot), appId: running.identity.appId });
}
function signalOwned(running, expected, signal, inspect = inspectProcesses, send = process.kill) {
  assertIsolation(running.runRoot, running.userData);
  assert.ok(running.owned.get(expected.pid) === expected, 'Unowned process; no signal');
  assert.equal(signal, 'SIGKILL', 'Only bounded failure cleanup is supported');
  if (!sameIdentity(inspect(running.runRoot, [expected.pid])[0], expected)) return false;
  // macOS has no pidfd-style birth-bound signal primitive here. This is a
  // fresh identity check before a specific-PID POSIX signal, not an atomic
  // kernel guarantee. Never signal by group/name or after observation failure.
  try { send(expected.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  return true;
}
function removeIsolationContext(runRoot) {
  disposeIsolationContext(runRoot);
  fs.rmSync(runRoot, { recursive: true, force: true });
}
function disposeIsolationContext(runRoot) {
  const state = registered(runRoot);
  if (state.helper) fs.rmSync(state.helper.scratch, { recursive: true, force: true });
  registry.delete(runRoot);
}
module.exports = { createIsolationContext, createIsolatedDirectory, assertIsolation, prepareNativeController,
  nativeControl, inspectProcesses, registerRoot, collectProcesses, remainingProcesses, guardedAction,
  signalOwned, sameIdentity, disposeIsolationContext, removeIsolationContext, snapshotDirectory };
