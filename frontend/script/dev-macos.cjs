'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveMacDevelopmentPython } = require('../electron/python-command.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(projectRoot, 'frontend');
const nodeExecutable = path.join(projectRoot, '.tools', 'node', 'bin', 'node');
const host = '127.0.0.1';
const port = 5173;
const viteStartupTimeoutMs = 120_000;
const children = new Set();
let stopping = false;
let stopPromise;
let requestedExitCode = 0;
let pythonStartupReportPath = null;

function probeProjectPython() {
  const reportDirectory = path.join(projectRoot, '.tools', 'reports', 'python-startup');
  const startedAt = new Date().toISOString();
  const filename = `${startedAt.replace(/[:.]/g, '-')}-${process.pid}.json`;
  let writeWarningShown = false;
  const record = (event) => {
    // The resolver only supplies allowlisted metadata and redacted stderr.
    // Never serialize process.env or the probe's raw stdout here.
    const report = { schema: 'reverie.python-startup.v1', launcherPid: process.pid,
      launcherStartedAt: startedAt, ...event };
    try {
      fs.mkdirSync(reportDirectory, { recursive: true });
      const contents = `${JSON.stringify(report, null, 2)}\n`;
      const destinations = [filename, 'latest.json'];
      if (event.type === 'failure') destinations.push('latest-failure.json');
      for (const destination of destinations) {
        const target = path.join(reportDirectory, destination);
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, contents, { mode: 0o600 });
        fs.renameSync(temporary, target);
      }
      pythonStartupReportPath = path.join(reportDirectory, filename);
    } catch (error) {
      if (!writeWarningShown) {
        console.error(`[Reverie dev] Could not save Python diagnostic (${error.code || 'IO_ERROR'}).`);
        writeWarningShown = true;
      }
    }
    if (event.type === 'retry') {
      console.error('[Reverie dev] Python 检查超过 10 秒，正在重试同一环境（最多 30 秒）。');
    }
  };
  record({ type: 'checking' });
  console.error('[Reverie dev] Checking project Python...');
  return resolveMacDevelopmentPython(projectRoot, { onDiagnostic: record });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkAddressAvailable(address) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already occupied. Stop its owner or use that existing development session.`));
      } else {
        reject(error);
      }
    });
    server.listen({ host: address, port, exclusive: true, ipv6Only: address === '::1' }, () => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  });
}

async function checkPortAvailable() {
  // Electron's development URL uses localhost. Reject an existing listener on
  // either loopback family, even though our own Vite binds IPv4 explicitly.
  await checkAddressAvailable(host);
  await checkAddressAvailable('::1');
}

function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: frontendRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function stopOwnedChildren() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    const owned = [...children];
    for (const child of owned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await Promise.all(owned.map(async (child) => {
      if (!await waitForClose(child, 5_000)) {
        // Kill only child processes created in this invocation. Port owners and
        // any previously running Reverie instance are never terminated here.
        child.kill('SIGKILL');
        await waitForClose(child, 2_000);
      }
    }));
  })();
  return stopPromise;
}

function checkHttpReady() {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: '/', timeout: 1_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('This development launcher requires native Apple Silicon macOS.');
  }
  if (fs.realpathSync(process.execPath) !== fs.realpathSync(nodeExecutable)) {
    throw new Error('Use script/dev-macos.sh so the project-local Node runtime is selected.');
  }
  await checkPortAvailable();
  if (stopping) return;
  const python = probeProjectPython();
  console.error(`[Reverie dev] Python: ${python}`);
  const electronExecutable = require('electron');
  if (typeof electronExecutable !== 'string' || !fs.existsSync(electronExecutable)) {
    throw new Error('The Electron executable is unavailable. Run script/setup-macos.sh.');
  }
  const vite = spawnOwned(nodeExecutable, [
    path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', host, '--port', String(port), '--strictPort',
  ]);
  let viteOutput = '';
  let viteAdvertisedReady = false;
  let viteFailure;
  vite.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    viteOutput = (viteOutput + String(chunk)).slice(-16_384);
    // Require the readiness message from our own child before probing HTTP.
    // A separate server that races for the port cannot satisfy this check.
    const plain = viteOutput.replace(/\u001b\[[0-9;]*m/g, '');
    viteAdvertisedReady ||= /Local:\s+http:\/\/127\.0\.0\.1:5173\//.test(plain);
  });
  vite.stderr.on('data', (chunk) => process.stderr.write(chunk));
  vite.once('error', (error) => { viteFailure = error; });
  vite.once('exit', (code, signal) => {
    viteFailure ||= new Error(`Vite stopped (${code ?? signal ?? 'unknown'}).`);
    if (!stopping) {
      requestedExitCode = 1;
      void stopOwnedChildren();
    }
  });

  const waitStarted = Date.now();
  const deadline = waitStarted + viteStartupTimeoutMs;
  let nextProgressAt = waitStarted + 10_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    if (viteFailure) throw viteFailure;
    if (viteAdvertisedReady && await checkHttpReady()) {
      if (!viteFailure && vite.exitCode === null && vite.signalCode === null) {
        ready = true;
        break;
      }
    }
    if (Date.now() >= nextProgressAt) {
      console.error(`[Reverie dev] Waiting for Vite (${Math.floor((Date.now() - waitStarted) / 1000)}s / ${viteStartupTimeoutMs / 1000}s); dependency files may still be loading.`);
      nextProgressAt = Date.now() + 10_000;
    }
    await delay(100);
  }
  if (viteFailure) throw viteFailure;
  if (stopping) return;
  if (!ready) throw new Error(`The Vite process did not become ready within ${viteStartupTimeoutMs / 1000} seconds (own ready log: ${viteAdvertisedReady ? 'received' : 'not received'}).`);

  console.error('[Reverie dev] Vite ready; starting Electron. Press Ctrl-C to stop this session.');
  const electron = spawnOwned(electronExecutable, ['.']);
  electron.stdout.on('data', (chunk) => process.stdout.write(chunk));
  electron.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await new Promise((resolve, reject) => {
    electron.once('error', reject);
    electron.once('exit', (code, signal) => {
      if (!stopping) requestedExitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    requestedExitCode = code;
    void stopOwnedChildren();
  });
}

main().catch((error) => {
  requestedExitCode = 1;
  console.error(`[Reverie dev] ${error.message}`);
  if (error.code === 'REVERIE_DEV_PYTHON_INVALID' && pythonStartupReportPath) {
    console.error(`[Reverie dev] Python startup diagnostic: ${pythonStartupReportPath}`);
  }
}).finally(async () => {
  await stopOwnedChildren();
  process.exitCode = requestedExitCode;
});
