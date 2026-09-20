'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const tools = path.join(root, '.tools');
const manifest = require('../config/macos-toolchain.json');
const uv = path.join(tools, 'uv', 'uv');
const pnpm = path.join(tools, 'pnpm', 'bin', 'pnpm.cjs');
const python = path.join(root, '.venv', 'bin', 'python');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--tools-only')) throw new Error('Usage: setup-macos.sh [--tools-only]');
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== `v${manifest.node.version}`) {
  throw new Error('Toolchain platform, architecture or Node version mismatch');
}
function run(command, args, capture = false, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status}${capture ? `: ${result.stderr}` : ''}`);
  return (result.stdout || '').trim();
}
function verify(file, item) {
  const [algorithm, expected, encoding] = item.sha256 ? ['sha256', item.sha256, 'hex'] : ['sha512', item.integrity.replace(/^sha512-/, ''), 'base64'];
  if (crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding) !== expected) throw new Error(`Checksum mismatch: ${file}`);
}
function installArchive(name) {
  const item = manifest[name];
  const target = path.join(tools, name);
  if (fs.existsSync(target)) return;
  const archive = path.join(tools, 'cache', 'downloads', `${name}-${item.version}.tar.gz`);
  if (!fs.existsSync(archive)) {
    console.log(`Downloading ${name} ${item.version} from its pinned release...`);
    run('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '3', '--connect-timeout', '20', item.url, '-o', `${archive}.part`]);
    verify(`${archive}.part`, item);
    fs.renameSync(`${archive}.part`, archive);
  }
  verify(archive, item);
  const staging = fs.mkdtempSync(path.join(tools, 'tmp', `${name}.`));
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', staging]);
  fs.renameSync(staging, target);
}
installArchive('uv');
installArchive('pnpm');
if (!run(uv, ['--version'], true).startsWith(`uv ${manifest.uv.version} `)
    && run(uv, ['--version'], true) !== `uv ${manifest.uv.version}`) throw new Error('Existing uv version mismatch');
if (run(process.execPath, [pnpm, '--version'], true) !== manifest.pnpm.version) throw new Error('Existing pnpm version mismatch');
fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
const wrapper = '#!/bin/sh\nexec "$(dirname "$0")/../node/bin/node" "$(dirname "$0")/../pnpm/bin/pnpm.cjs" "$@"\n';
fs.writeFileSync(path.join(tools, 'bin', 'pnpm'), wrapper, { mode: 0o755 });
const metadata = path.join(tools, 'python-downloads.json');
fs.writeFileSync(metadata, JSON.stringify({ [manifest.python.key]: manifest.python.download }, null, 2) + '\n');
process.env.UV_PYTHON_DOWNLOADS_JSON_URL = pathToFileURL(metadata).href;
const base = path.join(tools, 'python', manifest.python.key.replace('-darwin-', '-macos-'), 'bin', 'python3.12');
if (!fs.existsSync(path.dirname(path.dirname(base)))) run(uv, ['python', 'install', manifest.python.version, '--no-bin']);
if (!fs.existsSync(base)) throw new Error('Existing managed Python is incomplete; it was not replaced');
const probeCode = 'import json,sys,platform; print(json.dumps({"version":platform.python_version(),"arch":platform.machine(),"prefix":sys.prefix,"base_prefix":sys.base_prefix,"executable":sys.executable}))';
function probe(executable) {
  const info = JSON.parse(run(executable, ['-I', '-c', probeCode], true));
  if (info.version !== manifest.python.version || info.arch !== 'arm64') throw new Error(`Python version/architecture mismatch: ${JSON.stringify(info)}`);
  return info;
}
probe(base);
if (!fs.existsSync(path.join(root, '.venv'))) run(uv, ['venv', '--python', base, path.join(root, '.venv')]);
const info = probe(python);
if (fs.realpathSync(info.prefix) !== fs.realpathSync(path.join(root, '.venv')) || info.prefix === info.base_prefix
    || fs.realpathSync(info.base_prefix) !== fs.realpathSync(path.dirname(path.dirname(base)))
    || !/^include-system-site-packages\s*=\s*false\s*$/mi.test(fs.readFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'utf8'))) {
  throw new Error('Existing .venv does not belong to the pinned project Python; it was not replaced');
}
if (args.includes('--tools-only')) {
  console.log('Pinned project tools and isolated .venv are ready (dependencies not installed).');
  process.exit(0);
}
for (const name of ['requirements-macos-arm64.lock', 'requirements-macos-arm64-dev.lock']) {
  if (!fs.existsSync(path.join(root, name))) throw new Error(`Required committed lock is missing: ${name}`);
}
const readLock = (name) => new Map([...fs.readFileSync(path.join(root, name), 'utf8').matchAll(/^([a-z0-9.-]+)==(\S+) \\\n\s+--hash=sha256:([a-f0-9]{64})$/gm)].map((match) => [match[1], `${match[2]}:${match[3]}`]));
const runtimeLock = readLock('requirements-macos-arm64.lock');
const developmentLock = readLock('requirements-macos-arm64-dev.lock');
if (runtimeLock.size !== 47 || developmentLock.size <= runtimeLock.size) throw new Error('Unexpected macOS lock format or package count');
for (const [name, value] of runtimeLock) {
  if (developmentLock.get(name) !== value) throw new Error(`Runtime/dev lock mismatch: ${name}`);
}
run(uv, ['pip', 'sync', '--python', python, '--require-hashes', '--only-binary', ':all:', 'requirements-macos-arm64-dev.lock']);
run(uv, ['pip', 'check', '--python', python]);
const frontend = path.join(root, 'frontend');
const lockPath = path.join(frontend, 'pnpm-lock.yaml');
const before = fs.readFileSync(lockPath);
run(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--store-dir', path.join(tools, 'cache', 'pnpm-store'), `--config.cache-dir=${path.join(tools, 'cache', 'pnpm')}`, `--config.state-dir=${path.join(tools, 'cache', 'pnpm-state')}`], false, frontend);
if (!before.equals(fs.readFileSync(lockPath))) throw new Error('Frozen frontend lock changed unexpectedly');
run(process.execPath, [path.join(frontend, 'script', 'prepare-vendored-runtime.cjs')], false, frontend);
// Electron 42 downloads its binary on demand rather than in postinstall.
// Run the pinned package's checksum-verifying installer as part of setup.
run(process.execPath, [path.join(frontend, 'node_modules', 'electron', 'install.js')], false, frontend);
const electron = require(path.join(frontend, 'node_modules', 'electron'));
const binary = run('/usr/bin/file', [electron], true);
if (!binary.includes('arm64') || !binary.includes('Mach-O')) throw new Error(`Unexpected Electron binary: ${binary}`);
fs.mkdirSync(path.join(tools, 'reports'), { recursive: true });
const hashes = Object.fromEntries(['requirements-macos-arm64.lock', 'requirements-macos-arm64-dev.lock', 'frontend/pnpm-lock.yaml'].map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
fs.writeFileSync(path.join(tools, 'reports', 'setup.json'), JSON.stringify({ completedAt: new Date().toISOString(), toolchain: manifest, python: info, electron, binary, locks: hashes }, null, 2) + '\n');
console.log('Reverie macOS dependencies are ready. Run ./script/check-macos.sh, then ./script/dev-macos.sh.');
