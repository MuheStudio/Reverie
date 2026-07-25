'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BACKUP_BYTES = 16 * 1024 * 1024 * 1024;
const STAGED_PREFIX = '.reverie-import-';
const STAGED_SUFFIX = '.json';

function backupPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000')
    || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.json') {
    throw new TypeError('Backup selection must be an absolute JSON file path');
  }
  return path.resolve(value);
}

function sameFile(left, right) {
  if (!left || !right) return false;
  if (left.dev !== right.dev || left.ino !== right.ino) return false;
  return left.size === right.size
    && Math.trunc(left.mtimeMs) === Math.trunc(right.mtimeMs);
}

async function stageNativeBackupSource(filePath, options = {}) {
  if (!options.storageDir) throw new TypeError('backup staging storageDir is required');
  const sourcePath = backupPath(filePath);
  const storageDir = path.resolve(options.storageDir);
  const maxBytes = Number.isSafeInteger(options.maxBytes)
    ? options.maxBytes
    : MAX_BACKUP_BYTES;
  if (maxBytes < 1) throw new TypeError('backup staging limit is invalid');

  const before = await fs.promises.lstat(sourcePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new TypeError('Backup selection must be a regular non-symlink file');
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new RangeError('Backup file size is outside the supported range');
  }

  const resolvedRealPath = await fs.promises.realpath(sourcePath);
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  if (normalize(resolvedRealPath) !== normalize(sourcePath)) {
    throw new TypeError('Backup selection may not traverse a symbolic link');
  }

  await fs.promises.mkdir(storageDir, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(
    storageDir,
    `${STAGED_PREFIX}${crypto.randomUUID()}${STAGED_SUFFIX}`,
  );
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let source;
  let target;
  let committed = false;
  try {
    source = await fs.promises.open(sourcePath, sourceFlags);
    const opened = await source.stat();
    const after = await fs.promises.lstat(sourcePath);
    if (!opened.isFile() || !sameFile(before, opened) || !sameFile(opened, after)) {
      throw new Error('Backup file identity changed while it was selected');
    }

    target = await fs.promises.open(stagedPath, 'wx', 0o600);
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.length, opened.size - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead < 1) throw new Error('Backup file changed while it was staged');
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten < 1) throw new Error('Backup staging write made no progress');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const sourceAfterCopy = await source.stat();
    if (!sameFile(opened, sourceAfterCopy) || offset !== opened.size) {
      throw new Error('Backup file changed while it was staged');
    }
    await target.sync();
    committed = true;
    return {
      filePath: stagedPath,
      fileName: path.basename(sourcePath),
      byteLength: offset,
      sha256: digest.digest('hex'),
      async dispose() {
        try { await fs.promises.unlink(stagedPath); } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      },
    };
  } finally {
    try { await target?.close(); } catch {}
    try { await source?.close(); } catch {}
    if (!committed) {
      try { await fs.promises.unlink(stagedPath); } catch {}
    }
  }
}

module.exports = {
  MAX_BACKUP_BYTES,
  stageNativeBackupSource,
};
