'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { auditDependencyGraph, parseLoadCommands } = require('../script/macos-app-audit.cjs');

const dependency = (value, command = 'LC_LOAD_DYLIB') => ({ path: value, command });

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie app audit '));
  const root = path.join(parent, '中文 Candidate.app');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const nativeFiles = [];
  return {
    root, parent, nativeFiles,
    image(filename, { fileType = 'DYLIB', rpaths = [], dependencies = [], dylinker = null } = {}) {
      const target = path.join(root, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'A graph fixture; native format/signatures are checked by the outer audit.');
      const image = { path: filename, fileType, rpaths, dependencies, dylinker };
      nativeFiles.push(image);
      return image;
    },
    audit() { return auditDependencyGraph({ appRoot: root, nativeFiles }); },
  };
}

test('load commands distinguish IDs from all dependency kinds and preserve spaces', () => {
  const commands = [
    ['LC_RPATH', 'path', '@loader_path/Libraries'],
    ['LC_ID_DYLIB', 'name', './Electron Framework'],
    ['LC_LOAD_DYLIB', 'name', '@rpath/Electron Framework.framework/Electron Framework'],
    ['LC_LOAD_WEAK_DYLIB', 'name', '/System/Library/Frameworks/Example.framework/Example'],
    ['LC_REEXPORT_DYLIB', 'name', '@loader_path/reexport.dylib'],
    ['LC_LOAD_UPWARD_DYLIB', 'name', '@loader_path/upward.dylib'],
    ['LC_LAZY_LOAD_DYLIB', 'name', '@loader_path/lazy.dylib'],
    ['LC_LOAD_DYLINKER', 'name', '/usr/lib/dyld'],
  ];
  const text = commands.map(([command, field, value], index) => `Load command ${index}\n cmd ${command}\n cmdsize 128\n ${field} ${value} (offset 12)\n`).join('');
  const result = parseLoadCommands(text);
  assert.equal(result.installName, './Electron Framework');
  assert.equal(result.dylinker, '/usr/lib/dyld');
  assert.equal(result.dependencies.length, 5);
  assert.equal(result.dependencies.some((item) => item.path === './Electron Framework'), false);
  assert.equal(result.dependencies[0].path, '@rpath/Electron Framework.framework/Electron Framework');
  assert.deepEqual(result.rpaths, ['@loader_path/Libraries']);
});

test('malformed load commands and embedded dyld environment fail closed', () => {
  assert.throws(() => parseLoadCommands(''), /did not report/);
  assert.throws(() => parseLoadCommands('Load command 0\n cmd LC_LOAD_DYLIB\n cmdsize 32\n'), /Malformed/);
  assert.throws(() => parseLoadCommands('Load command 0\n cmd LC_DYLD_ENVIRONMENT\n name DYLD_LIBRARY_PATH=/tmp (offset 12)\n'), /forbidden/);
});

test('Electron framework dependencies inherit each real executable loader chain', (t) => {
  const f = fixture(t);
  const framework = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
  const loadFramework = dependency('@rpath/Electron Framework.framework/Versions/A/Electron Framework');
  const main = 'Contents/MacOS/Test';
  const helper = 'Contents/Frameworks/Test Helper (GPU).app/Contents/MacOS/Test Helper (GPU)';
  f.image(main, { fileType: 'EXECUTE', rpaths: ['@executable_path/../Frameworks'], dependencies: [loadFramework] });
  f.image(helper, { fileType: 'EXECUTE', rpaths: ['@executable_path/../../..'], dependencies: [loadFramework] });
  f.image(framework, { rpaths: ['@loader_path/Libraries'], dependencies: [dependency('@rpath/libffmpeg.dylib'), dependency('@rpath/Mantle.framework/Mantle')] });
  f.image('Contents/Frameworks/Mantle.framework/Mantle', { dependencies: [dependency('/usr/lib/libSystem.B.dylib')] });
  const graphics = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib';
  f.image(graphics, { rpaths: ['@executable_path/', '@loader_path/.'], dependencies: [dependency('@rpath/libffmpeg.dylib')] });
  f.image('Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib');
  const report = f.audit();
  const frameworkHosts = report.contexts.filter((item) => item.image === framework).map((item) => item.executable);
  assert.deepEqual(new Set(frameworkHosts), new Set([main, helper]));
  const graphicsHosts = report.dynamicEntrypoints.filter((item) => item.image === graphics).map((item) => item.executable);
  assert.deepEqual(new Set(graphicsHosts), new Set([main, helper]));
  assert.ok(report.dependencies.some((item) => item.image === framework && item.target === 'Contents/Frameworks/Mantle.framework/Mantle'));
});

test('an unrelated executable rpath cannot satisfy another process dependency', (t) => {
  const f = fixture(t);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE', rpaths: ['@executable_path/../Frameworks'], dependencies: [dependency('@rpath/private.dylib')] });
  f.image('Contents/Helpers/Other', { fileType: 'EXECUTE', rpaths: ['@loader_path/private-libraries'] });
  f.image('Contents/Helpers/private-libraries/private.dylib');
  assert.throws(() => f.audit(), /Unresolved LC_LOAD_DYLIB.*Contents\/MacOS\/Main/);
});

test('a missing bundled weak dependency is not silently accepted', (t) => {
  const f = fixture(t);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE', dependencies: [dependency('@loader_path/missing.dylib', 'LC_LOAD_WEAK_DYLIB')] });
  assert.throws(() => f.audit(), /Unresolved LC_LOAD_WEAK_DYLIB/);
});

test('unused external build rpaths still fail the audit', (t) => {
  const f = fixture(t);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE', rpaths: ['/Users/builder/build/lib'], dependencies: [dependency('/usr/lib/libSystem.B.dylib')] });
  assert.throws(() => f.audit(), /must be bundle-relative/);
});

test('external build libraries and traversed system prefixes are not system dependencies', (t) => {
  const f = fixture(t);
  const image = f.image('Contents/MacOS/Main', { fileType: 'EXECUTE' });
  for (const value of ['/opt/homebrew/lib/library.dylib', '/usr/local/lib/library.dylib', '/usr/lib/../../Users/builder/library.dylib']) {
    image.dependencies = [dependency(value)];
    assert.throws(() => f.audit(), /must be bundle-relative/);
  }
});

test('Python extension closures use only the bundled Python executable context', (t) => {
  const f = fixture(t);
  const executable = 'Contents/Resources/python/bin/python3.12';
  const extension = 'Contents/Resources/python/lib/python3.12/site-packages/example.so';
  f.image(executable, { fileType: 'EXECUTE', rpaths: ['@executable_path/../lib'] });
  f.image(extension, { fileType: 'BUNDLE', dependencies: [dependency('@rpath/libexample.dylib')] });
  const library = 'Contents/Resources/python/lib/libexample.dylib';
  f.image(library, { dependencies: [dependency('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')] });
  const report = f.audit();
  assert.ok(report.dependencies.some((item) => item.image === extension && item.executable === executable && item.target === library));
  assert.equal(report.dynamicEntrypoints.every((item) => item.executable === executable), true);
});

test('unclassified dynamic native code fails instead of using a global search path', (t) => {
  const f = fixture(t);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE' });
  f.image('Contents/Resources/unknown-addon.node', { fileType: 'BUNDLE' });
  assert.throws(() => f.audit(), /Unclassified dynamically loaded native image/);
});

test('a loader rpath cannot follow a symlink outside the application', (t) => {
  const f = fixture(t);
  const outside = path.join(f.parent, 'outside');
  fs.mkdirSync(outside);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE', rpaths: ['@loader_path/escape'] });
  fs.symlinkSync(outside, path.join(f.root, 'Contents/MacOS/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.audit(), /external symlink/);
});

test('non-system dynamic loaders are refused even without library dependencies', (t) => {
  const f = fixture(t);
  f.image('Contents/MacOS/Main', { fileType: 'EXECUTE', dylinker: '/Users/builder/dyld' });
  assert.throws(() => f.audit(), /External dynamic loader/);
});
