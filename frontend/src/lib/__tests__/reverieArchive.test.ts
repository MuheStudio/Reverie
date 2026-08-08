import { beforeEach, describe, expect, it } from 'vitest';
import {
  REVERIE_BACKUP_SCHEMA,
  REVERIE_CHARACTER_SCHEMA,
  REVERIE_WORLDBOOK_SCHEMA,
  createBackup,
  createCharacterCardExport,
  createDefaultArchive,
  createOnboardingPreferences,
  createWorldBookExport,
  clearLegacyArchiveAfterMigration,
  loadLegacyArchiveForMigration,
  normalizeArchive,
  parseBackupImport,
  parseCharacterCardBundleImport,
  parseCharacterCardBundleImportText,
  parseCharacterCardImport,
  parseCharacterCardImportText,
  parseSillyTavernPngPayload,
  parseStrictJsonText,
  parseWorldBookImport,
  parseWorldBookImportText,
} from '../reverieArchive';

beforeEach(() => {
  localStorage.clear();
});

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

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

function makeSillyTavernPngText(payloadJson: string, keyword = 'chara'): ArrayBuffer {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const keywordBytes = new TextEncoder().encode(keyword);
  const payloadText = utf8Base64(payloadJson);
  const payloadBytes = new TextEncoder().encode(payloadText);
  const textData = new Uint8Array(keywordBytes.length + 1 + payloadBytes.length);
  textData.set(keywordBytes, 0);
  textData.set(payloadBytes, keywordBytes.length + 1);
  const textChunk = pngChunk('tEXt', textData);
  const endChunk = pngChunk('IEND');
  const png = new Uint8Array(signature.length + textChunk.length + endChunk.length);
  png.set(signature, 0);
  png.set(textChunk, signature.length);
  png.set(endChunk, signature.length + textChunk.length);
  return png.buffer;
}

function makeSillyTavernPng(payload: unknown, keyword = 'chara'): ArrayBuffer {
  return makeSillyTavernPngText(JSON.stringify(payload), keyword);
}

describe('reverieArchive', () => {
  it('creates a Chinese default character and keeps multi-character activation', () => {
    const archive = normalizeArchive({
      characters: [
        {
          id: 'a',
          name: '星野幻月',
          description: '主角色',
          personality: '',
          speakingStyle: '',
          tags: [],
        },
        {
          id: 'b',
          name: '辅助角色',
          description: '第二角色',
          personality: '',
          speakingStyle: '',
          tags: [],
        },
      ],
      activeCharacterIds: ['a', 'b', 'missing'],
      worldBooks: [],
    });

    expect(archive.characters.map((card) => card.name)).toContain('星野幻月');
    expect(archive.activeCharacterIds).toEqual(['a', 'b']);
  });

  it('does not treat a malformed retired renderer archive as a fact source', () => {
    localStorage.setItem('reverie:archive:v1', '{not-json');

    expect(loadLegacyArchiveForMigration()).toBeNull();
  });

  it('upgrades legacy Hoshino archives to the Yumetsuki preset', () => {
    const archive = normalizeArchive({
      characters: [
        {
          id: 'hoshino-gengetsu',
          name: '星野幻月',
          description: 'legacy',
          personality: '',
          speakingStyle: '',
          tags: [],
          createdAt: '2026-07-02T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      activeCharacterIds: ['hoshino-gengetsu'],
      worldBooks: [
        {
          id: 'default-world-book',
          name: 'old world',
          entries: [],
          createdAt: '2026-07-02T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
    });

    expect(archive.characters[0].id).toBe('hoshino-yumetsuki');
    expect(archive.characters[0].alternateName).toBe('Hoshino Yumetsuki');
    expect(archive.characters[0].portraitUrl).toBe('/characters/hoshino-yumetsuki.jpg');
    expect(archive.activeCharacterIds).toEqual(['hoshino-yumetsuki']);
    expect(archive.worldBooks[0].entries.some((entry) => entry.id === 'entry-yumetsuki-profile')).toBe(true);
  });

  it('reads and clears the retired archive only for one-way migration', () => {
    const archive = createDefaultArchive();
    localStorage.setItem('reverie:archive:v1', JSON.stringify(archive));

    expect(loadLegacyArchiveForMigration()).toEqual(archive);
    clearLegacyArchiveAfterMigration();
    expect(loadLegacyArchiveForMigration()).toBeNull();
  });

  it('exports and imports character cards and world books as json envelopes', () => {
    const archive = createDefaultArchive();
    const cardEnvelope = createCharacterCardExport(archive.characters[0]);
    const worldEnvelope = createWorldBookExport(archive.worldBooks[0]);

    expect(cardEnvelope.schema).toBe(REVERIE_CHARACTER_SCHEMA);
    expect(worldEnvelope.schema).toBe(REVERIE_WORLDBOOK_SCHEMA);
    const importedCard = parseCharacterCardImport(cardEnvelope);
    expect(importedCard?.name).toBe('星野幻月');
    expect(importedCard?.catchphrases).toEqual(['嗯嗯', '好耶', '唔']);
    expect(importedCard?.neverSay).toContain('作为AI');
    expect(parseWorldBookImport(worldEnvelope)?.entries[0].content).toContain('Reverie');
  });

  it('routes SillyTavern cards away from the renderer-only archive parser', () => {
    const card = parseCharacterCardImport({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '诗怀雅',
        description: '龙门近卫局警司。',
        personality: '骄傲但认真。',
        first_mes: '你来了？',
        avatar: 'https://example.test/swire.png',
        mes_example: '<START>\n{{char}}: 哼。',
        scenario: '罗德岛宿舍。',
        creator_notes: '暂时无家可归。',
        post_history_instructions: '保持角色口吻。',
        tags: ['Arknights', 'Roleplay'],
        creator: 'tester',
        character_version: 'main',
      },
    });

    expect(card).toBeNull();
  });

  it('rejects malformed SillyTavern character json instead of guessing', () => {
    const malformed = `{
      "spec": "chara_card_v2",
      "spec_version": "2.0",
      "data": {
        "name": "家道中落的诗怀雅,
        "description": "富贵猫娘\\n现在暂住罗德岛。",
        "personality": "嘴硬心软。",
        "first_mes": "你怎么来了？",
        "avatar": "https://example.test/card.png",
        "mes_example": "",
        "scenario": "",
        "creator_notes": "她不想让你看到落魄的样子。
        "system_prompt": "",
        "post_history_instructions": "",
        "alternate_greetings": [],
        "tags": ["Arknights", "Female"],
        "creator": "RPKAppreciator",
        "character_version": "main",
        "extensions": {},
        "character_book": null
      }
    }`;

    const card = parseCharacterCardImportText(malformed);

    expect(card).toBeNull();
  });

  it('imports SillyTavern world books from entries objects', () => {
    const worldBook = parseWorldBookImportText(JSON.stringify({
      name: '',
      entries: {
        1: {
          uid: 1,
          key: ['Planet', 'Terra'],
          keys: ['Earth'],
          comment: 'Terra',
          content: 'Terra has two moons.',
          constant: true,
          disable: false,
          enabled: true,
        },
      },
    }), 'Arknights');

    expect(worldBook?.name).toBe('Arknights');
    expect(worldBook?.entries[0].id).toBe('entry_1');
    expect(worldBook?.entries[0].key).toContain('Planet');
    expect(worldBook?.entries[0].key).toContain('Earth');
    expect(worldBook?.entries[0].alwaysActive).toBe(true);
    expect(worldBook?.entries[0].enabled).toBe(true);
  });

  it('does not import embedded SillyTavern instructions in the renderer', () => {
    const bundle = parseCharacterCardBundleImportText(JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: '测试角色',
        description: '角色描述。',
        personality: '',
        first_mes: '',
        character_book: {
          entries: {
            a: {
              uid: 7,
              key: ['测试关键词'],
              comment: '角色世界书',
              content: '这条设定应随角色导入。',
              constant: false,
              enabled: true,
            },
          },
        },
      },
    }));

    expect(bundle).toBeNull();
  });

  it('extracts SillyTavern PNG character cards from embedded text chunks', () => {
    const payload = {
      spec: 'chara_card_v2',
      data: {
        name: 'PNG角色',
        description: '这段角色资料藏在图片里。',
        personality: '温柔但会闹小脾气。',
        first_mes: '你终于点开我啦。',
        character_book: {
          entries: {
            1: {
              uid: 1,
              key: ['PNG世界'],
              comment: 'PNG内嵌世界书',
              content: '这条世界书来自 PNG 角色卡。',
              constant: true,
              enabled: true,
            },
          },
        },
      },
    };

    const parsed = parseSillyTavernPngPayload(makeSillyTavernPng(payload));
    expect(parsed).toMatchObject({
      spec: 'chara_card_v2',
      data: {
        name: 'PNG角色',
        description: '这段角色资料藏在图片里。',
      },
    });
    expect(parseCharacterCardBundleImport(parsed)).toBeNull();
  });

  it('rejects a PNG card whose chunk integrity check fails', () => {
    const png = new Uint8Array(makeSillyTavernPng({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: '损坏卡片' },
    }));
    png[png.length - 8] ^= 0xff;

    expect(parseSillyTavernPngPayload(png.buffer)).toBeNull();
  });

  it('rejects duplicate and prototype-polluting JSON keys before PNG import', () => {
    const duplicateName = '{"spec":"chara_card_v2","data":{"name":"可信","na\\u006de":"覆盖"}}';
    const dangerousKey = '{"spec":"chara_card_v2","data":{"name":"测试","__proto__":{}}}';

    expect(parseSillyTavernPngPayload(makeSillyTavernPngText(duplicateName))).toBeNull();
    expect(parseSillyTavernPngPayload(makeSillyTavernPngText(dangerousKey))).toBeNull();
    expect(parseStrictJsonText('{"value":1e400}')).toBeNull();
  });

  it('clamps onboarding memory retention to one through three years', () => {
    expect(createOnboardingPreferences(1).memoryRetentionDays).toBe(365);
    expect(createOnboardingPreferences(3).memoryRetentionDays).toBe(1095);

    const backup = parseBackupImport({
      schema: REVERIE_BACKUP_SCHEMA,
      archive: createDefaultArchive(),
      onboarding: { completed: true, memoryRetentionYears: 99 },
      evidence: {},
    });

    expect(backup?.onboarding?.memoryRetentionYears).toBe(3);
  });

  it('round-trips the complete backup shape', () => {
    const archive = createDefaultArchive();
    const backup = createBackup({
      archive,
      userProfile: {
        name: '星野白夜',
        favorite_games: ['明日方舟'],
      },
      onboarding: createOnboardingPreferences(2),
      llmConfig: {
        provider: 'custom',
        apiKey: 'sk-test',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gateway-model',
        customHeaders: 'Authorization: backup-secret-canary',
      },
      worldState: {
        schema: 'reverie.full_local_backup.v2',
        emotion: { values: { joy: 70 } },
        affairs: { affairs: [{ id: 'aff_1', progress: 40 }] },
      },
      diaryEntries: [{ date: '2026-07-02', title: 'test' }],
      timelinePosts: [{ date: '2026-07-02', content: 'hello' }],
      chatMessages: [{ role: 'user', content: 'hi', id: '1' }],
    });

    expect(backup.schema).toBe(REVERIE_BACKUP_SCHEMA);
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('backup-secret-canary');
    expect(serialized).not.toContain('"apiKey"');
    expect(serialized).not.toContain('"customHeaders"');
    expect(parseBackupImport(backup)?.archive).toEqual(archive);
    expect(parseBackupImport(backup)?.userProfile?.name).toBe('星野白夜');
    expect(parseBackupImport(backup)?.worldState?.schema).toBe('reverie.full_local_backup.v2');
    expect(parseBackupImport({ schema: 'wrong' })).toBeNull();
  });

  it('strips and warns about credentials in legacy backup imports', () => {
    const parsed = parseBackupImport({
      schema: REVERIE_BACKUP_SCHEMA,
      archive: createDefaultArchive(),
      llmConfig: {
        provider: 'custom',
        apiKey: 'legacy-key-canary',
        customHeaders: 'Authorization: legacy-header-canary',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'gateway-model',
      },
      imageGenConfig: {
        provider: 'openai',
        apiKey: 'legacy-image-canary',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-image-1',
      },
      evidence: {},
    });

    expect(parsed?.llmConfig).toEqual({
      provider: 'custom',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'gateway-model',
    });
    expect(parsed?.securityWarnings).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain('legacy-key-canary');
    expect(JSON.stringify(parsed)).not.toContain('legacy-image-canary');
  });
});

