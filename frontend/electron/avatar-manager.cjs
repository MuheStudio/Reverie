'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TextDecoder } = require('util');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_AVATAR_BYTES = 300 * MiB;
const MAX_ZIP_BYTES = 250 * MiB;
const MAX_EXPANDED_BYTES = 750 * MiB;
const MAX_ZIP_ENTRIES = 4096;
const MAX_SINGLE_EXPANDED_BYTES = 300 * MiB;
const MAX_PATH_DEPTH = 16;
const MAX_COMPRESSION_RATIO = 100;
const MAX_TRIANGLES = 1_000_000;
const WARN_TRIANGLES = 300_000;
const MAX_TEXTURE_DIMENSION = 8192;
const MAX_ESTIMATED_VRAM = GiB;
const WARN_ESTIMATED_VRAM = 512 * MiB;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_SCHEMA = 'reverie.avatar-import.v1';
const MOTION_CANDIDATE_SCHEMA = 'reverie.avatar-motion-import.v1';
const MANIFEST_SCHEMA = 'reverie.avatar.v1';
const ACTIVE_SCHEMA = 'reverie.avatar-active.v1';
const IMPORT_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const AVATAR_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const FORBIDDEN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SCRIPT_EXTENSIONS = new Set([
  '.bat', '.cmd', '.com', '.cpl', '.dll', '.exe', '.hta', '.html', '.htm',
  '.jar', '.js', '.jse', '.lnk', '.mjs', '.msi', '.ps1', '.py', '.reg',
  '.scr', '.sh', '.svg', '.vbs', '.wsf',
]);
const LIVE2D_EXTENSIONS = new Set([
  '.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg',
]);
const MAPPING_CATEGORIES = new Set(['expression', 'action']);
const MAPPING_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIME_BY_EXTENSION = Object.freeze({
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
});

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function avatarError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRegularSource(sourcePath, maxBytes) {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw avatarError('AVATAR_SOURCE_INVALID', 'Avatar source must be a regular file');
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw avatarError('AVATAR_SOURCE_SIZE', `Avatar source exceeds the ${Math.floor(maxBytes / MiB)} MiB limit`);
  }
  return stat;
}

function decodeZipName(bytes, utf8) {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    throw avatarError('AVATAR_ZIP_ENCODING', 'Non-ASCII ZIP names must use UTF-8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw avatarError('AVATAR_ZIP_ENCODING', 'ZIP contains an invalid UTF-8 path');
  }
}

function canonicalArchivePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 240) {
    throw avatarError('AVATAR_PATH_INVALID', 'Archive path is empty or too long');
  }
  if (value.includes('\\') || value.startsWith('/') || value.startsWith('//')
    || /^[A-Za-z]:/.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw avatarError('AVATAR_PATH_INVALID', `Unsafe archive path: ${value}`);
  }
  const withoutSlash = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!withoutSlash || (!directory && value.endsWith('/'))) {
    throw avatarError('AVATAR_PATH_INVALID', `Invalid archive entry: ${value}`);
  }
  const segments = withoutSlash.split('/');
  if (segments.length > MAX_PATH_DEPTH) {
    throw avatarError('AVATAR_PATH_DEPTH', `Archive path is deeper than ${MAX_PATH_DEPTH} levels`);
  }
  const normalized = segments.map((raw) => {
    const segment = raw.normalize('NFC');
    if (!segment || segment === '.' || segment === '..' || segment.includes(':')
      || /[. ]$/.test(segment) || FORBIDDEN_DEVICE.test(segment)) {
      throw avatarError('AVATAR_PATH_INVALID', `Unsafe archive path segment: ${raw}`);
    }
    return segment;
  }).join('/');
  return normalized;
}

function parseZipExtra(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw avatarError('AVATAR_ZIP_EXTRA', 'Malformed ZIP extra field');
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) throw avatarError('AVATAR_ZIP_EXTRA', 'Malformed ZIP extra field');
    if (id === 0x0001) throw avatarError('AVATAR_ZIP64', 'ZIP64 archives are not supported');
    offset += size;
  }
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw avatarError('AVATAR_ZIP_EOCD', 'ZIP central directory is missing');
}

function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > MAX_ZIP_BYTES) {
    throw avatarError('AVATAR_ZIP_SIZE', 'ZIP is empty or exceeds the compressed size limit');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw avatarError('AVATAR_ZIP_MULTIDISK', 'Multi-disk ZIP archives are not supported');
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw avatarError('AVATAR_ZIP64', 'ZIP64 archives are not supported');
  }
  if (totalEntries < 1 || totalEntries > MAX_ZIP_ENTRIES) {
    throw avatarError('AVATAR_ZIP_COUNT', `ZIP must contain 1-${MAX_ZIP_ENTRIES} entries`);
  }
  if (centralOffset + centralSize !== eocd || centralOffset < 0) {
    throw avatarError('AVATAR_ZIP_LAYOUT', 'ZIP central directory layout is inconsistent');
  }

  const entries = [];
  const canonicalNames = new Map();
  const dataRanges = [];
  const entryRanges = [];
  let expandedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw avatarError('AVATAR_ZIP_CENTRAL', 'Malformed ZIP central directory');
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > eocd || nameLength === 0) {
      throw avatarError('AVATAR_ZIP_CENTRAL', 'Malformed ZIP central entry');
    }
    if (flags & 0x0001) throw avatarError('AVATAR_ZIP_ENCRYPTED', 'Encrypted ZIP entries are not supported');
    if (flags & 0x0008) throw avatarError('AVATAR_ZIP_DESCRIPTOR', 'ZIP data descriptors are not supported');
    if (flags & 0x2040) throw avatarError('AVATAR_ZIP_FLAGS', 'ZIP uses unsupported encryption flags');
    if (![0, 8].includes(method)) throw avatarError('AVATAR_ZIP_METHOD', `Unsupported ZIP compression method: ${method}`);
    if (startDisk !== 0) throw avatarError('AVATAR_ZIP_MULTIDISK', 'Multi-disk ZIP entry detected');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = decodeZipName(nameBytes, Boolean(flags & 0x0800));
    const dosDirectory = Boolean(externalAttributes & 0x10) || rawName.endsWith('/');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixType = unixMode & 0xf000;
    if (unixType === 0xa000) throw avatarError('AVATAR_ZIP_SYMLINK', 'Symbolic links are not allowed');
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) {
      throw avatarError('AVATAR_ZIP_FILETYPE', 'Only regular files and directories are allowed');
    }
    const directory = dosDirectory || unixType === 0x4000;
    const name = canonicalArchivePath(rawName, { directory });
    const collisionKey = name.toLocaleLowerCase('en-US');
    if (canonicalNames.has(collisionKey)) {
      throw avatarError('AVATAR_ZIP_COLLISION', `Duplicate or case/NFC-conflicting path: ${name}`);
    }
    canonicalNames.set(collisionKey, name);
    const extra = buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    parseZipExtra(extra);

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw avatarError('AVATAR_ZIP_LOCAL', `Missing local ZIP header for ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressed = buffer.readUInt32LE(localOffset + 18);
    const localUncompressed = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || localFlags !== flags || localMethod !== method
      || localCrc !== expectedCrc || localCompressed !== compressedSize
      || localUncompressed !== uncompressedSize
      || !buffer.subarray(localNameStart, localNameEnd).equals(nameBytes)) {
      throw avatarError('AVATAR_ZIP_MISMATCH', `Local/central ZIP mismatch for ${name}`);
    }
    parseZipExtra(buffer.subarray(localNameEnd, dataStart));
    if (directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw avatarError('AVATAR_ZIP_DIRECTORY', 'Directory ZIP entry contains data');
    }
    if (!directory) {
      if (uncompressedSize > MAX_SINGLE_EXPANDED_BYTES) {
        throw avatarError('AVATAR_ZIP_ENTRY_SIZE', 'A ZIP entry exceeds the 300 MiB per-file limit');
      }
      expandedBytes += uncompressedSize;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) {
        throw avatarError('AVATAR_ZIP_EXPANDED', 'ZIP exceeds the expanded size limit');
      }
      if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
        throw avatarError('AVATAR_ZIP_RATIO', `ZIP compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1`);
      }
      const extension = path.posix.extname(name).toLowerCase();
      if (SCRIPT_EXTENSIONS.has(extension) || !LIVE2D_EXTENSIONS.has(extension)) {
        throw avatarError('AVATAR_ZIP_EXTENSION', `Unsupported file type in Live2D package: ${extension || '(none)'}`);
      }
      dataRanges.push([dataStart, dataEnd, name]);
    }
    entryRanges.push([localOffset, dataEnd, name]);
    entries.push({
      name,
      directory,
      method,
      crc32: expectedCrc,
      compressedSize,
      uncompressedSize,
      dataStart,
      dataEnd,
    });
    cursor = centralEnd;
  }
  if (cursor !== eocd) throw avatarError('AVATAR_ZIP_CENTRAL', 'ZIP entry count does not match its directory');
  dataRanges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < dataRanges.length; index += 1) {
    if (dataRanges[index][0] < dataRanges[index - 1][1]) {
      throw avatarError('AVATAR_ZIP_OVERLAP', 'ZIP entries have overlapping data ranges');
    }
  }
  entryRanges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < entryRanges.length; index += 1) {
    if (entryRanges[index][0] < entryRanges[index - 1][1]) {
      throw avatarError('AVATAR_ZIP_OVERLAP', 'ZIP local entries overlap');
    }
  }
  return { entries, expandedBytes };
}

function inflateZipEntry(zipBuffer, entry) {
  if (entry.directory) return Buffer.alloc(0);
  const compressed = zipBuffer.subarray(entry.dataStart, entry.dataEnd);
  let output;
  try {
    output = entry.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  } catch {
    throw avatarError('AVATAR_ZIP_DEFLATE', `Could not decompress ${entry.name}`);
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
    throw avatarError('AVATAR_ZIP_CRC', `ZIP size or CRC mismatch for ${entry.name}`);
  }
  return output;
}

function safeModelReference(modelDirectory, reference) {
  if (typeof reference !== 'string' || !reference || reference.includes('\\')
    || /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('/')
    || reference.startsWith('//')) {
    throw avatarError('AVATAR_LIVE2D_REFERENCE', `Unsafe Live2D reference: ${String(reference)}`);
  }
  const joined = modelDirectory ? `${modelDirectory}/${reference}` : reference;
  return canonicalArchivePath(joined);
}

function collectLive2DReferences(model) {
  const refs = [];
  const files = model?.FileReferences;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'model3.json has no FileReferences object');
  }
  for (const key of ['Moc', 'Physics', 'Pose', 'UserData', 'DisplayInfo']) {
    if (files[key] != null) refs.push(files[key]);
  }
  if (files.Textures != null) {
    if (!Array.isArray(files.Textures)) throw avatarError('AVATAR_LIVE2D_MODEL', 'Textures must be an array');
    refs.push(...files.Textures);
  }
  for (const collectionKey of ['Expressions', 'Motions']) {
    const collection = files[collectionKey];
    if (collection == null) continue;
    const groups = collectionKey === 'Expressions'
      ? [collection]
      : Object.values(collection);
    for (const group of groups) {
      if (!Array.isArray(group)) throw avatarError('AVATAR_LIVE2D_MODEL', `${collectionKey} group must be an array`);
      for (const item of group) {
        if (item?.File != null) refs.push(item.File);
        if (item?.Sound != null) refs.push(item.Sound);
      }
    }
  }
  return refs;
}

function validateLive2DExtracted(outputDir, fileDescriptors, expandedBytes) {
  const files = new Map(fileDescriptors.map((descriptor) => [descriptor.path, descriptor]));
  const modelEntries = fileDescriptors.filter((entry) => entry.path.toLowerCase().endsWith('.model3.json'));
  if (modelEntries.length !== 1) {
    throw avatarError('AVATAR_LIVE2D_ENTRY', 'Live2D package must contain exactly one .model3.json');
  }
  const modelEntry = modelEntries[0];
  if (modelEntry.size > 8 * MiB) {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'model3.json is unexpectedly large');
  }
  let model;
  try {
    model = JSON.parse(fs.readFileSync(path.join(outputDir, ...modelEntry.path.split('/')), 'utf8'));
  } catch {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'model3.json is not valid JSON');
  }
  const version = Number(model?.Version);
  if (!Number.isInteger(version) || version < 3 || version > 4) {
    throw avatarError('AVATAR_LIVE2D_VERSION', 'Unsupported Live2D model3 version');
  }
  const modelDirectory = path.posix.dirname(modelEntry.path) === '.' ? '' : path.posix.dirname(modelEntry.path);
  const modelRootPrefix = modelDirectory ? `${modelDirectory}/` : '';
  if (!model.FileReferences || typeof model.FileReferences !== 'object'
    || Array.isArray(model.FileReferences)) {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'model3.json FileReferences is invalid');
  }
  const readJsonAsset = (descriptor, label) => {
    if (descriptor.size > 8 * MiB) {
      throw avatarError('AVATAR_LIVE2D_MODEL', `${label} is unexpectedly large`);
    }
    try {
      return JSON.parse(fs.readFileSync(path.join(outputDir, ...descriptor.path.split('/')), 'utf8'));
    } catch {
      throw avatarError('AVATAR_LIVE2D_MODEL', `${label} is not valid JSON`);
    }
  };
  const referencedExpressions = Array.isArray(model.FileReferences.Expressions)
    ? model.FileReferences.Expressions
    : [];
  if (model.FileReferences.Expressions != null && !Array.isArray(model.FileReferences.Expressions)) {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'Live2D Expressions must be an array');
  }
  const referencedMotions = model.FileReferences.Motions == null
    ? {}
    : model.FileReferences.Motions;
  if (!referencedMotions || typeof referencedMotions !== 'object' || Array.isArray(referencedMotions)) {
    throw avatarError('AVATAR_LIVE2D_MODEL', 'Live2D Motions must be an object');
  }
  const expressionFiles = new Set(
    referencedExpressions.map((entry) => String(entry?.File || '')),
  );
  const motionFiles = new Set(
    Object.values(referencedMotions)
      .flatMap((group) => Array.isArray(group) ? group : [])
      .map((entry) => String(entry?.File || '')),
  );
  let modelAugmented = false;
  for (const descriptor of fileDescriptors) {
    if (descriptor.path === modelEntry.path
      || (modelRootPrefix && !descriptor.path.startsWith(modelRootPrefix))) continue;
    const relative = path.posix.relative(modelDirectory || '.', descriptor.path);
    if (descriptor.path.toLowerCase().endsWith('.exp3.json') && !expressionFiles.has(relative)) {
      const expression = readJsonAsset(descriptor, 'Live2D expression');
      if (expression?.Type !== 'Live2D Expression' || !Array.isArray(expression.Parameters)
        || expression.Parameters.length > 10_000) {
        throw avatarError('AVATAR_LIVE2D_MODEL', `Invalid Live2D expression: ${relative}`);
      }
      referencedExpressions.push({
        Name: safeDetectedName(
          path.posix.basename(relative).replace(/\.exp3\.json$/i, ''),
          'Expression',
        ),
        File: relative,
      });
      expressionFiles.add(relative);
      modelAugmented = true;
    }
    if (descriptor.path.toLowerCase().endsWith('.motion3.json') && !motionFiles.has(relative)) {
      const motion = readJsonAsset(descriptor, 'Live2D motion');
      const duration = Number(motion?.Meta?.Duration);
      if (Number(motion?.Version) !== 3 || !Array.isArray(motion.Curves)
        || motion.Curves.length > 10_000 || !Number.isFinite(duration)
        || duration < 0 || duration > 600) {
        throw avatarError('AVATAR_LIVE2D_MODEL', `Invalid Live2D motion: ${relative}`);
      }
      const groupName = safeDetectedName(
        path.posix.basename(relative).replace(/\.motion3\.json$/i, ''),
        'Motion',
      );
      if (!Array.isArray(referencedMotions[groupName])) referencedMotions[groupName] = [];
      referencedMotions[groupName].push({ File: relative });
      motionFiles.add(relative);
      modelAugmented = true;
    }
  }
  if (referencedExpressions.length) model.FileReferences.Expressions = referencedExpressions;
  if (Object.keys(referencedMotions).length) model.FileReferences.Motions = referencedMotions;
  let normalizedExpandedBytes = expandedBytes;
  if (modelAugmented) {
    const modelPath = path.join(outputDir, ...modelEntry.path.split('/'));
    const previousSize = modelEntry.size;
    const normalizedModel = Buffer.from(`${JSON.stringify(model, null, 2)}\n`, 'utf8');
    if (normalizedModel.length > 8 * MiB) {
      throw avatarError('AVATAR_LIVE2D_MODEL', 'Augmented model3.json is unexpectedly large');
    }
    fs.writeFileSync(modelPath, normalizedModel);
    fsyncFile(modelPath);
    modelEntry.size = normalizedModel.length;
    modelEntry.sha256 = crypto.createHash('sha256').update(normalizedModel).digest('hex');
    normalizedExpandedBytes += normalizedModel.length - previousSize;
    if (normalizedExpandedBytes > MAX_EXPANDED_BYTES) {
      throw avatarError('AVATAR_ZIP_EXPANDED', 'Live2D package exceeds the expanded size limit');
    }
  }
  const exactNames = new Set(files.keys());
  const caseNames = new Map([...files.keys()].map((name) => [name.toLocaleLowerCase('en-US'), name]));
  for (const reference of collectLive2DReferences(model)) {
    const resolved = safeModelReference(modelDirectory, reference);
    if (modelRootPrefix && !resolved.startsWith(modelRootPrefix)) {
      throw avatarError('AVATAR_LIVE2D_REFERENCE', `Live2D reference leaves the model root: ${reference}`);
    }
    if (!exactNames.has(resolved)) {
      const caseVariant = caseNames.get(resolved.toLocaleLowerCase('en-US'));
      throw avatarError(
        'AVATAR_LIVE2D_MISSING',
        caseVariant
          ? `Live2D reference has the wrong letter case: ${reference}`
          : `Live2D referenced file is missing: ${reference}`,
      );
    }
  }
  const mocReferences = collectLive2DReferences(model)
    .map((reference) => safeModelReference(modelDirectory, reference))
    .filter((reference) => reference.toLowerCase().endsWith('.moc3'));
  if (mocReferences.length !== 1) {
    throw avatarError('AVATAR_LIVE2D_MOC', 'Live2D package must reference exactly one .moc3 file');
  }
  const mocHeader = Buffer.alloc(4);
  const mocPath = path.join(outputDir, ...mocReferences[0].split('/'));
  const mocFd = fs.openSync(mocPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fs.readSync(mocFd, mocHeader, 0, mocHeader.length, 0) !== 4
      || mocHeader.toString('ascii') !== 'MOC3') {
      throw avatarError('AVATAR_LIVE2D_MOC', 'Live2D .moc3 header is invalid');
    }
  } finally {
    fs.closeSync(mocFd);
  }
  let estimatedTextureBytes = 0;
  const textureStats = [];
  const textureReferences = Array.isArray(model.FileReferences?.Textures)
    ? model.FileReferences.Textures
    : [];
  for (const reference of textureReferences) {
    const resolved = safeModelReference(modelDirectory, reference);
    const descriptor = files.get(resolved);
    if (!descriptor) throw avatarError('AVATAR_LIVE2D_MISSING', `Live2D texture is missing: ${reference}`);
    const extension = path.posix.extname(resolved).toLowerCase();
    const mimeType = extension === '.png'
      ? 'image/png'
      : ['.jpg', '.jpeg'].includes(extension)
        ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp' : '';
    if (!mimeType) throw avatarError('AVATAR_LIVE2D_TEXTURE', 'Live2D texture format is unsupported');
    const bytes = fs.readFileSync(path.join(outputDir, ...resolved.split('/')));
    const dimensions = parseImageSize(bytes, mimeType);
    if (!dimensions) throw avatarError('AVATAR_LIVE2D_TEXTURE', `Live2D texture is invalid: ${reference}`);
    const [width, height] = dimensions;
    if (width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION) {
      throw avatarError(
        'AVATAR_LIVE2D_TEXTURE_SIZE',
        `Live2D texture exceeds ${MAX_TEXTURE_DIMENSION}×${MAX_TEXTURE_DIMENSION}`,
      );
    }
    estimatedTextureBytes += Math.ceil(width * height * 4 * 4 / 3);
    if (!Number.isSafeInteger(estimatedTextureBytes) || estimatedTextureBytes > MAX_ESTIMATED_VRAM) {
      throw avatarError('AVATAR_LIVE2D_VRAM', 'Live2D textures exceed the estimated 1 GiB GPU memory limit');
    }
    textureStats.push({ width, height, mimeType });
  }
  const expressionEntries = Array.isArray(model.FileReferences?.Expressions)
    ? model.FileReferences.Expressions
    : [];
  const motionGroups = model.FileReferences?.Motions
    && typeof model.FileReferences.Motions === 'object'
    && !Array.isArray(model.FileReferences.Motions)
    ? Object.keys(model.FileReferences.Motions)
    : [];
  const warnings = [];
  if (estimatedTextureBytes > WARN_ESTIMATED_VRAM) {
    warnings.push(`high_estimated_vram:${estimatedTextureBytes}`);
  }
  return {
    entryRelative: modelEntry.path,
    files: [...files.values()],
    stats: {
      fileCount: files.size,
      expandedBytes: normalizedExpandedBytes,
      modelVersion: version,
      textures: textureStats,
      estimatedVramBytes: estimatedTextureBytes,
      detected: {
        animationClips: motionGroups.map((name) => safeDetectedName(name, 'Motion')).slice(0, 256),
        expressions: expressionEntries.map((entry, index) => safeDetectedName(
          entry?.Name,
          `Expression ${index + 1}`,
        )).slice(0, 256),
      },
    },
    warnings,
  };
}

function validateLive2DPackage(zipBuffer, outputDir) {
  const parsed = parseZip(zipBuffer);
  const files = [];
  for (const entry of parsed.entries) {
    const target = path.join(outputDir, ...entry.name.split('/'));
    if (!isInside(outputDir, target)) throw avatarError('AVATAR_PATH_ESCAPE', 'Archive path escaped staging');
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = inflateZipEntry(zipBuffer, entry);
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    files.push({
      path: entry.name,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return validateLive2DExtracted(outputDir, files, parsed.expandedBytes);
}

function inventoryLive2DDirectory(sourceDir) {
  const sourceRoot = path.resolve(String(sourceDir || ''));
  const rootStat = fs.lstatSync(sourceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw avatarError('AVATAR_SOURCE_INVALID', 'Live2D source must be a regular directory');
  }
  const realRoot = fs.realpathSync(sourceRoot);
  const collisionKeys = new Set();
  const files = [];
  let entryCount = 0;
  let expandedBytes = 0;

  const visit = (current, segments) => {
    const currentStat = fs.lstatSync(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw avatarError('AVATAR_DIRECTORY_FILETYPE', 'Live2D folders may contain only regular files and directories');
    }
    const realCurrent = fs.realpathSync(current);
    if (!isInside(realRoot, realCurrent)) {
      throw avatarError('AVATAR_PATH_ESCAPE', 'Live2D folder resolves outside the selected root');
    }
    const directory = fs.opendirSync(current);
    try {
      for (;;) {
        const dirent = directory.readSync();
        if (!dirent) break;
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          throw avatarError('AVATAR_DIRECTORY_COUNT', `Live2D folder exceeds ${MAX_ZIP_ENTRIES} entries`);
        }
        const relative = canonicalArchivePath([...segments, dirent.name].join('/'), {
          directory: dirent.isDirectory(),
        });
        const collisionKey = relative.toLocaleLowerCase('en-US');
        if (collisionKeys.has(collisionKey)) {
          throw avatarError('AVATAR_DIRECTORY_COLLISION', `Duplicate or case/NFC-conflicting path: ${relative}`);
        }
        collisionKeys.add(collisionKey);
        const source = path.join(current, dirent.name);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) {
          throw avatarError('AVATAR_DIRECTORY_SYMLINK', 'Symbolic links and junctions are not allowed');
        }
        if (stat.isDirectory()) {
          visit(source, [...segments, dirent.name]);
          continue;
        }
        if (!stat.isFile()) {
          throw avatarError('AVATAR_DIRECTORY_FILETYPE', 'Live2D folders may contain only regular files and directories');
        }
        const extension = path.posix.extname(relative).toLowerCase();
        if (SCRIPT_EXTENSIONS.has(extension) || !LIVE2D_EXTENSIONS.has(extension)) {
          throw avatarError('AVATAR_DIRECTORY_EXTENSION', `Unsupported file type in Live2D folder: ${extension || '(none)'}`);
        }
        if (stat.size <= 0 || stat.size > MAX_SINGLE_EXPANDED_BYTES) {
          throw avatarError('AVATAR_DIRECTORY_FILE_SIZE', 'A Live2D folder file is empty or exceeds 300 MiB');
        }
        expandedBytes += stat.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) {
          throw avatarError('AVATAR_DIRECTORY_SIZE', 'Live2D folder exceeds the expanded size limit');
        }
        const realSource = fs.realpathSync(source);
        if (!isInside(realRoot, realSource)) {
          throw avatarError('AVATAR_PATH_ESCAPE', 'Live2D file resolves outside the selected root');
        }
        files.push({
          source,
          relative,
          size: stat.size,
          dev: stat.dev,
          ino: stat.ino,
        });
      }
    } finally {
      directory.closeSync();
    }
  };

  visit(sourceRoot, []);
  if (!files.length) throw avatarError('AVATAR_DIRECTORY_EMPTY', 'Live2D folder contains no files');
  return { sourceRoot, files, expandedBytes };
}

function validateLive2DDirectory(sourceDir, outputDir) {
  const inventory = inventoryLive2DDirectory(sourceDir);
  const descriptors = [];
  for (const file of inventory.files) {
    const target = path.join(outputDir, ...file.relative.split('/'));
    if (!isInside(outputDir, target)) throw avatarError('AVATAR_PATH_ESCAPE', 'Live2D path escaped staging');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copySource(file.source, target, MAX_SINGLE_EXPANDED_BYTES, file);
    const bytes = fs.readFileSync(target);
    descriptors.push({
      path: file.relative,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return validateLive2DExtracted(outputDir, descriptors, inventory.expandedBytes);
}

function parsePngSize(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  return null;
}

function parseJpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
      && length >= 7) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebpSize(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const type = bytes.toString('ascii', 12, 16);
  if (type === 'VP8X') return [readUInt24LE(bytes, 24) + 1, readUInt24LE(bytes, 27) + 1];
  if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
  if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

function parseImageSize(bytes, mimeType) {
  if (mimeType === 'image/png') return parsePngSize(bytes);
  if (mimeType === 'image/jpeg') return parseJpegSize(bytes);
  if (mimeType === 'image/webp') return parseWebpSize(bytes);
  return null;
}

function parseGlb(buffer) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw avatarError('AVATAR_GLB_MAGIC', 'File is not a GLB container');
  }
  if (buffer.readUInt32LE(4) !== 2) throw avatarError('AVATAR_GLB_VERSION', 'Only glTF 2.0 GLB files are supported');
  if (buffer.readUInt32LE(8) !== buffer.length) throw avatarError('AVATAR_GLB_LENGTH', 'GLB length header does not match the file');
  const chunks = [];
  let offset = 12;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw avatarError('AVATAR_GLB_CHUNK', 'Truncated GLB chunk header');
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (length % 4 !== 0 || end > buffer.length) throw avatarError('AVATAR_GLB_CHUNK', 'Invalid GLB chunk size');
    chunks.push({ type, bytes: buffer.subarray(start, end) });
    offset = end;
  }
  if (chunks.length < 1 || chunks[0].type !== 0x4e4f534a
    || chunks.filter((chunk) => chunk.type === 0x4e4f534a).length !== 1
    || chunks.filter((chunk) => chunk.type === 0x004e4942).length > 1) {
    throw avatarError('AVATAR_GLB_CHUNK', 'GLB must contain one JSON chunk and at most one BIN chunk');
  }
  let json;
  try {
    if (chunks[0].bytes.length > 32 * MiB) {
      throw avatarError('AVATAR_GLB_JSON_SIZE', 'GLB JSON chunk exceeds 32 MiB');
    }
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(chunks[0].bytes)
      .replace(/[\u0000\u0020]+$/g, '');
    json = JSON.parse(text);
  } catch {
    throw avatarError('AVATAR_GLB_JSON', 'GLB JSON chunk is invalid');
  }
  if (json?.asset?.version !== '2.0') throw avatarError('AVATAR_GLB_ASSET', 'GLB asset.version must be 2.0');
  return { json, bin: chunks.find((chunk) => chunk.type === 0x004e4942)?.bytes || Buffer.alloc(0) };
}

function arrayOrEmpty(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw avatarError('AVATAR_GLB_SCHEMA', `${label} must be an array`);
  return value;
}

function safeIndex(array, index, label) {
  if (!Number.isInteger(index) || index < 0 || index >= array.length) {
    throw avatarError('AVATAR_GLB_SCHEMA', `Invalid ${label} index`);
  }
  return array[index];
}

function validateGlb(buffer) {
  const { json, bin } = parseGlb(buffer);
  const buffers = arrayOrEmpty(json.buffers, 'buffers');
  const bufferViews = arrayOrEmpty(json.bufferViews, 'bufferViews');
  const accessors = arrayOrEmpty(json.accessors, 'accessors');
  const meshes = arrayOrEmpty(json.meshes, 'meshes');
  const images = arrayOrEmpty(json.images, 'images');
  const nodes = arrayOrEmpty(json.nodes, 'nodes');
  const animations = arrayOrEmpty(json.animations, 'animations');
  for (const [label, collection, limit] of [
    ['bufferViews', bufferViews, 100_000],
    ['accessors', accessors, 100_000],
    ['meshes', meshes, 100_000],
    ['nodes', nodes, 100_000],
    ['images', images, 4096],
    ['animations', animations, 4096],
  ]) {
    if (collection.length > limit) {
      throw avatarError('AVATAR_GLB_COUNT', `GLB contains too many ${label}`);
    }
  }
  for (const item of [...buffers, ...images]) {
    if (Object.prototype.hasOwnProperty.call(item || {}, 'uri')) {
      throw avatarError('AVATAR_GLB_EXTERNAL_URI', 'GLB must not contain external or data URIs');
    }
  }
  if (buffers.length > 1) throw avatarError('AVATAR_GLB_BUFFER', 'GLB may contain only its embedded binary buffer');
  if (buffers[0] && (!Number.isSafeInteger(buffers[0].byteLength) || buffers[0].byteLength < 0
    || buffers[0].byteLength > bin.length)) {
    throw avatarError('AVATAR_GLB_BUFFER', 'GLB buffer length is invalid');
  }
  for (const view of bufferViews) {
    if ((view?.buffer ?? 0) !== 0) throw avatarError('AVATAR_GLB_BUFFER', 'bufferView points outside the embedded buffer');
    const start = Number(view?.byteOffset || 0);
    const length = Number(view?.byteLength);
    const stride = view?.byteStride == null ? null : Number(view.byteStride);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)
      || start < 0 || length < 0 || start + length > bin.length
      || (stride !== null && (!Number.isInteger(stride) || stride < 4 || stride > 252))) {
      throw avatarError('AVATAR_GLB_BUFFER', 'bufferView range or stride is invalid');
    }
  }
  const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
  const typeComponents = new Map([
    ['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4],
    ['MAT2', 4], ['MAT3', 9], ['MAT4', 16],
  ]);
  for (const accessor of accessors) {
    const bytes = componentBytes.get(accessor?.componentType);
    const components = typeComponents.get(accessor?.type);
    const count = Number(accessor?.count);
    const byteOffset = Number(accessor?.byteOffset || 0);
    if (!bytes || !components || !Number.isSafeInteger(count) || count < 0
      || count > 100_000_000 || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      throw avatarError('AVATAR_GLB_ACCESSOR', 'Accessor shape is invalid');
    }
    if (accessor.bufferView != null) {
      const view = safeIndex(bufferViews, accessor.bufferView, 'accessor bufferView');
      const elementBytes = bytes * components;
      const stride = Number(view.byteStride || elementBytes);
      const required = count === 0 ? byteOffset : byteOffset + ((count - 1) * stride) + elementBytes;
      if (!Number.isSafeInteger(required) || required > view.byteLength || stride < elementBytes) {
        throw avatarError('AVATAR_GLB_ACCESSOR', 'Accessor exceeds its bufferView');
      }
    }
    if (accessor.sparse) {
      const sparseCount = Number(accessor.sparse.count);
      if (!Number.isSafeInteger(sparseCount) || sparseCount < 0 || sparseCount > count) {
        throw avatarError('AVATAR_GLB_ACCESSOR', 'Sparse accessor count is invalid');
      }
      safeIndex(bufferViews, accessor.sparse.indices?.bufferView, 'sparse indices bufferView');
      safeIndex(bufferViews, accessor.sparse.values?.bufferView, 'sparse values bufferView');
      if (![5121, 5123, 5125].includes(accessor.sparse.indices?.componentType)) {
        throw avatarError('AVATAR_GLB_ACCESSOR', 'Sparse index component type is invalid');
      }
    }
  }

  let triangles = 0;
  for (const mesh of meshes) {
    for (const primitive of arrayOrEmpty(mesh?.primitives, 'mesh.primitives')) {
      const mode = primitive.mode ?? 4;
      if (![0, 1, 2, 3, 4, 5, 6].includes(mode)) throw avatarError('AVATAR_GLB_SCHEMA', 'Invalid primitive mode');
      let count = 0;
      if (primitive.indices != null) count = Number(safeIndex(accessors, primitive.indices, 'accessor')?.count);
      else if (primitive.attributes?.POSITION != null) {
        count = Number(safeIndex(accessors, primitive.attributes.POSITION, 'POSITION accessor')?.count);
      }
      if (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000) {
        throw avatarError('AVATAR_GLB_SCHEMA', 'Primitive accessor count is invalid');
      }
      if (mode === 4) triangles += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
      if (!Number.isSafeInteger(triangles) || triangles > MAX_TRIANGLES) {
        throw avatarError('AVATAR_GLB_TRIANGLES', `Avatar exceeds the ${MAX_TRIANGLES.toLocaleString()} triangle limit`);
      }
    }
  }

  let textureBytes = 0;
  const textureStats = [];
  for (const image of images) {
    if (typeof image?.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) {
      throw avatarError('AVATAR_GLB_IMAGE', 'Embedded textures must be PNG, JPEG, or WebP');
    }
    const view = safeIndex(bufferViews, image.bufferView, 'image bufferView');
    if ((view.buffer ?? 0) !== 0) throw avatarError('AVATAR_GLB_BUFFER', 'Texture points to an unsupported buffer');
    const start = Number(view.byteOffset || 0);
    const length = Number(view.byteLength);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1
      || start + length > bin.length) {
      throw avatarError('AVATAR_GLB_BUFFER', 'Texture bufferView is out of bounds');
    }
    const dimensions = parseImageSize(bin.subarray(start, start + length), image.mimeType);
    if (!dimensions || dimensions.some((value) => !Number.isInteger(value) || value < 1)) {
      throw avatarError('AVATAR_GLB_IMAGE', 'Could not verify an embedded texture dimension');
    }
    const [width, height] = dimensions;
    if (width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION) {
      throw avatarError('AVATAR_GLB_TEXTURE_SIZE', `Texture exceeds ${MAX_TEXTURE_DIMENSION}×${MAX_TEXTURE_DIMENSION}`);
    }
    textureBytes += Math.ceil(width * height * 4 * 4 / 3);
    textureStats.push({ width, height, mimeType: image.mimeType });
  }
  const declaredBufferBytes = buffers.reduce((sum, item) => sum + Number(item.byteLength || 0), 0);
  const estimatedVramBytes = textureBytes + declaredBufferBytes;
  if (!Number.isSafeInteger(estimatedVramBytes) || estimatedVramBytes > MAX_ESTIMATED_VRAM) {
    throw avatarError('AVATAR_GLB_VRAM', 'Avatar exceeds the estimated 1 GiB GPU memory limit');
  }
  const warnings = [];
  if (triangles > WARN_TRIANGLES) warnings.push(`high_triangle_count:${triangles}`);
  if (estimatedVramBytes > WARN_ESTIMATED_VRAM) warnings.push(`high_estimated_vram:${estimatedVramBytes}`);
  const animationClips = animations.map((animation, index) => safeDetectedName(
    animation?.name,
    `Animation ${index + 1}`,
  ));
  const expressionNames = [];
  const vrm1Expressions = json.extensions?.VRMC_vrm?.expressions;
  for (const collection of [vrm1Expressions?.preset, vrm1Expressions?.custom]) {
    if (collection && typeof collection === 'object' && !Array.isArray(collection)) {
      expressionNames.push(...Object.keys(collection).map((name) => safeDetectedName(name, 'Expression')));
    }
  }
  const vrm0Groups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
  if (Array.isArray(vrm0Groups)) {
    for (const group of vrm0Groups) {
      expressionNames.push(safeDetectedName(group?.name || group?.presetName, 'Expression'));
    }
  }
  return {
    triangles,
    textures: textureStats,
    estimatedVramBytes,
    warnings,
    detected: {
      animationClips: [...new Set(animationClips)].slice(0, 256),
      expressions: [...new Set(expressionNames)].slice(0, 256),
    },
  };
}

function validateVrma(buffer) {
  const stats = validateGlb(buffer);
  const { json } = parseGlb(buffer);
  const extensionName = 'VRMC_vrm_animation';
  if (!Array.isArray(json.extensionsUsed) || !json.extensionsUsed.includes(extensionName)
    || !json.extensions || typeof json.extensions[extensionName] !== 'object'
    || Array.isArray(json.extensions[extensionName])) {
    throw avatarError('AVATAR_VRMA_EXTENSION', 'VRMA must contain the VRMC_vrm_animation extension');
  }
  const specVersion = json.extensions[extensionName].specVersion;
  if (typeof specVersion !== 'string' || !/^1(?:\.0)?(?:-draft)?$/i.test(specVersion)) {
    throw avatarError('AVATAR_VRMA_VERSION', 'VRMA uses an unsupported VRMC_vrm_animation version');
  }
  const animations = arrayOrEmpty(json.animations, 'animations');
  const accessors = arrayOrEmpty(json.accessors, 'accessors');
  const nodes = arrayOrEmpty(json.nodes, 'nodes');
  if (animations.length < 1 || animations.length > 64) {
    throw avatarError('AVATAR_VRMA_ANIMATION', 'VRMA must contain 1-64 glTF animations');
  }
  if (arrayOrEmpty(json.meshes, 'meshes').length || arrayOrEmpty(json.images, 'images').length) {
    throw avatarError('AVATAR_VRMA_PAYLOAD', 'VRMA attachments must not contain meshes or textures');
  }
  for (const animation of animations) {
    const samplers = arrayOrEmpty(animation?.samplers, 'animation.samplers');
    const channels = arrayOrEmpty(animation?.channels, 'animation.channels');
    if (!samplers.length || !channels.length || samplers.length > 100_000 || channels.length > 100_000) {
      throw avatarError('AVATAR_VRMA_ANIMATION', 'VRMA animation sampler/channel count is invalid');
    }
    for (const sampler of samplers) {
      safeIndex(accessors, sampler?.input, 'animation input accessor');
      safeIndex(accessors, sampler?.output, 'animation output accessor');
      if (sampler?.interpolation != null
        && !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(sampler.interpolation)) {
        throw avatarError('AVATAR_VRMA_ANIMATION', 'VRMA interpolation is invalid');
      }
    }
    for (const channel of channels) {
      safeIndex(samplers, channel?.sampler, 'animation sampler');
      safeIndex(nodes, channel?.target?.node, 'animation target node');
      if (!['translation', 'rotation', 'scale', 'weights'].includes(channel?.target?.path)) {
        throw avatarError('AVATAR_VRMA_ANIMATION', 'VRMA animation target path is invalid');
      }
    }
  }
  return {
    ...stats,
    animationCount: animations.length,
    vrmaSpecVersion: specVersion,
  };
}

function safeDetectedName(value, fallback) {
  const cleaned = String(value || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 110);
  return cleaned || fallback;
}

function normalizeDetected(value = {}) {
  const result = { animationClips: [], expressions: [] };
  for (const key of Object.keys(result)) {
    if (!Array.isArray(value[key]) || value[key].length > 256) {
      throw avatarError('AVATAR_DETECTED', 'Avatar detected capability list is invalid');
    }
    result[key] = [...new Set(value[key].map((name) => {
      if (typeof name !== 'string' || name.length < 1 || name.length > 110
        || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw avatarError('AVATAR_DETECTED', 'Avatar detected capability name is invalid');
      }
      return name.normalize('NFC');
    }))];
  }
  return result;
}

function defaultCapabilities(kind, renderReady = false) {
  return {
    renderReady,
    expressionMapping: true,
    actionMapping: true,
    expressionPlayback: false,
    embeddedAnimationPlayback: false,
    vrmaImport: kind === 'vrm',
    vrmaPlayback: kind === 'vrm',
  };
}

function emptyMapping() {
  return { expressions: {}, actions: {} };
}

function isSafeMappingKey(value) {
  return MAPPING_KEY_RE.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase());
}

function validateMapping(mapping, motions = [], detectedValue = {}) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw avatarError('AVATAR_MAPPING', 'Avatar mapping is invalid');
  }
  const result = emptyMapping();
  const motionIds = new Set(motions.map((motion) => motion.id));
  const detected = normalizeDetected(detectedValue);
  for (const [category, property] of [['expression', 'expressions'], ['action', 'actions']]) {
    const source = mapping[property];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw avatarError('AVATAR_MAPPING', `Avatar ${category} mapping is invalid`);
    }
    const entries = Object.entries(source);
    if (entries.length > 128) throw avatarError('AVATAR_MAPPING', 'Avatar mapping contains too many entries');
    for (const [key, target] of entries) {
      if (!isSafeMappingKey(key) || typeof target !== 'string'
        || target.length < 1 || target.length > 128 || /[\u0000-\u001f\u007f]/u.test(target)) {
        throw avatarError('AVATAR_MAPPING', `Avatar ${category} mapping entry is invalid`);
      }
      if (category === 'expression') {
        if (!target.startsWith('expression:')
          || !detected.expressions.includes(target.slice('expression:'.length))) {
          throw avatarError('AVATAR_MAPPING', 'Avatar expression mapping references an unknown expression');
        }
      } else if (target.startsWith('clip:')) {
        if (!detected.animationClips.includes(target.slice('clip:'.length))) {
          throw avatarError('AVATAR_MAPPING', 'Avatar action mapping references an unknown embedded clip');
        }
      } else if (!target.startsWith('vrma:') || !motionIds.has(target.slice('vrma:'.length))) {
        throw avatarError('AVATAR_MAPPING', 'Avatar action mapping references an unknown motion');
      }
      result[property][key] = target;
    }
  }
  return result;
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function copySource(source, target, maxBytes, expectedIdentity = null) {
  const initialIdentity = assertRegularSource(source, maxBytes);
  const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const input = fs.openSync(source, sourceFlags);
  let output = null;
  let total = 0;
  try {
    output = fs.openSync(target, 'wx', 0o600);
    const sourceStat = fs.fstatSync(input);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > maxBytes) {
      throw avatarError('AVATAR_SOURCE_SIZE', 'Avatar source changed or exceeds its size limit');
    }
    const expected = expectedIdentity || initialIdentity;
    if (sourceStat.size !== expected.size
      || sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino) {
      throw avatarError('AVATAR_SOURCE_CHANGED', 'Avatar source changed while it was being imported');
    }
    const chunk = Buffer.allocUnsafe(MiB);
    for (;;) {
      const read = fs.readSync(input, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw avatarError('AVATAR_SOURCE_SIZE', 'Avatar source grew beyond its size limit');
      let written = 0;
      while (written < read) {
        written += fs.writeSync(output, chunk, written, read - written);
      }
    }
    if (total <= 0) throw avatarError('AVATAR_SOURCE_SIZE', 'Avatar source is empty');
    fs.fsyncSync(output);
  } catch (error) {
    try { fs.unlinkSync(target); } catch {}
    throw error;
  } finally {
    fs.closeSync(input);
    if (output !== null) fs.closeSync(output);
  }
}

function safeDisplayName(value, fallback = 'Avatar') {
  const cleaned = String(value || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

class AvatarManager {
  constructor(options = {}) {
    if (!options.storageDir) throw new TypeError('AvatarManager requires storageDir');
    this.storageDir = path.resolve(options.storageDir);
    this.stagingDir = path.join(this.storageDir, 'staging');
    this.motionStagingDir = path.join(this.storageDir, 'motion-staging');
    this.recordsDir = path.join(this.storageDir, 'records');
    this.activePath = path.join(this.storageDir, 'active.json');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.previewTtlMs = Number.isInteger(options.previewTtlMs)
      ? Math.min(60 * 60 * 1000, Math.max(60 * 1000, options.previewTtlMs))
      : PREVIEW_TTL_MS;
    this.live2dRuntime = Object.freeze({
      available: Boolean(options.live2dRuntime?.available && options.live2dRuntime?.coreAvailable),
      coreAvailable: Boolean(options.live2dRuntime?.coreAvailable),
      rendererAvailable: Boolean(options.live2dRuntime?.rendererAvailable),
      licenseAccepted: Boolean(options.live2dRuntime?.licenseAccepted),
      developmentOnly: Boolean(options.live2dRuntime?.developmentOnly),
      reason: options.live2dRuntime?.available && !options.live2dRuntime?.coreAvailable
        ? 'Live2D Cubism Core is missing'
        : options.live2dRuntime?.reason || '',
    });
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.motionStagingDir, { recursive: true });
    fs.mkdirSync(this.recordsDir, { recursive: true });
    this.cleanupStaging();
  }

  cleanupStaging(now = Date.now()) {
    for (const root of [this.stagingDir, this.motionStagingDir]) {
      for (const name of fs.readdirSync(root)) {
        if (!IMPORT_ID_RE.test(name.replace(/\.partial$/, ''))) continue;
        const target = path.join(root, name);
        try {
          const stat = fs.lstatSync(target);
          if (stat.isSymbolicLink() || now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
            fs.rmSync(target, { recursive: true, force: true });
          }
        } catch {}
      }
    }
  }

  _readActive() {
    try {
      const stat = fs.lstatSync(this.activePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
      const value = JSON.parse(fs.readFileSync(this.activePath, 'utf8'));
      if (value?.schema === ACTIVE_SCHEMA && (value.activeId === null || AVATAR_ID_RE.test(value.activeId))) {
        return value.activeId;
      }
    } catch {}
    return null;
  }

  _recordFromManifest(manifest) {
    const entry = manifest.entryRelative.split('/').map(encodeURIComponent).join('/');
    return {
      id: manifest.id,
      name: manifest.name,
      kind: manifest.kind,
      entryUrl: `reverie-avatar://asset/${manifest.id}/${entry}`,
      status: 'ready',
      warnings: [...manifest.warnings],
      stats: manifest.stats,
      detected: cloneJson(manifest.detected),
      capabilities: { ...manifest.capabilities },
      mapping: cloneJson(manifest.mapping),
      motions: manifest.motions.map((motion) => ({
        id: motion.id,
        name: motion.name,
        url: `reverie-avatar://asset/${manifest.id}/${motion.path.split('/').map(encodeURIComponent).join('/')}`,
        size: motion.size,
        importedAtUtc: motion.importedAtUtc,
        playbackSupported: manifest.kind === 'vrm' && manifest.capabilities.vrmaPlayback === true,
      })),
    };
  }

  _readManifest(id) {
    if (!AVATAR_ID_RE.test(String(id || ''))) throw avatarError('AVATAR_ID', 'Invalid avatar identifier');
    const recordRoot = path.join(this.recordsDir, id);
    const payloadRoot = path.join(recordRoot, 'payload');
    for (const directory of [recordRoot, payloadRoot]) {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw avatarError('AVATAR_MANIFEST', 'Avatar record directory is invalid');
      }
    }
    const manifestPath = path.join(recordRoot, 'manifest.json');
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MiB) {
      throw avatarError('AVATAR_MANIFEST', 'Avatar manifest is invalid');
    }
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (value?.schema !== MANIFEST_SCHEMA || value.id !== id
      || !['vrm', 'glb', 'live2d'].includes(value.kind)
      || !Array.isArray(value.files) || typeof value.entryRelative !== 'string') {
      throw avatarError('AVATAR_MANIFEST', 'Avatar manifest schema is invalid');
    }
    const collisionKeys = new Set();
    for (const descriptor of value.files) {
      if (!descriptor || typeof descriptor !== 'object') throw avatarError('AVATAR_MANIFEST', 'Avatar file descriptor is invalid');
      const canonical = canonicalArchivePath(descriptor.path);
      const collision = canonical.toLocaleLowerCase('en-US');
      if (collisionKeys.has(collision)
        || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1
        || !/^[a-f0-9]{64}$/i.test(String(descriptor.sha256 || ''))) {
        throw avatarError('AVATAR_MANIFEST', 'Avatar file descriptor is invalid');
      }
      collisionKeys.add(collision);
    }
    if (!value.files.some((file) => file.path === value.entryRelative)) {
      throw avatarError('AVATAR_MANIFEST', 'Avatar entry file is not registered');
    }
    value.detected = normalizeDetected(value.detected || value.stats?.detected || {});
    value.capabilities = {
      ...defaultCapabilities(value.kind, true),
      ...(value.capabilities || {}),
      vrmaPlayback: value.kind === 'vrm',
    };
    if (Object.values(value.capabilities).some((capability) => typeof capability !== 'boolean')) {
      throw avatarError('AVATAR_MANIFEST', 'Avatar capability manifest is invalid');
    }
    value.motions = Array.isArray(value.motions) ? value.motions : [];
    const motionIds = new Set();
    for (const motion of value.motions) {
      if (!motion || typeof motion !== 'object'
        || !AVATAR_ID_RE.test(String(motion.id || '')) || motionIds.has(motion.id)
        || typeof motion.name !== 'string' || motion.name.length < 1 || motion.name.length > 80
        || typeof motion.path !== 'string' || !motion.path.startsWith('motions/')
        || !motion.path.toLowerCase().endsWith('.vrma')
        || !Number.isSafeInteger(motion.size) || motion.size < 1 || motion.size > MAX_AVATAR_BYTES
        || !/^[a-f0-9]{64}$/i.test(String(motion.sha256 || ''))
        || !Number.isFinite(Date.parse(motion.importedAtUtc))
        || !value.files.some((file) => file.path === motion.path
          && file.size === motion.size && file.sha256 === motion.sha256)) {
        throw avatarError('AVATAR_MANIFEST', 'Avatar motion descriptor is invalid');
      }
      motionIds.add(motion.id);
    }
    value.mapping = validateMapping(value.mapping || emptyMapping(), value.motions, value.detected);
    return value;
  }

  list() {
    const records = [];
    for (const name of fs.readdirSync(this.recordsDir)) {
      if (!AVATAR_ID_RE.test(name)) continue;
      try { records.push(this._recordFromManifest(this._readManifest(name))); } catch {
        records.push({
          id: name,
          name: 'Unavailable avatar',
          kind: 'glb',
          entryUrl: '',
          status: 'error',
          warnings: ['manifest_invalid'],
        });
      }
    }
    records.sort((a, b) => a.name.localeCompare(b.name));
    const activeId = this._readActive();
    return {
      records,
      activeId: records.some((record) => record.id === activeId && record.status === 'ready') ? activeId : null,
      runtime: { live2d: this.live2dRuntime },
    };
  }

  beginImport(sourcePath, options = {}) {
    const source = path.resolve(String(sourcePath || ''));
    const extension = path.extname(source).toLowerCase();
    const kind = extension === '.vrm' ? 'vrm' : extension === '.glb' ? 'glb' : extension === '.zip' ? 'live2d' : null;
    if (!kind) throw avatarError('AVATAR_FORMAT', 'Choose a .vrm, .glb, or .zip avatar package');
    return this._beginImport(source, { ...options, kind, extension, sourceIsDirectory: false });
  }

  beginImportDirectory(sourcePath, options = {}) {
    const source = path.resolve(String(sourcePath || ''));
    return this._beginImport(source, {
      ...options,
      kind: 'live2d',
      extension: '',
      sourceIsDirectory: true,
    });
  }

  _beginImport(source, options) {
    const { kind, extension, sourceIsDirectory } = options;
    if (kind === 'live2d' && !this.live2dRuntime.available) {
      throw avatarError('AVATAR_LIVE2D_DISABLED', this.live2dRuntime.reason || 'Live2D import is unavailable in this build');
    }
    const importId = options.importId || crypto.randomBytes(24).toString('base64url');
    if (!IMPORT_ID_RE.test(importId)) throw avatarError('AVATAR_IMPORT_ID', 'Invalid import identifier');
    const partial = path.join(this.stagingDir, `${importId}.partial`);
    const stable = path.join(this.stagingDir, importId);
    fs.mkdirSync(partial, { recursive: false });
    try {
      const payloadDir = path.join(partial, 'payload');
      fs.mkdirSync(payloadDir);
      let validation;
      let sourceCopy = null;
      if (sourceIsDirectory) {
        validation = validateLive2DDirectory(source, payloadDir);
      } else {
        sourceCopy = path.join(partial, 'source.bin');
        copySource(source, sourceCopy, kind === 'live2d' ? MAX_ZIP_BYTES : MAX_AVATAR_BYTES);
      }
      if (!sourceIsDirectory && kind === 'live2d') {
        validation = validateLive2DPackage(fs.readFileSync(sourceCopy), payloadDir);
      } else if (!sourceIsDirectory) {
        const targetName = `avatar${extension}`;
        const target = path.join(payloadDir, targetName);
        fs.copyFileSync(sourceCopy, target, fs.constants.COPYFILE_EXCL);
        fsyncFile(target);
        const bytes = fs.readFileSync(target);
        const stats = validateGlb(bytes);
        validation = {
          entryRelative: targetName,
          files: [{
            path: targetName,
            size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          }],
          stats,
          warnings: stats.warnings,
        };
      }
      const createdAt = this.now();
      const expiresAt = createdAt + this.previewTtlMs;
      const candidate = {
        schema: CANDIDATE_SCHEMA,
        importId,
        name: safeDisplayName(options.displayName || path.basename(source, extension)),
        kind,
        entryRelative: validation.entryRelative,
        files: validation.files,
        warnings: validation.warnings,
        stats: validation.stats,
        detected: normalizeDetected(validation.stats?.detected || {}),
        capabilities: defaultCapabilities(kind, false),
        createdAtUtc: new Date(createdAt).toISOString(),
        expiresAtUtc: new Date(expiresAt).toISOString(),
        previewReadyAtUtc: null,
        requiresRightsConfirmation: true,
      };
      atomicWriteJson(path.join(partial, 'candidate.json'), candidate);
      if (sourceCopy) fs.rmSync(sourceCopy, { force: true });
      fs.renameSync(partial, stable);
      const previewEntry = candidate.entryRelative.split('/').map(encodeURIComponent).join('/');
      return {
        importId,
        name: candidate.name,
        kind,
        warnings: [...candidate.warnings],
        stats: candidate.stats,
        detected: cloneJson(candidate.detected),
        summary: {
          files: candidate.stats.fileCount ?? candidate.files.length,
          bytes: candidate.stats.expandedBytes
            ?? candidate.files.reduce((sum, file) => sum + file.size, 0),
          triangles: candidate.stats.triangles,
          estimatedVramBytes: candidate.stats.estimatedVramBytes,
        },
        preview: {
          url: `reverie-avatar://preview/${importId}/${previewEntry}`,
          format: kind,
          expiresAtUtc: candidate.expiresAtUtc,
          capabilities: { ...candidate.capabilities },
        },
        requiresRightsConfirmation: true,
        requiresWarningAcceptance: candidate.warnings.length > 0,
      };
    } catch (error) {
      try { fs.rmSync(partial, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  _readCandidate(importId, { requireFresh = true } = {}) {
    const id = String(importId || '');
    if (!IMPORT_ID_RE.test(id)) throw avatarError('AVATAR_IMPORT_ID', 'Invalid import identifier');
    const stage = path.join(this.stagingDir, id);
    const payload = path.join(stage, 'payload');
    for (const directory of [stage, payload]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw avatarError('AVATAR_CANDIDATE', 'Avatar import candidate directory is invalid');
      }
    }
    const candidatePath = path.join(stage, 'candidate.json');
    const stat = fs.lstatSync(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MiB) {
      throw avatarError('AVATAR_CANDIDATE', 'Avatar import candidate is invalid');
    }
    const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    if (candidate?.schema !== CANDIDATE_SCHEMA || candidate.importId !== id
      || !['vrm', 'glb', 'live2d'].includes(candidate.kind)
      || !Array.isArray(candidate.files) || !Array.isArray(candidate.warnings)
      || typeof candidate.entryRelative !== 'string'
      || !Number.isFinite(Date.parse(candidate.expiresAtUtc))) {
      throw avatarError('AVATAR_CANDIDATE', 'Avatar import candidate is invalid');
    }
    const collisionKeys = new Set();
    for (const descriptor of candidate.files) {
      const canonical = canonicalArchivePath(descriptor?.path);
      const collision = canonical.toLocaleLowerCase('en-US');
      if (collisionKeys.has(collision)
        || !Number.isSafeInteger(descriptor?.size) || descriptor.size < 1
        || !/^[a-f0-9]{64}$/i.test(String(descriptor?.sha256 || ''))) {
        throw avatarError('AVATAR_CANDIDATE', 'Avatar import candidate file descriptor is invalid');
      }
      collisionKeys.add(collision);
    }
    if (!candidate.files.some((file) => file.path === candidate.entryRelative)) {
      throw avatarError('AVATAR_CANDIDATE', 'Avatar import entry file is not registered');
    }
    if (requireFresh && this.now() > Date.parse(candidate.expiresAtUtc)) {
      this.discardImport(id);
      throw avatarError('AVATAR_PREVIEW_EXPIRED', 'Avatar preview expired; import it again');
    }
    candidate.capabilities = {
      ...defaultCapabilities(candidate.kind, false),
      ...(candidate.capabilities || {}),
      vrmaPlayback: candidate.kind === 'vrm',
    };
    candidate.detected = normalizeDetected(candidate.detected || candidate.stats?.detected || {});
    return { stage, payload, candidatePath, candidate };
  }

  markPreviewReady(importId, rendererReport = {}) {
    const { candidatePath, candidate } = this._readCandidate(importId);
    const entry = this.openPreviewAsset(importId, candidate.entryRelative
      .split('/').map(encodeURIComponent).join('/'));
    fs.closeSync(entry.fd);
    const detected = rendererReport?.detected == null
      ? candidate.detected
      : normalizeDetected(rendererReport.detected);
    candidate.detected = detected;
    candidate.capabilities = {
      ...defaultCapabilities(candidate.kind, true),
      expressionPlayback: rendererReport?.capabilities?.expressionPlayback === true
        && detected.expressions.length > 0,
      embeddedAnimationPlayback: rendererReport?.capabilities?.embeddedAnimationPlayback === true
        && detected.animationClips.length > 0,
      vrmaPlayback: candidate.kind === 'vrm',
    };
    candidate.previewReadyAtUtc = new Date(this.now()).toISOString();
    atomicWriteJson(candidatePath, candidate);
    return {
      importId: candidate.importId,
      ready: true,
      previewReadyAtUtc: candidate.previewReadyAtUtc,
      detected: cloneJson(candidate.detected),
      capabilities: { ...candidate.capabilities },
    };
  }

  installTrustedDefaultDirectory(sourcePath, options = {}) {
    if (options.trustedOwnerAsset !== true) {
      throw avatarError('AVATAR_RIGHTS_REQUIRED', 'Trusted default avatar installation requires owner confirmation');
    }
    const current = this.list();
    if (current.records.length > 0) {
      return current.records.find((record) => record.id === current.activeId) || current.records[0];
    }
    const candidate = this.beginImportDirectory(sourcePath, {
      displayName: options.name || 'Yumi',
    });
    try {
      this.markPreviewReady(candidate.importId, {
        detected: candidate.detected,
        capabilities: {
          expressionPlayback: candidate.detected.expressions.length > 0,
          embeddedAnimationPlayback: candidate.detected.animationClips.length > 0,
        },
      });
      const record = this.commitImport({
        importId: candidate.importId,
        rightsConfirmed: true,
        warningAccepted: true,
      });
      this.setActive(record.id);
      return record;
    } catch (error) {
      this.discardImport(candidate.importId);
      throw error;
    }
  }

  discardImport(importId) {
    const id = String(importId || '');
    if (!IMPORT_ID_RE.test(id)) return { discarded: false };
    let discarded = false;
    for (const name of [id, `${id}.partial`]) {
      const target = path.join(this.stagingDir, name);
      if (!isInside(this.stagingDir, target)) continue;
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          discarded = true;
        }
      } catch {}
    }
    return { discarded };
  }

  commitImport(input = {}) {
    const importId = String(input.importId || '');
    if (input.rightsConfirmed !== true) {
      throw avatarError('AVATAR_RIGHTS_REQUIRED', 'Confirm that you have the right to use this avatar');
    }
    const { stage, candidate } = this._readCandidate(importId);
    if (!Number.isFinite(Date.parse(candidate.previewReadyAtUtc))) {
      throw avatarError('AVATAR_PREVIEW_REQUIRED', 'Preview this avatar successfully before adding it to the library');
    }
    if (candidate.warnings.length && input.warningAccepted !== true) {
      throw avatarError('AVATAR_WARNING_REQUIRED', 'Acknowledge the avatar performance warnings');
    }
    const id = crypto.randomUUID();
    const recordPartial = path.join(this.recordsDir, `${id}.partial`);
    const recordFinal = path.join(this.recordsDir, id);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      id,
      name: candidate.name,
      kind: candidate.kind,
      entryRelative: candidate.entryRelative,
      files: candidate.files,
      warnings: candidate.warnings,
      stats: candidate.stats,
      capabilities: {
        ...defaultCapabilities(candidate.kind, true),
        ...candidate.capabilities,
        vrmaPlayback: candidate.kind === 'vrm',
      },
      detected: candidate.detected,
      motions: [],
      mapping: emptyMapping(),
      importedAtUtc: new Date(this.now()).toISOString(),
      rightsConfirmed: true,
    };
    const stagedManifest = path.join(stage, 'manifest.json');
    atomicWriteJson(stagedManifest, manifest);
    try {
      fs.renameSync(stage, recordPartial);
      fs.renameSync(recordPartial, recordFinal);
    } catch (error) {
      try {
        if (fs.existsSync(recordPartial) && !fs.existsSync(stage)) fs.renameSync(recordPartial, stage);
      } catch {}
      try { fs.rmSync(path.join(stage, 'manifest.json'), { force: true }); } catch {}
      throw error;
    }
    try { fs.rmSync(path.join(recordFinal, 'candidate.json'), { force: true }); } catch {}
    return this._recordFromManifest(manifest);
  }

  setActive(id) {
    const activeId = id == null || id === '' ? null : String(id);
    if (activeId !== null) this._readManifest(activeId);
    atomicWriteJson(this.activePath, {
      schema: ACTIVE_SCHEMA,
      activeId,
      changedAtUtc: new Date().toISOString(),
    });
    return { activeId };
  }

  remove(id) {
    const avatarId = String(id || '');
    this._readManifest(avatarId);
    if (this._readActive() === avatarId) {
      throw avatarError('AVATAR_ACTIVE_REMOVE', 'Choose another avatar before removing the active avatar');
    }
    const target = path.join(this.recordsDir, avatarId);
    if (!isInside(this.recordsDir, target)) throw avatarError('AVATAR_ID', 'Invalid avatar identifier');
    fs.rmSync(target, { recursive: true, force: false });
    return { removed: true };
  }

  beginMotionImport(id, sourcePath, options = {}) {
    const avatarId = String(id || '');
    const manifest = this._readManifest(avatarId);
    if (manifest.kind !== 'vrm' || manifest.capabilities.vrmaImport !== true) {
      throw avatarError('AVATAR_VRMA_UNSUPPORTED', 'VRMA attachments are available only for registered VRM avatars');
    }
    const source = path.resolve(String(sourcePath || ''));
    if (path.extname(source).toLowerCase() !== '.vrma') {
      throw avatarError('AVATAR_VRMA_FORMAT', 'Choose a .vrma animation file');
    }
    const importId = options.importId || crypto.randomBytes(24).toString('base64url');
    if (!IMPORT_ID_RE.test(importId)) throw avatarError('AVATAR_IMPORT_ID', 'Invalid motion import identifier');
    const partial = path.join(this.motionStagingDir, `${importId}.partial`);
    const stable = path.join(this.motionStagingDir, importId);
    const motionId = crypto.randomUUID();
    fs.mkdirSync(partial, { recursive: false });
    try {
      const stagedMotion = path.join(partial, 'motion.vrma');
      copySource(source, stagedMotion, MAX_AVATAR_BYTES);
      const bytes = fs.readFileSync(stagedMotion);
      const stats = validateVrma(bytes);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const candidate = {
        schema: MOTION_CANDIDATE_SCHEMA,
        importId,
        avatarId,
        motionId,
        name: safeDisplayName(path.basename(source, path.extname(source)), 'Motion'),
        size: bytes.length,
        sha256,
        stats,
        createdAtUtc: new Date(this.now()).toISOString(),
        expiresAtUtc: new Date(this.now() + this.previewTtlMs).toISOString(),
      };
      atomicWriteJson(path.join(partial, 'candidate.json'), candidate);
      fs.renameSync(partial, stable);
      return {
        importId,
        avatarId,
        motionId,
        name: candidate.name,
        size: candidate.size,
        stats,
        playbackSupported: true,
      };
    } catch (error) {
      try { fs.rmSync(partial, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  discardMotionImport(importId) {
    const id = String(importId || '');
    if (!IMPORT_ID_RE.test(id)) return { discarded: false };
    let discarded = false;
    for (const name of [id, `${id}.partial`]) {
      const target = path.join(this.motionStagingDir, name);
      if (!isInside(this.motionStagingDir, target)) continue;
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          discarded = true;
        }
      } catch {}
    }
    return { discarded };
  }

  commitMotionImport(importId) {
    const id = String(importId || '');
    if (!IMPORT_ID_RE.test(id)) throw avatarError('AVATAR_IMPORT_ID', 'Invalid motion import identifier');
    const stage = path.join(this.motionStagingDir, id);
    const candidatePath = path.join(stage, 'candidate.json');
    const candidateStat = fs.lstatSync(candidatePath);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.size > MiB) {
      throw avatarError('AVATAR_VRMA_CANDIDATE', 'Motion import candidate is invalid');
    }
    const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    if (candidate?.schema !== MOTION_CANDIDATE_SCHEMA || candidate.importId !== id
      || !AVATAR_ID_RE.test(String(candidate.avatarId || ''))
      || !AVATAR_ID_RE.test(String(candidate.motionId || ''))
      || !Number.isSafeInteger(candidate.size) || candidate.size < 1 || candidate.size > MAX_AVATAR_BYTES
      || !/^[a-f0-9]{64}$/i.test(String(candidate.sha256 || ''))
      || !Number.isFinite(Date.parse(candidate.expiresAtUtc))) {
      throw avatarError('AVATAR_VRMA_CANDIDATE', 'Motion import candidate is invalid');
    }
    if (this.now() > Date.parse(candidate.expiresAtUtc)) {
      this.discardMotionImport(id);
      throw avatarError('AVATAR_VRMA_EXPIRED', 'Motion import expired; import it again');
    }
    const manifest = this._readManifest(candidate.avatarId);
    if (manifest.kind !== 'vrm' || manifest.capabilities.vrmaImport !== true) {
      throw avatarError('AVATAR_VRMA_UNSUPPORTED', 'The destination avatar no longer accepts VRMA attachments');
    }
    const verified = this._openRegisteredAsset(stage, [{
      path: 'motion.vrma',
      size: candidate.size,
      sha256: candidate.sha256,
    }], 'motion.vrma');
    fs.closeSync(verified.fd);
    const recordRoot = path.join(this.recordsDir, candidate.avatarId);
    const motionsRoot = path.join(recordRoot, 'payload', 'motions');
    fs.mkdirSync(motionsRoot, { recursive: true });
    const motionsStat = fs.lstatSync(motionsRoot);
    if (!motionsStat.isDirectory() || motionsStat.isSymbolicLink()) {
      throw avatarError('AVATAR_MANIFEST', 'Avatar motions directory is invalid');
    }
    const relative = `motions/${candidate.motionId}.vrma`;
    const finalPath = path.join(recordRoot, 'payload', ...relative.split('/'));
    const stagedPath = path.join(stage, 'motion.vrma');
    fs.renameSync(stagedPath, finalPath);
    const importedAtUtc = new Date(this.now()).toISOString();
    const descriptor = { path: relative, size: candidate.size, sha256: candidate.sha256 };
    const motion = {
      id: candidate.motionId,
      name: candidate.name,
      path: relative,
      size: candidate.size,
      sha256: candidate.sha256,
      stats: candidate.stats,
      importedAtUtc,
    };
    manifest.files.push(descriptor);
    manifest.motions.push(motion);
    manifest.capabilities.vrmaPlayback = true;
    try {
      atomicWriteJson(path.join(recordRoot, 'manifest.json'), manifest);
    } catch (error) {
      try { fs.renameSync(finalPath, stagedPath); } catch {}
      throw error;
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    return {
      id: motion.id,
      name: motion.name,
      url: `reverie-avatar://asset/${candidate.avatarId}/${relative.split('/').map(encodeURIComponent).join('/')}`,
      size: motion.size,
      importedAtUtc,
      playbackSupported: true,
    };
  }

  addVrma(id, sourcePath) {
    const candidate = this.beginMotionImport(id, sourcePath);
    try {
      return this.commitMotionImport(candidate.importId);
    } catch (error) {
      this.discardMotionImport(candidate.importId);
      throw error;
    }
  }

  removeMotion(id, motionId) {
    const avatarId = String(id || '');
    const targetMotionId = String(motionId || '');
    const manifest = this._readManifest(avatarId);
    const motion = manifest.motions.find((item) => item.id === targetMotionId);
    if (!motion) throw avatarError('AVATAR_MOTION_ID', 'Avatar motion was not found');
    if (Object.values(manifest.mapping.actions).includes(`vrma:${targetMotionId}`)) {
      throw avatarError('AVATAR_MOTION_MAPPED', 'Remove action mappings for this motion first');
    }
    const recordRoot = path.join(this.recordsDir, avatarId);
    manifest.motions = manifest.motions.filter((item) => item.id !== targetMotionId);
    manifest.files = manifest.files.filter((file) => file.path !== motion.path);
    atomicWriteJson(path.join(recordRoot, 'manifest.json'), manifest);
    const target = path.join(recordRoot, 'payload', ...motion.path.split('/'));
    try { fs.unlinkSync(target); } catch {}
    return { removed: true, motionId: targetMotionId };
  }

  setMapping(id, category, key, target) {
    const avatarId = String(id || '');
    const mappingCategory = String(category || '');
    const mappingKey = String(key || '');
    if (!MAPPING_CATEGORIES.has(mappingCategory) || !isSafeMappingKey(mappingKey)) {
      throw avatarError('AVATAR_MAPPING', 'Avatar mapping category or key is invalid');
    }
    const manifest = this._readManifest(avatarId);
    const property = mappingCategory === 'expression' ? 'expressions' : 'actions';
    const next = cloneJson(manifest.mapping);
    if (target == null || target === '') {
      delete next[property][mappingKey];
    } else {
      const mappingTarget = String(target);
      if (mappingTarget.length > 128 || /[\u0000-\u001f\u007f]/u.test(mappingTarget)) {
        throw avatarError('AVATAR_MAPPING', 'Avatar mapping target is invalid');
      }
      next[property][mappingKey] = mappingTarget;
    }
    manifest.mapping = validateMapping(next, manifest.motions, manifest.detected);
    atomicWriteJson(path.join(this.recordsDir, avatarId, 'manifest.json'), manifest);
    return { id: avatarId, mapping: cloneJson(manifest.mapping) };
  }

  _openRegisteredAsset(payloadRoot, descriptors, encodedRelative) {
    let relative;
    try {
      relative = String(encodedRelative || '').split('/').map((segment) => decodeURIComponent(segment)).join('/');
    } catch {
      throw avatarError('AVATAR_ASSET_PATH', 'Avatar asset path encoding is invalid');
    }
    const canonical = canonicalArchivePath(relative);
    const descriptor = descriptors.find((file) => file.path === canonical);
    if (!descriptor) throw avatarError('AVATAR_ASSET_MISSING', 'Avatar asset is not registered');
    const extension = path.posix.extname(canonical).toLowerCase();
    const mimeType = MIME_BY_EXTENSION[extension];
    if (!mimeType || SCRIPT_EXTENSIONS.has(extension)) {
      throw avatarError('AVATAR_ASSET_TYPE', 'Avatar asset type is not allowed');
    }
    const target = path.join(payloadRoot, ...canonical.split('/'));
    if (!isInside(payloadRoot, target)) throw avatarError('AVATAR_ASSET_PATH', 'Avatar asset path escaped its package');
    const realPayload = fs.realpathSync(payloadRoot);
    const realTarget = fs.realpathSync(target);
    if (!isInside(realPayload, realTarget)) throw avatarError('AVATAR_ASSET_PATH', 'Avatar asset resolves outside its package');
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(realTarget, flags);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== descriptor.size) {
        throw avatarError('AVATAR_ASSET_CHANGED', 'Avatar asset changed after import');
      }
      const hash = crypto.createHash('sha256');
      const chunk = Buffer.allocUnsafe(MiB);
      let position = 0;
      while (position < stat.size) {
        const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (read <= 0) throw avatarError('AVATAR_ASSET_CHANGED', 'Avatar asset became unreadable');
        hash.update(chunk.subarray(0, read));
        position += read;
      }
      if (hash.digest('hex') !== descriptor.sha256) {
        throw avatarError('AVATAR_ASSET_CHANGED', 'Avatar asset integrity check failed');
      }
      return { fd, size: stat.size, mimeType, cacheKey: descriptor.sha256 };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  openPreviewAsset(importId, encodedRelative) {
    const { payload, candidate } = this._readCandidate(importId);
    return this._openRegisteredAsset(payload, candidate.files, encodedRelative);
  }

  openAsset(id, encodedRelative) {
    const avatarId = String(id || '');
    const manifest = this._readManifest(avatarId);
    const recordRoot = path.join(this.recordsDir, avatarId);
    const payloadRoot = path.join(recordRoot, 'payload');
    return this._openRegisteredAsset(payloadRoot, manifest.files, encodedRelative);
  }
}

module.exports = {
  ACTIVE_SCHEMA,
  AVATAR_ID_RE,
  AvatarManager,
  CANDIDATE_SCHEMA,
  MANIFEST_SCHEMA,
  MAX_AVATAR_BYTES,
  MAX_COMPRESSION_RATIO,
  MAX_EXPANDED_BYTES,
  MAX_PATH_DEPTH,
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_SINGLE_EXPANDED_BYTES,
  PREVIEW_TTL_MS,
  canonicalArchivePath,
  crc32,
  inflateZipEntry,
  isInside,
  parseGlb,
  parseImageSize,
  parseZip,
  validateGlb,
  validateLive2DDirectory,
  validateLive2DPackage,
  validateVrma,
};
