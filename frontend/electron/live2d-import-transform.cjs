'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX_DIMENSION = 4096;
const MAX_DIMENSION_CEILING = 8192;
const MIN_DIMENSION = 256;

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function regularFile(filePath, label) {
  const resolved = path.resolve(String(filePath || ''));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  return resolved;
}

function normalizeMaxDimension(value) {
  const dimension = Number(value);
  if (!Number.isInteger(dimension) || dimension < MIN_DIMENSION || dimension > MAX_DIMENSION_CEILING) {
    throw new Error(`Live2D texture max dimension must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION_CEILING}`);
  }
  return dimension;
}

function parseTransformOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return [];
  const value = JSON.parse(trimmed);
  if (!Array.isArray(value)) throw new Error('Live2D texture transform returned invalid metadata');
  return value.filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string');
}

function createRuntimeTextureTransformer(options = {}) {
  const pythonPath = regularFile(options.pythonPath, 'Live2D texture transform Python');
  const scriptPath = regularFile(options.scriptPath, 'Live2D texture transform script');
  const maxDimension = normalizeMaxDimension(options.maxDimension ?? DEFAULT_MAX_DIMENSION);
  const timeoutMs = Number.isInteger(options.timeoutMs)
    ? Math.min(5 * 60 * 1000, Math.max(5_000, options.timeoutMs))
    : 120_000;

  return (characterRoot) => {
    const root = path.resolve(String(characterRoot || ''));
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Live2D texture transform root must be a regular directory');
    }
    const result = spawnSync(
      pythonPath,
      [scriptPath, root, String(maxDimension)],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Live2D texture transform failed: ${String(result.stderr || result.stdout || '').trim().slice(0, 1000)}`,
      );
    }
    const transforms = parseTransformOutput(result.stdout);
    for (const entry of transforms) {
      const target = path.resolve(root, ...String(entry.path).replace(/\\/g, '/').split('/'));
      if (!isInside(root, target)) {
        throw new Error(`Live2D texture transform escaped the model root: ${entry.path}`);
      }
    }
    return transforms;
  };
}

module.exports = {
  DEFAULT_MAX_DIMENSION,
  createRuntimeTextureTransformer,
  normalizeMaxDimension,
  parseTransformOutput,
};
