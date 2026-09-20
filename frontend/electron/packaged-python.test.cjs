'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PROBE_TIMEOUT_MS, createPackagedPythonEnvironment, resolveMacPackagedPython } = require('./packaged-python.cjs');

function fixture(t) {
  const resources = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie packaged python ')));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const runtime = path.join(resources, 'python');
  const command = path.join(runtime, 'bin', 'python3.12');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const probe = (overrides = {}) => ({ status: 0, stdout: JSON.stringify({
    version: [3, 12, 14], platform: 'darwin', machine: 'arm64',
    prefix: runtime, basePrefix: runtime, executable: command,
    isolated: 1, noUserSite: 1, dontWriteBytecode: true, ...overrides,
  }) });
  return { resources, runtime, command, probe };
}

test('packaged macOS selects only its standalone executable and probes with -I -B', (t) => {
  const f = fixture(t);
  let invocation;
  const events = [];
  assert.equal(resolveMacPackagedPython(f.resources, {
    spawnSync: (...args) => { invocation = args; return f.probe(); }, onDiagnostic: (event) => events.push(event),
  }), f.command);
  assert.equal(invocation[0], f.command);
  assert.deepEqual(invocation[1].slice(0, 3), ['-I', '-B', '-c']);
  assert.equal(invocation[2].timeout, PROBE_TIMEOUT_MS);
  assert.equal(PROBE_TIMEOUT_MS, 20_000);
  assert.equal(invocation[2].killSignal, 'SIGKILL');
  assert.deepEqual(invocation[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(events.map((event) => event.state), ['started', 'validated']);
});

test('packaged Python strips interpreter, loader, shell and credential pollution', () => {
  const resources = path.resolve('/app/Contents/Resources');
  const userData = path.resolve('/isolated-data');
  const environment = createPackagedPythonEnvironment(resources, {
    HOME: '/Users/example', LANG: 'zh_CN.UTF-8', TMPDIR: '/unsafe', PATH: '/developer/bin',
    PYTHONHOME: '/developer/python', PYTHONPATH: '/untrusted', PYTHONSTARTUP: '/code.py',
    VIRTUAL_ENV: '/venv', DYLD_INSERT_LIBRARIES: '/hook.dylib', NODE_OPTIONS: '--require=evil',
    OPENAI_API_KEY: 'secret-value', REVERIE_STORAGE_KEY_FD: '9', PYTHON_DOTENV_DISABLED: '0',
  }, userData);
  assert.equal(environment.HOME, '/Users/example');
  assert.equal(environment.LANG, 'zh_CN.UTF-8');
  // This is the macOS child environment even when the contract test runs on Windows.
  assert.equal(environment.PATH, `${path.join(resources, 'python', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`);
  for (const name of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'REVERIE_STORAGE_KEY_FD']) {
    assert.equal(environment[name], undefined, name);
  }
  assert.equal(environment.PYTHON_DOTENV_DISABLED, '1');
  assert.equal(environment.PYTHONNOUSERSITE, '1');
  assert.equal(environment.TMPDIR, path.join(userData, 'runtime', 'tmp'));
  assert.equal(environment.TMP, environment.TMPDIR);
  assert.equal(environment.TEMP, environment.TMPDIR);
  assert.equal(environment.XDG_CACHE_HOME, path.join(userData, 'runtime', 'cache'));
});

test('a missing bundled interpreter never falls back to legacy, system or development Python', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.command);
  fs.writeFileSync(path.join(f.runtime, 'python'), 'legacy interpreter');
  assert.throws(() => resolveMacPackagedPython(f.resources, {
    env: { REVERIE_DEV_PYTHON: '/other', PATH: '/system' },
    spawnSync: () => assert.fail('must not execute a fallback'),
  }), /runtime_missing_or_unsafe/);
});

for (const name of ['executable', 'bin', 'runtime']) {
  test(`packaged ${name} symlink is rejected`, { skip: process.platform === 'win32' }, (t) => {
    const f = fixture(t);
    const original = name === 'executable' ? f.command : name === 'bin' ? path.dirname(f.command) : f.runtime;
    const moved = path.join(f.resources, 'redirected');
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    assert.throws(() => resolveMacPackagedPython(f.resources), /runtime_missing_or_unsafe/);
  });
}

test('a non-executable bundled interpreter is rejected', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  fs.chmodSync(f.command, 0o644);
  assert.throws(() => resolveMacPackagedPython(f.resources), /runtime_missing_or_unsafe/);
});

for (const [label, overrides, reason] of [
  ['wrong Python version', { version: [3, 13, 0] }, 'runtime_version_or_architecture'],
  ['unapproved Python 3.12 patch', { version: [3, 12, 13] }, 'runtime_version_or_architecture'],
  ['Rosetta interpreter', { machine: 'x86_64' }, 'runtime_version_or_architecture'],
  ['wrong platform', { platform: 'linux' }, 'runtime_version_or_architecture'],
  ['non-isolated runtime', { isolated: 0 }, 'runtime_not_isolated'],
  ['enabled user site', { noUserSite: 0 }, 'runtime_not_isolated'],
  ['bytecode writes enabled', { dontWriteBytecode: false }, 'runtime_not_isolated'],
]) {
  test(`rejects ${label}`, (t) => {
    const f = fixture(t);
    assert.throws(() => resolveMacPackagedPython(f.resources, { spawnSync: () => f.probe(overrides) }), new RegExp(reason));
  });
}

for (const field of ['prefix', 'basePrefix', 'executable']) {
  test(`rejects an external ${field}`, (t) => {
    const f = fixture(t);
    assert.throws(() => resolveMacPackagedPython(f.resources, { spawnSync: () => f.probe({ [field]: f.resources }) }), /runtime_prefix_mismatch/);
  });
}

test('timeout remains distinct from interpreter failure and redacts diagnostic stderr', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveMacPackagedPython(f.resources, { spawnSync: () => ({
    error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL',
    stderr: 'api_key=private-key-value /Users/example/private/path\u001b[31m',
  }) }), (error) => {
    assert.equal(error.reason, 'probe_timeout');
    assert.equal(error.diagnostics.code, 'ETIMEDOUT');
    assert.equal(error.diagnostics.signal, 'SIGKILL');
    assert.ok(!error.diagnostics.stderr.includes('private-key-value'));
    assert.ok(!error.diagnostics.stderr.includes('/Users/example'));
    return true;
  });
});

test('malformed probe output is rejected rather than interpreted as success', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveMacPackagedPython(f.resources, { spawnSync: () => ({ status: 0, stdout: 'startup message\n{}' }) }), /probe_invalid_json/);
});
