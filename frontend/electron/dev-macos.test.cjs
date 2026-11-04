'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

async function listen(server, address = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: address, port: 5173, ipv6Only: address === '::1' }, resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function fixture(t, { viteFails = false, electronWaits = false, pythonFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie dev fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text, mode) => {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text, { mode });
  };
  write('frontend/script/dev-macos.cjs', fs.readFileSync(path.join(__dirname, '..', 'script', 'dev-macos.cjs')));
  write('frontend/electron/python-command.cjs', fs.readFileSync(path.join(__dirname, 'python-command.cjs')));
  write('frontend/electron/safe-log.cjs', fs.readFileSync(path.join(__dirname, 'safe-log.cjs')));
  fs.mkdirSync(path.join(root, '.tools', 'node', 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(root, '.tools', 'node', 'bin', 'node'));
  fs.mkdirSync(path.join(root, 'base'));
  const probe = JSON.stringify({
    version: [3, 12, 14], platform: 'darwin', machine: 'arm64',
    prefix: path.join(root, '.venv'), basePrefix: path.join(root, 'base'),
  });
  write('.venv/bin/python', pythonFails
    ? '#!/bin/sh\nprintf "startup failed: api_key=private-probe-test-token\\n" >&2\nexit 23\n'
    : `#!/bin/sh\nprintf '%s\\n' '${probe}'\n`, 0o755);
  write('frontend/node_modules/electron/index.js', 'module.exports = process.execPath;\n');
  write('frontend/package.json', JSON.stringify({ main: 'fake-electron.cjs' }));
  write('frontend/fake-electron.cjs', `
    require('node:fs').writeFileSync('electron-started', String(process.pid));
    ${electronWaits ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(0), 100);'}
  `);
  write('frontend/node_modules/vite/bin/vite.js', viteFails ? 'process.exit(7);\n' : `
    const fs = require('node:fs');
    const server = require('node:http').createServer((_req, res) => res.end('fixture'));
    fs.writeFileSync('vite-args', JSON.stringify(process.argv.slice(2)));
    server.listen(5173, '127.0.0.1', () => {
      fs.writeFileSync('vite-started', String(process.pid));
      console.log('  Local:   http://127.0.0.1:5173/');
    });
    process.on('SIGTERM', () => {
      fs.writeFileSync('vite-stopped', 'SIGTERM');
      server.close(() => process.exit(0));
    });
  `);
  return { root, file: (name) => path.join(root, 'frontend', name) };
}

function start(f, t) {
  const child = spawn(process.execPath, [f.file('script/dev-macos.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Development launcher test timed out: ${output}`));
    }, 12_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completion.catch(() => {});
  });
  return { child, completion };
}

async function waitForFile(filename) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error(`File was not created: ${filename}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test('macOS development launcher owns its Vite/Electron process lifecycle', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64' ? 'native macOS launcher' : false,
}, async (t) => {
  // Fixed-port integration tests must never interfere with an existing session.
  for (const address of ['127.0.0.1', '::1']) {
    const availability = net.createServer();
    try {
      await listen(availability, address);
      await close(availability);
    } catch (error) {
      if (error.code === 'EADDRINUSE') { t.skip('port 5173 belongs to an existing session'); return; }
      throw error;
    }
  }

  await t.test('occupied port fails without starting children or stopping the owner', async (t) => {
    const owner = net.createServer();
    await listen(owner);
    t.after(() => close(owner));
    const f = fixture(t);
    const result = await start(f, t).completion;
    assert.equal(result.code, 1);
    assert.match(result.output, /Port 5173 is already occupied/);
    assert.equal(owner.listening, true);
    assert.equal(fs.existsSync(f.file('electron-started')), false);
    assert.equal(fs.existsSync(f.file('vite-started')), false);
  });

  await t.test('Vite startup failure does not start Electron', async (t) => {
    const f = fixture(t, { viteFails: true });
    const result = await start(f, t).completion;
    assert.equal(result.code, 1);
    assert.match(result.output, /Vite stopped \(7\)/);
    assert.equal(fs.existsSync(f.file('electron-started')), false);
  });

  await t.test('Python failure records its real exit reason without leaking stderr credentials', async (t) => {
    const f = fixture(t, { pythonFails: true });
    const result = await start(f, t).completion;
    assert.equal(result.code, 1);
    assert.match(result.output, /Python startup diagnostic:/);
    assert.equal(result.output.includes('private-probe-test-token'), false);
    assert.equal(fs.existsSync(f.file('vite-started')), false);
    assert.equal(fs.existsSync(f.file('electron-started')), false);
    const filename = path.join(f.root, '.tools/reports/python-startup/latest-failure.json');
    const text = fs.readFileSync(filename, 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.type, 'failure');
    assert.equal(report.reason, 'probe_exit');
    assert.equal(report.diagnostics.attempts.length, 1);
    assert.equal(report.diagnostics.attempts[0].exitCode, 23);
    assert.equal(text.includes('private-probe-test-token'), false);
    assert.match(report.diagnostics.attempts[0].stderr, /\[REDACTED\]/);
  });

  await t.test('Electron starts after owned Vite is ready and exit stops owned Vite', async (t) => {
    const f = fixture(t);
    const result = await start(f, t).completion;
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(fs.readFileSync(path.join(f.root, '.tools/reports/python-startup/latest.json'), 'utf8'));
    assert.equal(report.type, 'validated');
    assert.equal(fs.existsSync(f.file('electron-started')), true);
    assert.equal(fs.readFileSync(f.file('vite-stopped'), 'utf8'), 'SIGTERM');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file('vite-args'), 'utf8')), [
      '--host', '127.0.0.1', '--port', '5173', '--strictPort',
    ]);
  });

  await t.test('interrupting the launcher stops both owned processes', async (t) => {
    const f = fixture(t, { electronWaits: true });
    const { child, completion } = start(f, t);
    await waitForFile(f.file('electron-started'));
    const electronPid = Number(fs.readFileSync(f.file('electron-started'), 'utf8'));
    child.kill('SIGINT');
    const result = await completion;
    assert.equal(result.code, 130, result.output);
    assert.equal(fs.readFileSync(f.file('vite-stopped'), 'utf8'), 'SIGTERM');
    assert.throws(() => process.kill(electronPid, 0), { code: 'ESRCH' });
  });
});
