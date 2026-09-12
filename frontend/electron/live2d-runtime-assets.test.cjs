'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RUNTIME_ASSET_SCHEMA,
  readRuntimeAssetsManifest,
  stageLive2DCoreOnlyTestRuntime,
  stageLive2DRuntimeAssets,
} = require('./live2d-runtime-assets.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-assets-'));
  const source = path.join(root, 'source');
  const resources = path.join(root, 'resources');
  const model = path.join(source, 'model');
  fs.mkdirSync(model, { recursive: true });
  const core = path.join(source, 'Live2DCubismCore.js');
  fs.writeFileSync(core, 'globalThis.Live2DCubismCore = {};', 'utf8');
  fs.writeFileSync(path.join(model, 'avatar.moc3'), 'moc', 'utf8');
  fs.writeFileSync(path.join(model, 'texture.png'), 'texture', 'utf8');
  fs.writeFileSync(path.join(model, 'avatar.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'avatar.moc3',
      Textures: ['texture.png'],
    },
  }), 'utf8');
  return { root, resources, core, model };
}

test('staged Live2D assets are self-contained and verified by hash', () => {
  const { resources, core, model } = fixture();
  const manifest = stageLive2DRuntimeAssets({
    coreSource: core,
    modelSource: model,
    resourceRoot: resources,
    mode: 'internal-test',
  });
  assert.equal(manifest.schema, RUNTIME_ASSET_SCHEMA);
  assert.equal(manifest.renderer.embedded, true);
  assert.ok(fs.existsSync(path.join(resources, 'Live2DCubismCore.js')));
  assert.ok(fs.existsSync(path.join(resources, 'character', 'avatar.model3.json')));
  assert.deepEqual(readRuntimeAssetsManifest(resources), manifest);
});

test('runtime asset verification fails closed after Core or model tampering', () => {
  const { resources, core, model } = fixture();
  stageLive2DRuntimeAssets({
    coreSource: core,
    modelSource: model,
    resourceRoot: resources,
    mode: 'internal-test',
  });
  fs.appendFileSync(path.join(resources, 'Live2DCubismCore.js'), 'tamper', 'utf8');
  assert.throws(() => readRuntimeAssetsManifest(resources), /hash/i);
});

test('staging rejects symlinks and missing model manifests', (t) => {
  const { root, resources, core, model } = fixture();
  fs.unlinkSync(path.join(model, 'avatar.model3.json'));
  assert.throws(() => stageLive2DRuntimeAssets({
    coreSource: core,
    modelSource: model,
    resourceRoot: resources,
    mode: 'internal-test',
  }), /model3/i);

  if (process.platform !== 'win32') {
    const link = path.join(root, 'linked-model');
    fs.symlinkSync(model, link, 'dir');
    assert.throws(() => stageLive2DRuntimeAssets({
      coreSource: core,
      modelSource: link,
      resourceRoot: resources,
      mode: 'internal-test',
    }), /symlink/i);
  } else {
    t.diagnostic('Windows symlink creation is privilege-dependent; recursive lstat is covered by implementation');
  }
});

test('staging rejects a non-Core JavaScript file even when it is non-empty', () => {
  const { resources, core, model } = fixture();
  fs.writeFileSync(core, 'globalThis.notCubism = {};', 'utf8');
  assert.throws(() => stageLive2DRuntimeAssets({
    coreSource: core,
    modelSource: model,
    resourceRoot: resources,
    mode: 'internal-test',
  }), /runtime symbol/i);
});

test('internal test runtime can stage Cubism Core without preinstalling a character', () => {
  const { resources, core } = fixture();
  const manifest = stageLive2DCoreOnlyTestRuntime({ coreSource: core, resourceRoot: resources });
  assert.equal(manifest.mode, 'internal-test');
  assert.equal(manifest.character, null);
  assert.equal(fs.existsSync(path.join(resources, 'character')), false);
  assert.deepEqual(readRuntimeAssetsManifest(resources), manifest);
});

test('public runtime can stage Cubism Core without a bundled character', () => {
  const { resources, core } = fixture();
  const manifest = stageLive2DCoreOnlyTestRuntime({
    coreSource: core,
    resourceRoot: resources,
    mode: 'public',
  });
  assert.equal(manifest.mode, 'public');
  assert.equal(manifest.character, null);
  assert.equal(fs.existsSync(path.join(resources, 'character')), false);
  assert.deepEqual(readRuntimeAssetsManifest(resources), manifest);
});
