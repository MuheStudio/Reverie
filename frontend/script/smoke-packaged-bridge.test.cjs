'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { assertPackagedLayout } = require('./smoke-packaged-bridge.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie packaged layout '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources');
  const source = path.join(resources, 'src');
  fs.mkdirSync(path.join(resources, 'python'), { recursive: true });
  for (const directory of ['diary', 'games', 'immersion', 'stickers', 'web', 'archive', 'lorebook', 'social', 'keepsakes']) {
    fs.mkdirSync(path.join(source, directory), { recursive: true });
  }
  const python = path.join(resources, 'python', 'python.exe');
  const entrypoint = path.join(source, 'main.py');
  for (const file of [python, entrypoint, ...['ambient.py', 'backup.py', 'notifications.py'].map((name) => path.join(source, name))]) {
    fs.writeFileSync(file, 'synthetic package layout fixture');
  }
  return { root, resources, source, python, entrypoint };
}

test('Windows package accepts the actual mix of Python packages and single-file modules', (t) => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.source, 'ambient')), false);
  assert.equal(fs.existsSync(path.join(f.source, 'backup')), false);
  assert.deepEqual(assertPackagedLayout(f.root), {
    resources: f.resources, python: f.python, entrypoint: f.entrypoint,
  });
});

for (const filename of ['ambient.py', 'backup.py', 'notifications.py', 'games']) {
  test(`Windows package rejects missing required module ${filename}`, (t) => {
    const f = fixture(t);
    fs.rmSync(path.join(f.source, filename), { recursive: true });
    assert.throws(() => assertPackagedLayout(f.root), /Core companion module was not packaged/);
  });
  test(`Windows package rejects the wrong filesystem type for ${filename}`, (t) => {
    const f = fixture(t);
    const target = path.join(f.source, filename);
    fs.rmSync(target, { recursive: true });
    if (filename.endsWith('.py')) fs.mkdirSync(target);
    else fs.writeFileSync(target, 'not a package directory');
    assert.throws(() => assertPackagedLayout(f.root), /invalid filesystem type/);
  });
}

for (const entry of ['python', 'entrypoint']) {
  test(`Windows package refuses a directory in place of the ${entry} input`, (t) => {
    const f = fixture(t);
    fs.unlinkSync(f[entry]);
    fs.mkdirSync(f[entry]);
    assert.throws(() => assertPackagedLayout(f.root), /Packaged bridge input is invalid/);
  });
}

test('Windows package refuses redirected package directories', (t) => {
  const f = fixture(t);
  const target = path.join(f.source, 'games');
  const redirected = path.join(f.root, 'redirected-games');
  fs.renameSync(target, redirected);
  fs.symlinkSync(redirected, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPackagedLayout(f.root), /invalid filesystem type/);
});

test('Windows package refuses symlinked single-file modules', {
  skip: process.platform === 'win32' ? 'POSIX file symlink fixture; Windows junctions tested separately' : false,
}, (t) => {
  const f = fixture(t);
  const target = path.join(f.source, 'ambient.py');
  const redirected = path.join(f.root, 'redirected-ambient.py');
  fs.renameSync(target, redirected);
  fs.symlinkSync(redirected, target);
  assert.throws(() => assertPackagedLayout(f.root), /invalid filesystem type/);
});

for (const moduleName of ['ambient', 'backup', 'games']) {
  test(`required ${moduleName} cannot drift into the source omission policy`, (t) => {
    const f = fixture(t);
    const filename = path.join(__dirname, 'smoke-packaged-bridge.cjs');
    const actualRequire = createRequire(filename);
    const injectedRequire = (specifier) => {
      const original = actualRequire(specifier);
      return specifier === './production-runtime.cjs'
        ? { ...original, OMITTED_SOURCE_MODULES: [...original.OMITTED_SOURCE_MODULES, moduleName] }
        : original;
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: injectedRequire, module, __dirname,
    }, { filename });
    assert.throws(() => module.exports.assertPackagedLayout(f.root), /must not appear in OMITTED_SOURCE_MODULES/);
  });
}

for (const filename of ['work_manager.py', 'affairs']) {
  test(`non-MVP module ${filename} remains forbidden`, (t) => {
    const f = fixture(t);
    if (filename.endsWith('.py')) fs.writeFileSync(path.join(f.source, filename), 'not allowed');
    else fs.mkdirSync(path.join(f.source, filename));
    assert.throws(() => assertPackagedLayout(f.root), /Non-MVP Python module was packaged/);
  });
}
