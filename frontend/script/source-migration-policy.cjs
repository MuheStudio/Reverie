'use strict';

// Narrow source-retirement regression checks, not a license classifier.
// Historical notices remain valid; remaining dependency origins are tracked
// separately from the retired source bodies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RETIRED_SOURCE_NAMES = Object.freeze(['anime_service', 'download_service', 'lorebook', 'hypa_v3.py', 'elephantops']);
const REQUIRED_MEDIA_MODULES = Object.freeze([
  'media-service.cjs', 'media-playlist.cjs', 'media-transfer.cjs', 'media-resources.cjs',
]);
const REQUIRED_WORLDBOOK_MODULES = Object.freeze(['__init__.py', 'engine.py', 'regex_worker.py', 'regex_supervisor.py', 'runtime.py']);
const REQUIRED_XIANGQI_MODULES = Object.freeze(['xiangqiEngine.ts', 'xiangqiState.ts', 'MiniGamePanel.tsx']);
const REQUIRED_SUMMARY_MODULES = Object.freeze(['__init__.py', 'engine.py', 'store.py', 'legacy.py', 'runtime.py']);
const HISTORY_FILES = Object.freeze(['kazumi-files.json', 'cat-catch-files.json', 'risu-worldbook-files.json', 'risu-hypa-files.json', 'elephantops-files.json']);
const HISTORY_PREFIXES = Object.freeze({ 'kazumi-files.json': 'src/anime_service/',
  'cat-catch-files.json': 'src/download_service/', 'risu-worldbook-files.json': 'src/lorebook/', 'risu-hypa-files.json': 'src/memory/hypa_v3.py', 'elephantops-files.json': 'frontend/node_modules/elephantops/' });
const LEGACY_HOST_REFERENCE = /\bgetDownloadAdapter\b|\belectron_adapter\.js\b|["'`]download_service["'`]/;
const IGNORED_BUILD_DIRECTORIES = new Set(['__pycache__', '.pytest_cache', 'node_modules', '.git']);

function statOrNull(filename) {
  try { return fs.lstatSync(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function requireDirectory(directory, label) {
  const stat = statOrNull(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Source migration gate requires a real ${label} directory`);
  }
}
function readRegular(filename, label) {
  const before = statOrNull(filename);
  if (!before || !before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Source migration gate requires a regular ${label}`);
  }
  const data = fs.readFileSync(filename);
  const after = fs.lstatSync(filename);
  if (data.length !== before.size || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
    || before.dev !== after.dev || after.isSymbolicLink()) {
    throw new Error(`Source migration gate found an incomplete or changing ${label}`);
  }
  return data;
}
function loadRetiredBodies(projectRoot) {
  const index = new Map();
  const inventories = [];
  for (const filename of HISTORY_FILES) {
    const relative = `LICENSES_CREDITS/history/${filename}`;
    const bytes = readRegular(path.join(projectRoot, ...relative.split('/')), relative);
    const record = JSON.parse(bytes.toString('utf8'));
    const prefix = HISTORY_PREFIXES[filename];
    if (record.schemaVersion !== 1 || !Array.isArray(record.files) || record.files.length === 0
      || record.fileCount !== record.files.length
      || !/^[a-f0-9]{40}$/.test(record.sourceTreeCommit || '')) {
      throw new Error(`Invalid source migration history inventory: ${relative}`);
    }
    const seen = new Set();
    let totalBytes = 0, selected = 0;
    for (const file of record.files) {
      if (typeof file.path !== 'string' || !file.path.startsWith(prefix)
        || file.path.includes('\\') || file.path.split('/').includes('..')
        || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
        throw new Error(`Invalid source migration history entry: ${relative}`);
      }
      seen.add(file.path); totalBytes += file.bytes;
      // Use only known executable bodies, not license text, icons, metadata or
      // third-party browser libraries stored elsewhere in the old extension.
      const selectedBody = filename === 'kazumi-files.json'
        ? file.path.endsWith('.dart')
        : filename === 'elephantops-files.json' ? /\.(?:js|ts)$/.test(file.path) : ['risu-worldbook-files.json', 'risu-hypa-files.json'].includes(filename) ? file.path.endsWith('.py')
          : file.path === 'src/download_service/electron_adapter.js'
          || /^src\/download_service\/js\/[^/]+\.js$/.test(file.path);
      if (!selectedBody || file.bytes === 0) continue;
      selected += 1;
      if (!index.has(file.bytes)) index.set(file.bytes, new Map());
      const hashes = index.get(file.bytes);
      if (!hashes.has(file.sha256)) hashes.set(file.sha256, []);
      hashes.get(file.sha256).push(file.path);
    }
    if (record.totalBytes !== totalBytes || selected === 0) {
      throw new Error(`Incomplete source migration history inventory: ${relative}`);
    }
    inventories.push({ path: relative, sourceTreeCommit: record.sourceTreeCommit,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), selectedBodies: selected });
  }
  return { index, inventories };
}
function maskPythonTrivia(source) {
  // Retain offsets/newlines while masking comments and string literals. This
  // keeps prose examples and inline comments out of executable-import checks.
  const masked = source.split('');
  const erase = (start, end) => { for (let i = start; i < end; i += 1) if (masked[i] !== '\n') masked[i] = ' '; };
  for (let i = 0; i < source.length;) {
    if (source[i] === '#') { const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end; erase(i, stop); i = stop; }
    else if (source[i] === '"' || source[i] === "'") {
      const start = i, quote = source[i], delimiter = source.slice(i, i + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
      i += delimiter.length;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; break; }
        i += 1;
      }
      erase(start, Math.min(i, source.length));
    } else i += 1;
  }
  return masked.join('');
}
function rejectLegacyWorldbookImport(source, display) {
  // Target active imports and literal dynamic imports, not format fields or
  // license words. This is a regression gate, not a full Python/dataflow audit.
  const joined = source.replace(/\\\r?\n/g, '');
  const code = maskPythonTrivia(joined);
  const staticImport = /(?:^|[;\n])\s*(?:from\s+(?:src\.)?\.*lorebook(?:\.[A-Za-z_][\w.]*)?\s+import\b|import\s+[^;\n]*\b(?:src\.)?lorebook(?:\b|\.))/;
  const parentImport = /(?:^|[;\n])\s*from\s+(?:src|\.+)\s+import\s*(?:\([^)]*\blorebook\b[^)]*\)|[^;\n]*\blorebook\b)/;
  let dynamicImport = false;
  let dynamicSummaryImport = false;
  for (const call of code.matchAll(/(?:\bimport_module|\b__import__)\s*\(/g)) {
    const firstArgument = joined.slice(call.index + call[0].length);
    if (/^\s*[rRuU]?(['"])(?:src\.|\.+)?(?:memory\.)?hypa_v3\1/.test(firstArgument)) dynamicSummaryImport = true;
    if (/^\s*[rRuU]?(['"])(?:src\.|\.)?lorebook(?:\.[\w.]+)?\1/.test(firstArgument)) dynamicImport = true;
  }
  if (/\b(?:from|import)\s+[^;\n]*\bhypa_v3\b/.test(code)
    || /\bfrom\s+[^;\n]+\s+import\s*\([^)]*\bhypa_v3\b/.test(code) || dynamicSummaryImport) {
    throw new Error(`Active Python source imports the retired summary implementation: ${display}`);
  }
  if (staticImport.test(code) || parentImport.test(code) || dynamicImport) {
    throw new Error(`Active Python source imports the retired worldbook implementation: ${display}`);
  }
}
function inspectTrees(scanRoots, retiredIndex) {
  let filesExamined = 0, hashesChecked = 0;
  const roots = [];
  for (const { directory, label, skipTop = [] } of scanRoots) {
    requireDirectory(directory, label);
    roots.push(label);
    const walk = (current, relative = '') => {
      const stat = fs.lstatSync(current);
      const name = path.basename(current);
      const display = relative ? `${label}/${relative.split(path.sep).join('/')}` : label;
      if (RETIRED_SOURCE_NAMES.includes(name.toLowerCase())) {
        throw new Error(`Retired source tree reintroduced: ${display}`);
      }
      if (stat.isSymbolicLink()) throw new Error(`Source migration gate refuses a source symlink: ${display}`);
      if (stat.isDirectory()) {
        for (const child of fs.readdirSync(current).sort()) {
          if (IGNORED_BUILD_DIRECTORIES.has(child) || (!relative && skipTop.includes(child))) continue;
          walk(path.join(current, child), path.join(relative, child));
        }
      } else if (stat.isFile()) {
        filesExamined += 1;
        if (name.endsWith('.py')) rejectLegacyWorldbookImport(readRegular(current, display).toString('utf8'), display);
        // Checking bytes by size also catches a renamed .js/.dart body saved
        // under a different extension without searching for license words.
        const candidates = retiredIndex.get(stat.size);
        if (!candidates) return;
        hashesChecked += 1;
        const digest = crypto.createHash('sha256').update(readRegular(current, display)).digest('hex');
        if (candidates.has(digest)) {
          throw new Error(`Retired executable body reintroduced: ${display} matches ${candidates.get(digest).join(', ')}`);
        }
      }
    };
    walk(directory);
  }
  return { roots, filesExamined, hashesChecked };
}
function assertMigration({ projectRoot, electronRoot, pythonRoot, scanRoots, scope }) {
  requireDirectory(electronRoot, 'Electron host');
  const { index, inventories } = loadRetiredBodies(projectRoot);
  for (const filename of REQUIRED_MEDIA_MODULES) {
    const bytes = readRegular(path.join(electronRoot, filename), `Electron module ${filename}`);
    if (!bytes.length) throw new Error(`Empty required source migration module: ${filename}`);
  }
  for (const filename of REQUIRED_WORLDBOOK_MODULES) {
    const bytes = readRegular(path.join(pythonRoot, 'worldbook', filename), `worldbook module ${filename}`);
    if (!bytes.length) throw new Error(`Empty required source migration worldbook module: ${filename}`);
  }
  for (const filename of REQUIRED_SUMMARY_MODULES) {
    const bytes = readRegular(path.join(pythonRoot, 'conversation_summary', filename), `summary module ${filename}`);
    if (!bytes.length) throw new Error(`Empty required summary module: ${filename}`);
  }
  for (const name of REQUIRED_XIANGQI_MODULES) readRegular(path.join(projectRoot, 'frontend/src/components/DreamRoom', name), `xiangqi module ${name}`);
  const main = readRegular(path.join(electronRoot, 'main.js'), 'Electron main.js').toString('utf8');
  if (LEGACY_HOST_REFERENCE.test(main)) throw new Error('Electron main.js still references the retired download adapter');
  const scan = inspectTrees(scanRoots, index);
  if (scope === 'staged-payload') {
    const graph = JSON.parse(readRegular(path.join(electronRoot, '../dist/retired-dependency-build-graph.json'), 'renderer module graph'));
    if (graph.schema !== 'reverie.renderer-module-retirement.v1' || graph.passed !== true || !Array.isArray(graph.modules)
      || graph.count !== graph.modules.length || crypto.createHash('sha256').update(JSON.stringify(graph.modules)).digest('hex') !== graph.sha256
      || graph.modules.some(id => /(?:^|\/)elephantops(?:@|\/|$)/.test(id))
      || REQUIRED_XIANGQI_MODULES.some(name => !graph.modules.includes(`src/components/DreamRoom/${name}`))) {
      throw new Error('Renderer graph does not establish independent Xiangqi replacement');
    }
  }
  return {
    schema: 'reverie.source-migration-policy.v1', scope, passed: true,
    claim: 'Source-retirement regression checks only; not a complete license or GPL-removal audit.',
    retiredSourceNames: [...RETIRED_SOURCE_NAMES], requiredMediaModules: [...REQUIRED_MEDIA_MODULES],
    legacySummaryImportsAbsent: true, requiredSummaryModules: [...REQUIRED_SUMMARY_MODULES],
    legacyHostReferenceAbsent: true, legacyWorldbookImportsAbsent: true, requiredWorldbookModules: [...REQUIRED_WORLDBOOK_MODULES], inventories, scan,
  };
}
function assertSourceMigrationSource(projectRoot) {
  const frontend = path.join(projectRoot, 'frontend');
  const scanRoots = [
    { directory: path.join(projectRoot, 'src'), label: 'src' },
    { directory: path.join(frontend, 'electron'), label: 'frontend/electron' },
  ];
  for (const name of ['src', 'vendor']) {
    const directory = path.join(frontend, name);
    if (statOrNull(directory)) scanRoots.push({ directory, label: `frontend/${name}` });
  }
  return assertMigration({ projectRoot, electronRoot: path.join(frontend, 'electron'), pythonRoot: path.join(projectRoot, 'src'), scanRoots, scope: 'source-inputs' });
}
function assertSourceMigrationStage({ projectRoot, resourceRoot, appRoot }) {
  requireDirectory(path.join(resourceRoot, 'src'), 'staged Python source');
  return assertMigration({
    projectRoot, electronRoot: path.join(appRoot, 'electron'), pythonRoot: path.join(resourceRoot, 'src'), scope: 'staged-payload',
    scanRoots: [
      // Interpreter and collected dependency notices are separately inventoried;
      // this check covers the application-owned source and resource payload.
      { directory: resourceRoot, label: 'resources', skipTop: ['python', 'THIRD_PARTY_LICENSES', 'app'] },
      { directory: appRoot, label: 'app' },
    ],
  });
}

module.exports = {
  RETIRED_SOURCE_NAMES, REQUIRED_XIANGQI_MODULES, REQUIRED_MEDIA_MODULES, REQUIRED_WORLDBOOK_MODULES, REQUIRED_SUMMARY_MODULES,
  assertSourceMigrationSource, assertSourceMigrationStage,
};
