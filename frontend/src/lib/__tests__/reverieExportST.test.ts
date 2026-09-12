import { describe, expect, it } from 'vitest';
import { createDefaultArchive } from '../reverieArchive';
import {
  assertSTv2Shape,
  cardPngExportFilename,
  embedCardIntoPng,
  exportAsSTv2Json,
  exportWorldBookAsST,
} from '../reverieExportST';
import { parseSillyTavernPngPayload } from '../reverieArchive';

function uint32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(uint32be(data.length), 0);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  const crcBytes = chunk.slice(4, 8 + data.length);
  for (const byte of crcBytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  chunk.set(uint32be((crc ^ 0xffffffff) >>> 0), 8 + data.length);
  return chunk;
}

function makeBasePng(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 最小合法 PNG：IHDR(1x1 RGB) + IDAT + IEND
  const ihdr = new Uint8Array(13);
  ihdr.set(uint32be(1), 0);
  ihdr.set(uint32be(1), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]);
  const parts = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND')];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('reverieExportST', () => {
  it('maps a Reverie card to the V2 spec shape with all required fields', () => {
    const card = createDefaultArchive().characters[0];
    const exported = exportAsSTv2Json(card);

    expect(exported.spec).toBe('chara_card_v2');
    expect(exported.spec_version).toBe('2.0');
    expect(exported.data.name).toBe(card.name);
    expect(exported.data.first_mes).toBe(card.firstMessage);
    expect(exported.data.alternate_greetings).toEqual([]);
    expect(exported.data.character_book).toBeNull();
    expect(() => assertSTv2Shape(exported)).not.toThrow();
  });

  it('embeds a world book as character_book when present', () => {
    const archive = createDefaultArchive();
    const card = archive.characters[0];
    const worldBook = archive.worldBooks[0];
    const exported = exportAsSTv2Json(card, worldBook);

    expect(exported.data.character_book).not.toBeNull();
    expect(exported.data.character_book?.entries.length).toBeGreaterThan(0);
    const first = exported.data.character_book?.entries[0];
    expect(first?.keys).toEqual(worldBook.entries[0].keywords);
    expect(first?.constant).toBe(true);
    expect(first?.position).toBe('before_char');
  });

  it('exports an empty world book as null character_book', () => {
    const card = createDefaultArchive().characters[0];
    const emptyBook = {
      ...createDefaultArchive().worldBooks[0],
      entries: [],
    };
    const exported = exportAsSTv2Json(card, emptyBook);
    expect(exported.data.character_book).toBeNull();
  });

  it('round-trips special characters through base64 PNG embedding', () => {
    const archive = createDefaultArchive();
    const card = exportAsSTv2Json(
      archive.characters[0],
      archive.worldBooks[0],
    );
    card.data.description = '包含 emoji 🐱、中文换行\n和 {{char}} 宏';
    card.data.alternate_greetings = ['你好，世界。', '再次问候'] ;

    const png = embedCardIntoPng(makeBasePng(), card);
    const parsed = parseSillyTavernPngPayload(png.buffer as ArrayBuffer);

    expect(parsed).toMatchObject({
      spec: 'chara_card_v2',
      data: {
        name: '星野幻月',
        description: '包含 emoji 🐱、中文换行\n和 {{char}} 宏',
      },
    });
  });

  it('replaces an existing chara chunk instead of duplicating it', () => {
    const archive = createDefaultArchive();
    const card = exportAsSTv2Json(archive.characters[0]);
    const once = embedCardIntoPng(makeBasePng(), card);
    const twice = embedCardIntoPng(once, card);

    const first = parseSillyTavernPngPayload(once.buffer as ArrayBuffer);
    const second = parseSillyTavernPngPayload(twice.buffer as ArrayBuffer);
    expect(first).toMatchObject({ spec: 'chara_card_v2' });
    expect(second).toMatchObject({ spec: 'chara_card_v2' });

    // 每次写入一对 chara+ccv3，再导出时替换而不是叠加。
    const textCount = countChunks(twice, 'tEXt');
    expect(textCount).toBe(2);
  });

  it('writes both chara and ccv3 tEXt chunks', () => {
    const archive = createDefaultArchive();
    const card = exportAsSTv2Json(archive.characters[0]);
    const png = embedCardIntoPng(makeBasePng(), card);
    expect(countChunks(png, 'tEXt')).toBe(2);
    expect(parseSillyTavernPngPayload(png.buffer as ArrayBuffer)).toMatchObject({
      spec: 'chara_card_v2',
    });
  });

  it('rejects a non-PNG base image', () => {
    const card = exportAsSTv2Json(createDefaultArchive().characters[0]);
    expect(() => embedCardIntoPng(new Uint8Array([1, 2, 3]), card)).toThrow(/PNG/);
  });

  it('builds safe export filenames', () => {
    expect(cardPngExportFilename('星野/幻月:测试')).toBe('星野_幻月_测试.png');
    expect(cardPngExportFilename('a'.repeat(200)).length).toBeLessThanOrEqual(90);
  });

  it('maps world book entries to V2 fields losslessly', () => {
    const archive = createDefaultArchive();
    const worldBook = archive.worldBooks[0];
    const st = exportWorldBookAsST(worldBook);

    expect(st.scan_depth).toBe(50);
    expect(st.token_budget).toBe(500);
    expect(st.recursive_scanning).toBe(false);
    expect(st.entries.length).toBe(worldBook.entries.length);
    const first = st.entries[0];
    expect(first.keys).toEqual(worldBook.entries[0].keywords);
    expect(first.secondary_keys).toEqual([]);
    expect(first.enabled).toBe(true);
  });
});

function countChunks(png: Uint8Array, type: string): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let count = 0;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const chunkType = String.fromCharCode(
      png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7],
    );
    if (chunkType === 'IEND') break;
    if (chunkType === type) count += 1;
    offset += 12 + length;
  }
  return count;
}
