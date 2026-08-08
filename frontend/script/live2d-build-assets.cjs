'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function resolveBuildPython(projectRoot) {
  const candidate = process.env.REVERIE_BUILD_PYTHON
    ? path.resolve(process.env.REVERIE_BUILD_PYTHON)
    : path.join(projectRoot, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(candidate)) {
    throw new Error('A Python build interpreter is required for Live2D texture staging');
  }
  return candidate;
}

function createTextureTransformer({ projectRoot, frontendRoot, maxDimension = 4096 }) {
  return (characterRoot) => {
    const result = spawnSync(
      resolveBuildPython(projectRoot),
      [
        path.join(frontendRoot, 'script', 'downscale-live2d-textures.py'),
        characterRoot,
        String(maxDimension),
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Live2D texture staging failed: ${String(result.stderr || '').trim().slice(0, 1000)}`);
    }
    const value = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(value)) throw new Error('Live2D texture staging returned invalid metadata');
    return value;
  };
}

module.exports = { createTextureTransformer };
