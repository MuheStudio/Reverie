'use strict';

/**
 * Dev-only helper: stage the Live2D Cubism Core into the gitignored
 * .runtime-cache so `pnpm electron` can render a locally imported Live2D
 * model in development mode.
 *
 * The Cubism Core (Live2DCubismCore.js) is Live2D Inc. software. It is not
 * committed to the GPLv3 source tree; it only lands in the local dev cache.
 * The release pipeline stages its own copy from REVERIE_LIVE2D_CORE_PATH and
 * refuses to ship it without a valid Live2D publication license.
 *
 * Usage:
 *   pnpm prepare:live2d-dev
 *   REVERIE_LIVE2D_CORE_SOURCE=/path/to/live2dcubismcore.min.js pnpm prepare:live2d-dev
 */

const fs = require('node:fs');
const path = require('node:path');

const frontendRoot = path.resolve(__dirname, '..');
const defaultSource = process.env.REVERIE_LIVE2D_CORE_SOURCE
  ? path.resolve(process.env.REVERIE_LIVE2D_CORE_SOURCE)
  : 'H:/My-soft/vibe-projects/Reverie/Cloning-project/Luna-ts/packages/web/public/live2dcubismcore.min.js';
const targetDir = path.join(frontendRoot, '.runtime-cache');
const target = path.join(targetDir, 'Live2DCubismCore.js');

function main() {
  const source = path.resolve(defaultSource);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024 * 1024) {
    throw new Error('Live2D Cubism Core must be a bounded regular file');
  }
  const content = fs.readFileSync(source, 'utf8');
  if (!content.includes('Live2DCubismCore')) {
    throw new Error('Source does not expose the Live2DCubismCore runtime symbol');
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`Live2D Cubism Core staged for dev: ${target} (${stat.size} bytes)`);
  console.log('Run "pnpm electron" after importing a Live2D model.');
}

main();
