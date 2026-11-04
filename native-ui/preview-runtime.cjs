'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const records = require('./build-record.cjs');

const SCHEMA = 'reverie.qt.preview-runtime.v1';
const MANIFEST_SCHEMA = 'reverie.qt.preview-manifest.v1';
const CAPABILITY = 'v1';
const SUPPORTED_DATA_FORMAT = 1;
const WORKSPACE_CONTROL_CONTRACT = 'v1';
const DATA_FORMAT_SCHEMA = 'reverie.preview.data-format.v1';
const DATA_FORMAT_RECORD = 'preview-data-format.json';
const META = 'preview-runtime.json';
const MANIFEST = 'preview-manifest.json';
const SEAL = 'preview-runtime.sha256';
const CONTROL_FILES = new Set([META, MANIFEST, SEAL]);
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_MAX_FILES = 10;
const READY_LINE_MAX_BYTES = 8192;
const MAX_FILES = 50000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const own = info => info.uid === process.getuid();
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function need(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value),
    'PREVIEW_ABSOLUTE_CANONICAL_REQUIRED');
  return value;
}
function directory(value) {
  absolute(value);
  need(fs.realpathSync(value) === value, 'PREVIEW_DIRECTORY_ALIAS');
  for (let current = value; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    need(info.isDirectory() && !info.isSymbolicLink(), 'PREVIEW_DIRECTORY_ALIAS');
    if (current === path.dirname(current)) break;
  }
  need(own(fs.lstatSync(value)), 'PREVIEW_DIRECTORY_OWNER');
  return value;
}
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0-\x1f\x7f\\]/.test(value)
    && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..'), 'PREVIEW_MANIFEST_PATH');
  return value;
}
function readBytes(file, limit = MAX_MANIFEST_BYTES) {
  const before = fs.lstatSync(file);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && own(before) && before.size <= limit,
    'PREVIEW_RECORD_UNSAFE');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    need(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, 'PREVIEW_RECORD_CHANGED');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    need(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
      'PREVIEW_RECORD_CHANGED');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function json(file, limit) { return JSON.parse(readBytes(file, limit).toString('utf8')); }
function writeNew(file, bytes, mode = 0o600) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function supportedDataFormat(value) {
  if (value === undefined) return 1;
  need(Number.isSafeInteger(value) && value >= 1 && value <= 2147483647, 'PREVIEW_RUNTIME_DATA_FORMAT_INVALID');
  return value;
}
function signedBundleCapabilities(bundle) {
  const file = path.join(bundle, 'Contents/Info.plist');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { supportedDataFormat: 1, workspaceControlContract: undefined };
  const bytes = readBytes(file, 1024 * 1024);
  // Qt's generated application plist is XML. A historical binary plist with
  // neither new key retains only the legacy capability; never infer control
  // support from unsigned metadata outside the signed application bundle.
  if (bytes.subarray(0, 8).toString('ascii') === 'bplist00') {
    need(!bytes.includes(Buffer.from('ReverieSupportedDataFormat')) &&
      !bytes.includes(Buffer.from('ReverieWorkspaceControlContract')), 'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID');
    return { supportedDataFormat: 1, workspaceControlContract: undefined };
  }
  const xml = bytes.toString('utf8');
  function value(name, type) {
    const keys = [...xml.matchAll(new RegExp(`<key>\\s*${name}\\s*</key>`, 'g'))];
    need(keys.length <= 1, 'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID');
    if (!keys.length) return undefined;
    const found = xml.match(new RegExp(`<key>\\s*${name}\\s*</key>\\s*<${type}>([^<]*)</${type}>`));
    need(found, 'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID');
    return found[1].trim();
  }
  const number = value('ReverieSupportedDataFormat', 'integer');
  need(number === undefined || /^[1-9][0-9]*$/.test(number), 'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID');
  const support = supportedDataFormat(number === undefined ? undefined : Number(number));
  const control = value('ReverieWorkspaceControlContract', 'string');
  need(control === undefined || (control === WORKSPACE_CONTROL_CONTRACT && number !== undefined),
    'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_INVALID');
  return { supportedDataFormat: support, workspaceControlContract: control };
}
function checkDataFormat(workspace, supported = SUPPORTED_DATA_FORMAT) {
  absolute(workspace);
  need(Number.isSafeInteger(supported) && supported >= 1, 'PREVIEW_RUNTIME_DATA_FORMAT_INVALID');
  const rootInfo = fs.lstatSync(workspace, { throwIfNoEntry: false });
  if (!rootInfo) { directory(path.dirname(workspace)); return 1; }
  directory(workspace);
  need((rootInfo.mode & 0o7777) === 0o700, 'PREVIEW_WORKSPACE_PERMISSIONS');
  const data = path.join(workspace, 'data'), dataInfo = fs.lstatSync(data, { throwIfNoEntry: false });
  if (!dataInfo) return 1;
  directory(data);
  need((dataInfo.mode & 0o7777) === 0o700, 'PREVIEW_DATA_FORMAT_INVALID');
  const record = path.join(data, DATA_FORMAT_RECORD), info = fs.lstatSync(record, { throwIfNoEntry: false });
  if (!info) return 1;
  need(info.isFile() && !info.isSymbolicLink() && own(info) && info.nlink === 1
    && (info.mode & 0o7777) === 0o600 && info.size > 0 && info.size <= 4096, 'PREVIEW_DATA_FORMAT_INVALID');
  let value;
  try { value = json(record, 4096); } catch { need(false, 'PREVIEW_DATA_FORMAT_INVALID'); }
  let current;
  try { current = fs.lstatSync(record, { throwIfNoEntry: false }); } catch { need(false, 'PREVIEW_DATA_FORMAT_INVALID'); }
  need(current && current.dev === info.dev && current.ino === info.ino && current.size === info.size &&
    current.mtimeMs === info.mtimeMs && current.ctimeMs === info.ctimeMs && current.nlink === 1 &&
    (current.mode & 0o7777) === 0o600 && !current.isSymbolicLink(), 'PREVIEW_DATA_FORMAT_INVALID');
  need(value && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'formatVersion,schema'
    && value.schema === DATA_FORMAT_SCHEMA && Number.isSafeInteger(value.formatVersion)
    && value.formatVersion >= 1 && value.formatVersion <= 2147483647, 'PREVIEW_DATA_FORMAT_INVALID');
  need(value.formatVersion <= supported, 'PREVIEW_DATA_FORMAT_TOO_NEW');
  return value.formatVersion;
}
function hasPendingRecovery(workspace) {
  // Even a malformed/aliased record requires the locked native recovery gate.
  return Boolean(fs.lstatSync(path.join(workspace, 'restore-transaction.json'), { throwIfNoEntry: false }));
}
function ensureUnder(root, value) {
  need(inside(root, value), 'PREVIEW_OUTPUT_ESCAPES_ROOT');
  const parts = path.relative(root, value).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info) need(info.isDirectory() && !info.isSymbolicLink() && own(info), 'PREVIEW_OUTPUT_ALIAS');
    else fs.mkdirSync(current, { mode: 0o755 });
  }
}
function inventory(root) {
  const result = [];
  function walk(directoryName) {
    for (const name of fs.readdirSync(path.join(root, directoryName)).sort()) {
      const nameInRoot = path.posix.join(directoryName, name);
      if (!directoryName && CONTROL_FILES.has(name)) continue;
      relative(nameInRoot);
      const file = path.join(root, nameInRoot), info = fs.lstatSync(file);
      if (info.isFile() && records.finderMetadataFile({ path: nameInRoot, type: 'file' })) continue;
      need(own(info), 'PREVIEW_RUNTIME_OWNER');
      need(result.length < MAX_FILES, 'PREVIEW_RUNTIME_TOO_MANY_FILES');
      if (info.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        need(!path.isAbsolute(target) && inside(root, path.resolve(path.dirname(file), target))
          && inside(root, fs.realpathSync(file)), 'PREVIEW_RUNTIME_LINK_ESCAPES');
        result.push({ path: nameInRoot, type: 'link', target });
      } else if (info.isDirectory()) {
        result.push({ path: nameInRoot, type: 'directory', mode: info.mode & 0o777 });
        walk(nameInRoot);
      } else {
        need(info.isFile() && info.nlink === 1, 'PREVIEW_RUNTIME_NOT_REGULAR');
        result.push({ path: nameInRoot, type: 'file', bytes: info.size, mode: info.mode & 0o777,
          sha256: records.fileHash(file) });
      }
    }
  }
  walk('');
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function copyFile(source, destination, provenance) {
  const before = fs.lstatSync(source);
  need(before.isFile() && !before.isSymbolicLink() && own(before), 'PREVIEW_COPY_SOURCE_UNSAFE');
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor);
    need(opened.dev === before.dev && opened.ino === before.ino, 'PREVIEW_COPY_SOURCE_CHANGED');
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor), current = fs.lstatSync(source);
    need(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && current.dev === before.dev && current.ino === before.ino, 'PREVIEW_COPY_SOURCE_CHANGED');
  } finally { fs.closeSync(descriptor); }
  writeNew(destination, bytes, before.mode & 0o777);
  need(records.fileHash(destination) === sha(bytes), 'PREVIEW_COPY_HASH_MISMATCH');
  provenance.push({ source, path: destination, sha256: sha(bytes) });
}
function copyTree(source, destination, provenance, rewriteLink = null, sourceRoot = source) {
  fs.mkdirSync(destination, { mode: fs.lstatSync(source).mode & 0o777 });
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name), to = path.join(destination, name), info = fs.lstatSync(from);
    if (info.isFile() && records.finderMetadataFile({ path: name, type: 'file' })) continue;
    if (info.isSymbolicLink()) {
      const original = fs.readlinkSync(from);
      const replacement = rewriteLink?.(from, to, original);
      const target = replacement ?? original;
      need(!path.isAbsolute(target), 'PREVIEW_COPY_ABSOLUTE_LINK');
      if (replacement === undefined || replacement === null)
        need(inside(sourceRoot, fs.realpathSync(from)), 'PREVIEW_COPY_SOURCE_LINK_ESCAPES');
      fs.symlinkSync(target, to);
      provenance.push({ source: from, path: to, originalTarget: original, target });
    } else if (info.isDirectory()) copyTree(from, to, provenance, rewriteLink, sourceRoot);
    else copyFile(from, to, provenance);
  }
}
function runtimeSourceBytes(projectRoot, head, entry) {
  const file = path.join(projectRoot, relative(entry.path));
  if (entry.type === 'file') {
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (info?.isFile() && !info.isSymbolicLink() && records.fileHash(file) === entry.sha256)
      return { bytes: fs.readFileSync(file), mode: info.mode & 0o777 };
  }
  need(/^[0-9a-f]{40}$/.test(head), 'PREVIEW_SOURCE_COMMIT');
  const bytes = execFileSync('git', ['show', '--no-ext-diff', '--no-textconv', `${head}:${entry.path}`], {
    cwd: projectRoot, maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (entry.type === 'link') need(bytes.toString('utf8') === entry.target, 'PREVIEW_SOURCE_LINK_CHANGED');
  else need(sha(bytes) === entry.sha256, 'PREVIEW_SOURCE_BYTES_CHANGED');
  return { bytes, mode: /\.(sh)$/.test(entry.path) ? 0o755 : 0o644 };
}
function sourceRuntimeInventory(root, sourceRows) {
  return records.withoutFinderMetadata(sourceRows).map(entry => {
    relative(entry.path);
    const file = path.join(root, entry.path), info = fs.lstatSync(file);
    if (entry.type === 'link') {
      need(info.isSymbolicLink() && fs.readlinkSync(file) === entry.target, 'PREVIEW_SOURCE_LINK_CHANGED');
      return { path: entry.path, type: 'link', target: entry.target };
    }
    need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'PREVIEW_SOURCE_NOT_REGULAR');
    return { path: entry.path, type: 'file', bytes: info.size, sha256: records.fileHash(file) };
  });
}
function externalExecutable(record, source) {
  const actual = fs.realpathSync(source);
  const bound = record.externalFiles.find(entry => fs.realpathSync(entry.path) === actual);
  need(bound && records.fileHash(actual) === bound.sha256, 'PREVIEW_EXECUTABLE_NOT_BUILD_BOUND');
  return { actual, sha256: bound.sha256 };
}
function requirePreviewBuild(buildDirectory, executableCopies = null) {
  directory(buildDirectory);
  const verified = records.verifyRecordedBuild(buildDirectory, executableCopies);
  records.validateOrdinaryBuildMode(verified.record);
  need(verified.record.previewWorkspaceContract === CAPABILITY, 'PREVIEW_UNSUPPORTED_CANDIDATE');
  return verified;
}
function activeIsolationBuild(projectRoot, buildDirectory, isolationRoot) {
  absolute(isolationRoot);
  // The engine sets TMPDIR to <scratch>/tmp, so os.tmpdir() is not the
  // scratch's parent. Bind its explicit isolation identity instead.
  need(path.basename(isolationRoot).startsWith('reverie-local-') &&
    typeof process.env.REVERIE_DATA_DIR === 'string' &&
    path.dirname(absolute(process.env.REVERIE_DATA_DIR)) === isolationRoot, 'PREVIEW_ISOLATION_ROOT_REQUIRED');
  directory(isolationRoot);
  need((fs.lstatSync(isolationRoot).mode & 0o7777) === 0o700, 'PREVIEW_ISOLATION_PERMISSIONS');
  const markers = ['active-local.json', 'active-registration.json'].map(name => path.join(projectRoot, '.tools/registered-run', name))
    .filter(file => fs.existsSync(file));
  need(markers.length === 1, 'PREVIEW_ACTIVE_RUN_REQUIRED');
  const marker = json(markers[0], 64 * 1024), metadata = marker.metadata || {};
  need(['reverie.active-local-run.v1', 'reverie.active-registration.v1'].includes(marker.schema), 'PREVIEW_ACTIVE_RUN_REQUIRED');
  const reportName = metadata.outputDirectory || metadata.reportDirectory;
  need(typeof reportName === 'string', 'PREVIEW_ACTIVE_REPORT_REQUIRED');
  const report = path.resolve(projectRoot, reportName);
  need(inside(path.join(projectRoot, '.tools/local'), report) || inside(path.join(projectRoot, '.tools/reports'), report),
    'PREVIEW_ACTIVE_REPORT_REQUIRED');
  directory(report);
  const ledger = json(path.join(report, 'run-ledger.json'), 64 * 1024 * 1024);
  const config = json(path.join(report, 'runtime-config.json'));
  need(ledger.unitIsolation?.scratch === isolationRoot && path.resolve(projectRoot, config.candidateDirectory) === buildDirectory,
    'PREVIEW_ACTIVE_BUILD_ISOLATION_MISMATCH');
  return { kind: 'isolated', isolationRoot, reportDirectory: report };
}
function adoptedBuild(projectRoot) {
  const pointerPath = path.join(projectRoot, '.tools/qt-candidates/last-local-sdk.json');
  const pointerBytes = readBytes(pointerPath, 64 * 1024), pointer = JSON.parse(pointerBytes);
  const buildDirectory = directory(absolute(pointer.directory));
  need(path.dirname(buildDirectory) === path.join(projectRoot, '.tools/qt-candidates'), 'PREVIEW_DEFAULT_CANDIDATE_PATH');
  const verified = requirePreviewBuild(buildDirectory), record = verified.record;
  need(typeof record.candidate === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(record.candidate)
    && path.basename(buildDirectory) === record.candidate && pointer.buildManifestSha256 === verified.buildManifestSha256,
    'PREVIEW_DEFAULT_POINTER_CHANGED');
  const reports = path.join(projectRoot, '.tools/reports');
  const names = fs.readdirSync(reports, { withFileTypes: true });
  need(names.length <= 4096, 'PREVIEW_ADOPTION_LOOKUP_LIMIT');
  const matches = [];
  for (const item of names) {
    if (!item.isDirectory() || !/^[a-z0-9][a-z0-9-]+$/.test(item.name)) continue;
    const report = path.join(reports, item.name), registrationFile = path.join(report, 'registration.json');
    if (!fs.existsSync(registrationFile)) continue;
    let registration;
    try { registration = json(registrationFile, 64 * 1024); } catch { continue; }
    if (registration.runKind !== 'formal' || registration.adoptCandidate !== true ||
        path.resolve(projectRoot, registration.candidateDirectory || '') !== buildDirectory) continue;
    const ledger = json(path.join(report, 'run-ledger.json'), 64 * 1024 * 1024);
    const approval = json(path.join(report, 'authorization.json'), 64 * 1024);
    if (ledger.passed === true && ledger.defaultPointerCandidateVerified === true &&
        ledger.postAdoptionBindingsVerified === true && ledger.adoptedPointerSha256 === sha(pointerBytes) &&
        ledger.sourceHead === registration.sourceHead && registration.sourceHead === record.source.head &&
        approval.schema === 'reverie.registered-run.authorization.v1' && approval.approved === true &&
        typeof approval.userApprovalText === 'string' && approval.userApprovalText.trim() &&
        approval.registrationSha256 === records.fileHash(registrationFile) &&
        ['registrationId', 'configSha256', 'toolCommit', 'sourceHead', 'sourceTreeHash'].every(key =>
          approval[key] === registration[key]) && ledger.configSha256 === registration.configSha256 &&
        ledger.authorizationSha256 === records.fileHash(path.join(report, 'authorization.json')))
      matches.push({ registrationId: registration.registrationId, reportDirectory: report,
        registrationSha256: records.fileHash(registrationFile), ledgerSha256: records.fileHash(path.join(report, 'run-ledger.json')) });
  }
  need(matches.length === 1, 'PREVIEW_CANDIDATE_NOT_ADOPTED');
  return { ...verified, buildDirectory, scope: { kind: 'adopted', adoption: matches[0] } };
}
function install(projectRoot, buildDirectory, destination, scope, verified) {
  absolute(destination);
  directory(path.dirname(destination));
  need(!fs.existsSync(destination) && !fs.lstatSync(destination, { throwIfNoEntry: false }), 'PREVIEW_RUNTIME_ALREADY_EXISTS');
  fs.mkdirSync(destination, { mode: 0o700 });
  const created = fs.lstatSync(destination), provenance = [];
  try {
    const record = verified.record, candidateDirectory = path.join(destination, 'candidate');
    fs.mkdirSync(candidateDirectory, { mode: 0o755 });
    copyTree(verified.app, path.join(candidateDirectory, 'Reverie Scene.app'), provenance);
    for (const name of ['build.json', 'source-inventory.json', 'application-inventory.json'])
      copyFile(path.join(buildDirectory, name), path.join(candidateDirectory, name), provenance);
    const sourceRows = records.runtimeInputs(json(path.join(buildDirectory, 'source-inventory.json')));
    need(records.digest(sourceRows).sha256 === record.source.runtimeInputs.sha256, 'PREVIEW_SOURCE_CATALOG_CHANGED');
    for (const entry of records.withoutFinderMetadata(sourceRows)) {
      const output = path.join(destination, relative(entry.path));
      ensureUnder(destination, path.dirname(output));
      const original = runtimeSourceBytes(projectRoot, record.source.head, entry);
      if (entry.type === 'link') {
        need(!path.isAbsolute(entry.target) && inside(destination, path.resolve(path.dirname(output), entry.target)), 'PREVIEW_SOURCE_LINK_ESCAPES');
        fs.symlinkSync(entry.target, output);
      } else {
        need(sha(original.bytes) === entry.sha256, 'PREVIEW_SOURCE_BYTES_CHANGED');
        writeNew(output, original.bytes, original.mode);
      }
    }
    const python = externalExecutable(record, path.join(record.python.basePrefix, 'bin/python3.12'));
    const pythonBase = directory(record.python.basePrefix);
    need(python.actual.startsWith(pythonBase + path.sep) && path.dirname(pythonBase).endsWith(path.join('.tools', 'python')),
      'PREVIEW_PYTHON_SOURCE_ROOT');
    const targetBase = path.join(destination, '.tools/python', path.basename(pythonBase));
    ensureUnder(destination, path.dirname(targetBase));
    copyTree(pythonBase, targetBase, provenance);
    const venv = directory(record.python.prefix);
    need(venv === path.join(projectRoot, '.venv'), 'PREVIEW_VENV_SOURCE_ROOT');
    copyTree(venv, path.join(destination, '.venv'), provenance, (from, to) => {
      if (from === path.join(venv, 'bin/python'))
        return path.relative(path.dirname(to), path.join(targetBase, 'bin/python3.12'));
      // These relative aliases resolve through the original absolute `python`
      // link. Rebind them explicitly before checking the copied link closure.
      if (path.dirname(from) === path.join(venv, 'bin') && /^python3(?:\.12)?$/.test(path.basename(from)) &&
          fs.realpathSync(from) === python.actual) return 'python';
      return undefined;
    });
    const configuration = path.join(destination, '.venv/pyvenv.cfg');
    const originalCfg = fs.readFileSync(configuration);
    const text = originalCfg.toString('utf8');
    need(/^home\s*=.*$/m.test(text) && /^include-system-site-packages\s*=\s*false\s*$/m.test(text), 'PREVIEW_VENV_CONFIGURATION');
    const cfgDescriptor = fs.openSync(configuration, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    try {
      fs.writeFileSync(cfgDescriptor, text.replace(/^home\s*=.*$/m, `home = ${path.join(targetBase, 'bin')}`));
      fs.fsyncSync(cfgDescriptor);
    } finally { fs.closeSync(cfgDescriptor); }
    provenance.push({ path: configuration, relocation: 'venv-home', originalSha256: sha(originalCfg), sha256: records.fileHash(configuration) });
    const sourceNode = record.externalFiles.find(entry => path.basename(entry.path) === 'node');
    need(sourceNode, 'PREVIEW_NODE_SOURCE_REQUIRED');
    const node = externalExecutable(record, sourceNode.path);
    ensureUnder(destination, path.join(destination, '.tools/node/bin'));
    copyFile(node.actual, path.join(destination, '.tools/node/bin/node'), provenance);
    need(records.fileHash(path.join(targetBase, 'bin/python3.12')) === python.sha256 &&
      records.fileHash(path.join(destination, '.tools/node/bin/node')) === node.sha256, 'PREVIEW_EXECUTABLE_COPY_CHANGED');
    need(JSON.stringify(sourceRuntimeInventory(destination, sourceRows)) === JSON.stringify(records.withoutFinderMetadata(sourceRows)),
      'PREVIEW_RUNTIME_INPUT_DIGEST');
    const installedFormat = supportedDataFormat(record.supportedDataFormat);
    need(record.workspaceControlContract === undefined || record.workspaceControlContract === WORKSPACE_CONTROL_CONTRACT,
      'PREVIEW_WORKSPACE_CONTROL_CONTRACT');
    const manifest = { schema: MANIFEST_SCHEMA, supportedDataFormat: installedFormat,
      ...(record.workspaceControlContract ? { workspaceControlContract: record.workspaceControlContract } : {}),
      sourceRuntimeInputs: record.source.runtimeInputs,
      entries: inventory(destination), copiedSources: provenance.map(item => ({ ...item, path: path.relative(destination, item.path).split(path.sep).join('/') })) };
    const manifestBytes = jsonBytes(manifest);
    need(manifestBytes.length <= MAX_MANIFEST_BYTES, 'PREVIEW_MANIFEST_TOO_LARGE');
    writeNew(path.join(destination, MANIFEST), manifestBytes);
    const metadata = { schema: SCHEMA, previewWorkspaceContract: CAPABILITY,
      supportedDataFormat: installedFormat,
      ...(record.workspaceControlContract ? { workspaceControlContract: record.workspaceControlContract } : {}),
      candidate: record.candidate || `local-${record.localIteration?.package || 'isolated'}`,
      sourceHead: record.source.head, installation: scope,
      manifestFile: MANIFEST, manifestSha256: sha(manifestBytes),
      hostExecutable: 'candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene',
      python: '.venv/bin/python', node: '.tools/node/bin/node', candidateBuild: 'candidate',
      buildManifestSha256: verified.buildManifestSha256 };
    const bytes = jsonBytes(metadata);
    need(bytes.length <= 64 * 1024, 'PREVIEW_METADATA_TOO_LARGE');
    writeNew(path.join(destination, META), bytes);
    writeNew(path.join(destination, SEAL), Buffer.from(sha(bytes) + '\n'));
    return verifyRuntime(destination);
  } catch (error) {
    const current = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino)
      fs.rmSync(destination, { recursive: true });
    throw error;
  }
}
function installIsolatedRuntime({ projectRoot, buildDirectory, destination, isolationRoot }) {
  directory(projectRoot); directory(buildDirectory); absolute(destination); absolute(isolationRoot);
  need(destination !== isolationRoot && inside(isolationRoot, destination), 'PREVIEW_ISOLATED_DESTINATION');
  const scope = activeIsolationBuild(projectRoot, buildDirectory, isolationRoot);
  const verified = requirePreviewBuild(buildDirectory);
  return install(projectRoot, buildDirectory, destination, scope, verified);
}
function installDefaultRuntime(projectRoot = path.resolve(__dirname, '..')) {
  directory(projectRoot);
  const adopted = adoptedBuild(projectRoot), parent = path.join(projectRoot, '.tools/preview-runtime');
  const info = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!info) fs.mkdirSync(parent, { mode: 0o700 });
  directory(parent);
  return install(projectRoot, adopted.buildDirectory, path.join(parent, adopted.record.candidate), adopted.scope, adopted);
}
function verifyRuntime(runtimeRoot) {
  directory(runtimeRoot);
  need((fs.lstatSync(runtimeRoot).mode & 0o7777) === 0o700, 'PREVIEW_RUNTIME_PERMISSIONS');
  const metadataBytes = readBytes(path.join(runtimeRoot, META), 64 * 1024);
  need(readBytes(path.join(runtimeRoot, SEAL), 65).toString('utf8') === sha(metadataBytes) + '\n', 'PREVIEW_METADATA_SEAL');
  const metadata = JSON.parse(metadataBytes);
  need(metadata.schema === SCHEMA && metadata.previewWorkspaceContract === CAPABILITY && metadata.manifestFile === MANIFEST
    && typeof metadata.candidate === 'string' && /^[0-9a-f]{40}$/.test(metadata.sourceHead), 'PREVIEW_METADATA_SCHEMA');
  const manifestBytes = readBytes(path.join(runtimeRoot, MANIFEST));
  need(sha(manifestBytes) === metadata.manifestSha256, 'PREVIEW_MANIFEST_CHANGED');
  const manifest = JSON.parse(manifestBytes);
  need(manifest.schema === MANIFEST_SCHEMA && Array.isArray(manifest.entries) && manifest.entries.length <= MAX_FILES,
    'PREVIEW_MANIFEST_SCHEMA');
  const supported = supportedDataFormat(metadata.supportedDataFormat);
  need(supported === supportedDataFormat(manifest.supportedDataFormat), 'PREVIEW_RUNTIME_DATA_FORMAT_BINDING');
  need(metadata.workspaceControlContract === manifest.workspaceControlContract &&
    (metadata.workspaceControlContract === undefined || metadata.workspaceControlContract === WORKSPACE_CONTROL_CONTRACT),
    'PREVIEW_WORKSPACE_CONTROL_CONTRACT');
  need(JSON.stringify(inventory(runtimeRoot)) === JSON.stringify(records.withoutFinderMetadata(manifest.entries)), 'PREVIEW_RUNTIME_FILES_CHANGED');
  need(metadata.hostExecutable === 'candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene'
    && metadata.python === '.venv/bin/python' && metadata.node === '.tools/node/bin/node'
    && metadata.candidateBuild === 'candidate', 'PREVIEW_ENTRY_CHANGED');
  need(metadata.installation?.kind === 'adopted' || metadata.installation?.kind === 'isolated', 'PREVIEW_INSTALLATION_KIND');
  if (metadata.installation.kind === 'isolated')
    need(typeof metadata.installation.isolationRoot === 'string' && runtimeRoot !== metadata.installation.isolationRoot
      && inside(absolute(metadata.installation.isolationRoot), runtimeRoot), 'PREVIEW_ISOLATED_DESTINATION');
  const python = path.join(runtimeRoot, metadata.python);
  need(fs.realpathSync(python).startsWith(path.join(runtimeRoot, '.tools/python') + path.sep), 'PREVIEW_PYTHON_OUTSIDE_RUNTIME');
  const verified = requirePreviewBuild(path.join(runtimeRoot, relative(metadata.candidateBuild)), {
    python: fs.realpathSync(python), node: path.join(runtimeRoot, metadata.node),
  });
  const signedCapabilities = signedBundleCapabilities(path.join(runtimeRoot, metadata.candidateBuild, 'Reverie Scene.app'));
  need(signedCapabilities.supportedDataFormat === supported &&
    signedCapabilities.workspaceControlContract === metadata.workspaceControlContract, 'PREVIEW_RUNTIME_BUNDLE_CAPABILITY_BINDING');
  need(verified.buildManifestSha256 === metadata.buildManifestSha256 && verified.record.source.head === metadata.sourceHead,
    'PREVIEW_BUILD_BINDING_CHANGED');
  need(supportedDataFormat(verified.record.supportedDataFormat) === supported &&
    verified.record.workspaceControlContract === metadata.workspaceControlContract, 'PREVIEW_RUNTIME_DATA_FORMAT_BINDING');
  need(metadata.candidate === (verified.record.candidate || `local-${verified.record.localIteration?.package || 'isolated'}`),
    'PREVIEW_CANDIDATE_BINDING_CHANGED');
  const rows = records.runtimeInputs(json(path.join(runtimeRoot, metadata.candidateBuild, 'source-inventory.json')));
  need(JSON.stringify(sourceRuntimeInventory(runtimeRoot, rows)) === JSON.stringify(records.withoutFinderMetadata(rows))
    && JSON.stringify(manifest.sourceRuntimeInputs) === JSON.stringify(verified.record.source.runtimeInputs),
    'PREVIEW_RUNTIME_INPUT_DIGEST');
  return { runtimeRoot, metadataPath: path.join(runtimeRoot, META), manifestPath: path.join(runtimeRoot, META), inventoryPath: path.join(runtimeRoot, MANIFEST),
    candidate: metadata.candidate, sourceHead: metadata.sourceHead, buildManifestSha256: metadata.buildManifestSha256, python,
    supportedDataFormat: supported, workspaceControlContract: metadata.workspaceControlContract || null,
    node: path.join(runtimeRoot, metadata.node), hostExecutable: path.join(runtimeRoot, metadata.hostExecutable),
    installationKind: metadata.installation?.kind, isolationRoot: metadata.installation?.isolationRoot || null };
}
function workspaceDirectory(workspace, runtime) {
  absolute(workspace);
  if (runtime.installationKind === 'isolated')
    need(workspace !== runtime.isolationRoot && inside(runtime.isolationRoot, workspace), 'PREVIEW_ISOLATED_WORKSPACE');
  need(!inside(runtime.runtimeRoot, workspace) && !inside(workspace, runtime.runtimeRoot), 'PREVIEW_WORKSPACE_OVERLAPS_RUNTIME');
  directory(path.dirname(workspace));
  const info = fs.lstatSync(workspace, { throwIfNoEntry: false });
  if (!info) fs.mkdirSync(workspace, { mode: 0o700 });
  directory(workspace);
  need((fs.lstatSync(workspace).mode & 0o7777) === 0o700, 'PREVIEW_WORKSPACE_PERMISSIONS');
  return workspace;
}
function boundedLog(workspace) {
  const logs = path.join(workspace, 'logs');
  if (!fs.existsSync(logs)) fs.mkdirSync(logs, { mode: 0o700 });
  directory(logs);
  need((fs.lstatSync(logs).mode & 0o7777) === 0o700, 'PREVIEW_LOG_PERMISSIONS');
  let descriptor = null, size = 0, sequence = 0;
  const prefix = `preview-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  function rotate() {
    if (descriptor !== null) fs.closeSync(descriptor);
    need(sequence < 1000000000000, 'PREVIEW_LOG_SEQUENCE_LIMIT');
    const filename = path.join(logs, `${prefix}-${String(sequence++).padStart(12, '0')}.log`);
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    size = 0;
    const files = fs.readdirSync(logs).filter(name => /^preview-[0-9]+-[0-9]+-[0-9a-f]{8}-[0-9]{12}\.log$/.test(name))
      .map(name => ({ file: path.join(logs, name), info: fs.lstatSync(path.join(logs, name)) }));
    for (const { info } of files)
      need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && own(info), 'PREVIEW_LOG_ALIAS');
    const removable = files.filter(item => item.file !== filename)
      .sort((a, b) => a.info.mtimeMs - b.info.mtimeMs || a.file.localeCompare(b.file, 'en'));
    for (const item of removable.slice(0, Math.max(0, files.length - LOG_MAX_FILES))) fs.unlinkSync(item.file);
  }
  return { directory: logs, write(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let offset = 0; offset < bytes.length;) {
      if (descriptor === null || size === LOG_MAX_BYTES) rotate();
      const length = Math.min(LOG_MAX_BYTES - size, bytes.length - offset);
      const written = fs.writeSync(descriptor, bytes, offset, length);
      need(written > 0, 'PREVIEW_LOG_WRITE_FAILED');
      size += written; offset += written;
    }
  }, close() { if (descriptor !== null) fs.closeSync(descriptor); descriptor = null; } };
}
async function startRuntime({ runtimeRoot, workspace }) {
  const runtime = verifyRuntime(runtimeRoot);
  // This precedes workspaceDirectory, host launch, cache/log creation and all
  // avatar helpers, including when the selected target is the first preview.
  checkDataFormat(workspace, runtime.supportedDataFormat);
  if (hasPendingRecovery(workspace)) {
    const controller = recoveryController(runtime, path.resolve(__dirname, '..'));
    runWorkspaceControl({ runtime: controller, workspace, operation: 'recover' });
    checkDataFormat(workspace, runtime.supportedDataFormat);
  }
  workspaceDirectory(workspace, runtime);
  const environment = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined)
    .map(key => [key, process.env[key]]));
  Object.assign(environment, { PATH: `${path.join(runtimeRoot, '.tools/node/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' });
  const child = spawn(runtime.hostExecutable, ['--workspace', workspace, '--project-root', runtimeRoot, '--python', runtime.python],
    { cwd: runtimeRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const handlers = new Map(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => [signal, () => forward(signal)]));
  for (const [signal, listener] of handlers) process.on(signal, listener);
  let log = null, logError, pending = [], pendingBytes = 0, readyTail = Buffer.alloc(0), droppingLine = false;
  function bufferBeforeReady(bytes) {
    if (bytes.length >= LOG_MAX_BYTES) { pending = [Buffer.from(bytes.subarray(bytes.length - LOG_MAX_BYTES))]; pendingBytes = LOG_MAX_BYTES; return; }
    if (bytes.length === 0) return;
    pending.push(Buffer.from(bytes)); pendingBytes += bytes.length;
    while (pendingBytes > LOG_MAX_BYTES) {
      const excess = pendingBytes - LOG_MAX_BYTES, first = pending[0];
      if (first.length <= excess) { pending.shift(); pendingBytes -= first.length; }
      else { pending[0] = first.subarray(excess); pendingBytes -= excess; }
    }
    if (pending.length >= 64) pending = [Buffer.concat(pending, pendingBytes)];
  }
  function acceptReady(line) {
    const prefix = 'REVERIE_PREVIEW_READY ';
    if (!line.subarray(0, prefix.length).equals(Buffer.from(prefix))) return;
    let value;
    try { value = JSON.parse(line.subarray(prefix.length).toString('utf8')); } catch { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'backendPid,candidate,hostPid,recoveryState,runtimeWritable,schema,sourceHead,workspaceId' ||
        value.schema !== 'reverie.qt.preview.ready.v1' || value.hostPid !== child.pid ||
        !Number.isSafeInteger(value.backendPid) || value.backendPid <= 1 || value.backendPid === child.pid ||
        value.candidate !== runtime.candidate || value.sourceHead !== runtime.sourceHead ||
        value.workspaceId !== sha(Buffer.from(workspace)) || value.recoveryState !== 'clean' || value.runtimeWritable !== true) return;
    // A rejected second host never reaches authenticated ready. Until this
    // point output is visible in the terminal but creates no workspace logs.
    log = boundedLog(workspace);
    for (const bytes of pending) log.write(bytes);
    pending = []; pendingBytes = 0;
  }
  function observeReady(bytes) {
    for (let offset = 0; offset < bytes.length && log === null;) {
      const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      if (!droppingLine) {
        if (readyTail.length + part.length > READY_LINE_MAX_BYTES) { readyTail = Buffer.alloc(0); droppingLine = true; }
        else readyTail = Buffer.concat([readyTail, part]);
      }
      if (newline < 0) break;
      if (!droppingLine) acceptReady(readyTail);
      readyTail = Buffer.alloc(0); droppingLine = false; offset = newline + 1;
    }
  }
  const output = (stream, chunk, stdout) => {
    stream.write(chunk);
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (log) log.write(bytes);
      else { bufferBeforeReady(bytes); if (stdout) observeReady(bytes); }
    } catch (error) { logError = logError || error; child.kill('SIGTERM'); }
  };
  child.stdout.on('data', chunk => output(process.stdout, chunk, true));
  child.stderr.on('data', chunk => output(process.stderr, chunk, false));
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal, hostPid: child.pid }));
    });
    if (logError) throw logError;
    return { ...runtime, ...result, logDirectory: path.join(workspace, 'logs'), readyObserved: log !== null };
  } finally {
    for (const [signal, listener] of handlers) process.removeListener(signal, listener);
    if (log) log.close();
  }
}
function defaultRuntimeRoot(projectRoot) {
  const pointer = json(path.join(projectRoot, '.tools/qt-candidates/last-local-sdk.json'), 64 * 1024);
  const name = path.basename(pointer.directory || '');
  need(/^[a-z0-9][a-z0-9-]{1,63}$/.test(name), 'PREVIEW_DEFAULT_CANDIDATE_PATH');
  return path.join(projectRoot, '.tools/preview-runtime', name);
}
function recoveryController(target, projectRoot) {
  if (target.workspaceControlContract === WORKSPACE_CONTROL_CONTRACT) return target;
  const candidates = [];
  try { candidates.push(defaultRuntimeRoot(projectRoot)); } catch {}
  const parent = path.join(projectRoot, '.tools/preview-runtime');
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')))
      if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(parent, entry.name));
  } catch {}
  for (const candidate of new Set(candidates)) {
    if (candidate === target.runtimeRoot) continue;
    try {
      const runtime = verifyRuntime(candidate);
      if (runtime.workspaceControlContract === WORKSPACE_CONTROL_CONTRACT) return runtime;
    } catch {}
  }
  need(false, 'PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED');
}
function runWorkspaceControl({ runtime, workspace, operation, snapshot }) {
  need(runtime.workspaceControlContract === WORKSPACE_CONTROL_CONTRACT, 'PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED');
  need(['snapshots', 'restore', 'recover'].includes(operation) && (operation === 'restore') === (snapshot !== undefined),
    'PREVIEW_RESTORE_ARGUMENTS');
  if (snapshot !== undefined)
    need(typeof snapshot === 'string' && snapshot.length <= 255 && /^(?:snapshot|pre-restore)-[A-Za-z0-9._-]+$/.test(snapshot), 'PREVIEW_RESTORE_SNAPSHOT_NAME');
  need(fs.lstatSync(workspace, { throwIfNoEntry: false })?.isDirectory(), 'PREVIEW_WORKSPACE_REQUIRED');
  workspaceDirectory(workspace, runtime); // Existing root only; no data/avatar creation.
  const environment = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(environment, { PATH: `${path.join(runtime.runtimeRoot, '.tools/node/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' });
  const arguments_ = ['--preview-workspace-control', operation, '--workspace-path', workspace,
    '--project-root', runtime.runtimeRoot, '--python', runtime.python];
  if (snapshot !== undefined) arguments_.push('--snapshot', snapshot);
  let output;
  try {
    output = execFileSync(runtime.hostExecutable, arguments_, { cwd: runtime.runtimeRoot, env: environment,
      encoding: 'utf8', maxBuffer: MAX_MANIFEST_BYTES });
  } catch (error) {
    const match = String(error.stderr || '').match(/\bPREVIEW_[A-Z_]+\b/);
    need(false, match ? match[0] : 'PREVIEW_RESTORE_CONTROL_FAILED');
  }
  let result;
  try { result = JSON.parse(output); } catch { need(false, 'PREVIEW_RESTORE_CONTROL_RESULT_INVALID'); }
  const schemas = { snapshots: 'reverie.preview.snapshots.v1', restore: 'reverie.preview.restore-result.v1',
    recover: 'reverie.preview.recovered.v1' };
  need(result && !Array.isArray(result) && result.schema === schemas[operation], 'PREVIEW_RESTORE_CONTROL_RESULT_INVALID');
  return result;
}
const shellArgument = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function restoreCommands(result, runtime, workspace, projectRoot) {
  const identity = result.dataIdentity;
  need(identity && typeof identity.candidate === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(identity.candidate) &&
    identity.candidate !== '.' && identity.candidate !== '..',
    'PREVIEW_RESTORE_CONTROL_RESULT_INVALID');
  const oldRoot = path.join(projectRoot, '.tools/preview-runtime', identity.candidate);
  const command = root => [path.join(projectRoot, 'script/preview-qt-macos.sh'), 'start', '--runtime-root', root,
    '--workspace', workspace].map(shellArgument).join(' ');
  return { ...result, rollbackCommand: command(oldRoot), retryCommand: command(runtime.runtimeRoot) };
}
async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const projectRoot = path.resolve(__dirname, '..');
  if (command === 'install') {
    need(rest.length === 0, 'PREVIEW_INSTALL_ARGUMENTS');
    process.stdout.write(JSON.stringify(installDefaultRuntime(projectRoot)) + '\n');
    return 0;
  }
  need(['start', 'verify', 'diagnostics', 'snapshots', 'restore', 'recover'].includes(command), 'PREVIEW_USAGE: install | start [--runtime-root ABS] [--workspace ABS] | snapshots [--runtime-root ABS] [--workspace ABS] | restore --snapshot NAME [--runtime-root ABS] [--workspace ABS] | recover [--runtime-root ABS] [--workspace ABS] | verify --runtime-root ABS | diagnostics --output ABS [--runtime-root ABS] [--workspace ABS]');
  let runtimeRoot, workspace, output, snapshot;
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index], value = rest[++index];
    if (key === '--runtime-root' && !runtimeRoot) runtimeRoot = absolute(value);
    else if (key === '--workspace' && !workspace && ['start', 'diagnostics', 'snapshots', 'restore', 'recover'].includes(command)) workspace = absolute(value);
    else if (key === '--output' && !output && command === 'diagnostics') output = absolute(value);
    else if (key === '--snapshot' && snapshot === undefined && command === 'restore') snapshot = value;
    else need(false, 'PREVIEW_ARGUMENTS');
  }
  if (command !== 'diagnostics') runtimeRoot ||= defaultRuntimeRoot(projectRoot);
  if (command === 'verify') { process.stdout.write(JSON.stringify(verifyRuntime(runtimeRoot)) + '\n'); return 0; }
  workspace ||= path.join(os.homedir(), 'Library/Application Support/Reverie Preview');
  if (['snapshots', 'restore', 'recover'].includes(command)) {
    need((command === 'restore') === (snapshot !== undefined), 'PREVIEW_RESTORE_ARGUMENTS');
    const runtime = verifyRuntime(runtimeRoot);
    let result = runWorkspaceControl({ runtime, workspace, operation: command, snapshot });
    if (command === 'restore') result = restoreCommands(result, runtime, workspace, projectRoot);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (command === 'restore') {
      process.stdout.write('回到旧版本：' + result.rollbackCommand + '\n');
      process.stdout.write('用新版本再试：' + result.retryCommand + '\n');
    }
    return 0;
  }
  if (command === 'diagnostics') {
    try {
      need(output, 'PREVIEW_DIAGNOSTICS_OUTPUT_REQUIRED');
      runtimeRoot ||= defaultRuntimeRoot(projectRoot);
      const runtime = verifyRuntime(runtimeRoot);
      require('./preview-diagnostics.cjs').exportDiagnostics({ workspace, output, runtime });
      process.stdout.write('PREVIEW_DIAGNOSTICS_EXPORTED\n');
      return 0;
    } catch (error) {
      // Build verification may contain source paths in its error text. This
      // entry emits fixed codes only, just like the exported document.
      const code = typeof error?.code === 'string' && /^PREVIEW_DIAGNOSTICS_[A-Z_]+$/.test(error.code) ?
        error.code : 'PREVIEW_DIAGNOSTICS_FAILED';
      const failure = new Error(code); failure.code = code; throw failure;
    }
  }
  const result = await startRuntime({ runtimeRoot, workspace });
  return result.exitCode === null ? 128 + (os.constants.signals[result.signal] || 1) : result.exitCode;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  const notices = {
    PREVIEW_DATA_FORMAT_TOO_NEW: '数据来自更新的版本，请用新版本打开，或先恢复升级前的快照。',
    PREVIEW_DATA_FORMAT_INVALID: '工作区数据格式记录无法安全读取，预览没有启动。请保留现场并反馈。',
    PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED: '未找到支持恢复的已验证新预览版本，已保留现场，预览没有启动。',
    PREVIEW_RESTORE_RECOVERY_REQUIRED: '恢复记录状态不明，已保留现场，预览未启动。请勿删除目录，导出诊断并反馈。',
  };
  process.stderr.write(String(error.message) + (notices[error.code] ? ': ' + notices[error.code] : '') + '\n'); process.exitCode = 1;
});
module.exports = { SCHEMA, MANIFEST_SCHEMA, CAPABILITY, SUPPORTED_DATA_FORMAT, WORKSPACE_CONTROL_CONTRACT,
  DATA_FORMAT_SCHEMA, DATA_FORMAT_RECORD, LOG_MAX_BYTES, LOG_MAX_FILES, supportedDataFormat, signedBundleCapabilities, checkDataFormat,
  hasPendingRecovery, recoveryController, runWorkspaceControl, restoreCommands,
  installDefaultRuntime, installIsolatedRuntime, verifyRuntime, startRuntime, boundedLog, main };
