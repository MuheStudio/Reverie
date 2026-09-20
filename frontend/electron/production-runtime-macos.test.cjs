'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  parseRuntimeLock, inspectTree, isMachO, resolveLoaderPath, isSystemDependency, externalAuditPath,
} = require('../script/production-runtime-macos.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const lock = fs.readFileSync(path.join(projectRoot, 'requirements-macos-arm64.lock'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie runtime fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('production runtime lock selects exactly 47 original hashed wheels', () => {
  const rows = parseRuntimeLock(lock);
  assert.equal(rows.length, 47);
  assert.equal(new Set(rows.map((row) => row.name)).size, 47);
  assert.deepEqual(rows.find((row) => row.name === 'sqlcipher3'), {
    name: 'sqlcipher3', version: '0.6.2', filename: 'sqlcipher3-0.6.2-cp312-cp312-macosx_11_0_arm64.whl',
    sha256: 'bc2edd981e65783bc0d4e337704a9eb436871ab91c68af02ed76354876087642',
  });
  assert.match(rows.find((row) => row.name === 'lxml').filename, /universal2\.whl$/);
  assert.equal(rows.some((row) => /^(pip|pytest|textual|playwright|torch|uv)$/.test(row.name)), false);
});

test('runtime lock rejects altered hashes, broad requirements, duplicates and developer packages', () => {
  assert.throws(() => parseRuntimeLock(lock.replace(/--hash=sha256:[a-f0-9]{64}/, '--hash=sha256:broken')), /exact wheel/);
  assert.throws(() => parseRuntimeLock(`${lock}\npytest>=8\n`), /exact wheel/);
  assert.throws(() => parseRuntimeLock(lock.replace('annotated-types==0.7.0', 'pip==0.7.0')), /Unexpected runtime distribution/);
  assert.throws(() => parseRuntimeLock(lock.replace('anyio==4.13.0', 'annotated-types==4.13.0')), /Unexpected runtime distribution/);
  assert.throws(() => parseRuntimeLock(lock.replace(/# annotated_types[^\n]+\nannotated-types[^\n]+\n[^\n]+\n/, '')), /47-package/);
});

test('runtime inventory hashes files and detects even a same-size mutation', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'library.py');
  fs.writeFileSync(file, 'before');
  const before = inspectTree(root);
  fs.writeFileSync(file, 'after!');
  const after = inspectTree(root);
  assert.equal(before[0].size, after[0].size);
  assert.notEqual(before[0].sha256, after[0].sha256);
});

test('runtime accepts only relative internal links and rejects escapes or dangling links', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'owned'));
  const link = path.join(root, 'alias');
  if (process.platform === 'win32') {
    fs.symlinkSync(path.join(root, 'owned'), link, 'junction');
    assert.throws(() => inspectTree(root), /Non-relocatable symlink/);
  } else {
    fs.symlinkSync('owned', link, 'dir');
    assert.equal(inspectTree(root).find((entry) => entry.path === 'alias').target, 'owned');
    fs.unlinkSync(link);
    fs.symlinkSync('../', link, 'dir');
    assert.throws(() => inspectTree(root), /Non-relocatable symlink/);
    fs.unlinkSync(link);
    fs.symlinkSync('missing', link, 'dir');
    assert.throws(() => inspectTree(root), { code: 'ENOENT' });
  }
});

test('Mach-O detection uses magic bytes rather than file extensions', (t) => {
  const root = fixture(t);
  for (const header of ['cffaedfe', 'cafebabe', 'cafebabf']) {
    const file = path.join(root, header);
    fs.writeFileSync(file, Buffer.from(header, 'hex'));
    assert.equal(isMachO(file), true);
  }
  const file = path.join(root, 'pretend.dylib');
  fs.writeFileSync(file, 'not a binary');
  assert.equal(isMachO(file), false);
});

test('loader references cannot escape runtime or resolve against Homebrew', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'lib/pkg/module.so');
  const executable = path.join(root, 'bin/python3.12');
  assert.equal(resolveLoaderPath('@loader_path/../libsupport.dylib', file, executable, root), path.join(root, 'lib/libsupport.dylib'));
  assert.equal(resolveLoaderPath('@executable_path/../lib', file, executable, root), path.join(root, 'lib'));
  assert.throws(() => resolveLoaderPath('@loader_path/../../../outside', file, executable, root), /leaves runtime/);
  assert.throws(() => resolveLoaderPath('/opt/homebrew/lib/library.dylib', file, executable, root), /leaves runtime/);
  assert.throws(() => resolveLoaderPath('library.dylib', file, executable, root), /Unsupported relative/);
});

test('system linkage allowlist rejects normalized traversal and non-system absolute paths', () => {
  assert.equal(isSystemDependency('/usr/lib/libSystem.B.dylib'), true);
  assert.equal(isSystemDependency('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'), true);
  for (const value of ['/usr/lib/../../Users/builder/lib.dylib', '/usr/local/lib/lib.dylib', '/opt/homebrew/lib/lib.dylib', '/Users/builder/lib.dylib', '@rpath/libSystem.B.dylib']) {
    assert.equal(isSystemDependency(value), false, value);
  }
});

test('audit scratch and reports cannot write into a bundle, including through an ancestor link', (t) => {
  const root = fixture(t);
  const bundle = path.join(root, 'Example.app');
  const runtime = path.join(bundle, 'Contents/Resources/python');
  fs.mkdirSync(runtime, { recursive: true });
  const alias = path.join(root, 'bundle-alias');
  fs.symlinkSync(bundle, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const output of [path.join(runtime, 'audit.json'), path.join(bundle, 'Resources/report'), path.join(alias, 'new/scratch')]) {
    assert.throws(() => externalAuditPath(runtime, output), /outside runtime and application bundles/);
  }
  assert.equal(externalAuditPath(runtime, path.join(root, 'external/report.json')), path.join(root, 'external/report.json'));
  assert.equal(fs.existsSync(path.join(alias, 'new')), false);
});
