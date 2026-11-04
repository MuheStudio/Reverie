'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const isolation = require('./acceptance-isolation.cjs');

test('native controller inspects a real synthetic process and rejects stale/unowned actions without launching any app',
  { skip: process.platform !== 'darwin' }, async t => {
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-native-policy-'));
    const { runRoot } = isolation.createIsolationContext(parent);
    const data = isolation.createIsolatedDirectory(runRoot, 'data');
    t.after(() => { isolation.disposeIsolationContext(runRoot); fs.rmSync(parent, { recursive: true, force: true }); });
    // Compile the actual acceptance helper, then test only /bin/sleep.
    const helper = isolation.prepareNativeController(runRoot);
    assert.equal(isolation.prepareNativeController(runRoot), helper);
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const exit = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const actual = isolation.inspectProcesses(runRoot, [child.pid])[0];
    assert.equal(actual.pid, child.pid); assert.equal(actual.uid, process.getuid());
    assert.equal(actual.name, fs.realpathSync('/bin/sleep')); assert.match(actual.birth, /^\d+:\d+$/);
    const request = { operation: 'check', expected: actual, directories: isolation.assertIsolation(runRoot, data) };
    assert.deepEqual(isolation.nativeControl(runRoot, request), actual);
    for (const expected of [{ ...actual, birth: '1:1' }, { ...actual, uid: actual.uid + 1 },
      { ...actual, name: '/different/executable' }, { ...actual, pid: 2147483647 }]) {
      assert.throws(() => isolation.nativeControl(runRoot, { ...request, expected }), /absent or changed/);
    }
    for (const appId of ['com.muhe.reverie.macos.test', 'com.muhe.reverie.qt.local', 'com.example.unowned']) {
      assert.throws(() => isolation.nativeControl(runRoot, { ...request, operation: 'quit',
        appId, appRoot: runRoot }), /outside the test application identity/);
    }
    assert.throws(() => isolation.nativeControl(runRoot, { ...request, operation: 'launch' }), /absent or changed/);
    const invalidDirectories = request.directories.map((item, index) => index ? { ...item, inode: '1' } : item);
    assert.throws(() => isolation.nativeControl(runRoot, { ...request, directories: invalidDirectories }), /absent or changed/);
    child.kill(); await exit;
    assert.deepEqual(isolation.inspectProcesses(runRoot, [actual.pid]), []);
    assert.throws(() => isolation.nativeControl(runRoot, request), /absent or changed/);
    const source = fs.readFileSync(path.join(__dirname, 'macos-confirm-error.swift'), 'utf8');
    assert.doesNotMatch(source, /NSWorkspace|openApplication|launchApplication|osascript|launchDate\s*[!=]/);
  });
