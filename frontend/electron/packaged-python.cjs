'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { redact } = require('./safe-log.cjs');

const PROBE_TIMEOUT_MS = 20_000;
const PROBE = [
  'import json, platform, sys',
  'print(json.dumps({"version": list(sys.version_info[:3]), "platform": sys.platform,',
  '"machine": platform.machine(), "prefix": sys.prefix, "basePrefix": sys.base_prefix,',
  '"executable": sys.executable, "isolated": sys.flags.isolated, "noUserSite": sys.flags.no_user_site,',
  '"dontWriteBytecode": sys.dont_write_bytecode}))',
].join('\n');

function createPackagedPythonEnvironment(resourcesPath, inherited = process.env, userDataPath = null) {
  // No developer interpreter, provider credentials, dynamic-loader overrides,
  // user site, or shell PATH may select code for the packaged Python host.
  const allowed = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const environment = Object.fromEntries(allowed.filter((key) => typeof inherited[key] === 'string')
    .map((key) => [key, inherited[key]]));
  return {
    ...environment,
    ...(userDataPath ? {
      TMPDIR: path.join(userDataPath, 'runtime', 'tmp'),
      TMP: path.join(userDataPath, 'runtime', 'tmp'),
      TEMP: path.join(userDataPath, 'runtime', 'tmp'),
      XDG_CACHE_HOME: path.join(userDataPath, 'runtime', 'cache'),
      XDG_DATA_HOME: path.join(userDataPath, 'runtime', 'data'),
      XDG_STATE_HOME: path.join(userDataPath, 'runtime', 'state'),
    } : {}),
    PATH: `${path.join(path.resolve(resourcesPath), 'python', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHON_DOTENV_DISABLED: '1',
  };
}

function safeStderr(value) {
  if (typeof value !== 'string') return '';
  return redact(value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''))
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[LOCAL_PATH]')
    .slice(0, 2048);
}

function resolveMacPackagedPython(resourcesPath, options = {}) {
  const fileSystem = options.fs || fs;
  const run = options.spawnSync || spawnSync;
  const resources = path.resolve(resourcesPath);
  const runtime = path.join(resources, 'python');
  const command = path.join(runtime, 'bin', 'python3.12');
  const started = process.hrtime.bigint();
  const duration = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  function emit(state, details = {}) {
    try { options.onDiagnostic?.({ state, command: 'python/bin/python3.12', elapsedMs: duration(), ...details }); } catch {}
  }
  function fail(reason, details = {}) {
    const error = new Error(`Bundled macOS Python validation failed (${reason}); startup was refused.`);
    error.code = 'REVERIE_PACKAGED_PYTHON_INVALID';
    error.reason = reason;
    error.diagnostics = { reason, elapsedMs: duration(), ...details };
    emit('failed', error.diagnostics);
    throw error;
  }
  let expectedRuntime;
  let expectedExecutable;
  try {
    for (const directory of [runtime, path.join(runtime, 'bin')]) {
      const stat = fileSystem.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('redirected runtime directory');
    }
    const stat = fileSystem.lstatSync(command);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error('invalid interpreter');
    fileSystem.accessSync(command, fs.constants.R_OK | fs.constants.X_OK);
    expectedRuntime = path.join(fileSystem.realpathSync(resources), 'python');
    expectedExecutable = path.join(expectedRuntime, 'bin', 'python3.12');
    if (fileSystem.realpathSync(runtime) !== expectedRuntime
      || fileSystem.realpathSync(command) !== expectedExecutable) throw new Error('runtime escaped resources');
  } catch {
    fail('runtime_missing_or_unsafe');
  }
  emit('started', { timeoutMs: PROBE_TIMEOUT_MS });
  let result;
  try {
    result = run(command, ['-I', '-B', '-c', PROBE], {
      cwd: resources,
      env: createPackagedPythonEnvironment(resources, options.env || process.env, options.userDataPath),
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail('probe_spawn_error', { code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : null });
  }
  if (result.error || result.status !== 0 || result.signal) {
    fail(result.error?.code === 'ETIMEDOUT' ? 'probe_timeout'
      : result.error ? 'probe_spawn_error' : result.signal ? 'probe_signal' : 'probe_exit', {
      status: Number.isInteger(result.status) ? result.status : null,
      signal: /^[A-Z0-9]+$/.test(result.signal || '') ? result.signal : null,
      code: /^[A-Z0-9_]+$/.test(result.error?.code || '') ? result.error.code : null,
      stderr: safeStderr(result.stderr),
    });
  }
  let details;
  try { details = JSON.parse(result.stdout); } catch { fail('probe_invalid_json'); }
  if (!Array.isArray(details?.version) || details.version[0] !== 3 || details.version[1] !== 12 || details.version[2] !== 14
    || details.platform !== 'darwin' || details.machine !== 'arm64') fail('runtime_version_or_architecture');
  if (details.isolated !== 1 || details.noUserSite !== 1 || details.dontWriteBytecode !== true) {
    fail('runtime_not_isolated');
  }
  try {
    if (fileSystem.realpathSync(details.prefix) !== expectedRuntime
      || fileSystem.realpathSync(details.basePrefix) !== expectedRuntime
      || fileSystem.realpathSync(details.executable) !== expectedExecutable) throw new Error('prefix mismatch');
  } catch { fail('runtime_prefix_mismatch'); }
  emit('validated', { pythonVersion: details.version.join('.'), architecture: details.machine });
  return command;
}

module.exports = { PROBE_TIMEOUT_MS, createPackagedPythonEnvironment, resolveMacPackagedPython };
