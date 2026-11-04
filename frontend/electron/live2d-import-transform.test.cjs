'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createRuntimeTextureTransformer,
  normalizeMaxDimension,
  parseTransformOutput,
} = require('./live2d-import-transform.cjs');

test('texture transformer config rejects missing files and illegal dimensions', () => {
  assert.equal(normalizeMaxDimension(4096), 4096);
  assert.throws(() => normalizeMaxDimension(128), /integer/i);
  assert.throws(() => createRuntimeTextureTransformer({
    pythonPath: path.join(os.tmpdir(), 'missing-python.exe'),
    scriptPath: path.join(os.tmpdir(), 'missing.py'),
  }), /regular file/i);
});

test('texture transformer parses metadata and refuses escaped paths', () => {
  assert.deepEqual(parseTransformOutput('[]'), []);
  assert.deepEqual(parseTransformOutput('[{"path":"textures/a.png","before":[8192,8192],"after":[4096,4096]}]'), [
    { path: 'textures/a.png', before: [8192, 8192], after: [4096, 4096] },
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-transform-'));
  const python = path.join(root, 'python.exe');
  const script = path.join(root, 'downscale.py');
  fs.writeFileSync(python, 'print');
  fs.chmodSync(python, 0o755);
  fs.writeFileSync(script, 'print');
  const transformer = createRuntimeTextureTransformer({
    pythonPath: python,
    scriptPath: script,
    maxDimension: 4096,
  });
  assert.equal(typeof transformer, 'function');
  fs.rmSync(root, { recursive: true, force: true });
});

test('validated interpreter link stays the invoked entry while broken/non-executable targets and script links are rejected', { skip: process.platform === 'win32' }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-texture-link 中文 ')));
  try {
    const entry = path.join(root, 'selected interpreter');
    const script = path.join(root, 'transform.cjs');
    fs.symlinkSync(process.execPath, entry);
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify([{path:"texture.png",invoked:process.argv0}]))');
    const transform = createRuntimeTextureTransformer({ pythonPath: entry, scriptPath: script });
    assert.equal(transform(root)[0].invoked, entry);
    const scriptAlias = path.join(root, 'alias.cjs');fs.symlinkSync(script, scriptAlias);
    assert.throws(() => createRuntimeTextureTransformer({ pythonPath: entry, scriptPath: scriptAlias }), /regular file/);
    fs.unlinkSync(entry);fs.symlinkSync(path.join(root, 'missing'), entry);
    assert.throws(() => createRuntimeTextureTransformer({ pythonPath: entry, scriptPath: script }), /regular file/);
    fs.unlinkSync(entry);const target = path.join(root, 'not executable');fs.writeFileSync(target, 'fixture');fs.chmodSync(target, 0o644);fs.symlinkSync(target, entry);
    assert.throws(() => createRuntimeTextureTransformer({ pythonPath: entry, scriptPath: script }), /regular file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
