'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const manifest = require('../config/macos-toolchain.json');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: bash script/check-macos.sh [--env-only]\n'
    + 'Default: environment, native storage, Python/frontend tests, build and desktop smoke.\n'
    + '--env-only: toolchain, package consistency and native encrypted-storage checks.\n');
  process.exit(0);
}
if (args.some((arg) => arg !== '--env-only') || args.length > 1) {
  process.stderr.write('Only --env-only is supported.\n');
  process.exit(2);
}

const envOnly = args.includes('--env-only');
const node = process.env.REVERIE_NODE || path.join(root, '.tools/node/bin/node');
const python = process.env.REVERIE_PYTHON || path.join(root, '.venv/bin/python');
const uv = process.env.REVERIE_UV || path.join(root, '.tools/uv/uv');
const pnpm = process.env.REVERIE_PNPM || path.join(root, '.tools/pnpm/bin/pnpm.cjs');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const reportDir = path.join(root, '.tools/reports', `check-${runId}`);
const scratchDir = path.join(reportDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });
const temporaryDir = path.join(scratchDir, 'tmp');
fs.mkdirSync(temporaryDir, { recursive: true });
const realTemporaryDir = fs.realpathSync(temporaryDir);
const summaryPath = path.join(reportDir, 'summary.json');
const summary = {
  schema: 'reverie.macos.check.v1',
  startedAt: new Date().toISOString(),
  mode: envOnly ? 'env-only' : 'full',
  projectRoot: root,
  reportDirectory: reportDir,
  toolchain: {
    platform: manifest.platform, architecture: manifest.arch,
    python: manifest.python.version, pythonBuild: manifest.python.build,
    node: manifest.node.version, uv: manifest.uv.version, pnpm: manifest.pnpm.version,
    development: manifest.development,
  },
  locks: Object.fromEntries(['requirements-macos-arm64.lock', 'requirements-macos-arm64-dev.lock', 'frontend/pnpm-lock.yaml'].map((name) => {
    try { return [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]; }
    catch { return [name, null]; }
  })),
  status: 'running',
  steps: [],
};
const env = {
  ...process.env,
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  // Avoid reading stale/sync-offloaded bytecode from the existing toolchain.
  // -B still prevents writes, and the interpreter/environment stays unchanged.
  PYTHONPYCACHEPREFIX: path.join(scratchDir, 'bytecode'),
  PYTHONUNBUFFERED: '1',
  PYTHON_DOTENV_DISABLED: '1',
  REVERIE_DATA_DIR: path.join(scratchDir, 'data'),
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  TMPDIR: realTemporaryDir,
  TMP: realTemporaryDir,
  TEMP: realTemporaryDir,
};
delete env.PYTHONPATH;
delete env.PYTHONHOME;
delete env.REVERIE_STORAGE_KEY_FD;
delete env.REVERIE_REQUIRE_ENCRYPTED_STORAGE;

function saveSummary() {
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function inside(candidate, directory) {
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function checkNode() {
  const details = {
    version: process.versions.node,
    architecture: process.arch,
    platform: process.platform,
    executable: process.execPath,
    realExecutable: fs.realpathSync(process.execPath),
  };
  const issues = [];
  for (const [name, hash] of Object.entries(summary.locks)) {
    if (!hash) issues.push(`Dependency lock is missing or unreadable: ${name}`);
  }
  try {
    if (!fs.readFileSync(path.join(root, 'frontend/pnpm-lock.yaml')).equals(
      fs.readFileSync(path.join(root, 'frontend/node_modules/.pnpm/lock.yaml')))) {
      issues.push('Installed frontend lock differs from the committed dependency lock');
    }
  } catch { issues.push('Installed frontend dependency lock is missing or unreadable'); }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') issues.push('Expected macOS arm64');
  if (process.versions.node !== manifest.node.version) issues.push(`Expected Node ${manifest.node.version}`);
  try {
    if (!inside(process.execPath, path.join(root, '.tools/node'))) issues.push('Node is outside the project toolchain');
    if (fs.realpathSync(node) !== details.realExecutable) issues.push('REVERIE_NODE differs from the running Node');
  } catch (error) {
    issues.push(`Node path check failed: ${error.code || error.name}`);
  }
  details.toolPaths = {};
  for (const [name, executable] of [['uv', uv], ['pnpm', pnpm]]) {
    try {
      details.toolPaths[name] = fs.realpathSync(executable);
      if (!inside(executable, path.join(root, '.tools', name))) issues.push(`${name} is outside the project toolchain`);
    } catch (error) {
      issues.push(`${name} path check failed: ${error.code || error.name}`);
    }
  }
  const report = { ...details, issues, ok: issues.length === 0 };
  const log = path.join(reportDir, '00-node.json');
  fs.writeFileSync(log, `${JSON.stringify(report, null, 2)}\n`);
  summary.steps.push({ name: 'node-environment', status: report.ok ? 'passed' : 'failed', exitCode: report.ok ? 0 : 1, durationSeconds: 0, log });
  process.stdout.write(`[${report.ok ? 'PASS' : 'FAIL'}] node-environment\n`);
  saveSummary();
}

let activeChild = null;
function stopGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* Already exited. */ }
  }
}

function runStep(name, command, commandArgs, options = {}) {
  const index = String(summary.steps.length).padStart(2, '0');
  const logPath = path.join(reportDir, `${index}-${name}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  process.stdout.write(`[RUN ] ${name}\n`);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeout;
    let escalation;
    let captured = '';
    const child = spawn(command, commandArgs, {
      cwd: options.cwd || root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    const output = (chunk) => {
      fs.writeSync(logFd, chunk);
      if (options.expectedOutput) captured = `${captured}${chunk.toString('utf8')}`.slice(-8192);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    function finish(exitCode, signal, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      activeChild = null;
      if (error) fs.writeSync(logFd, `Launch error: ${error.code || error.name}\n`);
      let outputMatches = true;
      if (options.expectedOutput && exitCode === 0) {
        outputMatches = options.expectedOutput.test(captured.trim());
        if (!outputMatches) fs.writeSync(logFd, 'Version output did not match the pinned toolchain.\n');
      }
      fs.closeSync(logFd);
      const passed = exitCode === 0 && !error && !timedOut && outputMatches;
      const result = {
        name, status: passed ? 'passed' : 'failed', startedAt,
        durationSeconds: Number((Number(process.hrtime.bigint() - started) / 1e9).toFixed(3)),
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal || null, timedOut,
        ...(error ? { errorCode: error.code || error.name } : {}),
        command: [command, ...commandArgs], log: logPath,
      };
      summary.steps.push(result);
      saveSummary();
      process.stdout.write(`[${passed ? 'PASS' : 'FAIL'}] ${name} (${result.durationSeconds}s)${passed ? '' : ` — ${logPath}`}\n`);
      resolve(result);
    }
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
    timeout = setTimeout(() => {
      timedOut = true;
      stopGroup(child, 'SIGTERM');
      escalation = setTimeout(() => stopGroup(child, 'SIGKILL'), 3000);
    }, options.timeoutMs || 300_000);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (activeChild) stopGroup(activeChild, 'SIGKILL');
    summary.status = 'interrupted';
    summary.finishedAt = new Date().toISOString();
    saveSummary();
    process.stderr.write(`Check interrupted; report: ${summaryPath}\n`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function main() {
  process.stdout.write(`macOS ${summary.mode} checks — reports: ${reportDir}\n`);
  saveSummary();
  checkNode();
  await runStep('python-environment', python, ['-I', '-B', '-X', `pycache_prefix=${env.PYTHONPYCACHEPREFIX}`, path.join(__dirname, 'check-macos-env.py'), '--mode', 'environment', '--report', path.join(reportDir, 'python-environment.json')]);
  await runStep('uv-version', uv, ['--version'], { expectedOutput: new RegExp(`^uv ${manifest.uv.version.split('.').join('\\.')}(?:\\s|$)`) });
  await runStep('pnpm-version', node, [pnpm, '--version'], { expectedOutput: new RegExp(`^${manifest.pnpm.version.split('.').join('\\.')}$`) });
  await runStep('python-dependency-consistency', uv, ['pip', 'check', '--python', python]);
  await runStep('encrypted-storage', python, ['-I', '-B', '-X', `pycache_prefix=${env.PYTHONPYCACHEPREFIX}`, path.join(__dirname, 'check-macos-env.py'), '--mode', 'storage', '--scratch', scratchDir, '--report', path.join(reportDir, 'encrypted-storage.json')]);
  if (!envOnly) {
    await runStep('pytest', python, ['-m', 'pytest'], { timeoutMs: 30 * 60_000 });
    // Execute the same installed script tools directly. pnpm 11 may implicitly
    // run install when linked source metadata changes, which a check must never do.
    const frontend = path.join(root, 'frontend');
    for (const configuration of ['tsconfig.json', 'tsconfig.node.json']) {
      await runStep(`frontend-typecheck-${configuration}`, node,
        [path.join(frontend, 'node_modules/typescript/bin/tsc'), '-p', configuration, '--noEmit'],
        { cwd: frontend, timeoutMs: 20 * 60_000 });
    }
    await runStep('frontend-test', node, [path.join(frontend, 'script/test-mvp.cjs')], { cwd: frontend, timeoutMs: 20 * 60_000 });
    await runStep('frontend-build', node, [path.join(frontend, 'script/run-clean-tool.cjs'), 'vite', 'build'], { cwd: frontend, timeoutMs: 20 * 60_000 });
    await runStep('framed-bridge', node, [path.join(__dirname, 'smoke-framed-bridge.cjs'), python], { timeoutMs: 120_000 });
    await runStep('desktop-core', node, [path.join(frontend, 'script/e2e-desktop-core-smoke.cjs')], { cwd: frontend, timeoutMs: 300_000 });
  }
  summary.finishedAt = new Date().toISOString();
  summary.status = summary.steps.every((step) => step.status === 'passed') ? 'passed' : 'failed';
  saveSummary();
  process.stdout.write(`Check ${summary.status}: ${summaryPath}\n`);
  process.exitCode = summary.status === 'passed' ? 0 : 1;
}

main().catch((error) => {
  if (activeChild) stopGroup(activeChild, 'SIGKILL');
  summary.status = 'failed';
  summary.finishedAt = new Date().toISOString();
  summary.runnerError = { name: error.name, code: error.code || null };
  saveSummary();
  process.stderr.write(`Check runner failed (${error.name}); report: ${summaryPath}\n`);
  process.exitCode = 1;
});
