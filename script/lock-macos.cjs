'use strict';

// Deliberate maintainer action. Setup only consumes committed locks.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../config/macos-toolchain.json');
const tools = path.join(root, '.tools');
const python = path.join(root, '.venv', 'bin', 'python');
function run(command, args) {
  const value = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (value.error) throw value.error;
  if (value.status !== 0) throw new Error(`${command} exited ${value.status}\n${value.stdout}\n${value.stderr}`);
  return value.stdout.trim();
}
const probe = JSON.parse(run(python, ['-I', '-c', 'import json,platform,sys;print(json.dumps([platform.python_version(),platform.machine(),sys.platform]))']));
if (JSON.stringify(probe) !== JSON.stringify([manifest.python.version, 'arm64', 'darwin'])) throw new Error('Lock generation requires the pinned macOS arm64 Python');
const lockEnv = path.join(tools, 'lock-env');
if (!fs.existsSync(lockEnv)) run(python, ['-I', '-m', 'venv', lockEnv]);
const resolver = path.join(lockEnv, 'bin', 'python');
const pip = run(resolver, ['-I', '-m', 'pip', '--version']).split(' ')[1];
if (pip !== '25.0.1') throw new Error(`Expected the pinned Python archive's bundled pip 25.0.1, got ${pip}`);
const cache = path.join(tools, 'cache', 'pip');
const dir = path.join(tools, 'lock-resolution');
fs.mkdirSync(dir, { recursive: true });
const input = path.join(dir, 'dev.in');
fs.writeFileSync(input, `-r ${path.join(root, 'requirements-runtime.txt')}\n` + Object.entries(manifest.development).map(([name, version]) => `${name}==${version}`).join('\n') + '\n');
// Do not publish one half of the pair if the second resolution fails.
const candidates = [];
for (const [kind, source, output] of [
  ['runtime', path.join(root, 'requirements-runtime.txt'), 'requirements-macos-arm64.lock'],
  ['dev', input, 'requirements-macos-arm64-dev.lock'],
]) {
  console.log(`Resolving ${kind} macOS arm64 wheels (no installation)...`);
  const report = path.join(dir, `${kind}.json`);
  run(resolver, ['-I', '-m', 'pip', '--isolated', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:', '--disable-pip-version-check', '--cache-dir', cache, '--index-url', 'https://pypi.org/simple', '--report', report, '-r', source]);
  const resolved = JSON.parse(fs.readFileSync(report, 'utf8'));
  const rows = resolved.install.map((item) => {
    const filename = decodeURIComponent(new URL(item.download_info.url).pathname.split('/').pop());
    const hash = item.download_info.archive_info.hashes.sha256;
    if (!filename.endsWith('.whl') || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`No verified wheel for ${item.metadata.name}`);
    const name = item.metadata.name.toLowerCase().replace(/[-_.]+/g, '-');
    return { name, version: item.metadata.version, hash, filename };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const pins = fs.readFileSync(path.join(root, 'requirements-runtime.txt'), 'utf8').split(/\r?\n/).filter((line) => /^[a-z]/i.test(line)).map((line) => line.trim().split('=='));
  for (const [name, version] of pins) {
    if (!rows.some((row) => row.name === name && row.version === version)) throw new Error(`Runtime pin drift: ${name}==${version}`);
  }
  if (kind === 'runtime' && rows.length !== pins.length) throw new Error('Runtime closure changed; review the source requirements before locking');
  const text = `# macOS arm64 / CPython ${manifest.python.version}; ${kind} wheel lock.\n# Regenerate deliberately with ./script/lock-macos.sh (pip ${pip}).\n# Exact wheels selected on native macOS; installation never falls back to source.\n` + rows.map((row) => `# ${row.filename}\n${row.name}==${row.version} \\\n    --hash=sha256:${row.hash}\n`).join('');
  candidates.push({ output, text, rows });
}
const [runtime, development] = candidates;
for (const row of runtime.rows) {
  if (!development.rows.some((candidate) => candidate.name === row.name && candidate.version === row.version && candidate.hash === row.hash)) {
    throw new Error(`Runtime/dev wheel mismatch: ${row.name}`);
  }
}
for (const candidate of candidates) fs.writeFileSync(path.join(dir, candidate.output), candidate.text);
for (const candidate of candidates) {
  fs.renameSync(path.join(dir, candidate.output), path.join(root, candidate.output));
  console.log(`Wrote ${candidate.output}: ${candidate.rows.length} pinned packages.`);
}
