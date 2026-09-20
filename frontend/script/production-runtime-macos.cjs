'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MANIFEST_NAME = 'reverie-python-runtime.json';
const SCHEMA = 'reverie.python.macos.runtime.v1';
const FORBIDDEN_PACKAGES = new Set(['pip', 'setuptools', 'wheel', 'uv', 'pytest', 'hypothesis', 'playwright', 'pytest-playwright', 'textual', 'pyyaml', 'torch', 'sentence-transformers', 'lancedb']);
const canonical = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.error?.code || result.status}/${result.signal || ''}): ${(result.stderr || '').slice(-3000)}`);
  }
  return result.stdout.trim();
}

function buildEnvironment(scratch) {
  const environment = {};
  // Start from a small build environment; explicit tool paths remove ambient
  // Python/uv/pip/DYLD settings and never select Homebrew or a user interpreter.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  for (const directory of ['tmp', 'cache', 'data']) fs.mkdirSync(path.join(scratch, directory), { recursive: true });
  return { ...environment, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: path.join(scratch, 'tmp'), TMP: path.join(scratch, 'tmp'), TEMP: path.join(scratch, 'tmp'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_DATA_HOME: path.join(scratch, 'data'),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHON_DOTENV_DISABLED: '1',
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PIP_CONFIG_FILE: '/dev/null', UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'never',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
}

function parseRuntimeLock(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let wheel;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const match = /^# ([A-Za-z0-9_.+-]+\.whl)$/.exec(line);
      if (match) wheel = match[1];
      continue;
    }
    const pin = /^([a-z0-9.-]+)==([^\s;\\]+) \\$/.exec(line);
    const digest = /^\s*--hash=sha256:([a-f0-9]{64})\s*$/.exec(lines[index + 1] || '');
    if (!pin || !digest || !wheel) throw new Error('Runtime lock must contain exact wheel names, pins and single SHA-256 hashes');
    const name = canonical(pin[1]);
    if (FORBIDDEN_PACKAGES.has(name) || rows.some((row) => row.name === name)) throw new Error(`Unexpected runtime distribution: ${name}`);
    rows.push({ name, version: pin[2], filename: wheel, sha256: digest[1] });
    wheel = undefined;
    index += 1;
  }
  if (rows.length !== 47) throw new Error(`Expected the 47-package runtime closure, received ${rows.length}`);
  return rows;
}

function inspectTree(runtimeRoot) {
  const root = fs.realpathSync(runtimeRoot);
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      const entry = { path: relative(root, file) };
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) || !contained(root, path.resolve(path.dirname(file), target))) throw new Error(`Non-relocatable symlink: ${entry.path}`);
        const resolved = fs.realpathSync(file);
        if (!contained(root, resolved)) throw new Error(`Escaping symlink: ${entry.path}`);
        entries.push({ ...entry, type: 'symlink', target });
      } else if (stat.isDirectory()) {
        entries.push({ ...entry, type: 'directory' });
        visit(file);
      } else if (stat.isFile()) {
        entries.push({ ...entry, type: 'file', size: stat.size, mode: stat.mode & 0o777, sha256: hashFile(file) });
      } else throw new Error(`Special filesystem object in runtime: ${entry.path}`);
    }
  }
  visit(root);
  return entries;
}

function isMachO(file) {
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(4);
  let count;
  try { count = fs.readSync(descriptor, header, 0, 4, 0); } finally { fs.closeSync(descriptor); }
  return count === 4 && new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']).has(header.toString('hex'));
}

function machoMetadata(file) {
  const loadCommands = run('/usr/bin/otool', ['-l', file]);
  const rpaths = [...loadCommands.matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map((match) => match[1]);
  const identity = /\bcmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/.exec(loadCommands)?.[1];
  const dependencies = run('/usr/bin/otool', ['-L', file]).split('\n').slice(1)
    .map((line) => /^\s*(.+?) \(compatibility version /.exec(line)?.[1]).filter((name) => name && name !== identity);
  const architectures = run('/usr/bin/lipo', ['-archs', file]).split(/\s+/);
  return { architectures, dependencies, rpaths, ...(identity ? { installName: identity } : {}) };
}

function resolveLoaderPath(value, file, executable, root) {
  let resolved;
  if (value === '@loader_path' || value.startsWith('@loader_path/')) resolved = path.resolve(path.dirname(file), value.slice('@loader_path'.length).replace(/^\//, ''));
  else if (value === '@executable_path' || value.startsWith('@executable_path/')) resolved = path.resolve(path.dirname(executable), value.slice('@executable_path'.length).replace(/^\//, ''));
  else if (path.isAbsolute(value)) resolved = path.resolve(value);
  else throw new Error(`Unsupported relative Mach-O path: ${value}`);
  if (!contained(root, resolved)) throw new Error(`Mach-O reference leaves runtime: ${value}`);
  return resolved;
}

function isSystemDependency(value) {
  if (!path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized.startsWith('/usr/lib/') || normalized.startsWith('/System/Library/');
}

function canonicalDestination(value) {
  let ancestor = path.resolve(value);
  const missing = [];
  for (;;) {
    try { fs.lstatSync(ancestor); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function externalAuditPath(root, value) {
  const destination = canonicalDestination(value);
  if (contained(root, destination) || destination.split(path.sep).some((name) => name.endsWith('.app'))) throw new Error('Audit output must be outside runtime and application bundles');
  return destination;
}

function auditNative(runtimeRoot, entries) {
  const root = fs.realpathSync(runtimeRoot);
  const executable = path.join(root, 'bin/python3.12');
  const native = entries.filter((entry) => entry.type === 'file' && isMachO(path.join(root, entry.path)))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256, ...machoMetadata(path.join(root, entry.path)) }));
  const executableMetadata = native.find((entry) => entry.path === 'bin/python3.12');
  if (!executableMetadata) throw new Error('Production Python must be a regular Mach-O bin/python3.12');
  for (const entry of native) {
    if (entry.architectures.length !== 1 || entry.architectures[0] !== 'arm64') throw new Error(`Runtime native file is not arm64-only: ${entry.path}`);
    const file = path.join(root, entry.path);
    const runpaths = entry.rpaths.map((value) => resolveLoaderPath(value, file, executable, root));
    runpaths.push(...executableMetadata.rpaths.map((value) => resolveLoaderPath(value, executable, executable, root)));
    entry.resolvedDependencies = entry.dependencies.map((dependency) => {
      if (isSystemDependency(dependency)) return { dependency, kind: 'system' };
      let candidates;
      if (dependency.startsWith('@rpath/')) candidates = runpaths.map((directory) => path.join(directory, dependency.slice('@rpath/'.length)));
      else candidates = [resolveLoaderPath(dependency, file, executable, root)];
      const target = candidates.find((candidate) => fs.existsSync(candidate) && contained(root, fs.realpathSync(candidate)));
      if (!target) throw new Error(`Unresolved non-system Mach-O dependency in ${entry.path}: ${dependency}`);
      return { dependency, kind: 'bundled', target: relative(root, fs.realpathSync(target)) };
    });
  }
  return native;
}

function pruneRuntime(root) {
  const removed = [];
  function remove(file) {
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    removed.push(relative(root, file));
    fs.rmSync(file, { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(path.join(root, 'bin'))) {
    if (name !== 'python3.12') remove(path.join(root, 'bin', name));
  }
  for (const name of ['include', 'share', 'lib/pkgconfig', 'lib/python3.12/ensurepip', 'lib/python3.12/idlelib', 'lib/python3.12/turtledemo', 'lib/python3.12/test', 'lib/python3.12/site-packages/bin']) remove(path.join(root, name));
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (name === '__pycache__' || name === 'tests' || name === 'test' || name.startsWith('config-3.12-') || /\.(py[co]|a|o)$/.test(name) || /^_test.*\.so$/.test(name)) remove(file);
      else if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return removed;
}

function preserveDistributionLicenses(root) {
  const licenses = inspectTree(root).filter((entry) => entry.type === 'file'
    && !entry.path.includes('/site-packages/')
    && /(^|\/)(licen[cs]e|copying|notice)([._-][^/]*)?$/i.test(entry.path));
  for (const entry of licenses) {
    const target = path.join(root, 'licenses/cpython-distribution', entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, entry.path), target);
  }
  return licenses.map((entry) => ({ source: entry.path, retained: `licenses/cpython-distribution/${entry.path}`, sha256: entry.sha256 }));
}

function thinNative(root) {
  const transformations = [];
  for (const entry of inspectTree(root)) {
    if (entry.type !== 'file') continue;
    const file = path.join(root, entry.path);
    if (!isMachO(file)) continue;
    const architectures = run('/usr/bin/lipo', ['-archs', file]).split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error(`No arm64 slice in ${entry.path}`);
    const operations = [];
    if (architectures.length > 1) {
      const temporary = `${file}.arm64-tmp`;
      run('/usr/bin/lipo', [file, '-thin', 'arm64', '-output', temporary]);
      fs.chmodSync(temporary, fs.statSync(file).mode & 0o777);
      fs.renameSync(temporary, file);
      operations.push({ operation: 'lipo-thin-arm64', inputArchitectures: architectures });
    }
    // Some pinned wheels carry unused absolute CI build rpaths. Remove these
    // search paths, then prove that every actual load dependency still resolves
    // inside the bundle or to an Apple system library in the final audit.
    for (const value of machoMetadata(file).rpaths) {
      if (path.isAbsolute(value) && !isSystemDependency(`${value}/placeholder`)) {
        if (contained(root, path.resolve(value))) {
          const replacement = `@loader_path/${relative(path.dirname(file), value)}`;
          run('/usr/bin/install_name_tool', ['-rpath', value, replacement, file]);
          operations.push({ operation: 'relativize-rpath', previous: value, replacement });
        } else {
          run('/usr/bin/install_name_tool', ['-delete_rpath', value, file]);
          operations.push({ operation: 'remove-external-build-rpath', previous: value });
        }
      }
    }
    if (operations.length) {
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
      operations.push({ operation: 'ad-hoc-sign-for-runtime-probe' });
      transformations.push({ path: entry.path, operations, inputSha256: entry.sha256, outputSha256: hashFile(file) });
    }
  }
  return transformations;
}

async function ensureDownload(url, destination, expectedHash) {
  if (fs.existsSync(destination)) {
    if (hashFile(destination) !== expectedHash) throw new Error(`Cached artifact checksum mismatch: ${path.basename(destination)}`);
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.${process.pid}.part`;
  try {
    run('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--connect-timeout', '20', url, '-o', partial], { timeout: 300_000 });
    if (hashFile(partial) !== expectedHash) throw new Error(`Downloaded artifact checksum mismatch: ${path.basename(destination)}`);
    fs.renameSync(partial, destination);
  } finally { fs.rmSync(partial, { force: true }); }
}

async function collectWheels(rows, wheelRoot) {
  for (const row of rows) {
    const destination = path.join(wheelRoot, row.filename);
    if (fs.existsSync(destination)) {
      if (hashFile(destination) !== row.sha256) throw new Error(`Cached wheel checksum mismatch: ${row.filename}`);
      continue;
    }
    const document = JSON.parse(run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--retry', '3', `https://pypi.org/pypi/${row.name}/${row.version}/json`]));
    const artifact = document.urls.find((item) => item.filename === row.filename && item.digests.sha256 === row.sha256);
    if (!artifact || new URL(artifact.url).hostname !== 'files.pythonhosted.org') throw new Error(`The locked wheel is unavailable from PyPI: ${row.filename}`);
    await ensureDownload(artifact.url, destination, row.sha256);
  }
}

async function auditMacRuntime({ runtimeRoot, projectRoot = path.resolve(__dirname, '../..'), probe = true, reportPath, expectedPackages, scratchRoot } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Native macOS arm64 is required for the production runtime audit');
  const root = fs.realpathSync(runtimeRoot);
  const entry = path.join(root, 'bin/python3.12');
  if (!fs.lstatSync(entry).isFile() || fs.lstatSync(entry).isSymbolicLink()) throw new Error('Bundled Python entry must be a real regular file');
  const entries = inspectTree(root).filter((item) => item.path !== MANIFEST_NAME);
  for (const item of entries) {
    if (item.path === 'pyvenv.cfg' || /(^|\/)(__pycache__|node_modules)(\/|$)|\.py[co]$/.test(item.path)) throw new Error(`Developer/cache file in runtime: ${item.path}`);
  }
  const rows = expectedPackages || JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8')).packages;
  if (rows.length !== 47 || rows.some((item) => FORBIDDEN_PACKAGES.has(canonical(item.name)))) throw new Error('Runtime package inventory is not the 47-package production closure');
  const nativeFiles = auditNative(root, entries);
  const report = { schema: 'reverie.python.macos.audit.v1', architecture: 'arm64', nativeFiles, files: entries };
  const scratchParent = externalAuditPath(root, scratchRoot || fs.realpathSync(os.tmpdir()));
  const outputPath = reportPath ? externalAuditPath(root, reportPath) : null;
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, '.runtime-audit-'));
  if (contained(root, scratch)) throw new Error('Audit scratch must be outside the runtime');
  try {
    const expectedFile = path.join(scratch, 'packages.json');
    fs.writeFileSync(expectedFile, JSON.stringify(Object.fromEntries(rows.map((row) => [row.name, row.version]))));
    const args = ['-I', '-B', path.join(projectRoot, 'frontend/script/production-runtime-macos-probe.py'), '--runtime-root', root, '--expected-packages', expectedFile, '--scratch', scratch];
    if (!probe) args.push('--inventory-only');
    report.probe = JSON.parse(run(entry, args, { cwd: scratch, env: buildEnvironment(scratch), timeout: 180_000 }));
    const after = inspectTree(root).filter((item) => item.path !== MANIFEST_NAME);
    if (JSON.stringify(entries) !== JSON.stringify(after)) throw new Error('Runtime probe modified bundled files');
    report.runtimeUnchanged = true;
    report.ok = true;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function stageMacPythonRuntime({ projectRoot = path.resolve(__dirname, '../..'), stagingRoot, cacheRoot, uvPath, sourceArchive, onProgress } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Production Python staging requires native macOS arm64');
  const root = fs.realpathSync(projectRoot);
  const destination = path.resolve(stagingRoot);
  const cache = path.resolve(cacheRoot || path.join(root, 'frontend/.macos-runtime-cache'));
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const finalRoot = path.join(destination, 'python');
  if (fs.existsSync(finalRoot)) throw new Error(`Refusing to replace an existing staged runtime: ${finalRoot}`);
  const configuration = JSON.parse(fs.readFileSync(path.join(root, 'config/macos-toolchain.json'), 'utf8'));
  if (configuration.python.version !== '3.12.14' || configuration.python.build !== '20260901' || configuration.python.download.arch.family !== 'aarch64') throw new Error('Unexpected production Python source identity');
  const lockPath = path.join(root, 'requirements-macos-arm64.lock');
  const packages = parseRuntimeLock(fs.readFileSync(lockPath, 'utf8'));
  const uv = path.resolve(uvPath || path.join(root, '.tools/uv/uv'));
  if (run(uv, ['--version']).split(/\s+/)[1] !== configuration.uv.version) throw new Error('Build-only uv version does not match the pinned toolchain');
  const archive = path.resolve(sourceArchive || path.join(cache, `cpython-${configuration.python.version}-${configuration.python.build}.tar.gz`));
  if (sourceArchive) {
    if (hashFile(archive) !== configuration.python.download.sha256) throw new Error('Supplied Python archive checksum mismatch');
  } else await ensureDownload(configuration.python.download.url, archive, configuration.python.download.sha256);
  const names = run('/usr/bin/tar', ['-tf', archive]).split('\n');
  if (names.some((name) => !name.startsWith('python/') || name.split('/').includes('..') || name.includes('\\'))) throw new Error('Unsafe Python archive layout');
  const work = fs.mkdtempSync(path.join(destination, '.python-stage-'));
  const temporaryRoot = path.join(work, 'python');
  const scratch = path.join(work, 'build-scratch');
  const progress = (message) => { try { if (typeof onProgress === 'function') onProgress(message); } catch { /* Progress reporting cannot change the staged artifact. */ } };
  try {
    progress('Extracting checksum-verified CPython source archive');
    run('/usr/bin/tar', ['-xzf', archive, '-C', work]);
    inspectTree(temporaryRoot);
    const distributionLicenses = preserveDistributionLicenses(temporaryRoot);
    const python = path.join(temporaryRoot, 'bin/python3.12');
    if (!fs.lstatSync(python).isFile() || fs.lstatSync(python).isSymbolicLink()) throw new Error('Source archive Python entry is not a regular executable');
    const site = path.join(temporaryRoot, 'lib/python3.12/site-packages');
    // Remove the archive's installer distribution before installing the exact
    // runtime closure. Nothing is copied from a developer Python or venv.
    fs.rmSync(site, { recursive: true, force: true });
    fs.mkdirSync(site, { recursive: true });
    progress('Verifying and installing the 47 locked production wheels');
    const wheelRoot = path.join(cache, 'wheels');
    await collectWheels(packages, wheelRoot);
    const env = buildEnvironment(scratch);
    run(uv, ['--no-config', '--cache-dir', path.join(cache, 'uv'), 'pip', 'sync', '--python', python, '--target', site,
      '--require-hashes', '--only-binary', ':all:', '--no-index', '--find-links', wheelRoot, '--link-mode', 'copy', lockPath], { env, cwd: scratch, timeout: 300_000 });
    const removed = pruneRuntime(temporaryRoot);
    progress('Thinning universal wheel binaries and auditing runtime linkage');
    const transformations = thinNative(temporaryRoot);
    // Physically relocate before invoking the runtime with clean HOME/PATH and
    // unrelated cwd. Any reference to the extraction location must now fail.
    const relocatedParent = path.join(work, 'relocated runtime 中文');
    fs.mkdirSync(relocatedParent);
    const relocated = path.join(relocatedParent, 'python');
    fs.renameSync(temporaryRoot, relocated);
    const audit = await auditMacRuntime({ runtimeRoot: relocated, projectRoot: root, expectedPackages: packages, scratchRoot: work });
    const licenseFiles = audit.files.filter((entry) => entry.type === 'file' && /(^|\/)(licen[cs]e|copying|notice)([._-][^/]*)?$/i.test(entry.path));
    if (!licenseFiles.some((entry) => entry.path === 'lib/python3.12/LICENSE.txt')) throw new Error('CPython license is missing');
    const manifest = { schema: SCHEMA, inventoryStage: 'pre-app-signing', platform: 'darwin', architecture: 'arm64',
      source: { version: configuration.python.version, build: configuration.python.build, url: configuration.python.download.url, sha256: configuration.python.download.sha256 },
      lock: { filename: 'requirements-macos-arm64.lock', sha256: hashFile(lockPath) },
      layout: { executable: 'bin/python3.12', stdlib: 'lib/python3.12', sitePackages: 'lib/python3.12/site-packages', standalone: true },
      packages: packages.map((row) => ({ ...row, ...(audit.probe.packages.find((item) => item.name === row.name) || {}) })),
      transformations, removed, distributionLicenses, licenseFiles, nativeFiles: audit.nativeFiles, files: audit.files,
      validation: { relocated: true, offlineProbe: audit.probe, runtimeUnchanged: audit.runtimeUnchanged } };
    fs.writeFileSync(path.join(relocated, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(relocated, finalRoot);
    progress('Standalone macOS arm64 Python runtime is ready');
    return { runtimeRoot: finalRoot, manifestPath: path.join(finalRoot, MANIFEST_NAME), manifest, audit };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { stageMacPythonRuntime, auditMacRuntime, parseRuntimeLock, inspectTree, isMachO, resolveLoaderPath, isSystemDependency, externalAuditPath, MANIFEST_NAME };
