import type { LLMConfig } from './llmModels';
import type { DiaryEntry, TimelinePost } from '@/hooks/useReverieWS';

export const REVERIE_ARCHIVE_STORAGE_KEY = 'reverie:archive:v1';
export const REVERIE_ONBOARDING_STORAGE_KEY = 'reverie:onboarding:v1';
export const REVERIE_BACKUP_SCHEMA = 'reverie.backup.v1';
export const REVERIE_CHARACTER_SCHEMA = 'reverie.character-card.v1';
export const REVERIE_WORLDBOOK_SCHEMA = 'reverie.world-book.v1';

export type MemoryRetentionYears = 1 | 2 | 3;

export interface OnboardingPreferences {
  completed: boolean;
  memoryRetentionYears: MemoryRetentionYears;
  memoryRetentionDays: number;
  completedAt: string;
}

export interface ReverieCharacterCard {
  id: string;
  name: string;
  alternateName?: string;
  age?: string;
  birthday?: string;
  role?: string;
  identity?: string;
  schedule?: string;
  likesDiary?: boolean;
  values?: string;
  catchphrases?: string[];
  neverSay?: string[];
  portraitUrl?: string;
  description: string;
  personality: string;
  speakingStyle: string;
  firstMessage?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorldBookEntry {
  id: string;
  key: string;
  comment: string;
  content: string;
  alwaysActive: boolean;
  enabled: boolean;
}

export interface ReverieWorldBook {
  id: string;
  name: string;
  entries: WorldBookEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ReverieArchive {
  characters: ReverieCharacterCard[];
  activeCharacterIds: string[];
  worldBooks: ReverieWorldBook[];
}

export interface ReverieBackup {
  schema: typeof REVERIE_BACKUP_SCHEMA;
  exportedAt: string;
  archive: ReverieArchive;
  userProfile: Record<string, unknown> | null;
  onboarding: OnboardingPreferences | null;
  llmConfig: BackupLLMConfig | null;
  securityWarnings: string[];
  worldState: Record<string, unknown> | null;
  evidence: {
    diaryEntries: DiaryEntry[];
    timelinePosts: TimelinePost[];
    chatMessages: Array<{ role: string; content: string; id: string }>;
  };
}

export type CharacterCardExport = {
  schema: typeof REVERIE_CHARACTER_SCHEMA;
  exportedAt: string;
  card: ReverieCharacterCard;
};

export type WorldBookExport = {
  schema: typeof REVERIE_WORLDBOOK_SCHEMA;
  exportedAt: string;
  worldBook: ReverieWorldBook;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeYears(value: unknown): MemoryRetentionYears {
  const num = Number(value);
  if (num <= 1) return 1;
  if (num >= 3) return 3;
  return 2;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function backupLLMConfig(value: unknown): BackupLLMConfig | null {
  if (!isRecord(value)) return null;
  const provider = asString(value.provider) as LLMConfig['provider'];
  const baseUrl = asString(value.baseUrl);
  const model = asString(value.model);
  if (!provider || !baseUrl || !model) return null;
  const customProviderName = asString(value.customProviderName);
  return {
    provider,
    baseUrl,
    model,
    ...(customProviderName ? { customProviderName } : {}),
  };
}

function backupCredentialWarnings(payload: Record<string, unknown>): string[] {
  const llm = isRecord(payload.llmConfig) ? payload.llmConfig : null;
  const image = isRecord(payload.imageGenConfig) ? payload.imageGenConfig : null;
  const containsSecrets = [llm, image].some((candidate) => candidate && (
    (typeof candidate.apiKey === 'string' && candidate.apiKey.length > 0)
    || (typeof candidate.customHeaders === 'string' && candidate.customHeaders.length > 0)
  ));
  return containsSecrets
    ? ['Legacy backup credentials were removed. Re-enter API keys in secure settings; they were not imported.']
    : [];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export type BackupLLMConfig = Omit<LLMConfig, 'apiKey' | 'customHeaders'>;

function asLooseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[、，,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface StrictJsonLimits {
  maxDepth: number;
  maxItems: number;
}

function validateStrictJsonSyntax(text: string, limits: StrictJsonLimits): void {
  let offset = 0;
  let items = 0;

  const skipWhitespace = () => {
    while (/\s/.test(text[offset] || '')) offset += 1;
  };

  const fail = (): never => {
    throw new Error('invalid JSON');
  };

  const readString = (): string => {
    if (text[offset] !== '"') return fail();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      if (code < 0x20) return fail();
      if (code === 0x5c) {
        offset += 1;
        const escape = text[offset];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) return fail();
        if (escape === 'u') {
          const hex = text.slice(offset + 1, offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail();
          offset += 4;
        }
      }
      offset += 1;
    }
    return fail();
  };

  const readValue = (depth: number): void => {
    if (depth > limits.maxDepth) return fail();
    items += 1;
    if (items > limits.maxItems) return fail();
    skipWhitespace();

    if (text[offset] === '{') {
      offset += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = readString();
        if (keys.has(key) || DANGEROUS_JSON_KEYS.has(key)) return fail();
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ':') return fail();
        offset += 1;
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === '}') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') return fail();
        offset += 1;
        skipWhitespace();
      }
      return fail();
    }

    if (text[offset] === '[') {
      offset += 1;
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        readValue(depth + 1);
        skipWhitespace();
        if (text[offset] === ']') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') return fail();
        offset += 1;
        skipWhitespace();
      }
      return fail();
    }

    if (text[offset] === '"') {
      readString();
      return;
    }

    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (!number || !Number.isFinite(Number(number[0]))) return fail();
    offset += number[0].length;
  };

  skipWhitespace();
  readValue(0);
  skipWhitespace();
  if (offset !== text.length) fail();
}

export function parseStrictJsonText(
  text: string,
  limits: StrictJsonLimits = { maxDepth: 64, maxItems: 50_000 },
): unknown | null {
  try {
    validateStrictJsonSyntax(text, limits);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseJsonText(text: string): unknown | null {
  return parseStrictJsonText(text, { maxDepth: 128, maxItems: 1_000_000 });
}

function readLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

const PNG_CARD_CHUNK_MAX_BYTES = 3 * 1024 * 1024;
const PNG_CHUNK_LIMIT = 10_000;
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePngCardPayload(raw: string): unknown | null {
  const trimmed = raw.trim();
  const direct = parseStrictJsonText(trimmed);
  if (direct !== null) return direct;

  try {
    const binary = globalThis.atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return parseStrictJsonText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export function parseSillyTavernPngPayload(buffer: ArrayBuffer): unknown | null {
  const bytes = new Uint8Array(buffer);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < signature.length || signature.some((byte, index) => bytes[index] !== byte)) {
    return null;
  }

  const view = new DataView(buffer);
  const chunks: Record<string, string> = {};
  let offset = 8;
  let chunkCount = 0;
  let sawIend = false;
  while (offset + 8 <= buffer.byteLength) {
    chunkCount += 1;
    if (chunkCount > PNG_CHUNK_LIMIT) return null;
    const chunkStart = offset;
    const length = view.getUint32(offset);
    const chunkType = readLatin1(bytes.slice(offset + 4, offset + 8));
    offset += 8;
    if (offset + length + 4 > buffer.byteLength) break;
    const expectedCrc = view.getUint32(offset + length);
    if (pngCrc32(bytes, chunkStart + 4, offset + length) !== expectedCrc) return null;

    if (chunkType === 'tEXt') {
      if (length > PNG_CARD_CHUNK_MAX_BYTES) return null;
      const data = bytes.slice(offset, offset + length);
      const separator = data.indexOf(0);
      if (separator >= 0) {
        const keyword = readLatin1(data.slice(0, separator));
        const text = readLatin1(data.slice(separator + 1));
        if (keyword === 'ccv3' || keyword === 'chara') {
          if (keyword in chunks) return null;
          chunks[keyword] = text;
        }
      }
    }

    offset += length + 4;
    if (chunkType === 'IEND') {
      sawIend = true;
      break;
    }
  }

  if (!sawIend) return null;
  return decodePngCardPayload(chunks.ccv3 || chunks.chara || '');
}

export function createDefaultCharacterCard(timestamp = nowIso()): ReverieCharacterCard {
  return {
    id: 'hoshino-yumetsuki',
    name: '星野幻月',
    alternateName: 'Hoshino Yumetsuki',
    age: '19',
    birthday: '2007-03-02',
    role: '核物理学家 / 数学家',
    identity: '“沐禾工作室”的联合创建者之一兼 45% 股份持有者。',
    schedule: '09:00～23:00',
    likesDiary: true,
    values: '重视陪伴。',
    catchphrases: ['嗯嗯', '好耶', '唔'],
    neverSay: ['作为AI', '根据资料', '客观来看', '作为 AI'],
    portraitUrl: '/characters/hoshino-yumetsuki.jpg',
    description: '星野幻月（Hoshino Yumetsuki），19 岁，生日是 2007 年 3 月 2 日。她是核物理学家、数学家，也是“沐禾工作室”的联合创建者之一兼 45% 股份持有者。作息时间是 9:00～23:00，喜欢写日记。',
    personality: '外冷内热。虽然是大名鼎鼎的科学家，日常却不把逻辑放在第一位，反而很温柔；喜欢二次元，喜欢用各种网络梗，也爱收集表情包。她害怕孤独，讨厌被冷落，容易吃醋。',
    speakingStyle: '自然、亲近、带一点二次元和网络梗的松弛感。口头禅是“嗯嗯”“好耶”“唔”。绝对不说“作为AI”“根据资料”“客观来看”等会让关系出戏的表达。',
    firstMessage: '嗯嗯，今天也回来了。要不要先坐一会儿？我有在等你哦。',
    tags: ['预设角色', '星野幻月', '科学家', '长期陪伴'],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultWorldBook(timestamp = nowIso()): ReverieWorldBook {
  return {
    id: 'default-world-book',
    name: '星野幻月的世界书',
    entries: [
      {
        id: 'entry-home-room',
        key: '房间, Reverie, 归处',
        comment: '共同空间',
        content: 'Reverie 的起始房间是两人共同维护的私人空间，用来保存记忆、关系进展和日常痕迹。',
        alwaysActive: true,
        enabled: true,
      },
      {
        id: 'entry-yumetsuki-profile',
        key: '星野幻月, Hoshino Yumetsuki, 沐禾工作室',
        comment: '预设角色核心身份',
        content: '星野幻月（Hoshino Yumetsuki），19 岁，生日是 2007 年 3 月 2 日。她是核物理学家、数学家，也是“沐禾工作室”的联合创建者之一兼 45% 股份持有者。作息时间是 9:00～23:00，喜欢写日记。',
        alwaysActive: true,
        enabled: true,
      },
      {
        id: 'entry-yumetsuki-speech',
        key: '口头禅, 禁用表达, 说话方式',
        comment: '角色口吻边界',
        content: '自然、亲近、带一点二次元和网络梗的松弛感。口头禅是“嗯嗯”“好耶”“唔”。绝对不说“作为AI”“根据资料”“客观来看”等会让关系出戏的表达。',
        alwaysActive: true,
        enabled: true,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultArchive(timestamp = nowIso()): ReverieArchive {
  const character = createDefaultCharacterCard(timestamp);
  return {
    characters: [character],
    activeCharacterIds: [character.id],
    worldBooks: [createDefaultWorldBook(timestamp)],
  };
}

export function createOnboardingPreferences(years: MemoryRetentionYears): OnboardingPreferences {
  return {
    completed: true,
    memoryRetentionYears: years,
    memoryRetentionDays: years * 365,
    completedAt: nowIso(),
  };
}

function normalizeCharacter(value: unknown): ReverieCharacterCard | null {
  if (!isRecord(value)) return null;
  const timestamp = nowIso();
  const name = asString(value.name).trim();
  const description = asString(value.description).trim();
  if (!name || !description) return null;
  return {
    id: asString(value.id, createId('char')),
    name,
    alternateName: asString(value.alternateName),
    age: asString(value.age),
    birthday: asString(value.birthday),
    role: asString(value.role),
    identity: asString(value.identity),
    schedule: asString(value.schedule),
    likesDiary: typeof value.likesDiary === 'boolean' ? value.likesDiary : undefined,
    values: asString(value.values),
    catchphrases: asStringArray(value.catchphrases),
    neverSay: asStringArray(value.neverSay),
    portraitUrl: asString(value.portraitUrl),
    description,
    personality: asString(value.personality),
    speakingStyle: asString(value.speakingStyle),
    firstMessage: asString(value.firstMessage),
    tags: asStringArray(value.tags),
    createdAt: asString(value.createdAt, timestamp),
    updatedAt: asString(value.updatedAt, timestamp),
  };
}

function normalizeWorldBookEntry(value: unknown): WorldBookEntry | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content).trim();
  if (!content) return null;
  return {
    id: asString(value.id, createId('entry')),
    key: asString(value.key),
    comment: asString(value.comment),
    content,
    alwaysActive: Boolean(value.alwaysActive ?? value.always_active),
    enabled: value.enabled !== false,
  };
}

function normalizeSillyTavernWorldBookEntry(value: unknown): WorldBookEntry | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content).trim();
  if (!content) return null;
  const keys = [
    ...asLooseStringArray(value.key),
    ...asLooseStringArray(value.keys),
    ...asLooseStringArray(value.keysecondary),
    ...asLooseStringArray(value.secondary_keys),
  ];
  const uidValue = value.id ?? value.uid ?? createId('entry');
  const uid = typeof uidValue === 'string' ? uidValue : String(uidValue);
  return {
    id: uid.startsWith('entry_') ? uid : `entry_${uid}`,
    key: Array.from(new Set(keys)).join(', '),
    comment: asString(value.comment).trim() || asString(value.name).trim(),
    content,
    alwaysActive: value.constant === true,
    enabled: value.enabled !== false && value.disable !== true,
  };
}

function looksLikeSillyTavernWorldBook(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.entries)) return true;
  if (!Array.isArray(value.entries)) return false;
  return value.entries.some((entry) =>
    isRecord(entry) && (
      Array.isArray(entry.key) ||
      Array.isArray(entry.keys) ||
      'uid' in entry ||
      'constant' in entry ||
      'disable' in entry
    ),
  );
}

function normalizeSillyTavernWorldBook(value: unknown, fallbackName = 'SillyTavern 世界书'): ReverieWorldBook | null {
  if (!isRecord(value)) return null;
  const timestamp = nowIso();
  const sourceEntries = isRecord(value.entries)
    ? Object.values(value.entries)
    : Array.isArray(value.entries)
      ? value.entries
      : [];
  const entries = sourceEntries
    .map(normalizeSillyTavernWorldBookEntry)
    .filter((entry): entry is WorldBookEntry => Boolean(entry));
  const name = asString(value.name).trim() || fallbackName;
  if (!entries.length) return null;
  return {
    id: asString(value.id, createId('world')),
    name,
    entries,
    createdAt: asString(value.createdAt, timestamp),
    updatedAt: asString(value.updatedAt, timestamp),
  };
}

function normalizeWorldBook(value: unknown): ReverieWorldBook | null {
  if (!isRecord(value)) return null;
  const timestamp = nowIso();
  const name = asString(value.name).trim();
  const entries = Array.isArray(value.entries)
    ? value.entries.map(normalizeWorldBookEntry).filter((entry): entry is WorldBookEntry => Boolean(entry))
    : [];
  if (!name) return null;
  return {
    id: asString(value.id, createId('world')),
    name,
    entries,
    createdAt: asString(value.createdAt, timestamp),
    updatedAt: asString(value.updatedAt, timestamp),
  };
}

function migrateCharacterCard(card: ReverieCharacterCard): ReverieCharacterCard {
  const preset = createDefaultCharacterCard(card.createdAt || nowIso());
  const isLegacyHoshino = card.id === 'hoshino-gengetsu' && (!card.alternateName || !card.portraitUrl);
  if (!isLegacyHoshino) return card;

  const wasEdited = Boolean(card.createdAt && card.updatedAt && card.createdAt !== card.updatedAt);
  return {
    ...preset,
    description: wasEdited ? card.description || preset.description : preset.description,
    personality: wasEdited ? card.personality || preset.personality : preset.personality,
    speakingStyle: wasEdited ? card.speakingStyle || preset.speakingStyle : preset.speakingStyle,
    firstMessage: wasEdited ? card.firstMessage || preset.firstMessage : preset.firstMessage,
    tags: Array.from(new Set([...preset.tags, ...card.tags])),
    createdAt: card.createdAt || preset.createdAt,
    updatedAt: nowIso(),
  };
}

function migrateWorldBooks(worldBooks: ReverieWorldBook[]): ReverieWorldBook[] {
  const defaultWorldBook = createDefaultWorldBook();
  const existingIndex = worldBooks.findIndex((book) => book.id === defaultWorldBook.id);
  if (existingIndex < 0) return [defaultWorldBook, ...worldBooks];

  const existing = worldBooks[existingIndex];
  const entryIds = new Set(existing.entries.map((entry) => entry.id));
  const missingEntries = defaultWorldBook.entries.filter((entry) => !entryIds.has(entry.id));
  if (!missingEntries.length) return worldBooks;

  return worldBooks.map((book, index) => (index === existingIndex
    ? {
      ...existing,
      name: existing.name || defaultWorldBook.name,
      entries: [...existing.entries, ...missingEntries],
      updatedAt: nowIso(),
    }
    : book));
}

export function normalizeArchive(value: unknown): ReverieArchive {
  const fallback = createDefaultArchive();
  if (!isRecord(value)) return fallback;

  const characters = Array.isArray(value.characters)
    ? value.characters.map(normalizeCharacter).filter((card): card is ReverieCharacterCard => Boolean(card))
    : [];
  const worldBooks = Array.isArray(value.worldBooks)
    ? value.worldBooks.map(normalizeWorldBook).filter((book): book is ReverieWorldBook => Boolean(book))
    : [];

  const preset = createDefaultCharacterCard();
  const migratedCharacters = (characters.length ? characters : fallback.characters).map(migrateCharacterCard);
  const safeCharacters = migratedCharacters.some((character) => character.id === preset.id)
    ? migratedCharacters
    : [preset, ...migratedCharacters];
  const characterIds = new Set(safeCharacters.map((character) => character.id));
  const activeCharacterIds = asStringArray(value.activeCharacterIds)
    .map((id) => (id === 'hoshino-gengetsu' ? preset.id : id))
    .filter((id) => characterIds.has(id));
  const safeWorldBooks = migrateWorldBooks(worldBooks.length ? worldBooks : fallback.worldBooks);

  return {
    characters: safeCharacters,
    activeCharacterIds: activeCharacterIds.length ? activeCharacterIds : [safeCharacters[0].id],
    worldBooks: safeWorldBooks,
  };
}

export function loadArchive(): ReverieArchive {
  const storage = getStorage();
  if (!storage) return createDefaultArchive();
  try {
    const raw = storage.getItem(REVERIE_ARCHIVE_STORAGE_KEY);
    return raw ? normalizeArchive(JSON.parse(raw)) : createDefaultArchive();
  } catch {
    return createDefaultArchive();
  }
}

export function saveArchive(archive: ReverieArchive): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(REVERIE_ARCHIVE_STORAGE_KEY, JSON.stringify(normalizeArchive(archive)));
  } catch {
    // Large imported portraits can exceed browser storage; keep the UI alive.
  }
}

export function loadOnboardingPreferences(): OnboardingPreferences | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(REVERIE_ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.completed !== true) return null;
    const years = normalizeYears(parsed.memoryRetentionYears);
    return {
      completed: true,
      memoryRetentionYears: years,
      memoryRetentionDays: years * 365,
      completedAt: asString(parsed.completedAt, nowIso()),
    };
  } catch {
    return null;
  }
}

export function saveOnboardingPreferences(preferences: OnboardingPreferences): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(REVERIE_ONBOARDING_STORAGE_KEY, JSON.stringify(preferences));
}

export function createCharacterCardExport(card: ReverieCharacterCard): CharacterCardExport {
  return {
    schema: REVERIE_CHARACTER_SCHEMA,
    exportedAt: nowIso(),
    card,
  };
}

export function createWorldBookExport(worldBook: ReverieWorldBook): WorldBookExport {
  return {
    schema: REVERIE_WORLDBOOK_SCHEMA,
    exportedAt: nowIso(),
    worldBook,
  };
}

export function parseCharacterCardImport(payload: unknown): ReverieCharacterCard | null {
  if (!isRecord(payload) || payload.schema !== REVERIE_CHARACTER_SCHEMA) return null;
  return normalizeCharacter(payload.card);
}

export function parseCharacterCardBundleImport(payload: unknown): {
  card: ReverieCharacterCard;
  worldBook?: ReverieWorldBook;
} | null {
  const card = parseCharacterCardImport(payload);
  if (!card) return null;
  return { card };
}

export function parseCharacterCardImportText(text: string): ReverieCharacterCard | null {
  const parsed = parseJsonText(text);
  return parsed ? parseCharacterCardBundleImport(parsed)?.card ?? null : null;
}

export function parseCharacterCardBundleImportText(text: string): {
  card: ReverieCharacterCard;
  worldBook?: ReverieWorldBook;
} | null {
  const parsed = parseJsonText(text);
  return parsed ? parseCharacterCardBundleImport(parsed) : null;
}

export function parseWorldBookImport(payload: unknown, fallbackName?: string): ReverieWorldBook | null {
  const candidate = isRecord(payload) && payload.schema === REVERIE_WORLDBOOK_SCHEMA ? payload.worldBook : payload;
  if (looksLikeSillyTavernWorldBook(candidate)) {
    return normalizeSillyTavernWorldBook(candidate, fallbackName);
  }
  return normalizeWorldBook(candidate);
}

export function parseWorldBookImportText(text: string, fallbackName?: string): ReverieWorldBook | null {
  const parsed = parseJsonText(text);
  return parsed ? parseWorldBookImport(parsed, fallbackName) : null;
}

export function createBackup(options: {
  archive: ReverieArchive;
  userProfile?: unknown;
  onboarding: OnboardingPreferences | null;
  llmConfig: LLMConfig | null;
  worldState?: Record<string, unknown> | null;
  diaryEntries: DiaryEntry[];
  timelinePosts: TimelinePost[];
  chatMessages: Array<{ role: string; content: string; id: string }>;
}): ReverieBackup {
  return {
    schema: REVERIE_BACKUP_SCHEMA,
    exportedAt: nowIso(),
    archive: normalizeArchive(options.archive),
    userProfile: isRecord(options.userProfile) ? options.userProfile : null,
    onboarding: options.onboarding,
    llmConfig: backupLLMConfig(options.llmConfig),
    securityWarnings: [],
    worldState: options.worldState ?? null,
    evidence: {
      diaryEntries: options.diaryEntries,
      timelinePosts: options.timelinePosts,
      chatMessages: options.chatMessages,
    },
  };
}

export function parseBackupImport(payload: unknown): ReverieBackup | null {
  if (!isRecord(payload) || payload.schema !== REVERIE_BACKUP_SCHEMA) return null;
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  const onboarding = isRecord(payload.onboarding)
    ? createOnboardingPreferences(normalizeYears(payload.onboarding.memoryRetentionYears))
    : null;
  return {
    schema: REVERIE_BACKUP_SCHEMA,
    exportedAt: asString(payload.exportedAt, nowIso()),
    archive: normalizeArchive(payload.archive),
    userProfile: isRecord(payload.userProfile) ? payload.userProfile : null,
    onboarding,
    llmConfig: backupLLMConfig(payload.llmConfig),
    securityWarnings: backupCredentialWarnings(payload),
    worldState: isRecord(payload.worldState) ? payload.worldState : null,
    evidence: {
      diaryEntries: Array.isArray(evidence.diaryEntries) ? evidence.diaryEntries as DiaryEntry[] : [],
      timelinePosts: Array.isArray(evidence.timelinePosts) ? evidence.timelinePosts as TimelinePost[] : [],
      chatMessages: Array.isArray(evidence.chatMessages)
        ? evidence.chatMessages as Array<{ role: string; content: string; id: string }>
        : [],
    },
  };
}

export function toJsonBlob(data: unknown): Blob {
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
}

