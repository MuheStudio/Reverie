'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_ASSET_SCHEMA = 'reverie.live2d.runtime-assets.v1';
const RUNTIME_ASSET_MANIFEST = 'LIVE2D-RUNTIME-ASSETS.json';
const CORE_FILENAME = 'Live2DCubismCore.js';
const CHARACTER_DIRECTORY = 'character';

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) {
    throw new Error(`${label} escaped the Live2D staging root`);
  }
}

function regularFile(filePath, label) {
  const resolved = path.resolve(String(filePath || ''));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  return { resolved, stat };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateCubismCore(filePath) {
  const { stat } = regularFile(filePath, 'Live2D Cubism Core');
  if (stat.size > 16 * 1024 * 1024) {
    throw new Error('Live2D Cubism Core is unexpectedly large');
  }
  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes('Live2DCubismCore')) {
    throw new Error('Live2D Cubism Core does not expose the expected runtime symbol');
  }
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Live2D source contains a symlink: ${current}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Live2D source contains a non-file entry: ${current}`);
    files.push({
      absolute: current,
      relative: path.relative(root, current).replace(/\\/g, '/'),
      size: stat.size,
      sha256: sha256File(current),
    });
  };
  visit(root);
  return files;
}

function treeSha256(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relative, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(String(file.size), 'ascii');
    hash.update('\0', 'utf8');
    hash.update(file.sha256, 'ascii');
    hash.update('\n', 'ascii');
  }
  return hash.digest('hex');
}

function copyDirectory(sourceRoot, targetRoot, stagingRoot) {
  assertInside(stagingRoot, targetRoot, 'Live2D character destination');
  if (fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const file of walkRegularFiles(sourceRoot)) {
    const target = path.join(targetRoot, ...file.relative.split('/'));
    assertInside(targetRoot, target, 'Live2D character file');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.absolute, target, fs.constants.COPYFILE_EXCL);
  }
}

function findSingleModel(files) {
  const models = files.filter((file) => file.relative.toLowerCase().endsWith('.model3.json'));
  if (models.length !== 1) {
    throw new Error(`Live2D character must contain exactly one model3.json file; found ${models.length}`);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(models[0].absolute, 'utf8'));
    if (parsed?.Version !== 3 || !parsed.FileReferences || typeof parsed.FileReferences !== 'object') {
      throw new Error('invalid model');
    }
  } catch {
    throw new Error('Live2D model3.json is invalid');
  }
  return models[0];
}

function stageLive2DRuntimeAssets(options = {}) {
  const resourceRoot = path.resolve(String(options.resourceRoot || ''));
  if (!resourceRoot) throw new Error('Live2D resource root is required');
  fs.mkdirSync(resourceRoot, { recursive: true });

  const { resolved: coreSource } = regularFile(options.coreSource, 'Live2D Cubism Core');
  validateCubismCore(coreSource);
  const modelSource = path.resolve(String(options.modelSource || ''));
  const modelStat = fs.lstatSync(modelSource);
  if (!modelStat.isDirectory() || modelStat.isSymbolicLink()) {
    throw new Error('Live2D character source must be a real directory');
  }
  const sourceFiles = walkRegularFiles(modelSource);
  findSingleModel(sourceFiles);

  const coreTarget = path.join(resourceRoot, CORE_FILENAME);
  const characterTarget = path.join(resourceRoot, CHARACTER_DIRECTORY);
  assertInside(resourceRoot, coreTarget, 'Live2D Core destination');
  if (fs.existsSync(coreTarget)) fs.rmSync(coreTarget, { force: true });
  fs.copyFileSync(coreSource, coreTarget, fs.constants.COPYFILE_EXCL);
  copyDirectory(modelSource, characterTarget, resourceRoot);
  const textureTransforms = typeof options.transformCharacter === 'function'
    ? options.transformCharacter(characterTarget) || []
    : [];

  const stagedFiles = walkRegularFiles(characterTarget);
  const stagedModel = findSingleModel(stagedFiles);
  const manifest = {
    schema: RUNTIME_ASSET_SCHEMA,
    mode: options.mode === 'public' ? 'public' : 'internal-test',
    renderer: {
      embedded: true,
      engine: 'pixi-live2d-display/cubism4',
    },
    core: {
      path: CORE_FILENAME,
      bytes: fs.statSync(coreTarget).size,
      sha256: sha256File(coreTarget),
    },
    character: {
      directory: CHARACTER_DIRECTORY,
      entry: stagedModel.relative,
      files: stagedFiles.length,
      bytes: stagedFiles.reduce((total, file) => total + file.size, 0),
      treeSha256: treeSha256(stagedFiles),
      textureTransforms,
    },
  };
  fs.writeFileSync(
    path.join(resourceRoot, RUNTIME_ASSET_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

function stageLive2DCoreOnlyTestRuntime(options = {}) {
  const resourceRoot = path.resolve(String(options.resourceRoot || ''));
  if (!resourceRoot) throw new Error('Live2D resource root is required');
  const mode = options.mode === 'public' ? 'public' : 'internal-test';
  fs.mkdirSync(resourceRoot, { recursive: true });
  const { resolved: coreSource } = regularFile(options.coreSource, 'Live2D Cubism Core');
  validateCubismCore(coreSource);
  const coreTarget = path.join(resourceRoot, CORE_FILENAME);
  assertInside(resourceRoot, coreTarget, 'Live2D Core destination');
  if (fs.existsSync(coreTarget)) fs.rmSync(coreTarget, { force: true });
  fs.copyFileSync(coreSource, coreTarget, fs.constants.COPYFILE_EXCL);
  const manifest = {
    schema: RUNTIME_ASSET_SCHEMA,
    mode,
    renderer: {
      embedded: true,
      engine: 'pixi-live2d-display/cubism4',
    },
    core: {
      path: CORE_FILENAME,
      bytes: fs.statSync(coreTarget).size,
      sha256: sha256File(coreTarget),
    },
    character: null,
  };
  fs.writeFileSync(
    path.join(resourceRoot, RUNTIME_ASSET_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

function readRuntimeAssetsManifest(resourceRootValue) {
  const resourceRoot = path.resolve(String(resourceRootValue || ''));
  const manifestPath = path.join(resourceRoot, RUNTIME_ASSET_MANIFEST);
  const { stat } = regularFile(manifestPath, 'Live2D runtime asset manifest');
  if (stat.size > 64 * 1024) throw new Error('Live2D runtime asset manifest is too large');
  const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    value?.schema !== RUNTIME_ASSET_SCHEMA
    || !['internal-test', 'public'].includes(value.mode)
    || value.renderer?.embedded !== true
    || value.renderer?.engine !== 'pixi-live2d-display/cubism4'
    || value.core?.path !== CORE_FILENAME
    || (value.character !== null && (
      value.character?.directory !== CHARACTER_DIRECTORY
      || typeof value.character?.entry !== 'string'
    ))
  ) {
    throw new Error('Live2D runtime asset manifest has an invalid schema');
  }

  const corePath = path.join(resourceRoot, value.core.path);
  assertInside(resourceRoot, corePath, 'Live2D Core');
  const core = regularFile(corePath, 'Live2D Cubism Core');
  validateCubismCore(corePath);
  if (core.stat.size !== value.core.bytes || sha256File(corePath) !== value.core.sha256) {
    throw new Error('Live2D Cubism Core hash does not match the runtime manifest');
  }

  if (value.character === null) {
    if (value.mode !== 'internal-test' && value.mode !== 'public') {
      throw new Error('Core-only Live2D runtime is allowed only in internal-test or public builds');
    }
    if (fs.existsSync(path.join(resourceRoot, CHARACTER_DIRECTORY))) {
      throw new Error('Core-only Live2D runtime unexpectedly contains a character directory');
    }
    return value;
  }

  const characterRoot = path.join(resourceRoot, value.character.directory);
  assertInside(resourceRoot, characterRoot, 'Live2D character');
  const characterStat = fs.lstatSync(characterRoot);
  if (!characterStat.isDirectory() || characterStat.isSymbolicLink()) {
    throw new Error('Live2D character directory is invalid');
  }
  const files = walkRegularFiles(characterRoot);
  const model = findSingleModel(files);
  if (
    model.relative !== value.character.entry
    || files.length !== value.character.files
    || files.reduce((total, file) => total + file.size, 0) !== value.character.bytes
    || treeSha256(files) !== value.character.treeSha256
  ) {
    throw new Error('Live2D character tree hash does not match the runtime manifest');
  }
  return value;
}

module.exports = {
  CHARACTER_DIRECTORY,
  CORE_FILENAME,
  RUNTIME_ASSET_MANIFEST,
  RUNTIME_ASSET_SCHEMA,
  readRuntimeAssetsManifest,
  sha256File,
  stageLive2DCoreOnlyTestRuntime,
  stageLive2DRuntimeAssets,
};
