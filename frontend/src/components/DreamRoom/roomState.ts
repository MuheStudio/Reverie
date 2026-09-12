export type RoomMoodKey = 'calm' | 'soft' | 'warm' | 'lonely' | 'bright';

export interface RoomMoodState {
  key: RoomMoodKey;
  label: string;
  glow: string;
}

export type CoreEmotionKey =
  | 'joy'
  | 'calm'
  | 'excitement'
  | 'sadness'
  | 'anger'
  | 'anxiety'
  | 'grievance'
  | 'touched';

export interface RoomAtmosphere extends RoomMoodState {
  backgroundClass: string;
  dominantEmotion: CoreEmotionKey;
  dominantLabel: string;
  statusLine: string;
  lampSpread: number;
  particleDuration: number;
  particleOpacity: number;
  sceneBrightness: number;
  sceneSaturation: number;
  shadowOpacity: number;
}

export type RoomScenePanelId = 'diary' | 'phone';
export type PhoneAppPanelId =
  | 'timeline'
  | 'group'
  | 'music'
  | 'stickers'
  | 'memory'
  | 'video'
  | 'tetris'
  | 'snake'
  | 'gomoku'
  | 'chess'
  | 'xiangqi'
  | 'go';
export type RoomPanelId =
  | RoomScenePanelId
  | PhoneAppPanelId
  | 'ai'
  | 'archive'
  | 'backup'
  | 'antiAiSettings'
  | 'chatSettings'
  | 'diarySettings'
  | 'memorySettings'
  | 'personalitySettings'
  | 'immersionSettings'
  | 'userProfile'
  | 'voicePack'
  | 'settings'
  | 'status';

export interface RoomShortcut {
  id: 'chat' | RoomScenePanelId;
  label: string;
  subtitle: string;
  target: 'chat' | RoomScenePanelId;
  roomRole: 'communication' | 'private' | 'device';
}

export type DiaryPrivacy = 'locked' | 'safe' | 'glimpse' | 'unknown';

export const ROOM_MOODS: Record<RoomMoodKey, RoomMoodState> = {
  calm: { key: 'calm', label: '安静月光', glow: '#9db9ff' },
  soft: { key: 'soft', label: '柔软棉被', glow: '#f5b9ce' },
  warm: { key: 'warm', label: '暖灯陪伴', glow: '#f7c875' },
  lonely: { key: 'lonely', label: '雨夜独处', glow: '#88a7c8' },
  bright: { key: 'bright', label: '星屑清晨', glow: '#a8e6cf' },
};

export const ROOM_SHORTCUTS: RoomShortcut[] = [
  {
    id: 'chat',
    label: '聊天',
    subtitle: '像敲门一样发消息',
    target: 'chat',
    roomRole: 'communication',
  },
  {
    id: 'diary',
    label: '日记',
    subtitle: '只看她愿意留下的痕迹',
    target: 'diary',
    roomRole: 'private',
  },
  {
    id: 'phone',
    label: '手机',
    subtitle: '动态、音乐、回忆和小游戏',
    target: 'phone',
    roomRole: 'device',
  },
];

const MOOD_ALIASES: Array<{ pattern: RegExp; key: RoomMoodKey }> = [
  { pattern: /孤独|寂寞|低落|难过|失落|lonely|sad|blue/i, key: 'lonely' },
  { pattern: /开心|高兴|兴奋|明亮|期待|happy|bright|excited/i, key: 'bright' },
  { pattern: /温暖|亲近|安心|依赖|warm|safe|close/i, key: 'warm' },
  { pattern: /柔软|撒娇|害羞|甜|soft|shy|cute/i, key: 'soft' },
];

interface EmotionVisualProfile {
  aliases: RegExp;
  label: string;
  roomLabel: string;
  mood: RoomMoodKey;
  warmth: number;
  energy: number;
  light: number;
  shadow: number;
}

const EMOTION_VISUALS: Record<CoreEmotionKey, EmotionVisualProfile> = {
  joy: {
    aliases: /^(joy|happy|happiness|开心|高兴|快乐)$/i,
    label: '开心',
    roomLabel: '晨光雀跃',
    mood: 'bright',
    warmth: 0.82,
    energy: 0.66,
    light: 0.82,
    shadow: 0.18,
  },
  calm: {
    aliases: /^(calm|peaceful|quiet|平静|安静)$/i,
    label: '平静',
    roomLabel: '安静月光',
    mood: 'calm',
    warmth: 0.08,
    energy: 0.18,
    light: 0.50,
    shadow: 0.30,
  },
  excitement: {
    aliases: /^(excitement|excited|兴奋|期待)$/i,
    label: '兴奋',
    roomLabel: '星屑跃动',
    mood: 'bright',
    warmth: 0.62,
    energy: 1,
    light: 0.92,
    shadow: 0.12,
  },
  sadness: {
    aliases: /^(sadness|sad|blue|失落|难过|伤心)$/i,
    label: '失落',
    roomLabel: '雨夜低云',
    mood: 'lonely',
    warmth: -0.92,
    energy: 0.08,
    light: 0.18,
    shadow: 0.88,
  },
  anger: {
    aliases: /^(anger|angry|mad|生气|愤怒)$/i,
    label: '生气',
    roomLabel: '灼热暗影',
    mood: 'warm',
    warmth: 0.52,
    energy: 0.92,
    light: 0.28,
    shadow: 0.72,
  },
  anxiety: {
    aliases: /^(anxiety|anxious|nervous|紧张|焦虑|不安)$/i,
    label: '紧张',
    roomLabel: '灯影微颤',
    mood: 'calm',
    warmth: -0.28,
    energy: 0.78,
    light: 0.30,
    shadow: 0.58,
  },
  grievance: {
    aliases: /^(grievance|upset|wronged|委屈|吃醋)$/i,
    label: '委屈',
    roomLabel: '薄雾垂光',
    mood: 'soft',
    warmth: -0.48,
    energy: 0.34,
    light: 0.26,
    shadow: 0.74,
  },
  touched: {
    aliases: /^(touched|moved|感动|动容)$/i,
    label: '感动',
    roomLabel: '暖光回响',
    mood: 'warm',
    warmth: 0.88,
    energy: 0.46,
    light: 0.76,
    shadow: 0.22,
  },
};

const CORE_EMOTION_KEYS = Object.keys(EMOTION_VISUALS) as CoreEmotionKey[];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normaliseEmotionKey(rawKey: string): CoreEmotionKey | undefined {
  const key = rawKey.trim();
  return CORE_EMOTION_KEYS.find((candidate) => EMOTION_VISUALS[candidate].aliases.test(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function collectStrings(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[、，,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function parseTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function resolveRoomMood(emotion?: Record<string, unknown> | null): RoomMoodState {
  const candidates = [
    firstString(emotion ?? undefined, ['current', 'primary', 'mood', 'label', 'emotion']),
    firstString(emotion ?? undefined, ['state', 'tone', 'weather']),
  ].filter(Boolean) as string[];
  const merged = candidates.join(' ');
  const match = MOOD_ALIASES.find((alias) => alias.pattern.test(merged));
  return ROOM_MOODS[match?.key ?? 'calm'];
}

export function deriveRoomAtmosphere(
  emotions: Record<string, number>,
  connected: boolean,
): RoomAtmosphere {
  const recognised = new Map<CoreEmotionKey, number>();
  Object.entries(emotions).forEach(([rawKey, rawValue]) => {
    const key = normaliseEmotionKey(rawKey);
    if (!key || !Number.isFinite(rawValue)) return;
    recognised.set(key, clamp(rawValue, 0, 100));
  });

  if (!recognised.size) recognised.set('calm', 1);
  const ranked = [...recognised.entries()].sort(([, left], [, right]) => right - left);
  const [dominantEmotion] = ranked[0];
  const dominantProfile = EMOTION_VISUALS[dominantEmotion];
  const total = ranked.reduce((sum, [, score]) => sum + Math.max(score, 1), 0);
  const weighted = (field: 'warmth' | 'energy' | 'light' | 'shadow') => (
    ranked.reduce(
      (sum, [key, score]) => sum + EMOTION_VISUALS[key][field] * Math.max(score, 1),
      0,
    ) / total
  );

  const warmth = weighted('warmth');
  const energy = weighted('energy');
  const light = weighted('light');
  const shadow = weighted('shadow');
  const mood = ROOM_MOODS[dominantProfile.mood];

  return {
    ...mood,
    label: dominantProfile.roomLabel,
    backgroundClass: `mood_${mood.key}`,
    dominantEmotion,
    dominantLabel: dominantProfile.label,
    statusLine: connected
      ? `房间正随着${dominantProfile.label}里混合的情绪缓慢变换。`
      : '房间暂时离线，仍保留最后一次本地光影。',
    lampSpread: Math.round(clamp(78 + warmth * 58 + light * 26, 54, 158)),
    particleDuration: Number(clamp(15 - energy * 9, 5.5, 15).toFixed(2)),
    particleOpacity: Number(clamp(0.12 + light * 0.42, 0.12, 0.58).toFixed(2)),
    sceneBrightness: Number(clamp(0.78 + light * 0.33, 0.78, 1.1).toFixed(2)),
    sceneSaturation: Number(clamp(0.82 + energy * 0.34, 0.82, 1.18).toFixed(2)),
    shadowOpacity: Number(clamp(0.14 + shadow * 0.56, 0.16, 0.68).toFixed(2)),
  };
}

export function getPersonaDisplayName(persona?: Record<string, unknown> | null): string {
  return firstString(persona ?? undefined, ['name', 'nickname', 'display_name']) ?? 'Reverie';
}

export function getPersonaIdentityLine(persona?: Record<string, unknown> | null): string {
  if (!persona) return '一位仍在慢慢醒来的梦境住客';

  const identityValue = persona.identity;
  const identity =
    typeof identityValue === 'string'
      ? identityValue.trim()
      : isRecord(identityValue)
        ? firstString(identityValue, ['title', 'description', 'name', 'role'])
        : undefined;
  const role = firstString(persona, ['role', 'occupation', 'position']);
  const age = firstString(persona, ['age', 'apparent_age']);

  const segments = [identity, role, age && `${age}岁`].filter(Boolean);
  return segments.length ? segments.join(' · ') : '正在把自己一点点讲给你听';
}

export function formatRelationshipStage(relationship?: unknown): string {
  const relationshipRecord = isRecord(relationship) ? relationship : undefined;
  const raw =
    firstString(relationshipRecord, ['stage', 'label', 'name']) ??
    firstString(relationshipRecord, ['phase', 'status']);
  if (!raw) return '关系仍在初醒';

  const normalized = raw.toLowerCase();
  if (/initial|stranger|new|初/.test(normalized)) return '初识期';
  if (/acquaintance|familiar|friend|熟|朋友/.test(normalized)) return '熟悉';
  if (/close|trust|依赖|亲近|信任/.test(normalized)) return '亲近期';
  if (/bond|companion|陪伴|羁绊/.test(normalized)) return '陪伴期';
  // Unknown backend stages used to leak raw English strings into the zh UI.
  if (/^[a-z0-9_.\- ]+$/i.test(normalized)) return '关系仍在初醒';
  return raw;
}

export function formatRecentInterest(persona?: Record<string, unknown> | null): string {
  const interests = collectStrings(
    persona?.interests ??
      persona?.likes ??
      persona?.hobbies ??
      (isRecord(persona?.profile) ? persona?.profile.interests : undefined),
  );
  return interests.slice(0, 3).join('、') || '还没把喜欢的东西完全告诉你';
}

export function formatEvidenceConnectionLine(options: {
  diaryCount: number;
  timelineCount: number;
  isConnected: boolean;
  lastSyncAt?: string | null;
}): string {
  const pieces = [
    `${options.diaryCount} 页日记痕迹`,
    `${options.timelineCount} 条生活动态`,
    options.isConnected ? '正在听见房间的实时动静' : '离线时保留安全快照',
  ];
  if (options.lastSyncAt) pieces.push('刚刚整理过生活证据');
  return pieces.join(' · ');
}

export function getLatestDiaryEntry<T extends { updated_at?: string; created_at?: string; date?: string }>(
  entries: T[],
): T | undefined {
  return [...entries].sort(
    (a, b) =>
      parseTime(b.updated_at ?? b.created_at ?? b.date) -
      parseTime(a.updated_at ?? a.created_at ?? a.date),
  )[0];
}

export function getLatestTimelinePost<T extends { date?: string }>(posts: T[]): T | undefined {
  return [...posts].sort((a, b) => parseTime(b.date) - parseTime(a.date))[0];
}

export function getDiaryPrivacy(entry?: { is_locked?: boolean; can_peek?: boolean }): DiaryPrivacy {
  if (!entry) return 'unknown';
  if (entry.is_locked) return 'locked';
  if (entry.can_peek) return 'glimpse';
  return 'safe';
}

export function getDiaryPrivacyLine(entry?: { is_locked?: boolean; can_peek?: boolean }): string {
  const privacy = getDiaryPrivacy(entry);
  if (privacy === 'locked') return '这页上了锁，房间只显示“她写过”，不显示内容。';
  if (privacy === 'glimpse') return '她愿意露出一点点边角，但不会把整页摊开。';
  if (privacy === 'safe') return '这页可以安全地摆在房间里。';
  return '还没有可展示的日记痕迹。';
}

export function formatDiaryPreview(entry?: { title?: string; content?: string; is_locked?: boolean }): string {
  if (!entry) return '抽屉还很轻，等她慢慢写下第一行。';
  if (entry.is_locked) return '锁扣合着，只能看见纸页的重量。';
  const text = entry.title || entry.content || '';
  return text.trim() || '这一页还没写完，只留下了浅浅的纸纹。';
}
