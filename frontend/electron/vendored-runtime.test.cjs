'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareVendoredRuntime } = require('../script/prepare-vendored-runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-vendor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'vendor', 'pixi-live2d-display');
  fs.cpSync(path.join(__dirname, '..', 'vendor', 'pixi-live2d-display'), source, { recursive: true });
  const installed = path.join(root, 'node_modules', 'pixi-live2d-display');
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(source, 'package.json'), path.join(installed, 'package.json'));
  return { root, source, installed };
}

test('restores missing renderer files byte-for-byte and is idempotent', (t) => {
  const f = fixture(t);
  assert.deepEqual(prepareVendoredRuntime(f.root).restored, ['cubism4.es.js', 'cubism4.js']);
  for (const name of ['cubism4.es.js', 'cubism4.js']) {
    assert.deepEqual(fs.readFileSync(path.join(f.installed, 'dist', name)), fs.readFileSync(path.join(f.source, 'dist', name)));
  }
  assert.deepEqual(prepareVendoredRuntime(f.root).restored, []);
});

test('a source hash mismatch fails before writing installed files', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.source, 'dist', 'cubism4.js'), '\n// changed');
  assert.throws(() => prepareVendoredRuntime(f.root), /integrity check failed/);
  assert.equal(fs.existsSync(path.join(f.installed, 'dist')), false);
});

test('a conflicting existing renderer is preserved and no other file is copied', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.installed, 'dist'));
  const changed = path.join(f.installed, 'dist', 'cubism4.js');
  fs.writeFileSync(changed, 'user modified renderer');
  assert.throws(() => prepareVendoredRuntime(f.root), /refusing to overwrite/);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'user modified renderer');
  assert.equal(fs.existsSync(path.join(f.installed, 'dist', 'cubism4.es.js')), false);
});

test('an unexpected installed package version is rejected', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.installed, 'package.json'), JSON.stringify({ name: 'pixi-live2d-display', version: '0.5.0' }));
  assert.throws(() => prepareVendoredRuntime(f.root), /identity does not match/);
});

test('an installed package link escaping node_modules is rejected', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  fs.rmSync(f.installed, { recursive: true });
  fs.symlinkSync(f.source, f.installed);
  assert.throws(() => prepareVendoredRuntime(f.root), /outside this project node_modules/);
});

test('a symlinked destination directory is rejected', {
  skip: process.platform === 'win32' ? 'symlink creation may require Windows elevation' : false,
}, (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.source, 'dist'), path.join(f.installed, 'dist'));
  assert.throws(() => prepareVendoredRuntime(f.root), /ordinary directory/);
});
