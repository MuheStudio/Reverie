'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  inspectTree, isMachO, isSystemDependency, externalAuditPath,
} = require('./production-runtime-macos.cjs');

const LOAD_COMMANDS = new Set(['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LAZY_LOAD_DYLIB', 'LC_LOAD_UPWARD_DYLIB']);
const relative = (root, filename) => path.relative(root, filename).split(path.sep).join('/');
const inside = (root, filename) => {
  const value = path.relative(root, filename);
  return value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
};

function command(tool, args, options = {}) {
  const result = spawnSync(tool, args, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`${path.basename(tool)} audit failed (${result.error?.code || result.status}/${result.signal || ''}): ${(result.stderr || '').slice(-2000)}`);
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

function parseLoadCommands(text) {
  const parsed = { dependencies: [], rpaths: [], installName: null, dylinker: null };
  const sections = text.split(/^Load command \d+\s*$/m).slice(1);
  if (!sections.length) throw new Error('otool did not report Mach-O load commands');
  for (const section of sections) {
    const name = /^\s*cmd (LC_[A-Z0-9_]+)\s*$/m.exec(section)?.[1];
    if (name === 'LC_DYLD_ENVIRONMENT') throw new Error('Embedded dyld environment commands are forbidden');
    if (LOAD_COMMANDS.has(name) || name === 'LC_ID_DYLIB' || name === 'LC_LOAD_DYLINKER' || name === 'LC_RPATH') {
      const value = /^\s*(?:name|path) (.+?) \(offset \d+\)\s*$/m.exec(section)?.[1];
      if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Malformed ${name} load command`);
      if (LOAD_COMMANDS.has(name)) parsed.dependencies.push({ command: name, path: value });
      else if (name === 'LC_ID_DYLIB') parsed.installName = value;
      else if (name === 'LC_LOAD_DYLINKER') parsed.dylinker = value;
      else parsed.rpaths.push(value);
    }
  }
  return parsed;
}

function readMachO(filename) {
  // otool interprets trailing '(GPU)'/'(Renderer)' as archive-member syntax.
  // Inspect the same opened file through a read-only inherited descriptor so
  // every Electron helper is actually inspected, without aliases or copies.
  const descriptor = fs.openSync(filename, 'r');
  try {
    const options = { stdio: ['ignore', 'pipe', 'pipe', descriptor] };
    const architectures = command('/usr/bin/lipo', ['-archs', '/dev/fd/3'], options).stdout.trim().split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== 'arm64') throw new Error(`Mach-O is not arm64-only: ${filename}`);
    const header = command('/usr/bin/otool', ['-hv', '/dev/fd/3'], options).stdout;
    const line = header.split('\n').find((value) => /^MH_(?:MAGIC|CIGAM)/.test(value.trim()));
    const fileType = line?.trim().split(/\s+/)[4];
    if (!['EXECUTE', 'DYLIB', 'BUNDLE'].includes(fileType)) throw new Error(`Unexpected native file type ${fileType || 'unknown'}: ${filename}`);
    return { architectures, fileType, ...parseLoadCommands(command('/usr/bin/otool', ['-l', '/dev/fd/3'], options).stdout) };
  } finally { fs.closeSync(descriptor); }
}

function expandBundlePath(value, image, executable, root) {
  let candidate;
  if (value === '@loader_path' || value.startsWith('@loader_path/')) candidate = path.resolve(path.dirname(image), value.slice('@loader_path'.length).replace(/^\//, ''));
  else if (value === '@executable_path' || value.startsWith('@executable_path/')) candidate = path.resolve(path.dirname(executable), value.slice('@executable_path'.length).replace(/^\//, ''));
  else throw new Error(`Mach-O reference must be bundle-relative: ${value}`);
  if (!inside(root, candidate)) throw new Error(`Mach-O reference escapes the application: ${value}`);
  if (fs.existsSync(candidate)) {
    candidate = fs.realpathSync(candidate);
    if (!inside(root, candidate)) throw new Error(`Mach-O reference follows an external symlink: ${value}`);
  }
  return candidate;
}

function auditDependencyGraph({ appRoot, nativeFiles }) {
  const root = fs.realpathSync(appRoot);
  const records = new Map(nativeFiles.map((item) => [item.path, item]));
  if (records.size !== nativeFiles.length) throw new Error('Duplicate native paths in audit inventory');
  const contexts = [];
  const dependencies = [];
  const dynamicEntrypoints = [];
  const covered = new Set();
  const visited = new Set();
  function walk(imagePath, executablePath, inheritedRunpaths, ancestry = []) {
    const image = records.get(imagePath);
    if (!image) throw new Error(`Dependency target is not a scanned native image: ${imagePath}`);
    const imageFile = path.join(root, imagePath);
    const executable = path.join(root, executablePath);
    const ownPaths = image.rpaths.map((value) => expandBundlePath(value, imageFile, executable, root));
    const runpaths = [...new Set([...ownPaths, ...inheritedRunpaths])];
    const stateKey = JSON.stringify([imagePath, executablePath, runpaths]);
    if (visited.has(stateKey)) return;
    if (visited.size >= 5000) throw new Error('Native loader graph exceeds the bounded audit limit');
    visited.add(stateKey);
    covered.add(imagePath);
    contexts.push({ image: imagePath, executable: executablePath, runpaths: runpaths.map((item) => relative(root, item)) });
    if (image.dylinker && !isSystemDependency(image.dylinker)) throw new Error(`External dynamic loader in ${imagePath}: ${image.dylinker}`);
    for (const dependency of image.dependencies) {
      const record = { image: imagePath, executable: executablePath, ...dependency };
      if (isSystemDependency(dependency.path)) {
        dependencies.push({ ...record, kind: 'system' });
        continue;
      }
      let candidates;
      if (dependency.path.startsWith('@rpath/')) {
        const suffix = dependency.path.slice('@rpath/'.length);
        if (!suffix) throw new Error(`Empty rpath dependency in ${imagePath}`);
        candidates = runpaths.map((directory) => path.resolve(directory, suffix));
      } else candidates = [expandBundlePath(dependency.path, imageFile, executable, root)];
      let target;
      for (const candidate of candidates) {
        if (!inside(root, candidate)) throw new Error(`Dependency escapes application in ${imagePath}: ${dependency.path}`);
        if (!fs.existsSync(candidate)) continue;
        const canonical = fs.realpathSync(candidate);
        if (!inside(root, canonical)) throw new Error(`Dependency follows an external symlink: ${dependency.path}`);
        target = relative(root, canonical);
        if (!records.has(target)) throw new Error(`Dependency resolves to a non-native file in ${imagePath}: ${dependency.path}`);
        break;
      }
      if (!target) throw new Error(`Unresolved ${dependency.command} for ${imagePath} under ${executablePath}: ${dependency.path}`);
      dependencies.push({ ...record, kind: 'bundled', target });
      // Runpaths come only from this image and its actual loader ancestry.
      // No directory from an unrelated binary may satisfy the dependency.
      if (!ancestry.includes(target)) walk(target, executablePath, runpaths, [...ancestry, imagePath]);
    }
  }
  const executables = nativeFiles.filter((item) => item.fileType === 'EXECUTE');
  if (!executables.length) throw new Error('Application contains no native executable');
  for (const executable of executables) walk(executable.path, executable.path, []);

  const pythonEntry = 'Contents/Resources/python/bin/python3.12';
  if (records.has(pythonEntry)) {
    const python = records.get(pythonEntry);
    if (python.fileType !== 'EXECUTE') throw new Error('Bundled Python entry is not a native executable');
    const inherited = python.rpaths.map((value) => expandBundlePath(value, path.join(root, pythonEntry), path.join(root, pythonEntry), root));
    for (const image of nativeFiles) {
      if (image.path.startsWith('Contents/Resources/python/') && image.fileType !== 'EXECUTE') {
        dynamicEntrypoints.push({ image: image.path, executable: pythonEntry, policy: 'python-extension-or-ctypes-library' });
        walk(image.path, pythonEntry, inherited);
      }
    }
  }
  const electronFramework = nativeFiles.find((item) => /^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/[^/]+\/Electron Framework$/.test(item.path));
  if (electronFramework) {
    const libraryPrefix = `${path.posix.dirname(electronFramework.path)}/Libraries/`;
    const frameworkContexts = contexts.filter((item) => item.image === electronFramework.path);
    for (const image of nativeFiles.filter((item) => item.path.startsWith(libraryPrefix) && item.fileType !== 'EXECUTE')) {
      for (const context of frameworkContexts) {
        dynamicEntrypoints.push({ image: image.path, executable: context.executable, policy: 'electron-framework-library' });
        walk(image.path, context.executable, context.runpaths.map((item) => path.join(root, item)));
      }
    }
  }
  for (const image of nativeFiles) {
    if (!covered.has(image.path)) throw new Error(`Unclassified dynamically loaded native image: ${image.path}`);
  }
  return { contexts, dependencies, dynamicEntrypoints };
}

function bundleExecutable(bundle) {
  const name = command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]).stdout.trim();
  if (!name || path.basename(name) !== name || /[\\\x00-\x1f]/.test(name)) throw new Error('Invalid CFBundleExecutable');
  const filename = path.join(bundle, 'Contents/MacOS', name);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Application executable must be a real regular file: ${filename}`);
  return filename;
}

function signatureInfo(filename) {
  command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', filename]);
  const result = command('/usr/bin/codesign', ['-d', '--verbose=4', filename]);
  const text = `${result.stdout}\n${result.stderr}`;
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] || null;
  return { verified: true, identifier: field('Identifier'), cdHash: field('CDHash'),
    teamIdentifier: field('TeamIdentifier'), signatureKind: field('Signature') || (text.includes('Authority=') ? 'certificate' : 'unknown'),
    codeDirectory: /^CodeDirectory (.*)$/m.exec(text)?.[1] || null };
}

async function auditMacApp({ appPath, reportPath } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Application audit requires native macOS arm64');
  const appRoot = fs.realpathSync(appPath);
  if (!appRoot.endsWith('.app') || !fs.statSync(appRoot).isDirectory()) throw new Error('Expected a macOS .app bundle');
  const output = reportPath ? externalAuditPath(appRoot, reportPath) : null;
  const entries = inspectTree(appRoot);
  const nativeFiles = entries.filter((entry) => entry.type === 'file' && isMachO(path.join(appRoot, entry.path)))
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256, ...readMachO(path.join(appRoot, entry.path)) }));
  const byPath = new Map(nativeFiles.map((item) => [item.path, item]));
  const main = relative(appRoot, bundleExecutable(appRoot));
  if (byPath.get(main)?.fileType !== 'EXECUTE') throw new Error('Main application entry is not a scanned Mach-O executable');
  if (byPath.get('Contents/Resources/python/bin/python3.12')?.fileType !== 'EXECUTE') throw new Error('Standalone production Python executable is missing');
  const frameworks = nativeFiles.filter((item) => /^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/[^/]+\/Electron Framework$/.test(item.path));
  if (frameworks.length !== 1) throw new Error('Application must contain exactly one Electron Framework binary');
  const nestedApps = entries.filter((entry) => entry.type === 'directory' && entry.path.endsWith('.app'));
  const helperRoles = new Set();
  for (const entry of nestedApps) {
    const executable = relative(appRoot, bundleExecutable(path.join(appRoot, entry.path)));
    if (byPath.get(executable)?.fileType !== 'EXECUTE') throw new Error(`Nested application has no native executable: ${entry.path}`);
    const helper = / Helper(?: \((GPU|Plugin|Renderer)\))?\.app$/.exec(entry.path);
    if (helper) helperRoles.add(helper[1] || 'generic');
  }
  for (const role of ['generic', 'GPU', 'Plugin', 'Renderer']) {
    if (!helperRoles.has(role)) throw new Error(`Electron helper role is missing: ${role}`);
  }
  const graph = auditDependencyGraph({ appRoot, nativeFiles });
  const signatures = [];
  for (const image of nativeFiles) signatures.push({ path: image.path, kind: 'mach-o', ...signatureInfo(path.join(appRoot, image.path)) });
  const containers = entries.filter((entry) => entry.type === 'directory' && /\.(app|framework|xpc)$/.test(entry.path)).map((entry) => entry.path);
  for (const container of [...containers, '.']) signatures.push({ path: container, kind: 'code-bundle', ...signatureInfo(path.join(appRoot, container)) });
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appRoot]);
  const after = inspectTree(appRoot);
  if (JSON.stringify(entries) !== JSON.stringify(after)) throw new Error('Application files changed during the read-only audit');
  const report = { schema: 'reverie.macos.app-audit.v1', architecture: 'arm64', inventoryStage: 'post-signing',
    mainExecutable: main, nativeFiles, symlinks: entries.filter((entry) => entry.type === 'symlink'),
    ...graph, signatures, entireBundleSignatureVerified: true, applicationUnchanged: true, ok: true };
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

module.exports = { auditMacApp, auditDependencyGraph, parseLoadCommands, expandBundlePath, readMachO };
