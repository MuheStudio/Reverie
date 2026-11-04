'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { resolveMacDevelopmentPython } = require('./python-command.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie python '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  fs.mkdirSync(base);
  return {
    root,
    base,
    environment(name = '.venv') {
      const prefix = path.join(root, name);
      const command = path.join(prefix, 'bin', 'python');
      fs.mkdirSync(path.dirname(command), { recursive: true });
      fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { prefix, command };
    },
    probe(prefix, overrides = {}) {
      return () => ({
        status: 0,
        stdout: JSON.stringify({
          version: [3, 12, 10], platform: 'darwin', machine: 'arm64',
          prefix, basePrefix: base, ...overrides,
        }),
      });
    },
  };
}

test('macOS selects .venv before legacy venv, including paths with spaces', (t) => {
  const f = fixture(t);
  const preferred = f.environment();
  f.environment('venv');
  assert.equal(resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(preferred.prefix),
  }), preferred.command);
});

test('macOS selects legacy venv when .venv is absent', (t) => {
  const f = fixture(t);
  const legacy = f.environment('venv');
  assert.equal(resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(legacy.prefix),
  }), legacy.command);
});

test('macOS never falls back to PATH when project environments are absent', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: () => assert.fail('must not spawn a system interpreter'),
  }), /No project Python environment/);
});

test('an existing damaged .venv does not fall back to a valid legacy venv', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.venv'));
  const legacy = f.environment('venv');
  assert.throws(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(legacy.prefix),
  }), /damaged or not executable/);
});

test('a non-directory .venv is a clear failure', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.venv'), 'invalid');
  assert.throws(() => resolveMacDevelopmentPython(f.root), /damaged or not executable/);
});

test('a valid interpreter symlink is executed through its original venv entry', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  const { prefix, command } = f.environment();
  const target = path.join(f.base, 'python3.12');
  fs.renameSync(command, target);
  fs.symlinkSync(target, command);
  let invocation;
  const selected = resolveMacDevelopmentPython(f.root, {
    spawnSync: (executable, args, options) => {
      invocation = { executable, args, options };
      return f.probe(prefix)();
    },
  });
  assert.equal(selected, command);
  assert.equal(invocation.executable, command);
  assert.notEqual(invocation.executable, fs.realpathSync(command));
  assert.deepEqual(invocation.args.slice(0, 2), ['-I', '-c']);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
});

test('a dangling preferred environment symlink does not select legacy venv', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.root, '.venv'));
  f.environment('venv');
  assert.throws(() => resolveMacDevelopmentPython(f.root), /damaged or not executable/);
});

test('a dangling interpreter symlink is rejected', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  const { command } = f.environment();
  fs.unlinkSync(command);
  fs.symlinkSync(path.join(f.base, 'missing'), command);
  assert.throws(() => resolveMacDevelopmentPython(f.root), /damaged or not executable/);
});

test('a non-executable interpreter is rejected before probing', {
  skip: process.platform === 'win32' ? 'POSIX execute permission test' : false,
}, (t) => {
  const f = fixture(t);
  const { command } = f.environment();
  fs.chmodSync(command, 0o644);
  assert.throws(() => resolveMacDevelopmentPython(f.root), /damaged or not executable/);
});

for (const [label, overrides, expected] of [
  ['Python 3.13', { version: [3, 13, 0] }, /Python 3\.12/],
  ['Rosetta Python', { machine: 'x86_64' }, /native arm64/],
  ['non-macOS Python', { platform: 'linux' }, /native arm64/],
]) {
  test(`rejects ${label}`, (t) => {
    const f = fixture(t);
    const { prefix } = f.environment();
    assert.throws(() => resolveMacDevelopmentPython(f.root, {
      spawnSync: f.probe(prefix, overrides),
    }), expected);
  });
}

test('rejects an interpreter that resolves to its base environment', (t) => {
  const f = fixture(t);
  const { prefix } = f.environment();
  assert.throws(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(prefix, { basePrefix: prefix }),
  }), /not running inside its project virtual environment/);
});

test('rejects an interpreter that runs in a different venv', (t) => {
  const f = fixture(t);
  f.environment();
  const wrong = f.environment('other');
  assert.throws(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(wrong.prefix),
  }), /not running inside its project virtual environment/);
});

for (const [label, result] of [
  ['timeout', { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null }],
  ['failure', { status: 1, stderr: 'failure details' }],
  ['signal', { status: null, signal: 'SIGTERM' }],
  ['unframed diagnostics', { status: 0, stdout: 'startup log\n{}' }],
]) {
  test(`rejects a probe ${label}`, (t) => {
    const f = fixture(t);
    f.environment();
    assert.throws(() => resolveMacDevelopmentPython(f.root, {
      spawnSync: () => result,
    }), /startup check/);
  });
}

function caughtError(callback) {
  let failure;
  assert.throws(callback, (error) => {
    failure = error;
    return error.code === 'REVERIE_DEV_PYTHON_INVALID';
  });
  return failure;
}

for (const thrown of [false, true]) {
  test(`a ${thrown ? 'thrown' : 'returned'} timeout retries the same venv once and validates its result`, (t) => {
    const f = fixture(t);
    const { prefix, command } = f.environment();
    f.environment('venv');
    const invocations = [];
    const events = [];
    const selected = resolveMacDevelopmentPython(f.root, {
      spawnSync: (executable, args, options) => {
        invocations.push({ executable, args, options });
        if (invocations.length === 1) {
          const error = Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
          if (thrown) throw error;
          return { error, status: null, signal: 'SIGKILL', stderr: 'first attempt exceeded its deadline' };
        }
        return f.probe(prefix)();
      },
      onDiagnostic: (event) => events.push(event),
    });
    assert.equal(selected, command);
    assert.deepEqual(invocations.map((call) => call.executable), [command, command]);
    assert.deepEqual(invocations.map((call) => call.options.timeout), [10_000, 30_000]);
    assert.deepEqual(invocations.map((call) => call.options.killSignal), ['SIGKILL', 'SIGKILL']);
    assert.deepEqual(invocations[0].args, invocations[1].args);
    assert.deepEqual(invocations[0].args.slice(0, 2), ['-I', '-c']);
    assert.deepEqual(events.map((event) => event.type), ['attempt', 'retry', 'attempt', 'validated']);
    assert.equal(events[1].nextAttempt, 2);
    assert.equal(events[1].timeoutMs, 30_000);
    assert.equal(events[0].diagnostics.attempts.length, 1, 'earlier snapshots must not change');
    assert.equal(events[0].diagnostics.attempts[0].errorCode, 'ETIMEDOUT');
    const validated = events.at(-1);
    assert.equal(validated.command, '.venv/bin/python');
    assert.equal(validated.diagnostics.attempts.length, 2);
    assert.equal(validated.diagnostics.attempts[1].exitCode, 0);
    assert.ok(Number.isFinite(Date.parse(validated.diagnostics.startedAt)));
    assert.ok(Number.isFinite(Date.parse(validated.diagnostics.completedAt)));
    assert.ok(validated.diagnostics.elapsedMs >= 0);
  });
}

test('two timeouts stop without a third probe or another interpreter', (t) => {
  const f = fixture(t);
  const { command } = f.environment();
  f.environment('venv');
  const commands = [];
  const events = [];
  const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: (executable) => {
      commands.push(executable);
      return { error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL' };
    },
    onDiagnostic: (event) => events.push(event),
  }));
  assert.deepEqual(commands, [command, command]);
  assert.equal(failure.reason, 'probe_timeout');
  assert.deepEqual(failure.diagnostics.attempts.map((attempt) => attempt.timeoutMs), [10_000, 30_000]);
  assert.match(failure.message, /10-second check and one 30-second retry/);
  assert.doesNotMatch(failure.message, /setup|reinstall/i);
  assert.deepEqual(events.map((event) => event.type), ['attempt', 'retry', 'attempt', 'failure']);
  assert.strictEqual(events.at(-1).diagnostics, failure.diagnostics);
});

for (const [label, result, expectedReason, expectedCode] of [
  ['EPERM', { error: { code: 'EPERM' }, status: null }, 'probe_spawn_error', 'EPERM'],
  ['EACCES', { error: { code: 'EACCES' }, status: null }, 'probe_spawn_error', 'EACCES'],
  ['output overflow', { error: { code: 'ENOBUFS' }, status: null }, 'probe_output_limit', 'ENOBUFS'],
  ['nonzero exit', { status: 7, stderr: 'initialization failed' }, 'probe_exit', null],
  ['SIGTERM', { status: null, signal: 'SIGTERM' }, 'probe_signal', null],
  ['SIGKILL without timeout', { status: null, signal: 'SIGKILL' }, 'probe_signal', null],
]) {
  test(`a probe ${label} is diagnosed without retrying`, (t) => {
    const f = fixture(t);
    const { command } = f.environment();
    const calls = [];
    const events = [];
    const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
      spawnSync: (executable) => { calls.push(executable); return result; },
      onDiagnostic: (event) => events.push(event),
    }));
    assert.deepEqual(calls, [command]);
    assert.equal(failure.reason, expectedReason);
    assert.equal(failure.diagnostics.attempts[0].errorCode, expectedCode);
    assert.equal(failure.diagnostics.attempts[0].exitCode, result.status);
    assert.equal(failure.diagnostics.attempts[0].signal, result.signal || null);
    assert.deepEqual(events.map((event) => event.type), ['attempt', 'failure']);
    if (result.signal) assert.doesNotMatch(failure.message, /setup|reinstall/i);
  });
}

for (const [label, overrides, expectedReason] of [
  ['wrong version', { version: [3, 13, 0] }, 'version_mismatch'],
  ['wrong architecture', { machine: 'x86_64' }, 'platform_mismatch'],
  ['wrong platform', { platform: 'linux' }, 'platform_mismatch'],
  ['wrong venv', null, 'venv_mismatch'],
  ['invalid JSON', false, 'probe_invalid_output'],
]) {
  test(`a retry with ${label} still fails closed`, (t) => {
    const f = fixture(t);
    const { prefix, command } = f.environment();
    const other = f.environment('venv');
    const calls = [];
    const events = [];
    const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
      spawnSync: (executable) => {
        calls.push(executable);
        if (calls.length === 1) return { error: { code: 'ETIMEDOUT' }, status: null };
        if (overrides === false) return { status: 0, stdout: 'unframed secret output' };
        return f.probe(prefix, overrides || { prefix: other.prefix })();
      },
      onDiagnostic: (event) => events.push(event),
    }));
    assert.deepEqual(calls, [command, command]);
    assert.equal(failure.reason, expectedReason);
    assert.equal(events.at(-1).type, 'failure');
    assert.equal(events.some((event) => event.type === 'validated'), false);
    assert.equal(JSON.stringify(failure).includes('unframed secret output'), false);
  });
}

test('diagnostics redact stderr, bound UTF-8 bytes, and never retain raw stdout or environment', (t) => {
  const f = fixture(t);
  f.environment();
  const events = [];
  const stderr = 'token=token-canary password=password-canary Authorization: Bearer bearer-canary\n'
    + '/Users/private-owner/private-location\n' + '中'.repeat(1500);
  const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: () => ({ status: 1, stdout: 'raw-stdout-canary', stderr }),
    onDiagnostic: (event) => events.push(event),
  }));
  const serialized = JSON.stringify({ events, diagnostics: failure.diagnostics });
  for (const secret of ['token-canary', 'password-canary', 'bearer-canary', 'private-owner', 'private-location', 'raw-stdout-canary', f.root]) {
    assert.equal(serialized.includes(secret), false, `must not expose ${secret}`);
  }
  assert.match(serialized, /REDACTED/);
  assert.match(serialized, /LOCAL_PATH/);
  assert.equal(Object.hasOwn(failure.diagnostics, 'env'), false);
  for (const event of events) {
    const entry = event.diagnostics.attempts[0];
    assert.ok(Buffer.byteLength(entry.stderr, 'utf8') <= 2048);
    assert.equal(entry.stderr.includes('\ufffd'), false);
    assert.equal(Object.hasOwn(entry, 'stdout'), false);
  }
});

test('a low-level thrown spawn error is classified without copying its raw message', (t) => {
  const f = fixture(t);
  f.environment();
  let calls = 0;
  const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: () => {
      calls += 1;
      throw Object.assign(new Error('raw exception canary'), {
        code: 'EPERM', stderr: Buffer.from('password=throw-canary'),
      });
    },
  }));
  assert.equal(calls, 1);
  assert.equal(failure.reason, 'probe_spawn_error');
  assert.equal(failure.diagnostics.attempts[0].errorCode, 'EPERM');
  assert.equal(JSON.stringify(failure).includes('raw exception canary'), false);
  assert.equal(JSON.stringify(failure).includes('throw-canary'), false);
});

test('a throwing diagnostic callback cannot bypass or break validation', (t) => {
  const f = fixture(t);
  const { command, prefix } = f.environment();
  const onDiagnostic = (event) => {
    event.diagnostics.attempts.push({ exitCode: 0 });
    throw new Error('telemetry failed');
  };
  assert.equal(resolveMacDevelopmentPython(f.root, { spawnSync: f.probe(prefix), onDiagnostic }), command);
  const failure = caughtError(() => resolveMacDevelopmentPython(f.root, {
    spawnSync: f.probe(prefix, { machine: 'x86_64' }), onDiagnostic,
  }));
  assert.equal(failure.reason, 'platform_mismatch');
  assert.equal(failure.diagnostics.attempts.length, 1);
});

// Exercise the actual entry-point selection functions without initializing
// Electron or starting a Python bridge. This protects the untouched production
// and Windows branches when the macOS development resolver is integrated.
function mainSelector(root, { isDev, platform }) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const names = ['isRegularUnlinkedFile', 'getPythonCommand'];
  const functions = names.map((name) => {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `${name} entry-point function must exist`);
    return match[0];
  });
  const context = {
    fs, path, IS_DEV: isDev, process: { platform }, getRuntimeRoot: () => root,
    resolveMacDevelopmentPython: () => assert.fail('must not use the macOS development resolver'),
  };
  vm.runInNewContext(functions.join('\n'), context);
  return context.getPythonCommand;
}

test('legacy Linux packaged mode rejects a missing interpreter even when a development venv exists', (t) => {
  const f = fixture(t);
  f.environment();
  const select = mainSelector(f.root, { isDev: false, platform: 'linux' });
  assert.throws(select, /Verified bundled Python runtime is missing/);
});

test('legacy Linux packaged mode accepts only its bundled interpreter and never probes a development venv', (t) => {
  const f = fixture(t);
  f.environment();
  const bundled = path.join(f.root, 'python', 'python');
  fs.mkdirSync(path.dirname(bundled));
  fs.writeFileSync(bundled, 'bundled');
  assert.equal(mainSelector(f.root, { isDev: false, platform: 'linux' })(), bundled);
});

test('legacy Linux packaged mode still rejects symlinked interpreters', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  const { command } = f.environment();
  fs.mkdirSync(path.join(f.root, 'python'));
  fs.symlinkSync(command, path.join(f.root, 'python', 'python'));
  assert.throws(mainSelector(f.root, { isDev: false, platform: 'linux' }), /Verified bundled Python/);
});

test('Windows development retains its venv Scripts entry and PATH fallback', (t) => {
  const f = fixture(t);
  f.environment();
  const select = mainSelector(f.root, { isDev: true, platform: 'win32' });
  assert.equal(select(), 'python');
  const executable = path.join(f.root, 'venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'Windows launcher');
  assert.equal(select(), executable);
});

test('Windows packaged mode retains its python.exe path', (t) => {
  const f = fixture(t);
  const executable = path.join(f.root, 'python', 'python.exe');
  fs.mkdirSync(path.dirname(executable));
  fs.writeFileSync(executable, 'Windows runtime');
  assert.equal(mainSelector(f.root, { isDev: false, platform: 'win32' })(), executable);
});
