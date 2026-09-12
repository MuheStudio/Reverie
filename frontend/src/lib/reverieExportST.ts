/**
 * Clean-room SillyTavern V2 export for Reverie character cards and world books.
 *
 * Field names follow the public Character Card V2 specification
 * (https://github.com/malfoyslastname/character-card-spec-v2), not SillyTavern
 * source code. PNG tEXt embedding follows the W3C PNG specification
 * (ISO/IEC 15948): the JSON payload is base64-encoded and stored in tEXt
 * chunks whose keywords are `chara` (V2) and `ccv3` (V3 readers prefer this).
 */
import type { ReverieCharacterCard, ReverieWorldBook, WorldBookEntry } from './reverieArchive';

export interface STV2CharacterBook {
  name: string;
  description: string;
  scan_depth: number;
  token_budget: number;
  recursive_scanning: boolean;
  extensions: Record<string, unknown>;
  entries: STV2CharacterBookEntry[];
}

export interface STV2CharacterBookEntry {
  keys: string[];
  secondary_keys: string[];
  content: string;
  enabled: boolean;
  insertion_order: number;
  position: 'before_char' | 'after_char';
  constant: boolean;
  selective: boolean;
  case_sensitive: boolean;
  priority: number;
  comment: string;
  id: string;
  extensions: Record<string, unknown>;
}

export interface STV2CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book: STV2CharacterBook | null;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
}

export interface STV2Card {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: STV2CardData;
}

const STV2_REQUIRED_FIELDS: ReadonlyArray<keyof STV2CardData> = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version',
  'extensions',
];

function boundedString(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedStringArray(value: string[], maximum: number): string[] {
  return value.slice(0, maximum).map((item) => item.slice(0, 4000));
}

/**
 * Convert a Reverie world book into the V2 CharacterBook shape. Entries with
 * no keywords and no always-active flag are still exported verbatim; the spec
 * keeps all fields optional except content.
 */
export function exportWorldBookAsST(book: ReverieWorldBook): STV2CharacterBook {
  const entries: STV2CharacterBookEntry[] = book.entries.map((entry) => exportWorldBookEntryAsST(entry));
  return {
    name: boundedString(book.name, 500),
    description: '',
    scan_depth: book.scanDepth || 50,
    token_budget: book.tokenBudget || 500,
    recursive_scanning: book.recursiveScanning === true,
    extensions: {},
    entries,
  };
}

export function exportWorldBookEntryAsST(entry: WorldBookEntry): STV2CharacterBookEntry {
  return {
    keys: entry.keywords.slice(0, 100),
    secondary_keys: entry.secondaryKeywords.slice(0, 100),
    content: entry.content,
    enabled: entry.enabled !== false,
    insertion_order: entry.insertionOrder,
    position: entry.position,
    constant: entry.alwaysActive === true,
    // V2 的 selective 是布尔：true 表示需要至少一个辅助关键词命中。
    selective: entry.secondaryKeywords.length > 0,
    case_sensitive: entry.caseSensitive === true,
    priority: entry.priority,
    comment: entry.comment || '',
    id: entry.id,
    extensions: {},
  };
}

/**
 * Map a Reverie character card to the SillyTavern V2 JSON shape. The world
 * book, when present, is embedded as `data.character_book`.
 */
export function exportAsSTv2Json(
  card: ReverieCharacterCard,
  worldBook?: ReverieWorldBook,
): STV2Card {
  const data: STV2CardData = {
    name: boundedString(card.name, 120),
    description: boundedString(card.description || '', 12_000),
    personality: boundedString(card.personality || '', 6_000),
    scenario: boundedString(card.identity || card.role || '', 8_000),
    first_mes: boundedString(card.firstMessage || '', 8_000),
    mes_example: '',
    creator_notes: boundedString(card.values || '', 4_000),
    system_prompt: boundedString(card.importedSystemPrompt || '', 8_000),
    post_history_instructions: boundedString(card.importedPostHistoryInstructions || '', 8_000),
    alternate_greetings: boundedStringArray(card.alternateGreetings || [], 50),
    character_book: worldBook && worldBook.entries.length
      ? exportWorldBookAsST(worldBook)
      : null,
    tags: boundedStringArray(card.tags || [], 100),
    creator: 'Reverie',
    character_version: '1.0',
    extensions: {},
  };
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  };
}

export function assertSTv2Shape(card: STV2Card): void {
  for (const field of STV2_REQUIRED_FIELDS) {
    if (!(field in card.data)) {
      throw new Error(`导出字段缺失：${field}`);
    }
  }
}

// ── PNG tEXt 嵌入（W3C PNG 规格）──────────────────────────

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crc32Table();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function textChunk(keyword: string, payload: string): Uint8Array {
  const keywordBytes = new TextEncoder().encode(keyword);
  const payloadBytes = new TextEncoder().encode(payload);
  const data = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
  data.set(keywordBytes, 0);
  data.set(payloadBytes, keywordBytes.length + 1);
  const lengthBytes = uint32be(data.length);
  const typeBytes = new TextEncoder().encode('tEXt');
  const chunk = new Uint8Array(12 + data.length);
  chunk.set(lengthBytes, 0);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = crc32(chunk, 4, 8 + data.length);
  chunk.set(uint32be(crc), 8 + data.length);
  return chunk;
}

function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function findExistingCardChunks(bytes: Uint8Array): number[] {
  // 返回需要移除的 tEXt 块起始位置（chara / ccv3 关键字）
  const positions: number[] = [];
  let offset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
    );
    if (type === 'IEND') break;
    if (type === 'tEXt' && length >= 5) {
      const dataStart = offset + 8;
      const separator = bytes.indexOf(0, dataStart);
      if (separator >= dataStart && separator < dataStart + length) {
        const keyword = String.fromCharCode(...bytes.slice(dataStart, separator));
        if (keyword === 'chara' || keyword === 'ccv3') positions.push(offset);
      }
    }
    offset += 12 + length;
  }
  return positions;
}

/**
 * Embed the V2 JSON into an existing PNG's tEXt chunks (keyword `chara`),
 * replacing any prior `chara`/`ccv3` chunks. Returns a complete PNG byte
 * array. The source PNG must be a valid PNG whose IHDR chunk is intact.
 */
export function embedCardIntoPng(pngBytes: Uint8Array, card: STV2Card): Uint8Array {
  if (
    pngBytes.length < 8
    || PNG_SIGNATURE.some((byte, index) => pngBytes[index] !== byte)
  ) {
    throw new Error('底图不是有效的 PNG 文件');
  }
  const cardJson = JSON.stringify(card);
  const payload = base64EncodeUtf8(cardJson);
  const charaChunk = textChunk('chara', payload);
  const ccv3Chunk = textChunk('ccv3', payload);

  const removed = findExistingCardChunks(pngBytes);
  const removedSet = new Set(removed);

  const output: Uint8Array[] = [PNG_SIGNATURE];
  let offset = 8;
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let inserted = false;
  while (offset + 8 <= pngBytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      pngBytes[offset + 4], pngBytes[offset + 5], pngBytes[offset + 6], pngBytes[offset + 7],
    );
    const chunkEnd = offset + 12 + length;
    if (type === 'IEND') break;
    if (!removedSet.has(offset)) {
      if (!inserted && type !== 'IHDR') {
        // 首个非 IHDR 块之前插入新的 tEXt（规范允许，社区惯例放在 IDAT 之前）
        output.push(charaChunk, ccv3Chunk);
        inserted = true;
      }
      output.push(pngBytes.slice(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  if (!inserted) output.push(charaChunk, ccv3Chunk);
  output.push(pngBytes.slice(offset));
  const result = new Uint8Array(output.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of output) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

export function cardPngExportFilename(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.png`;
}
