'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redact } = require('./safe-log.cjs');

const PROBE = [
  'import json, platform, sys',
  'print(json.dumps({"version": list(sys.version_info[:3]), "platform": sys.platform,',
  '"machine": platform.machine(), "prefix": sys.prefix, "basePrefix": sys.base_prefix}))',
].join('\n');

function safeStderr(value) {
  // Preserve useful interpreter diagnostics without raw paths, credentials,
  // terminal controls, or a partial UTF-8 character at the 2 KiB boundary.
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '';
  const clean = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const safe = redact(clean.replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,"'}]+/gi, '$1[REDACTED]'))
    // A traceback path may begin a line or follow punctuation; neither has a
    // word boundary before its leading slash.
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[LOCAL_PATH]');
  const bytes = Buffer.from(safe, 'utf8');
  let end = Math.min(bytes.length, 2048);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function probeFailureReason(result) {
  if (result.error?.code === 'ETIMEDOUT') return 'probe_timeout';
  if (result.error?.code === 'ENOBUFS') return 'probe_output_limit';
  if (result.error) return 'probe_spawn_error';
  if (result.signal) return 'probe_signal';
  if (result.status !== 0) return Number.isInteger(result.status) ? 'probe_exit' : 'probe_spawn_error';
  return null;
}

function diagnosticCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : null;
}

/** macOS development only; packaged Python and other platforms keep their own policy. */
function resolveMacDevelopmentPython(projectRoot, options = {}) {
  const fileSystem = options.fs || fs;
  const run = options.spawnSync || spawnSync;
  const root = path.resolve(projectRoot);
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const attempts = [];
  let diagnosticCommand = null;
  const elapsedMs = (since) => Math.round(Number(process.hrtime.bigint() - since) / 1e6);
  function snapshot(complete = false) {
    return Object.freeze({
      startedAt,
      ...(complete ? { completedAt: new Date().toISOString() } : {}),
      elapsedMs: elapsedMs(started),
      command: diagnosticCommand,
      attempts: Object.freeze(attempts.map((attempt) => Object.freeze({ ...attempt }))),
    });
  }
  function emit(type, reason, diagnostics = snapshot(), extra = {}) {
    if (typeof options.onDiagnostic !== 'function') return;
    try {
      options.onDiagnostic(Object.freeze({ type, command: diagnosticCommand, ...(reason ? { reason } : {}), diagnostics, ...extra }));
    } catch { /* Observability must never change environment validation. */ }
  }
  function fail(reason, message) {
    const error = new Error(message);
    error.code = 'REVERIE_DEV_PYTHON_INVALID';
    error.reason = reason;
    error.diagnostics = snapshot(true);
    emit('failure', reason, error.diagnostics);
    throw error;
  }
  let environmentRoot;
  for (const name of ['.venv', 'venv']) {
    const candidate = path.join(root, name);
    try {
      // lstat also detects a broken environment-directory symlink. An existing
      // but broken preferred environment must never silently select another.
      fileSystem.lstatSync(candidate);
      environmentRoot = candidate;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        fail('environment_unavailable', `Cannot inspect the project Python environment (${diagnosticCode(error.code) || 'filesystem error'}). Check its access permissions.`);
      }
    }
  }
  if (!environmentRoot) {
    fail('environment_missing', 'No project Python environment (.venv or venv) was found. Run script/setup-macos.sh to prepare it.');
  }

  const command = path.join(environmentRoot, 'bin', 'python');
  diagnosticCommand = path.relative(root, command).split(path.sep).join('/');
  let expectedPrefix;
  try {
    if (!fileSystem.statSync(environmentRoot).isDirectory()) throw new Error('not a directory');
    const entry = fileSystem.lstatSync(command);
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('not a file or symlink');
    const target = fileSystem.statSync(command);
    if (!target.isFile() || target.size === 0) throw new Error('invalid interpreter target');
    fileSystem.accessSync(command, fs.constants.R_OK | fs.constants.X_OK);
    // A venv normally links to a base interpreter outside the repository.
    // Resolve only for validation; executing that target would lose venv lookup.
    fileSystem.realpathSync(command);
    expectedPrefix = fileSystem.realpathSync(environmentRoot);
  } catch (error) {
    fail('environment_unavailable', `The selected Python environment is damaged or not executable: ${diagnosticCommand} (${diagnosticCode(error.code) || 'invalid interpreter entry'}). Inspect the project environment before repairing it.`);
  }

  // This is a separate, captured process. The actual bridge stdout remains
  // exclusively reserved for framed protocol messages.
  let result;
  for (const timeoutMs of [10_000, 30_000]) {
    const attemptStarted = process.hrtime.bigint();
    try {
      result = run(command, ['-I', '-c', PROBE], {
        cwd: root,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!result || typeof result !== 'object') result = { error: { code: 'INVALID_SPAWN_RESULT' } };
    } catch (error) {
      // Node usually returns an error in the result, but injected runners and
      // some argument/OS failures throw before a result exists.
      result = { error: error || { code: 'UNKNOWN' }, status: error?.status, signal: error?.signal, stderr: error?.stderr };
    }
    const reason = probeFailureReason(result);
    const attempt = {
      attempt: attempts.length + 1,
      timeoutMs,
      elapsedMs: elapsedMs(attemptStarted),
      errorCode: result.error ? diagnosticCode(result.error.code) || 'UNKNOWN' : null,
      exitCode: Number.isInteger(result.status) ? result.status : null,
      signal: diagnosticCode(result.signal),
      stderr: safeStderr(result.stderr),
      reason,
    };
    attempts.push(attempt);
    emit('attempt', reason);
    if (result.error?.code === 'ETIMEDOUT' && attempts.length === 1) {
      emit('retry', 'probe_timeout', snapshot(), { nextAttempt: 2, timeoutMs: 30_000 });
      continue;
    }
    if (reason) {
      const description = {
        probe_timeout: 'timed out after the 10-second check and one 30-second retry',
        probe_output_limit: 'exceeded the 64 KiB output limit',
        probe_signal: `was terminated by ${attempt.signal || 'an unknown signal'}`,
        probe_exit: `exited with code ${attempt.exitCode}`,
        probe_spawn_error: `could not start (${attempt.errorCode || 'invalid process result'})`,
      }[reason];
      const nextStep = reason === 'probe_timeout' || reason === 'probe_signal'
        ? 'Inspect the startup diagnostics and current system conditions before retrying.'
        : 'Inspect the startup diagnostics before repairing the project environment.';
      fail(reason, `Python startup check for ${diagnosticCommand} ${description}. ${nextStep}`);
    }
    break;
  }
  let details;
  try {
    details = JSON.parse(result.stdout);
  } catch {
    fail('probe_invalid_output', `The selected Python interpreter returned an invalid startup check: ${diagnosticCommand}. Expected one JSON object.`);
  }
  if (!Array.isArray(details?.version) || details.version[0] !== 3 || details.version[1] !== 12) {
    fail('version_mismatch', 'macOS development requires Python 3.12. The selected environment does not match.');
  }
  if (details.platform !== 'darwin' || details.machine !== 'arm64') {
    fail('platform_mismatch', 'macOS development requires a native arm64 Python interpreter. The selected environment does not match.');
  }
  try {
    if (typeof details.prefix !== 'string' || typeof details.basePrefix !== 'string') {
      throw new Error('missing prefixes');
    }
    const actualPrefix = fileSystem.realpathSync(details.prefix);
    const basePrefix = fileSystem.realpathSync(details.basePrefix);
    if (actualPrefix !== expectedPrefix || actualPrefix === basePrefix) {
      throw new Error('not the selected venv');
    }
  } catch {
    fail('venv_mismatch', 'The selected Python interpreter is not running inside its project virtual environment. Inspect its original venv entry and pyvenv.cfg.');
  }
  emit('validated', null, snapshot(true));
  return command;
}

module.exports = { resolveMacDevelopmentPython };
