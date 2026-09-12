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
  fs.writeFileSync(script, 'print');
  const transformer = createRuntimeTextureTransformer({
    pythonPath: python,
    scriptPath: script,
    maxDimension: 4096,
  });
  assert.equal(typeof transformer, 'function');
});
