'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PYTHON_RUNTIME = Object.freeze({
  version: '3.12.10',
  architecture: 'win_amd64',
  filename: 'python-3.12.10-embed-amd64.zip',
  url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',
  sha256: '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3',
  sigstoreUrl:
    'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.sigstore',
});

const OMITTED_SOURCE_MODULES = Object.freeze([
  'affairs',
  'ambient',
  'anime_service',
  'archive',
  'backup',
  'diary',
  'interest',
  'lorebook',
  'notifications',
  'tests',
  'timeline',
  'ui',
  'web',
  'work_manager',
]);

const FORBIDDEN_RUNTIME_NAMES = Object.freeze([
  '.git',
  '.pytest_cache',
  '.venv',
  '_tests',
  '__fixtures__',
  '__tests__',
  'anime_service',
  'lancedb',
  'lorebook',
  'playwright',
  'pytest',
  'sentence_transformers',
  'test',
  'tests',
  'torch',
  'transformers',
  'venv',
]);

function normalizePackageName(value) {
  return String(value || '').trim().toLowerCase().replace(/[_.]+/g, '-');
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(parent, child, label = 'Path') {
  if (!isInside(parent, child)) {
    throw new Error(`${label} escaped ${path.resolve(parent)}: ${path.resolve(child)}`);
  }
}

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? undefined : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `: ${(result.stderr || result.stdout || '').trim().slice(0, 4000)}`
      : '';
    throw new Error(`${path.basename(command)} exited with code ${result.status}${detail}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function removeInside(parent, target) {
  assertInside(parent, target, 'Removal path');
  fs.rmSync(target, { recursive: true, force: true });
}

function downloadWithPowerShell(url, target) {
  const temporary = `${target}.${process.pid}.${Date.now()}.download`;
  assertInside(path.dirname(target), temporary, 'Download path');
  fs.rmSync(temporary, { force: true });
  try {
    run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:REVERIE_DOWNLOAD_URL -OutFile $env:REVERIE_DOWNLOAD_TARGET",
    ], {
      env: {
        REVERIE_DOWNLOAD_URL: url,
        REVERIE_DOWNLOAD_TARGET: temporary,
      },
    });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ensureVerifiedPythonArchive(cacheRoot) {
  ensureDir(cacheRoot);
  const archive = path.join(cacheRoot, PYTHON_RUNTIME.filename);
  assertInside(cacheRoot, archive, 'Python archive');
  if (fs.existsSync(archive) && hashFile(archive) !== PYTHON_RUNTIME.sha256) {
    fs.rmSync(archive, { force: true });
  }
  if (!fs.existsSync(archive)) {
    downloadWithPowerShell(PYTHON_RUNTIME.url, archive);
  }
  const actual = hashFile(archive);
  if (actual !== PYTHON_RUNTIME.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(
      `Python runtime SHA-256 mismatch: expected ${PYTHON_RUNTIME.sha256}, received ${actual}`,
    );
  }
  return archive;
}

function extractVerifiedPython(archive, destination, stagingRoot) {
  assertInside(stagingRoot, destination, 'Python runtime destination');
  removeInside(stagingRoot, destination);
  ensureDir(destination);
  run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Expand-Archive -LiteralPath $env:REVERIE_ARCHIVE_SOURCE -DestinationPath $env:REVERIE_ARCHIVE_TARGET -Force',
  ], {
    env: {
      REVERIE_ARCHIVE_SOURCE: archive,
      REVERIE_ARCHIVE_TARGET: destination,
    },
  });
  const pth = path.join(destination, 'python312._pth');
  if (!fs.existsSync(pth)) {
    throw new Error('Verified Python archive did not contain python312._pth');
  }
  fs.writeFileSync(
    pth,
    ['python312.zip', '.', 'Lib/site-packages', 'import site', ''].join('\r\n'),
    'ascii',
  );
}

function resolveBuildPython(projectRoot) {
  const override = process.env.REVERIE_BUILD_PYTHON;
  const candidate = override
    ? path.resolve(override)
    : path.join(projectRoot, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      'A Python 3.12 build interpreter is required. Set REVERIE_BUILD_PYTHON or rebuild venv.',
    );
  }
  const version = run(candidate, ['-c', 'import sys; print(sys.version_info[:2])'], {
    capture: true,
    cwd: projectRoot,
  });
  if (version !== '(3, 12)') {
    throw new Error(`Build interpreter must be Python 3.12, received ${version}`);
  }
  return candidate;
}

function populateLockedPackages({ projectRoot, frontendRoot, destination }) {
  const buildPython = resolveBuildPython(projectRoot);
  const lock = path.join(projectRoot, 'requirements-runtime.lock');
  const wheelhouse = path.join(frontendRoot, '.runtime-cache', 'wheels-win-amd64-cp312');
  const sitePackages = path.join(destination, 'Lib', 'site-packages');
  if (!fs.existsSync(lock)) throw new Error(`Runtime dependency lock is missing: ${lock}`);
  ensureDir(wheelhouse);
  ensureDir(sitePackages);

  run(
    buildPython,
    [
      '-m',
      'pip',
      'download',
      '--disable-pip-version-check',
      '--only-binary=:all:',
      '--require-hashes',
      '--no-deps',
      '--dest',
      wheelhouse,
      '--requirement',
      lock,
    ],
    { cwd: projectRoot },
  );
  run(
    buildPython,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-index',
      '--find-links',
      wheelhouse,
      '--only-binary=:all:',
      '--require-hashes',
      '--no-deps',
      '--no-compile',
      '--target',
      sitePackages,
      '--requirement',
      lock,
    ],
    { cwd: projectRoot },
  );
  pruneInstalledRuntime(sitePackages);
}

function pruneInstalledRuntime(sitePackages) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Installed Python dependency contains a symlink: ${current}`);
    }
    const name = path.basename(current).toLowerCase();
    if (stat.isDirectory()) {
      if (['.pytest_cache', '__pycache__', '_tests', '__tests__', 'test', 'tests'].includes(name)) {
        assertInside(sitePackages, current, 'Python dependency cleanup');
        fs.rmSync(current, { recursive: true, force: true });
        return;
      }
      for (const child of fs.readdirSync(current)) visit(path.join(current, child));
      return;
    }
    if (
      name.endsWith('.pyc')
      || name.endsWith('.pyo')
      || /^(?:test_.+|.+_test)\.py$/i.test(name)
    ) {
      assertInside(sitePackages, current, 'Python dependency cleanup');
      fs.rmSync(current, { force: true });
    }
  };
  visit(sitePackages);
}

function readLockedPackageNames(lockPath) {
  const names = new Set();
  for (const line of fs.readFileSync(lockPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==/);
    if (match) names.add(normalizePackageName(match[1]));
  }
  return names;
}

function readInstalledDistributions(sitePackages) {
  const distributions = [];
  for (const name of fs.readdirSync(sitePackages)) {
    if (!name.toLowerCase().endsWith('.dist-info')) continue;
    const metadata = path.join(sitePackages, name, 'METADATA');
    if (!fs.existsSync(metadata)) {
      throw new Error(`Installed distribution metadata is missing: ${metadata}`);
    }
    const content = fs.readFileSync(metadata, 'utf8');
    const packageName = content.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = content.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (!packageName || !version) {
      throw new Error(`Invalid installed distribution metadata: ${metadata}`);
    }
    distributions.push({
      name: packageName,
      normalizedName: normalizePackageName(packageName),
      version,
    });
  }
  return distributions.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
}

function verifyInstalledDistributions(projectRoot, destination) {
  const lockPath = path.join(projectRoot, 'requirements-runtime.lock');
  const expected = readLockedPackageNames(lockPath);
  const sitePackages = path.join(destination, 'Lib', 'site-packages');
  const distributions = readInstalledDistributions(sitePackages);
  const installed = new Set(distributions.map((item) => item.normalizedName));
  const missing = [...expected].filter((name) => !installed.has(name));
  const unexpected = [...installed].filter((name) => !expected.has(name));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Python runtime dependency drift (missing=${missing.join(',')}; unexpected=${unexpected.join(',')})`,
    );
  }
  return distributions.map(({ normalizedName: _normalizedName, ...item }) => item);
}

function preparePythonRuntime({ projectRoot, frontendRoot, destination, stagingRoot }) {
  const cacheRoot = path.join(frontendRoot, '.runtime-cache', 'python');
  const archive = ensureVerifiedPythonArchive(cacheRoot);
  extractVerifiedPython(archive, destination, stagingRoot);
  populateLockedPackages({ projectRoot, frontendRoot, destination });
  const packages = verifyInstalledDistributions(projectRoot, destination);
  const executable = path.join(destination, 'python.exe');
  const version = run(
    executable,
    [
      '-c',
      [
        'import json,sys',
        'import cryptography,httpx,numpy,ollama,openai,pydantic,sqlcipher3,sqlite_vec,websockets',
        'from PIL import Image',
        'print(json.dumps({"version":sys.version.split()[0],"bits":__import__("struct").calcsize("P")*8}))',
      ].join(';'),
    ],
    {
      capture: true,
      cwd: destination,
      env: { PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  const details = JSON.parse(version);
  if (details.version !== PYTHON_RUNTIME.version || details.bits !== 64) {
    throw new Error(`Unexpected staged Python runtime: ${version}`);
  }
  // Keep this cleanup after the smoke import as a defence in depth in case a
  // future interpreter or native dependency ignores PYTHONDONTWRITEBYTECODE.
  pruneInstalledRuntime(path.join(destination, 'Lib', 'site-packages'));
  return {
    interpreter: { ...PYTHON_RUNTIME },
    packages,
  };
}

function shouldCopyProductionPythonSource(source, stat, sourceRoot) {
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(source));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some((part) => (
    OMITTED_SOURCE_MODULES.includes(part)
    || OMITTED_SOURCE_MODULES.includes(path.parse(part).name)
  ))) return false;
  const name = path.basename(source).toLowerCase();
  if (stat.isDirectory()) {
    return !['__pycache__', '.pytest_cache'].includes(name);
  }
  if (name.endsWith('.pyc') || name.endsWith('.pyo')) return false;
  if (/^(?:test_.+|.+_test)\.py$/i.test(name)) return false;
  return true;
}

function copyProductionPythonSource(sourceRoot, destination, stagingRoot) {
  assertInside(stagingRoot, destination, 'Production source destination');
  removeInside(stagingRoot, destination);
  const visit = (source, target) => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing a Python source symlink: ${source}`);
    }
    if (!shouldCopyProductionPythonSource(source, stat, sourceRoot)) return;
    if (stat.isDirectory()) {
      ensureDir(target);
      for (const name of fs.readdirSync(source)) {
        visit(path.join(source, name), path.join(target, name));
      }
      return;
    }
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  };
  visit(sourceRoot, destination);
}

function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) return;
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Release payload contains a symlink: ${current}`);
    visitor(current, stat);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
    }
  };
  visit(root);
}

function assertProductionPayload(resourceRoot, appRoot = null) {
  const findings = [];
  for (const root of [resourceRoot, appRoot].filter(Boolean)) {
    walkFiles(root, (current, stat) => {
      const name = path.basename(current).toLowerCase();
      if (FORBIDDEN_RUNTIME_NAMES.includes(name)) {
        findings.push(path.relative(root, current));
      }
      if (!stat.isDirectory() && (
        /\.(?:test|spec|fixture)\.(?:py|c?js|mjs|json)$/i.test(name)
        || name.endsWith('.pyc')
        || name.endsWith('.pyo')
      )) {
        findings.push(path.relative(root, current));
      }
    });
  }
  if (findings.length) {
    throw new Error(`Production payload contains forbidden development/reference files: ${findings.slice(0, 20).join(', ')}`);
  }
  if (!fs.existsSync(path.join(resourceRoot, 'python', 'python.exe'))) {
    throw new Error('Production payload is missing python/python.exe');
  }
  if (fs.existsSync(path.join(resourceRoot, 'venv'))) {
    throw new Error('Production payload must not contain a virtual environment');
  }
  return true;
}

function directorySize(root) {
  let total = 0;
  walkFiles(root, (_current, stat) => {
    if (stat.isFile()) total += stat.size;
  });
  return total;
}

function writeProductionInventory({
  resourceRoot,
  appRoot,
  runtime,
  target = path.join(resourceRoot, 'PRODUCTION-INVENTORY.json'),
}) {
  assertProductionPayload(resourceRoot, appRoot);
  const payload = {
    schema: 'reverie.production-inventory.v1',
    generatedAtUtc: new Date().toISOString(),
    localFirst: true,
    transport: 'electron-parent-framed-stdio-v4',
    python: runtime,
    sourcePolicy: {
      packagedRoot: 'src',
      omittedReferenceOrDevelopmentModules: [...OMITTED_SOURCE_MODULES],
    },
    apiCapabilities: {
      defaultState: 'off-unless-owner-enables',
      guarded: ['proactive_chat', 'automatic_diary', 'web_search', 'image_generation'],
    },
    payloadBytes: {
      python: directorySize(path.join(resourceRoot, 'python')),
      pythonSource: directorySize(path.join(resourceRoot, 'src')),
      electronApp: appRoot ? directorySize(appRoot) : 0,
    },
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

module.exports = {
  FORBIDDEN_RUNTIME_NAMES,
  OMITTED_SOURCE_MODULES,
  PYTHON_RUNTIME,
  assertProductionPayload,
  copyProductionPythonSource,
  directorySize,
  ensureVerifiedPythonArchive,
  normalizePackageName,
  preparePythonRuntime,
  pruneInstalledRuntime,
  readInstalledDistributions,
  readLockedPackageNames,
  shouldCopyProductionPythonSource,
  verifyInstalledDistributions,
  writeProductionInventory,
};
