import { createAppFileApi, type FileOperations } from '@/lib';
import type { DiaryEntry, TimelinePost } from '@/hooks/useReverieWS';

const MIRROR_PREFIX = 'reverie-ws';
const DIARY_LIMIT = 12;
const TIMELINE_LIMIT = 20;

interface DiaryMirrorEntry {
  id: string;
  date: string;
  title: string;
  content: string;
  mood: 'happy' | 'sad' | 'neutral' | 'excited' | 'tired' | 'anxious' | 'hopeful' | 'angry';
  createdAt: number;
  updatedAt: number;
}

interface TimelineMirrorPost {
  id: string;
  author: {
    name: string;
    username: string;
    avatar: string;
  };
  content: string;
  timestamp: number;
  likes: number;
  isLiked: boolean;
  comments: unknown[];
}

export interface LifeEvidenceSyncResult {
  diaryCount: number;
  timelineCount: number;
  skipped: boolean;
}

function stableHash(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function makeLifeEvidenceId(kind: 'diary' | 'timeline', seed: string): string {
  return `${MIRROR_PREFIX}-${kind}-${stableHash(seed || kind)}`;
}

function dateOnly(value: string | undefined, fallbackTime: number): string {
  const text = value?.trim();
  if (text && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return new Date(fallbackTime).toISOString().slice(0, 10);
}

function parseEvidenceTime(value: string | undefined, fallbackTime: number): number {
  if (!value) return fallbackTime;
  const normalized = value.trim().replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : fallbackTime;
}

function mapDiaryMood(mood: string | undefined): DiaryMirrorEntry['mood'] {
  const text = (mood || '').toLowerCase();
  if (/happy|joy|love|开心|快乐|高兴/.test(text)) return 'happy';
  if (/sad|grievance|lonely|难过|失落|孤独/.test(text)) return 'sad';
  if (/angry|annoyed|生气|炸毛|恼火/.test(text)) return 'angry';
  if (/excited|兴奋|期待/.test(text)) return 'excited';
  if (/tired|sleepy|困|疲惫|熬夜/.test(text)) return 'tired';
  if (/anxious|fear|害怕|焦虑/.test(text)) return 'anxious';
  if (/hope|希望|期待/.test(text)) return 'hopeful';
  return 'neutral';
}

function hasVisibleDiaryContent(entry: DiaryEntry): boolean {
  return Boolean((entry.can_peek || entry.peekable) && entry.content?.trim());
}

export function buildDiaryMirrorEntry(
  entry: DiaryEntry,
  index = 0,
  fallbackTime = Date.now(),
): DiaryMirrorEntry {
  const timestamp = parseEvidenceTime(entry.date, fallbackTime);
  const day = dateOnly(entry.date, timestamp);
  const seed = `${entry.date || day}|${entry.title || ''}|${entry.mood || ''}|${index}`;
  const canPeek = Boolean(entry.can_peek || entry.peekable);
  const lockedNote = entry.status_label || '房间只同步了日期和心情，没有展开私密正文。';
  const content = hasVisibleDiaryContent(entry)
    ? entry.content!.trim()
    : canPeek
      ? `今晚能翻到这页，但后端只给了元数据。\n\n${lockedNote}`
      : `这页日记仍锁着。\n\n${lockedNote}`;

  return {
    id: makeLifeEvidenceId('diary', seed),
    date: day,
    title: entry.title?.trim() || `${day} 的日记`,
    content,
    mood: mapDiaryMood(entry.mood),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function buildTimelineMirrorPost(
  post: TimelinePost,
  personaName: string,
  index = 0,
  fallbackTime = Date.now(),
): TimelineMirrorPost {
  const timestamp = parseEvidenceTime(post.date, fallbackTime);
  const seed = `${post.id || post.event_id || ''}|${post.date || ''}|${post.content || ''}|${index}`;
  const fallbackContent = post.tags?.length
    ? `她留下了一条关于 ${post.tags.slice(0, 2).join('、')} 的小动态。`
    : '她留下了一条还没写正文的小动态。';

  return {
    id: makeLifeEvidenceId('timeline', seed),
    author: {
      name: personaName.trim() || '星野幻月',
      username: '@reverie_room',
      avatar: '',
    },
    content: post.content?.trim() || fallbackContent,
    timestamp,
    likes: 0,
    isLiked: false,
    comments: [],
  };
}

async function syncMirrorFiles<T extends { id: string }>(
  api: FileOperations,
  dir: string,
  items: T[],
): Promise<void> {
  const keepIds = new Set(items.map((item) => item.id));

  await Promise.all(items.map((item) => api.writeFile(`${dir}/${item.id}.json`, item)));

  const files = await api.listFiles(dir);
  await Promise.all(
    files
      .filter((file) => file.type === 'file')
      .filter((file) => file.name.startsWith(MIRROR_PREFIX) && file.name.endsWith('.json'))
      .filter((file) => !keepIds.has(file.name.replace(/\.json$/, '')))
      .map((file) => api.deleteFile(`${dir}/${file.name}`)),
  );
}

export async function syncLifeEvidenceToAppFiles({
  diaryEntries,
  timelinePosts,
  personaName,
}: {
  diaryEntries: DiaryEntry[];
  timelinePosts: TimelinePost[];
  personaName: string;
}): Promise<LifeEvidenceSyncResult> {
  if (!diaryEntries.length && !timelinePosts.length) {
    return { diaryCount: 0, timelineCount: 0, skipped: true };
  }

  const diaryMirrors = diaryEntries
    .slice(0, DIARY_LIMIT)
    .map((entry, index) => buildDiaryMirrorEntry(entry, index));
  const timelineMirrors = timelinePosts
    .slice(0, TIMELINE_LIMIT)
    .map((post, index) => buildTimelineMirrorPost(post, personaName, index));

  await Promise.all([
    syncMirrorFiles(createAppFileApi('diary'), '/entries', diaryMirrors),
    syncMirrorFiles(createAppFileApi('twitter'), '/posts', timelineMirrors),
  ]);

  return {
    diaryCount: diaryMirrors.length,
    timelineCount: timelineMirrors.length,
    skipped: false,
  };
}
