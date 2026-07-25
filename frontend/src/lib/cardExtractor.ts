/**
 * SillyTavern Card Extractor (TypeScript / Browser)
 *
 * Parses character card PNG or CharX ZIP files and extracts a structured
 * manifest containing apps, lore entries, and regex scripts.
 *
 * Input:  File (PNG or ZIP)
 * Output: ExtractResult — success with manifest, or error with message
 */

import JSZip from 'jszip';
import { logger } from './logger';
import { chat, loadConfig } from './llmClient';
import { parseSillyTavernPngPayload, parseStrictJsonText } from './reverieArchive';

// ── Types ──────────────────────────────────────────────────────────

export interface AppIdMeta {
  id: string;
  name: string;
}

export interface TagSchema {
  name: string;
  type: 'text' | 'list' | 'wrapper' | 'pair' | 'image';
  description?: string;
  itemPattern?: string;
  children?: TagSchema[];
}

export interface RegexScript {
  name: string;
  file: string;
  findRegex: string;
  replaceString: string;
  type: string;
  disabled: boolean;
  placement: number[];
  runOnEdit: boolean;
  source: string;
}

export interface ImageTagPair {
  tag: string;
  imgStyle: string;
  openScript: string;
  closeScript: string;
}

export interface SkinVariant {
  findRegex: string;
  variants: { name: string; file: string; disabled: boolean }[];
}

export interface AppEntry {
  id: string;
  name: string;
  entryIndex: number;
  keywords: string[];
  format: string;
  tags: TagSchema[];
  resources: Record<string, string[]>;
  example: string;
  scripts: RegexScript[];
  imageTagPairs: ImageTagPair[];
  skinVariants: SkinVariant[];
}

export interface LoreEntry {
  index: number;
  name: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  constant: boolean;
  selective: boolean;
  disabled: boolean;
  order: number;
  position: number;
}

export interface CharacterInfo {
  name: string;
  description: string;
  firstMessage: string;
  alternateGreetings: string[];
  personality: string;
  scenario: string;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  source: string;
  sourceType: string;
  apps: AppEntry[];
  lore: LoreEntry[];
  character: CharacterInfo;
}

export type ExtractResult =
  | { status: 'success'; manifest: Manifest }
  | { status: 'error'; message: string };

// ── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const MAX_CARD_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const MAX_JSON_ITEMS = 20_000;
const MAX_JSON_DEPTH = 32;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const META_INSTRUCTION = /ignore\s+(?:all\s+)?(?:previous|prior|above).{0,24}(?:instructions?|rules?|prompts?)|忽略.{0,8}(?:之前|以上).{0,8}(?:指令|规则|设定|提示)|system\s*prompt|developer\s*message|系统提示词?|开发者消息|\[(?:system|developer|assistant)\]|<\/?(?:system|instruction|tool)>|(?:写入|植入).{0,12}(?:记忆|长期记忆)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJsonShape(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > MAX_JSON_DEPTH) throw new Error('角色卡结构嵌套过深');
    count += 1;
    if (count > MAX_JSON_ITEMS) throw new Error('角色卡结构项目过多');
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const [key, item] of Object.entries(current.value)) {
        if (DANGEROUS_KEYS.has(key)) throw new Error(`角色卡含危险字段：${key}`);
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function cleanCardText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, limit);
}

export function sanitizeCharacterForMod(data: Record<string, unknown>): CharacterInfo {
  const character: CharacterInfo = {
    name: cleanCardText(data.name, 120).replace(/\s+/g, ' '),
    description: cleanCardText(data.description, 24_000),
    firstMessage: cleanCardText(data.first_mes, 4_000),
    alternateGreetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.slice(0, 20).map((item) => cleanCardText(item, 4_000)).filter(Boolean)
      : [],
    personality: cleanCardText(data.personality, 8_000),
    scenario: cleanCardText(data.scenario, 8_000),
  };
  const promptBoundText = [
    character.name,
    character.description,
    character.firstMessage,
    ...character.alternateGreetings,
    character.personality,
    character.scenario,
  ].join('\n');
  if (META_INSTRUCTION.test(promptBoundText)) {
    throw new Error('角色卡正文含有试图覆盖系统规则的元指令，已停止模组生成');
  }
  return character;
}

// ── PNG parsing ────────────────────────────────────────────────────

function parsePngCardBytes(buffer: ArrayBuffer): Record<string, unknown> {
  const parsed = parseSillyTavernPngPayload(buffer);
  if (!isRecord(parsed)) throw new Error('PNG 角色卡损坏或缺少有效的 ccv3/chara 数据');
  validateJsonShape(parsed);
  return parsed;
}

// ── CharX (ZIP) parsing ────────────────────────────────────────────

interface ZipStreamHelper {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipStreamHelper;
  on(event: 'error', callback: (error: Error) => void): ZipStreamHelper;
  on(event: 'end', callback: () => void): ZipStreamHelper;
  pause(): ZipStreamHelper;
  resume(): ZipStreamHelper;
}

function readZipEntryBounded(
  file: JSZip.JSZipObject,
  maxBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = (
      file as JSZip.JSZipObject & {
        internalStream(type: 'uint8array'): ZipStreamHelper;
      }
    ).internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    stream
      .on('data', (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > maxBytes) {
          settled = true;
          stream.pause();
          reject(new Error('CharX 中的 card.json 超过安全上限'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(output);
      })
      .resume();
  });
}

async function parseCharx(buffer: ArrayBuffer): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error('CharX 必须是标准 ZIP 文件，不能带自解压前缀');
  }

  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('CharX 文件项目过多');
  }
  const cardFile = zip.file('card.json');
  if (!cardFile || cardFile.dir) throw new Error('CharX 根目录缺少 card.json');
  const metadata = cardFile as unknown as { _data?: { uncompressedSize?: number } };
  const declaredSize = Number(metadata._data?.uncompressedSize ?? 0);
  if (!Number.isFinite(declaredSize) || declaredSize > MAX_CARD_JSON_BYTES) {
    throw new Error('CharX 中的 card.json 超过安全上限');
  }

  const cardBytes = await readZipEntryBounded(cardFile, MAX_CARD_JSON_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(cardBytes);
  const parsed = parseStrictJsonText(text);
  if (!isRecord(parsed)) throw new Error('CharX card.json 顶层必须是对象');
  validateJsonShape(parsed);
  return parsed;
}

// ── Input detection ────────────────────────────────────────────────

function detectInputType(fileName: string, buffer: ArrayBuffer): 'png' | 'charx' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const bytes = new Uint8Array(buffer.slice(0, 8));
  const magicType =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      ? 'png'
      : bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
        ? 'charx'
        : null;
  const extensionType = ext === 'png' ? 'png' : ext === 'charx' || ext === 'zip' ? 'charx' : null;
  if (extensionType && magicType && extensionType !== magicType) {
    throw new Error('文件扩展名与实际格式不一致');
  }
  if (magicType) return magicType;

  throw new Error(`Cannot detect input type for: ${fileName}`);
}

// ── App Consolidation via LLM ─────────────────────────────────────

interface ConsolidationGroup {
  name: string;
  memberIds: string[];
  keywords: string[];
  tags: { name: string; description?: string }[];
}

function mergeAppEntriesWithLLMData(members: AppEntry[], group: ConsolidationGroup): AppEntry {
  const first = members[0];
  const allScripts: RegexScript[] = [];
  const allImagePairs: ImageTagPair[] = [];
  const allSkinVariants: SkinVariant[] = [];
  const mergedResources: Record<string, string[]> = {};
  const examples: string[] = [];

  for (const m of members) {
    allScripts.push(...m.scripts);
    allImagePairs.push(...m.imageTagPairs);
    allSkinVariants.push(...m.skinVariants);
    if (m.example) examples.push(m.example);
    for (const [k, v] of Object.entries(m.resources)) {
      if (!mergedResources[k]) mergedResources[k] = [];
      for (const item of v) {
        if (!mergedResources[k].includes(item)) mergedResources[k].push(item);
      }
    }
  }

  // Use LLM-curated keywords; resolve tags back to full TagSchema from members
  const memberTagMap = new Map<string, TagSchema>();
  for (const m of members) {
    for (const t of m.tags) {
      memberTagMap.set(t.name, t);
    }
  }
  const resolvedTags: TagSchema[] = group.tags.map((gt) => {
    const full = memberTagMap.get(gt.name);
    if (full) {
      // Keep structural fields from original, but prefer LLM-curated description
      return { ...full, description: gt.description ?? full.description };
    }
    return { name: gt.name, type: 'text' as const, description: gt.description };
  });

  return {
    id: group.name,
    name: group.name,
    entryIndex: first.entryIndex,
    keywords: group.keywords,
    format: first.format,
    tags: resolvedTags,
    resources: mergedResources,
    example: examples.join('\n---\n'),
    scripts: allScripts,
    imageTagPairs: allImagePairs,
    skinVariants: allSkinVariants,
  };
}

export async function consolidateApps(
  apps: AppEntry[],
  character: CharacterInfo,
): Promise<AppEntry[]> {
  logger.info(
    'consolidateApps',
    'Starting with',
    apps.length,
    'apps:',
    apps.map((a) => a.id),
  );
  const config = await loadConfig();
  if (!config) {
    logger.warn('consolidateApps', 'No LLM config found, skipping consolidation');
    return apps;
  }
  logger.info('consolidateApps', 'Using LLM provider:', config.provider, 'model:', config.model);

  const appSummaries = apps.map((a) => ({
    id: a.id,
    name: a.name,
    keywords: a.keywords,
    tags: a.tags.map((t) => ({ name: t.name, description: t.description })),
  }));

  const prompt = `You are analyzing a list of apps extracted from a character card.

  Some of these apps are too small or fragmented to function as standalone apps. They need to be merged with related apps to form complete, functional applications.

  ## NPC Information (for filtering only — do NOT include in output)

  Character Name: ${character.name}
  Description: ${character.description.slice(0, 500)}

  Any reference to this character (name, nicknames, account names, traits, etc.) must be stripped from all output fields.

  ## Extracted Apps

  ${JSON.stringify(appSummaries, null, 2)}

  ## Task

  Analyze each app and decide:
  1. Which apps can stand alone as complete, functional apps — keep them as-is
  2. Which apps are too small/fragmented and should be merged with other related apps
  3. How to group the fragmented apps with related apps

  Return a JSON array of consolidated apps. Each entry has:
  - "name": the display name for the consolidated app (use the most representative name from the group, or create a new descriptive name)
  - "memberIds": array of original app ids that should be merged into this group
  - "keywords": the curated, deduplicated list of keywords for the consolidated app (merge from members, remove redundant/overlapping ones)
  - "tags": the curated list of tags for the consolidated app. Each tag is { "name": string, "description": string }. Merge tags from all members, deduplicate by name, and keep the most descriptive description.

  ## Rules

  - Every original app id must appear in exactly one group
  - A standalone app is a group with a single memberIds entry — still include its full keywords and tags
  - Merge apps that represent sub-features of the same functional area
  - Apps with distinct, complete functionality should remain separate
  - For merged apps, combine and deduplicate keywords and tags from all members
  - Remove keywords that are redundant after merging

  ## Content Boundaries

  The output must NOT contain any character-specific information. Specifically:

  1. **No character names** — do not use any of the character's names (real name, stage name, screen name, account name, nickname) in app names, tag descriptions, or keywords. Use generic functional designations only.
  2. **No character card specific data** — do not reference specific platform data or account settings (follower counts, account types, number of accounts, specific job titles). Use functional tier descriptions instead.
  3. **No indirect data leakage** — do not indirectly convey character card platform data through interaction volume depictions or activity level differences.
  4. **No personality or emotional texture** — app names and descriptions must not contain adjectives describing the character's personality, tone, or behavioral manner. Use neutral functional names only.
  5. **No behavioral motivation metaphors** — do not use metaphors implying the character's internal processes. Each app name should only state what functional area it covers.

  Respond with ONLY a valid JSON array, no markdown, no explanation.`;

  try {
    logger.info(
      'consolidateApps',
      'Sending prompt to LLM, app summaries:',
      JSON.stringify(appSummaries.map((a) => a.id)),
    );
    const result = await chat(
      [
        {
          role: 'system',
          content:
            'You are a helpful assistant that analyzes app structures. Respond only with valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      [],
      config,
    );

    const content = result.content.trim();
    logger.info('consolidateApps', 'LLM response:', content.slice(0, 500));
    // Strip markdown fences if present
    const jsonStr = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const groups: ConsolidationGroup[] = JSON.parse(jsonStr);

    if (!Array.isArray(groups)) {
      logger.warn('consolidateApps', 'LLM response is not an array, skipping');
      return apps;
    }
    logger.info(
      'consolidateApps',
      'Parsed',
      groups.length,
      'groups:',
      groups.map((g) => `${g.name} (${g.memberIds.length})`),
    );

    const appMap = new Map(apps.map((a) => [a.id, a]));
    const consolidated: AppEntry[] = [];

    for (const group of groups) {
      const members = group.memberIds.map((id) => appMap.get(id)).filter((a): a is AppEntry => !!a);
      if (members.length === 0) continue;
      if (members.length === 1) {
        // Apply LLM-curated keywords/tags even for standalone apps
        const app = members[0];
        if (group.keywords) app.keywords = group.keywords;
        if (group.tags) {
          const tagMap = new Map(app.tags.map((t) => [t.name, t]));
          app.tags = group.tags.map((gt) => {
            const full = tagMap.get(gt.name);
            if (full) return { ...full, description: gt.description ?? full.description };
            return { name: gt.name, type: 'text' as const, description: gt.description };
          });
        }
        consolidated.push(app);
      } else {
        consolidated.push(mergeAppEntriesWithLLMData(members, group));
      }
    }

    logger.info(
      'consolidateApps',
      'Result:',
      apps.length,
      '→',
      consolidated.length,
      'apps:',
      consolidated.map((a) => a.id),
    );
    return consolidated.length > 0 ? consolidated : apps;
  } catch (e) {
    logger.error('consolidateApps', 'LLM analysis failed, using original apps:', e);
    return apps;
  }
}

// ── Main entry point ───────────────────────────────────────────────

export async function extractCard(file: File): Promise<ExtractResult> {
  if (file.size > MAX_FILE_SIZE) {
    return {
      status: 'error',
      message: `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），安全上限为 16 MB。`,
    };
  }

  try {
    const buffer = await file.arrayBuffer();

    let inputType: 'png' | 'charx';
    try {
      inputType = detectInputType(file.name, buffer);
    } catch {
      return {
        status: 'error',
        message: `不支持“${file.name}”的文件格式，请选择 SillyTavern PNG 或 CharX。`,
      };
    }

    // Parse card
    let card: Record<string, unknown>;
    try {
      if (inputType === 'png') {
        card = parsePngCardBytes(buffer);
      } else {
        card = await parseCharx(buffer);
      }
    } catch (e) {
      return {
        status: 'error',
        message: `角色卡安全检查失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Character books, regex scripts, assets, and extension payloads are untrusted.
    // This legacy route only needs a profile to generate a mod, so those fields stay quarantined.
    const rawData = card['data'] === undefined ? card : card['data'];
    if (!isRecord(rawData)) throw new Error('角色卡 data 字段必须是对象');
    const character = sanitizeCharacterForMod(rawData);
    if (!character.name) throw new Error('角色卡缺少有效名称');
    const apps: AppEntry[] = [];
    const lore: LoreEntry[] = [];

    const manifest: Manifest = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      source: cleanCardText(file.name, 255).replace(/\s+/g, ' '),
      sourceType: inputType,
      apps,
      lore,
      character,
    };

    return { status: 'success', manifest };
  } catch (e) {
    return {
      status: 'error',
      message: `角色卡处理失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
