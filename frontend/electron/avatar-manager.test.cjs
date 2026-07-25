'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  AvatarManager,
  canonicalArchivePath,
  crc32,
  parseZip,
  validateGlb,
  validateLive2DDirectory,
  validateLive2DPackage,
  validateVrma,
} = require('./avatar-manager.cjs');
const { parseAssetUrl, parseAvatarUrl } = require('./avatar-protocol.cjs');

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const input of entries) {
    const name = Buffer.from(input.name, 'utf8');
    const raw = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data || '');
    const method = input.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const flags = (input.flags ?? 0) | 0x0800;
    const checksum = input.crc ?? crc32(raw);
    const localName = Buffer.from(input.localName || input.name, 'utf8');
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(raw.length),
      u16(localName.length), u16(0), localName, compressed,
    ]);
    localParts.push(local);
    const external = input.externalAttributes ?? 0;
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(input.madeBy ?? 0x0314), u16(20), u16(flags), u16(method),
      u16(0), u16(0), u32(checksum), u32(compressed.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(external),
      u32(localOffset), name,
    ]));
    localOffset += local.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(localOffset), u16(0),
  ]);
}

function pad4(buffer, byte = 0x20) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, byte)]) : buffer;
}

function makeGlb(json, binary = Buffer.alloc(0)) {
  const jsonBytes = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const chunks = [
    Buffer.concat([u32(jsonBytes.length), u32(0x4e4f534a), jsonBytes]),
  ];
  if (binary.length) {
    const bin = pad4(binary, 0);
    chunks.push(Buffer.concat([u32(bin.length), u32(0x004e4942), bin]));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from('glTF'), u32(2), u32(body.length + 12), body]);
}

function minimalGlb(extra = {}) {
  return makeGlb({
    asset: { version: '2.0' },
    scenes: [{}],
    scene: 0,
    ...extra,
  });
}

function live2dEntries() {
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4wAAAABJRU5ErkJggg==',
    'base64',
  );
  return [
    {
      name: 'model/model.model3.json',
      data: JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'model.moc3',
          Textures: ['textures/texture.png'],
        },
      }),
    },
    { name: 'model/model.moc3', data: 'MOC3test' },
    { name: 'model/textures/texture.png', data: pixel },
  ];
}

test('archive paths reject Windows, traversal, ADS, control, and ambiguous names', () => {
  for (const value of [
    '../evil', 'a/../evil', 'C:/evil', '//server/share', 'a\\evil',
    'CON/file.png', 'folder/name:stream', 'folder/trailing. ', 'a/\u0001b',
  ]) {
    assert.throws(() => canonicalArchivePath(value), /path|segment/i, value);
  }
  assert.equal(canonicalArchivePath('角色/模型.model3.json'), '角色/模型.model3.json');
});

test('valid Live2D ZIP verifies references and extracts only regular allowlisted files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-test-'));
  const result = validateLive2DPackage(makeZip(live2dEntries()), root);
  assert.equal(result.entryRelative, 'model/model.model3.json');
  assert.equal(result.files.length, 3);
  assert.equal(fs.readFileSync(path.join(root, 'model', 'model.moc3'), 'utf8'), 'MOC3test');
});

test('Live2D import safely discovers unreferenced expression and motion files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-test-'));
  const entries = [
    ...live2dEntries(),
    {
      name: 'model/开心.exp3.json',
      data: JSON.stringify({ Type: 'Live2D Expression', Parameters: [] }),
    },
    {
      name: 'model/wave.motion3.json',
      data: JSON.stringify({
        Version: 3,
        Meta: { Duration: 1.5 },
        Curves: [],
      }),
    },
  ];
  const result = validateLive2DPackage(makeZip(entries), root);
  assert.deepEqual(result.stats.detected.expressions, ['开心']);
  assert.deepEqual(result.stats.detected.animationClips, ['wave']);
  const model = JSON.parse(
    fs.readFileSync(path.join(root, 'model', 'model.model3.json'), 'utf8'),
  );
  assert.equal(model.FileReferences.Expressions[0].File, '开心.exp3.json');
  assert.equal(model.FileReferences.Motions.wave[0].File, 'wave.motion3.json');
});

test('ZIP parser rejects traversal, case collisions, encryption, symlinks, and CRC lies', () => {
  assert.throws(() => parseZip(makeZip([{ name: '../evil.json', data: '{}' }])), /path/i);
  assert.throws(
    () => parseZip(makeZip([{ name: 'A.json', data: '{}' }, { name: 'a.json', data: '{}' }])),
    /conflicting|duplicate/i,
  );
  assert.throws(() => parseZip(makeZip([{ name: 'a.json', data: '{}', flags: 1 }])), /Encrypted/i);
  assert.throws(
    () => parseZip(makeZip([{
      name: 'link.json',
      data: 'target',
      externalAttributes: (0xa1ff << 16) >>> 0,
    }])),
    /Symbolic/i,
  );
  const crcLie = makeZip([{ name: 'a.json', data: '{}', crc: 123 }]);
  const parsed = parseZip(crcLie);
  assert.throws(
    () => require('./avatar-manager.cjs').inflateZipEntry(crcLie, parsed.entries[0]),
    /CRC/i,
  );
});

test('Live2D package rejects missing and escaping references and executable extras', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-test-'));
  const missing = live2dEntries();
  missing.pop();
  assert.throws(() => validateLive2DPackage(makeZip(missing), root), /missing/i);
  assert.throws(
    () => parseZip(makeZip([...live2dEntries(), { name: 'model/payload.js', data: 'x' }])),
    /Unsupported file type/i,
  );
  const escaping = live2dEntries();
  escaping[0].data = JSON.stringify({
    Version: 3,
    FileReferences: { Moc: '../model.moc3', Textures: [] },
  });
  assert.throws(
    () => validateLive2DPackage(
      makeZip(escaping),
      fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-test-')),
    ),
    /reference|path segment/i,
  );
});

test('GLB verifier rejects malformed headers, external URIs, and excessive geometry', () => {
  assert.throws(() => validateGlb(Buffer.from('not glb')), /GLB/i);
  assert.throws(
    () => validateGlb(minimalGlb({ buffers: [{ byteLength: 8, uri: 'https://evil.invalid/a.bin' }] })),
    /external/i,
  );
  assert.throws(
    () => validateGlb(minimalGlb({
      accessors: [{ count: 3_000_003, componentType: 5125, type: 'SCALAR' }],
      meshes: [{ primitives: [{ indices: 0 }] }],
    })),
    /triangle/i,
  );
  assert.equal(validateGlb(minimalGlb()).triangles, 0);
});

test('AvatarManager keeps paths opaque, requires rights, and protects the active record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-manager-'));
  const source = path.join(root, 'chosen.vrm');
  fs.writeFileSync(source, minimalGlb());
  const manager = new AvatarManager({
    storageDir: path.join(root, 'avatars'),
    live2dRuntime: { available: false, licenseAccepted: false },
  });
  const candidate = manager.beginImport(source);
  assert.match(candidate.importId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(candidate.preview.url, /^reverie-avatar:\/\/preview\//);
  assert.equal(JSON.stringify(candidate).includes(source), false);
  assert.throws(() => manager.commitImport({ importId: candidate.importId }), /right/i);
  assert.throws(
    () => manager.commitImport({ importId: candidate.importId, rightsConfirmed: true }),
    /preview/i,
  );
  manager.markPreviewReady(candidate.importId, {
    detected: { animationClips: [], expressions: [] },
    capabilities: {},
  });
  const record = manager.commitImport({
    importId: candidate.importId,
    rightsConfirmed: true,
    warningAccepted: true,
  });
  assert.match(record.entryUrl, /^reverie-avatar:\/\/asset\//);
  assert.equal(record.capabilities.renderReady, true);
  assert.equal(record.capabilities.vrmaPlayback, true);
  assert.equal(record.entryUrl.includes(root), false);
  assert.throws(
    () => manager.openPreviewAsset(candidate.importId, 'avatar.vrm'),
    /candidate|ENOENT/i,
  );
  assert.equal(manager.list().activeId, null);
  manager.setActive(record.id);
  assert.throws(() => manager.remove(record.id), /active/i);
  manager.setActive(null);
  assert.deepEqual(manager.remove(record.id), { removed: true });
});

test('avatar protocol parser rejects encoded separators and non-asset authorities', () => {
  assert.deepEqual(
    parseAssetUrl('reverie-avatar://asset/123/model/avatar.vrm'),
    { id: '123', encodedRelative: 'model/avatar.vrm' },
  );
  assert.throws(() => parseAssetUrl('reverie-avatar://asset/123/a%2Fb.vrm'), /separator/i);
  assert.throws(() => parseAssetUrl('reverie-avatar://evil/123/a.vrm'), /Invalid/i);
  assert.deepEqual(
    parseAvatarUrl('reverie-avatar://preview/abcdefghijklmnopqrstuvwxyzABCDEF/avatar.vrm'),
    {
      type: 'preview',
      id: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      encodedRelative: 'avatar.vrm',
    },
  );
});

test('Live2D folder import enforces the same closed-world package rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-folder-'));
  const source = path.join(root, 'character');
  fs.mkdirSync(path.join(source, 'textures'), { recursive: true });
  fs.writeFileSync(path.join(source, 'avatar.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'avatar.moc3', Textures: ['textures/texture.png'] },
  }));
  fs.writeFileSync(path.join(source, 'avatar.moc3'), 'MOC3folder');
  fs.writeFileSync(
    path.join(source, 'textures', 'texture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const output = path.join(root, 'output');
  fs.mkdirSync(output);
  const validated = validateLive2DDirectory(source, output);
  assert.equal(validated.entryRelative, 'avatar.model3.json');

  fs.writeFileSync(path.join(source, 'run.js'), 'alert(1)');
  assert.throws(
    () => validateLive2DDirectory(source, fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-out-'))),
    /unsupported/i,
  );
});

test('preview expiry discards staging and never changes the old active avatar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-expiry-'));
  const source = path.join(root, 'avatar.vrm');
  fs.writeFileSync(source, minimalGlb());
  let now = Date.parse('2026-01-01T00:00:00Z');
  const manager = new AvatarManager({
    storageDir: path.join(root, 'avatars'),
    now: () => now,
    previewTtlMs: 60_000,
  });
  const candidate = manager.beginImport(source);
  now += 60_001;
  assert.throws(() => manager.markPreviewReady(candidate.importId), /expired/i);
  assert.equal(manager.list().activeId, null);
  assert.equal(fs.existsSync(path.join(manager.stagingDir, candidate.importId)), false);
});

test('VRMA is validated, attached atomically, mapped by namespace, and advertised as playable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-avatar-vrma-'));
  const source = path.join(root, 'avatar.vrm');
  fs.writeFileSync(source, minimalGlb());
  const manager = new AvatarManager({ storageDir: path.join(root, 'avatars') });
  const candidate = manager.beginImport(source);
  manager.markPreviewReady(candidate.importId);
  const avatar = manager.commitImport({
    importId: candidate.importId,
    rightsConfirmed: true,
    warningAccepted: true,
  });
  const vrmaBytes = minimalGlb({
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0' } },
    nodes: [{}],
    accessors: [
      { count: 1, componentType: 5126, type: 'SCALAR' },
      { count: 1, componentType: 5126, type: 'VEC4' },
    ],
    animations: [{
      name: 'Wave',
      samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
    }],
  });
  assert.equal(validateVrma(vrmaBytes).animationCount, 1);
  const motionPath = path.join(root, 'wave.vrma');
  fs.writeFileSync(motionPath, vrmaBytes);
  const motion = manager.addVrma(avatar.id, motionPath);
  assert.equal(motion.playbackSupported, true);
  assert.equal(manager.list().records[0].capabilities.vrmaPlayback, true);
  manager.setMapping(avatar.id, 'action', 'wave', `vrma:${motion.id}`);
  assert.throws(() => manager.removeMotion(avatar.id, motion.id), /mapping/i);
  manager.setMapping(avatar.id, 'action', 'wave', null);
  assert.deepEqual(manager.removeMotion(avatar.id, motion.id), {
    removed: true,
    motionId: motion.id,
  });
});
