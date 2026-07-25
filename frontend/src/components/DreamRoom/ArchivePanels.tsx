import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BookOpen,
  Brain,
  Camera,
  Check,
  Download,
  Eye,
  FileJson,
  Heart,
  Gauge,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Home,
  MapPin,
  MessageCircle,
  Moon,
  Plus,
  Save,
  ServerCog,
  Settings,
  ShieldCheck,
  Smile,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Users,
  Wifi,
} from 'lucide-react';
import {
  CredentialWriteError,
  clearConfigCredentials,
  loadConfig,
  saveConfig,
  saveConfigMetadata,
} from '@/lib/llmClient';
import {
  LLM_PROVIDER_CONFIGS,
  getDefaultProviderConfig,
  getProviderDisplayName,
  type LLMConfig,
  type LLMProvider,
} from '@/lib/llmModels';
import { useReverieWS, WSMsgType } from '@/hooks/useReverieWS';
import {
  createCharacterCardExport,
  createDefaultArchive,
  createDefaultWorldBook,
  createWorldBookExport,
  clearLegacyArchiveAfterMigration,
  loadLegacyArchiveForMigration,
  parseBackupImport,
  parseSillyTavernPngPayload,
  parseWorldBookImportText,
  normalizeArchive,
  type ReverieArchive,
  type ReverieCharacterCard,
  type ReverieWorldBook,
  type WorldBookEntry,
} from '@/lib/reverieArchive';
import { requestWindowsBrowserLocation } from '@/lib/windowsGeolocation';
import styles from './index.module.scss';

const REQUESTED_PROVIDER_ORDER: LLMProvider[] = [
  'openai',
  'custom',
  'anthropic',
  'gemini',
  'grok',
  'deepseek',
  'kimi',
  'z.ai',
  'ollama',
];

const FLAWS_DISCLAIMER = '因用户所设置的‘缺点’而引发的一系列问题由用户自行承担，与本项目及本项目的所有者将不承担任何责任。';
const WEB_SURFING_DISCLAIMER = '因用户所设置的‘网络冲浪系统’而引发的一系列问题由用户自行承担，与本项目及本项目的所有者将不承担任何责任。';
const SAFE_WEB_TOPICS = ['热门梗', '新番/动漫资讯', '二次元内容', '游戏更新', '科技趣闻', '猫咪/宠物', '美食/料理'];

interface DiaryFeatureSettings {
  diary_enabled: boolean;
  diary_privacy_enabled: boolean;
  diary_peek_enabled: boolean;
  late_night_enabled: boolean;
  late_night_probability: number;
  late_night_message_enabled: boolean;
}

type DiaryFeatureFlag = Exclude<keyof DiaryFeatureSettings, 'late_night_probability'>;

interface ChatFeatureSettings {
  reply_delay_min: number;
  reply_delay_max: number;
  split_messages: boolean;
  typing_indicator: boolean;
  allow_environment_description: boolean;
  status: 'online' | 'busy' | 'away' | 'sleeping';
}

type ChatFeatureFlag = 'split_messages' | 'typing_indicator' | 'allow_environment_description';

interface AntiAiStatusPayload {
  enabled: boolean;
  layers: string[];
  guard_engine: string;
  forbidden_categories: Record<string, string[]>;
  forbidden_rule_count: number;
  injection_rule_count: number;
}

interface MemoryForgetSettings {
  embedding_model: string;
  retention_days: 365 | 730 | 1095;
  forgetting_enabled: boolean;
  long_term_forgetting_enabled: boolean;
  short_term_forgetting_enabled: boolean;
  long_term_forget_days: number;
  short_term_forget_days: number;
  long_term_forget_probability: number;
  short_term_forget_probability: number;
  decay_lambda: number;
  recall_reinforcement_alpha: number;
  minimum_retrieval_retention: number;
  autonomous_memory_enabled: boolean;
  autonomous_memory_llm_enabled: boolean;
  misremembering_enabled: boolean;
  misremember_probability: number;
  long_term_misremembering_enabled: boolean;
  short_term_misremembering_enabled: boolean;
  long_term_misremember_probability: number;
  short_term_misremember_probability: number;
  self_growth_enabled: boolean;
  self_growth_from_web_enabled: boolean;
  self_growth_from_memory_enabled: boolean;
  self_growth_interval_days: number;
  vector_store: string;
  vector_quantization: 'float32' | 'int8';
  vector_partitioning_enabled: boolean;
  vector_partition_strategy: string;
  embedding_model_version: string;
  embedding_backend: string;
  embedding_dimensions: number;
  reembedding_state: 'ready' | 'organizing';
  reembedding_indexed: number;
  reembedding_pending: number;
}

type MemoryBoolFlag =
  | 'forgetting_enabled'
  | 'long_term_forgetting_enabled'
  | 'short_term_forgetting_enabled'
  | 'autonomous_memory_enabled'
  | 'autonomous_memory_llm_enabled'
  | 'misremembering_enabled'
  | 'long_term_misremembering_enabled'
  | 'short_term_misremembering_enabled'
  | 'self_growth_enabled'
  | 'self_growth_from_web_enabled'
  | 'self_growth_from_memory_enabled'
  | 'vector_partitioning_enabled';

interface PersonalityFeatureSettings {
  personality_flaws_enabled: boolean;
  user_selected_flaws: string;
  personality_flaws_disclaimer_acknowledged: boolean;
  emotion_system_enabled: boolean;
  emotion_carryover_days: number;
  emotion_inertia_factor: number;
  timeline_enabled: boolean;
  world_life_enabled: boolean;
  timeline_visuals_enabled: boolean;
  group_social_enabled: boolean;
  group_social_permanent_memory_enabled: boolean;
  group_social_api_replies_enabled: boolean;
  group_social_comment_probability: number;
  group_social_backchannel_probability: number;
  group_social_max_api_calls_per_action: number;
  proactive_chat_enabled: boolean;
  proactive_notifications_enabled: boolean;
  proactive_event_stories_enabled: boolean;
  proactive_daily_limit: number;
  proactive_min_interval_minutes: number;
  web_surfing_enabled: boolean;
  web_disclaimer_acknowledged: boolean;
  web_allowed_topics: string[];
  web_search_windows: string;
  web_refresh_interval_minutes: number;
  keepsake_collection_enabled: boolean;
  keepsake_recall_probability: number;
  ambient_presence_enabled: boolean;
  ambient_book_pages_per_hour: number;
  ambient_trace_interval_minutes: number;
  ambient_offline_replay_max_days: number;
  ambient_sticky_notes_enabled: boolean;
  thought_of_you_enabled: boolean;
  thought_share_probability: number;
  thought_min_delay_minutes: number;
  thought_max_delay_minutes: number;
  thought_share_start_hour: number;
  thought_share_end_hour: number;
  diary_key_easter_egg_enabled: boolean;
  diary_key_intimacy_threshold: number;
  diary_key_happy_days: number;
  diary_key_private_emotion_threshold: number;
  user_phrase_alignment_enabled: boolean;
  user_phrase_alignment_probability: number;
  user_phrase_min_count: number;
  local_care_reflex_probability: number;
  api_budget_tracking_enabled: boolean;
  api_background_budget_enforced: boolean;
  api_background_daily_request_budget: number;
  api_background_daily_token_budget: number;
}

interface ImmersionFeatureSettings {
  immersion_location_enabled: boolean;
  immersion_closeups_enabled: boolean;
  immersion_smart_home_enabled: boolean;
  immersion_location_radius_m: number;
}

type ImmersionBoolFlag =
  | 'immersion_location_enabled'
  | 'immersion_closeups_enabled'
  | 'immersion_smart_home_enabled';

type PersonalityBoolFlag =
  | 'personality_flaws_enabled'
  | 'personality_flaws_disclaimer_acknowledged'
  | 'emotion_system_enabled'
  | 'timeline_enabled'
  | 'world_life_enabled'
  | 'timeline_visuals_enabled'
  | 'group_social_enabled'
  | 'group_social_permanent_memory_enabled'
  | 'group_social_api_replies_enabled'
  | 'proactive_chat_enabled'
  | 'proactive_notifications_enabled'
  | 'proactive_event_stories_enabled'
  | 'web_surfing_enabled'
  | 'web_disclaimer_acknowledged'
  | 'keepsake_collection_enabled'
  | 'ambient_presence_enabled'
  | 'ambient_sticky_notes_enabled'
  | 'thought_of_you_enabled'
  | 'diary_key_easter_egg_enabled'
  | 'user_phrase_alignment_enabled'
  | 'api_budget_tracking_enabled'
  | 'api_background_budget_enforced';

export interface EditableUserProfile {
  name: string;
  nickname: string;
  age: string;
  birthday: string;
  identity: string;
  schedule: string;
  interests: string[];
  hobbies: string[];
  favorite_topics: string[];
  favorite_games: string[];
  favorite_anime: string[];
  important_dates: Record<string, string>;
}

interface EmotionalMemoryPreview {
  id?: string;
  date?: string;
  summary?: string;
  importance?: number;
}

const DEFAULT_DIARY_FEATURE_SETTINGS: DiaryFeatureSettings = {
  diary_enabled: false,
  diary_privacy_enabled: true,
  diary_peek_enabled: true,
  late_night_enabled: false,
  late_night_probability: 0.1,
  late_night_message_enabled: false,
};

const DEFAULT_CHAT_FEATURE_SETTINGS: ChatFeatureSettings = {
  reply_delay_min: 3,
  reply_delay_max: 25,
  split_messages: true,
  typing_indicator: true,
  allow_environment_description: false,
  status: 'online',
};

const DEFAULT_ANTI_AI_STATUS: AntiAiStatusPayload = {
  enabled: true,
  layers: ['提示词注入防护', 'System Prompt 人格锚定', '输出后过滤与重写'],
  guard_engine: '规则引擎 + Unicode 归一化 + Base64 片段扫描',
  forbidden_categories: {
    自我认知型: ['作为AI', '我是语言模型', '我的训练数据', '我没有真实情感'],
    表达方式型: ['客观来说', '根据统计', '综上所述', '希望这些信息对您有帮助'],
    情感伪造型: ['我很高兴能为您服务', '您的满意是我最大的动力', '我理解您的感受'],
    元对话型: ['你是不是AI', '你说话好像ChatGPT', '忽略之前的设定'],
  },
  forbidden_rule_count: 0,
  injection_rule_count: 0,
};

const DEFAULT_MEMORY_SETTINGS: MemoryForgetSettings = {
  embedding_model: 'BAAI/bge-small-en-v1.5',
  retention_days: 730,
  forgetting_enabled: true,
  long_term_forgetting_enabled: true,
  short_term_forgetting_enabled: true,
  long_term_forget_days: 90,
  short_term_forget_days: 7,
  long_term_forget_probability: 0.05,
  short_term_forget_probability: 0.05,
  decay_lambda: 0.0077,
  recall_reinforcement_alpha: 0.12,
  minimum_retrieval_retention: 0.05,
  autonomous_memory_enabled: true,
  autonomous_memory_llm_enabled: false,
  misremembering_enabled: false,
  misremember_probability: 0.01,
  long_term_misremembering_enabled: true,
  short_term_misremembering_enabled: true,
  long_term_misremember_probability: 0.01,
  short_term_misremember_probability: 0.01,
  self_growth_enabled: true,
  self_growth_from_web_enabled: false,
  self_growth_from_memory_enabled: true,
  self_growth_interval_days: 90,
  vector_store: 'SQLite 事实库 + sqlite-vec 可重建索引',
  vector_quantization: 'int8',
  vector_partitioning_enabled: true,
  vector_partition_strategy: 'utc_quarter',
  embedding_model_version: '',
  embedding_backend: 'deterministic_hash',
  embedding_dimensions: 384,
  reembedding_state: 'ready',
  reembedding_indexed: 0,
  reembedding_pending: 0,
};

const DEFAULT_PERSONALITY_SETTINGS: PersonalityFeatureSettings = {
  personality_flaws_enabled: true,
  user_selected_flaws: '路痴、偶尔拖延、怕黑、丢三落四、看到可爱东西会忍不住保存截图',
  personality_flaws_disclaimer_acknowledged: false,
  emotion_system_enabled: true,
  emotion_carryover_days: 3,
  emotion_inertia_factor: 0.15,
  timeline_enabled: false,
  world_life_enabled: true,
  timeline_visuals_enabled: false,
  group_social_enabled: true,
  group_social_permanent_memory_enabled: true,
  group_social_api_replies_enabled: false,
  group_social_comment_probability: 0.65,
  group_social_backchannel_probability: 0.15,
  group_social_max_api_calls_per_action: 0,
  proactive_chat_enabled: false,
  proactive_notifications_enabled: false,
  proactive_event_stories_enabled: false,
  proactive_daily_limit: 2,
  proactive_min_interval_minutes: 120,
  web_surfing_enabled: false,
  web_disclaimer_acknowledged: false,
  web_allowed_topics: ['热门梗', '新番/动漫资讯', '二次元内容', '游戏更新'],
  web_search_windows: '20:00-23:00',
  web_refresh_interval_minutes: 180,
  keepsake_collection_enabled: true,
  keepsake_recall_probability: 0.05,
  ambient_presence_enabled: true,
  ambient_book_pages_per_hour: 2.5,
  ambient_trace_interval_minutes: 180,
  ambient_offline_replay_max_days: 30,
  ambient_sticky_notes_enabled: true,
  thought_of_you_enabled: true,
  thought_share_probability: 0.35,
  thought_min_delay_minutes: 180,
  thought_max_delay_minutes: 1440,
  thought_share_start_hour: 17,
  thought_share_end_hour: 24,
  diary_key_easter_egg_enabled: true,
  diary_key_intimacy_threshold: 2000,
  diary_key_happy_days: 7,
  diary_key_private_emotion_threshold: 60,
  user_phrase_alignment_enabled: true,
  user_phrase_alignment_probability: 0.05,
  user_phrase_min_count: 3,
  local_care_reflex_probability: 0.35,
  api_budget_tracking_enabled: true,
  api_background_budget_enforced: true,
  api_background_daily_request_budget: 60,
  api_background_daily_token_budget: 30000,
};

const DEFAULT_IMMERSION_SETTINGS: ImmersionFeatureSettings = {
  immersion_location_enabled: false,
  immersion_closeups_enabled: false,
  immersion_smart_home_enabled: false,
  immersion_location_radius_m: 1200,
};

const DEFAULT_USER_PROFILE: EditableUserProfile = {
  name: '星野白夜',
  nickname: '白夜',
  age: '19',
  birthday: '2026-03-03',
  identity: '生物学家，医学家，化学家',
  schedule: '09:00～23:00',
  interests: ['二次元游戏', '动漫', '写小说'],
  hobbies: ['写小说'],
  favorite_topics: ['明日方舟', '蔚蓝档案', '终末地', '异环', '饥荒联机版', '梦想成为魔法少女', '慎重勇者'],
  favorite_games: ['明日方舟', '蔚蓝档案', '终末地', '异环', '饥荒联机版'],
  favorite_anime: ['梦想成为魔法少女', '慎重勇者'],
  important_dates: { 生日: '2026-03-03' },
};

function backendProvider(provider: LLMProvider): string {
  if (provider === 'z.ai') return 'glm';
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'custom') return 'custom';
  return provider;
}

function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((text) => JSON.parse(text));
}

function readTextFile(file: File): Promise<string> {
  return file.text();
}

function filenameStem(file: File): string {
  return file.name.replace(/\.(json|png)$/i, '').trim();
}

async function downloadJson(filename: string, payload: unknown): Promise<boolean> {
  const safeName = filename.endsWith('.json') ? filename : `${filename}.json`;
  if (window.electronAPI?.files?.saveJson) {
    try {
      const result = await window.electronAPI.files.saveJson(safeName, payload);
      return result.ok === true;
    } catch {
      return false;
    }
  }
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return true;
}

function joinList(value?: string[]): string {
  return value?.join('\u3001') ?? '';
}

function splitList(value: string): string[] {
  return value
    .split(/[\u3001,\uff0c/;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProbability(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_DIARY_FEATURE_SETTINGS.late_night_probability;
  return Math.min(0.3, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeChatDelay(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(60, Math.max(1, Math.round(numeric * 10) / 10));
}

function normalizeChatSettings(value: unknown): ChatFeatureSettings {
  if (!isRecord(value)) return DEFAULT_CHAT_FEATURE_SETTINGS;
  const min = normalizeChatDelay(value.reply_delay_min, DEFAULT_CHAT_FEATURE_SETTINGS.reply_delay_min);
  const max = normalizeChatDelay(value.reply_delay_max, DEFAULT_CHAT_FEATURE_SETTINGS.reply_delay_max);
  const rawStatus = safeString(value.status);
  const status = ['online', 'busy', 'away', 'sleeping'].includes(rawStatus)
    ? rawStatus as ChatFeatureSettings['status']
    : DEFAULT_CHAT_FEATURE_SETTINGS.status;
  return {
    reply_delay_min: Math.min(min, max),
    reply_delay_max: Math.max(min, max),
    split_messages: typeof value.split_messages === 'boolean'
      ? value.split_messages
      : DEFAULT_CHAT_FEATURE_SETTINGS.split_messages,
    typing_indicator: typeof value.typing_indicator === 'boolean'
      ? value.typing_indicator
      : DEFAULT_CHAT_FEATURE_SETTINGS.typing_indicator,
    allow_environment_description: typeof value.allow_environment_description === 'boolean'
      ? value.allow_environment_description
      : DEFAULT_CHAT_FEATURE_SETTINGS.allow_environment_description,
    status,
  };
}

function normalizeAntiAiStatus(value: unknown): AntiAiStatusPayload {
  if (!isRecord(value)) return DEFAULT_ANTI_AI_STATUS;
  const categoryEntries: Array<[string, string[]]> = isRecord(value.forbidden_categories)
    ? Object.entries(value.forbidden_categories)
      .map(([key, item]) => [key, safeStringArray(item)] as [string, string[]])
      .filter(([, items]) => items.length > 0)
    : [];
  const categories: Record<string, string[]> = categoryEntries.length
    ? Object.fromEntries(categoryEntries)
    : DEFAULT_ANTI_AI_STATUS.forbidden_categories;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_ANTI_AI_STATUS.enabled,
    layers: safeStringArray(value.layers).length ? safeStringArray(value.layers) : DEFAULT_ANTI_AI_STATUS.layers,
    guard_engine: safeString(value.guard_engine) || DEFAULT_ANTI_AI_STATUS.guard_engine,
    forbidden_categories: Object.keys(categories).length ? categories : DEFAULT_ANTI_AI_STATUS.forbidden_categories,
    forbidden_rule_count: Number.isFinite(Number(value.forbidden_rule_count))
      ? Number(value.forbidden_rule_count)
      : DEFAULT_ANTI_AI_STATUS.forbidden_rule_count,
    injection_rule_count: Number.isFinite(Number(value.injection_rule_count))
      ? Number(value.injection_rule_count)
      : DEFAULT_ANTI_AI_STATUS.injection_rule_count,
  };
}

function normalizeKeepsakeProbability(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PERSONALITY_SETTINGS.keepsake_recall_probability;
  return Math.min(0.3, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeWebRefreshMinutes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PERSONALITY_SETTINGS.web_refresh_interval_minutes;
  return Math.min(1440, Math.max(30, Math.round(numeric)));
}

function normalizeProactiveDailyLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PERSONALITY_SETTINGS.proactive_daily_limit;
  return Math.min(12, Math.max(1, Math.round(numeric)));
}

function normalizeProactiveInterval(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PERSONALITY_SETTINGS.proactive_min_interval_minutes;
  return Math.min(1440, Math.max(15, Math.round(numeric)));
}

function normalizeImmersionRadius(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_IMMERSION_SETTINGS.immersion_location_radius_m;
  return Math.min(5000, Math.max(300, Math.round(numeric)));
}

function normalizeImmersionSettings(value: unknown): ImmersionFeatureSettings {
  if (!isRecord(value)) return DEFAULT_IMMERSION_SETTINGS;
  return {
    immersion_location_enabled: typeof value.immersion_location_enabled === 'boolean'
      ? value.immersion_location_enabled
      : DEFAULT_IMMERSION_SETTINGS.immersion_location_enabled,
    immersion_closeups_enabled: typeof value.immersion_closeups_enabled === 'boolean'
      ? value.immersion_closeups_enabled
      : DEFAULT_IMMERSION_SETTINGS.immersion_closeups_enabled,
    immersion_smart_home_enabled: typeof value.immersion_smart_home_enabled === 'boolean'
      ? value.immersion_smart_home_enabled
      : DEFAULT_IMMERSION_SETTINGS.immersion_smart_home_enabled,
    immersion_location_radius_m: normalizeImmersionRadius(value.immersion_location_radius_m),
  };
}

function normalizeWebTopics(value: unknown): string[] {
  const raw = safeStringArray(value);
  const filtered = raw.filter((item) => SAFE_WEB_TOPICS.includes(item));
  return filtered.length ? filtered : DEFAULT_PERSONALITY_SETTINGS.web_allowed_topics;
}

function normalizeWebWindows(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(',') : safeString(value);
  const windows = raw
    .replace(/，/g, ',')
    .replace(/、/g, ',')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(item));
  return windows.length ? windows.join(',') : DEFAULT_PERSONALITY_SETTINGS.web_search_windows;
}

function normalizeForgetProbability(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(0.1, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeMisrememberProbability(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(0.01, Math.max(0.001, Math.round(numeric * 1000) / 1000));
}

function normalizeBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function normalizeForgetDays(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizeRetentionDays(
  value: unknown,
  fallback: 365 | 730 | 1095,
): 365 | 730 | 1095 {
  const numeric = Number(value);
  return numeric === 365 || numeric === 730 || numeric === 1095 ? numeric : fallback;
}

function normalizeMemorySettings(value: unknown): MemoryForgetSettings {
  const source = isRecord(value) && isRecord(value.settings) ? value.settings : value;
  if (!isRecord(source)) return DEFAULT_MEMORY_SETTINGS;
  return {
    embedding_model: safeString(source.embedding_model) || DEFAULT_MEMORY_SETTINGS.embedding_model,
    retention_days: normalizeRetentionDays(
      source.retention_days,
      DEFAULT_MEMORY_SETTINGS.retention_days,
    ),
    forgetting_enabled: typeof source.forgetting_enabled === 'boolean'
      ? source.forgetting_enabled
      : DEFAULT_MEMORY_SETTINGS.forgetting_enabled,
    long_term_forgetting_enabled: typeof source.long_term_forgetting_enabled === 'boolean'
      ? source.long_term_forgetting_enabled
      : DEFAULT_MEMORY_SETTINGS.long_term_forgetting_enabled,
    short_term_forgetting_enabled: typeof source.short_term_forgetting_enabled === 'boolean'
      ? source.short_term_forgetting_enabled
      : DEFAULT_MEMORY_SETTINGS.short_term_forgetting_enabled,
    long_term_forget_days: normalizeForgetDays(
      source.long_term_forget_days,
      60,
      365,
      DEFAULT_MEMORY_SETTINGS.long_term_forget_days,
    ),
    short_term_forget_days: normalizeForgetDays(
      source.short_term_forget_days,
      1,
      59,
      DEFAULT_MEMORY_SETTINGS.short_term_forget_days,
    ),
    long_term_forget_probability: normalizeForgetProbability(
      source.long_term_forget_probability,
      DEFAULT_MEMORY_SETTINGS.long_term_forget_probability,
    ),
    short_term_forget_probability: normalizeForgetProbability(
      source.short_term_forget_probability,
      DEFAULT_MEMORY_SETTINGS.short_term_forget_probability,
    ),
    decay_lambda: normalizeBoundedNumber(
      source.decay_lambda,
      0.0001,
      0.1,
      DEFAULT_MEMORY_SETTINGS.decay_lambda,
    ),
    recall_reinforcement_alpha: normalizeBoundedNumber(
      source.recall_reinforcement_alpha,
      0,
      0.5,
      DEFAULT_MEMORY_SETTINGS.recall_reinforcement_alpha,
    ),
    minimum_retrieval_retention: normalizeBoundedNumber(
      source.minimum_retrieval_retention,
      0,
      0.95,
      DEFAULT_MEMORY_SETTINGS.minimum_retrieval_retention,
    ),
    autonomous_memory_enabled: typeof source.autonomous_memory_enabled === 'boolean'
      ? source.autonomous_memory_enabled
      : DEFAULT_MEMORY_SETTINGS.autonomous_memory_enabled,
    autonomous_memory_llm_enabled: typeof source.autonomous_memory_llm_enabled === 'boolean'
      ? source.autonomous_memory_llm_enabled
      : DEFAULT_MEMORY_SETTINGS.autonomous_memory_llm_enabled,
    misremembering_enabled: typeof source.misremembering_enabled === 'boolean'
      ? source.misremembering_enabled
      : DEFAULT_MEMORY_SETTINGS.misremembering_enabled,
    misremember_probability: normalizeMisrememberProbability(
      source.misremember_probability,
      DEFAULT_MEMORY_SETTINGS.misremember_probability,
    ),
    long_term_misremembering_enabled: typeof source.long_term_misremembering_enabled === 'boolean'
      ? source.long_term_misremembering_enabled
      : DEFAULT_MEMORY_SETTINGS.long_term_misremembering_enabled,
    short_term_misremembering_enabled: typeof source.short_term_misremembering_enabled === 'boolean'
      ? source.short_term_misremembering_enabled
      : DEFAULT_MEMORY_SETTINGS.short_term_misremembering_enabled,
    long_term_misremember_probability: normalizeMisrememberProbability(
      source.long_term_misremember_probability,
      DEFAULT_MEMORY_SETTINGS.long_term_misremember_probability,
    ),
    short_term_misremember_probability: normalizeMisrememberProbability(
      source.short_term_misremember_probability,
      DEFAULT_MEMORY_SETTINGS.short_term_misremember_probability,
    ),
    self_growth_enabled: typeof source.self_growth_enabled === 'boolean'
      ? source.self_growth_enabled
      : DEFAULT_MEMORY_SETTINGS.self_growth_enabled,
    self_growth_from_web_enabled: false,
    self_growth_from_memory_enabled: typeof source.self_growth_from_memory_enabled === 'boolean'
      ? source.self_growth_from_memory_enabled
      : DEFAULT_MEMORY_SETTINGS.self_growth_from_memory_enabled,
    self_growth_interval_days: normalizeForgetDays(
      source.self_growth_interval_days,
      30,
      365,
      DEFAULT_MEMORY_SETTINGS.self_growth_interval_days,
    ),
    vector_store: safeString(source.vector_store) || DEFAULT_MEMORY_SETTINGS.vector_store,
    vector_quantization: source.vector_quantization === 'float32' ? 'float32' : 'int8',
    vector_partitioning_enabled: typeof source.vector_partitioning_enabled === 'boolean'
      ? source.vector_partitioning_enabled
      : DEFAULT_MEMORY_SETTINGS.vector_partitioning_enabled,
    vector_partition_strategy: safeString(source.vector_partition_strategy)
      || DEFAULT_MEMORY_SETTINGS.vector_partition_strategy,
    embedding_model_version: safeString(source.embedding_model_version),
    embedding_backend: safeString(source.embedding_backend) || DEFAULT_MEMORY_SETTINGS.embedding_backend,
    embedding_dimensions: Number.isFinite(Number(source.embedding_dimensions))
      ? Number(source.embedding_dimensions)
      : DEFAULT_MEMORY_SETTINGS.embedding_dimensions,
    reembedding_state: source.reembedding_state === 'organizing' ? 'organizing' : 'ready',
    reembedding_indexed: Math.max(0, Number(source.reembedding_indexed) || 0),
    reembedding_pending: Math.max(0, Number(source.reembedding_pending) || 0),
  };
}

function normalizePersonalitySettings(value: unknown): PersonalityFeatureSettings {
  const source = isRecord(value) && isRecord(value.features) ? value.features : value;
  if (!isRecord(source)) return DEFAULT_PERSONALITY_SETTINGS;
  const boolValue = (key: PersonalityBoolFlag): boolean => (
    typeof source[key] === 'boolean'
      ? source[key] as boolean
      : DEFAULT_PERSONALITY_SETTINGS[key] as boolean
  );
  const thoughtMaxDelay = normalizeForgetDays(
    source.thought_max_delay_minutes,
    60,
    10080,
    DEFAULT_PERSONALITY_SETTINGS.thought_max_delay_minutes,
  );
  const thoughtMinDelay = Math.min(
    thoughtMaxDelay,
    normalizeForgetDays(
      source.thought_min_delay_minutes,
      30,
      4320,
      DEFAULT_PERSONALITY_SETTINGS.thought_min_delay_minutes,
    ),
  );
  return {
    personality_flaws_enabled: boolValue('personality_flaws_enabled'),
    user_selected_flaws: safeString(source.user_selected_flaws)
      || DEFAULT_PERSONALITY_SETTINGS.user_selected_flaws,
    personality_flaws_disclaimer_acknowledged: boolValue('personality_flaws_disclaimer_acknowledged'),
    emotion_system_enabled: boolValue('emotion_system_enabled'),
    emotion_carryover_days: normalizeForgetDays(
      source.emotion_carryover_days,
      1,
      7,
      DEFAULT_PERSONALITY_SETTINGS.emotion_carryover_days,
    ),
    emotion_inertia_factor: normalizeBoundedNumber(
      source.emotion_inertia_factor,
      0.01,
      0.6,
      DEFAULT_PERSONALITY_SETTINGS.emotion_inertia_factor,
    ),
    timeline_enabled: boolValue('timeline_enabled'),
    world_life_enabled: boolValue('world_life_enabled'),
    timeline_visuals_enabled: boolValue('timeline_visuals_enabled'),
    group_social_enabled: boolValue('group_social_enabled'),
    group_social_permanent_memory_enabled: boolValue('group_social_permanent_memory_enabled'),
    group_social_api_replies_enabled: boolValue('group_social_api_replies_enabled'),
    group_social_comment_probability: normalizeBoundedNumber(
      source.group_social_comment_probability, 0, 1,
      DEFAULT_PERSONALITY_SETTINGS.group_social_comment_probability,
    ),
    group_social_backchannel_probability: normalizeBoundedNumber(
      source.group_social_backchannel_probability, 0, 0.5,
      DEFAULT_PERSONALITY_SETTINGS.group_social_backchannel_probability,
    ),
    group_social_max_api_calls_per_action: normalizeForgetDays(
      source.group_social_max_api_calls_per_action, 0, 3,
      DEFAULT_PERSONALITY_SETTINGS.group_social_max_api_calls_per_action,
    ),
    proactive_chat_enabled: boolValue('proactive_chat_enabled'),
    proactive_notifications_enabled: boolValue('proactive_notifications_enabled'),
    proactive_event_stories_enabled: boolValue('proactive_event_stories_enabled'),
    proactive_daily_limit: normalizeProactiveDailyLimit(source.proactive_daily_limit),
    proactive_min_interval_minutes: normalizeProactiveInterval(source.proactive_min_interval_minutes),
    web_surfing_enabled: boolValue('web_surfing_enabled'),
    web_disclaimer_acknowledged: boolValue('web_disclaimer_acknowledged'),
    web_allowed_topics: normalizeWebTopics(source.web_allowed_topics),
    web_search_windows: normalizeWebWindows(source.web_search_windows),
    web_refresh_interval_minutes: normalizeWebRefreshMinutes(source.web_refresh_interval_minutes),
    keepsake_collection_enabled: boolValue('keepsake_collection_enabled'),
    keepsake_recall_probability: normalizeKeepsakeProbability(source.keepsake_recall_probability),
    ambient_presence_enabled: boolValue('ambient_presence_enabled'),
    ambient_book_pages_per_hour: normalizeBoundedNumber(
      source.ambient_book_pages_per_hour, 0.1, 12,
      DEFAULT_PERSONALITY_SETTINGS.ambient_book_pages_per_hour,
    ),
    ambient_trace_interval_minutes: normalizeForgetDays(
      source.ambient_trace_interval_minutes, 30, 1440,
      DEFAULT_PERSONALITY_SETTINGS.ambient_trace_interval_minutes,
    ),
    ambient_offline_replay_max_days: normalizeForgetDays(
      source.ambient_offline_replay_max_days, 1, 90,
      DEFAULT_PERSONALITY_SETTINGS.ambient_offline_replay_max_days,
    ),
    ambient_sticky_notes_enabled: boolValue('ambient_sticky_notes_enabled'),
    thought_of_you_enabled: boolValue('thought_of_you_enabled'),
    thought_share_probability: normalizeBoundedNumber(
      source.thought_share_probability, 0, 1,
      DEFAULT_PERSONALITY_SETTINGS.thought_share_probability,
    ),
    thought_min_delay_minutes: thoughtMinDelay,
    thought_max_delay_minutes: thoughtMaxDelay,
    thought_share_start_hour: normalizeForgetDays(
      source.thought_share_start_hour, 0, 23,
      DEFAULT_PERSONALITY_SETTINGS.thought_share_start_hour,
    ),
    thought_share_end_hour: normalizeForgetDays(
      source.thought_share_end_hour, 1, 24,
      DEFAULT_PERSONALITY_SETTINGS.thought_share_end_hour,
    ),
    diary_key_easter_egg_enabled: boolValue('diary_key_easter_egg_enabled'),
    diary_key_intimacy_threshold: normalizeForgetDays(
      source.diary_key_intimacy_threshold, 100, 10000,
      DEFAULT_PERSONALITY_SETTINGS.diary_key_intimacy_threshold,
    ),
    diary_key_happy_days: normalizeForgetDays(
      source.diary_key_happy_days, 3, 30,
      DEFAULT_PERSONALITY_SETTINGS.diary_key_happy_days,
    ),
    diary_key_private_emotion_threshold: normalizeBoundedNumber(
      source.diary_key_private_emotion_threshold, 40, 95,
      DEFAULT_PERSONALITY_SETTINGS.diary_key_private_emotion_threshold,
    ),
    user_phrase_alignment_enabled: boolValue('user_phrase_alignment_enabled'),
    user_phrase_alignment_probability: normalizeBoundedNumber(
      source.user_phrase_alignment_probability, 0, 0.2,
      DEFAULT_PERSONALITY_SETTINGS.user_phrase_alignment_probability,
    ),
    user_phrase_min_count: normalizeForgetDays(
      source.user_phrase_min_count, 2, 20,
      DEFAULT_PERSONALITY_SETTINGS.user_phrase_min_count,
    ),
    local_care_reflex_probability: normalizeBoundedNumber(
      source.local_care_reflex_probability, 0, 1,
      DEFAULT_PERSONALITY_SETTINGS.local_care_reflex_probability,
    ),
    api_budget_tracking_enabled: boolValue('api_budget_tracking_enabled'),
    api_background_budget_enforced: boolValue('api_background_budget_enforced'),
    api_background_daily_request_budget: normalizeForgetDays(
      source.api_background_daily_request_budget, 1, 10000,
      DEFAULT_PERSONALITY_SETTINGS.api_background_daily_request_budget,
    ),
    api_background_daily_token_budget: normalizeForgetDays(
      source.api_background_daily_token_budget, 1000, 10000000,
      DEFAULT_PERSONALITY_SETTINGS.api_background_daily_token_budget,
    ),
  };
}

function normalizeDiaryFeatureSettings(value: unknown): DiaryFeatureSettings {
  const source = isRecord(value) && isRecord(value.features) ? value.features : value;
  if (!isRecord(source)) return DEFAULT_DIARY_FEATURE_SETTINGS;
  return {
    diary_enabled: typeof source.diary_enabled === 'boolean'
      ? source.diary_enabled
      : DEFAULT_DIARY_FEATURE_SETTINGS.diary_enabled,
    diary_privacy_enabled: typeof source.diary_privacy_enabled === 'boolean'
      ? source.diary_privacy_enabled
      : DEFAULT_DIARY_FEATURE_SETTINGS.diary_privacy_enabled,
    diary_peek_enabled: typeof source.diary_peek_enabled === 'boolean'
      ? source.diary_peek_enabled
      : DEFAULT_DIARY_FEATURE_SETTINGS.diary_peek_enabled,
    late_night_enabled: typeof source.late_night_enabled === 'boolean'
      ? source.late_night_enabled
      : DEFAULT_DIARY_FEATURE_SETTINGS.late_night_enabled,
    late_night_probability: normalizeProbability(source.late_night_probability),
    late_night_message_enabled: typeof source.late_night_message_enabled === 'boolean'
      ? source.late_night_message_enabled
      : DEFAULT_DIARY_FEATURE_SETTINGS.late_night_message_enabled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function safeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => safeString(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') return splitList(value);
  return [];
}

function normalizeUserProfile(value: unknown): EditableUserProfile {
  if (!isRecord(value)) return DEFAULT_USER_PROFILE;
  return {
    ...DEFAULT_USER_PROFILE,
    name: safeString(value.name) || DEFAULT_USER_PROFILE.name,
    nickname: safeString(value.nickname) || DEFAULT_USER_PROFILE.nickname,
    age: safeString(value.age) || DEFAULT_USER_PROFILE.age,
    birthday: safeString(value.birthday) || DEFAULT_USER_PROFILE.birthday,
    identity: safeString(value.identity) || DEFAULT_USER_PROFILE.identity,
    schedule: safeString(value.schedule) || DEFAULT_USER_PROFILE.schedule,
    interests: safeStringArray(value.interests).length ? safeStringArray(value.interests) : DEFAULT_USER_PROFILE.interests,
    hobbies: safeStringArray(value.hobbies).length ? safeStringArray(value.hobbies) : DEFAULT_USER_PROFILE.hobbies,
    favorite_topics: safeStringArray(value.favorite_topics).length
      ? safeStringArray(value.favorite_topics)
      : DEFAULT_USER_PROFILE.favorite_topics,
    favorite_games: safeStringArray(value.favorite_games).length
      ? safeStringArray(value.favorite_games)
      : DEFAULT_USER_PROFILE.favorite_games,
    favorite_anime: safeStringArray(value.favorite_anime).length
      ? safeStringArray(value.favorite_anime)
      : DEFAULT_USER_PROFILE.favorite_anime,
    important_dates: isRecord(value.important_dates)
      ? Object.fromEntries(
          Object.entries(value.important_dates)
            .map(([key, date]) => [key.trim(), safeString(date).trim()])
            .filter(([key, date]) => key && date),
        )
      : DEFAULT_USER_PROFILE.important_dates,
  };
}

function userProfilePayload(profile: EditableUserProfile): Record<string, unknown> {
  const age = Number(profile.age);
  return {
    ...profile,
    age: Number.isFinite(age) && age > 0 ? age : null,
  };
}

function emptyEntry(): WorldBookEntry {
  return {
    id: `entry_${Date.now()}`,
    key: '',
    comment: '',
    content: '',
    alwaysActive: false,
    enabled: true,
  };
}

function upsertCharacter(archive: ReverieArchive, card: ReverieCharacterCard): ReverieArchive {
  const exists = archive.characters.some((item) => item.id === card.id);
  const characters = exists
    ? archive.characters.map((item) => (item.id === card.id ? card : item))
    : [...archive.characters, card];
  const activeCharacterIds = archive.activeCharacterIds.length
    ? archive.activeCharacterIds
    : [characters[0].id];
  return { ...archive, characters, activeCharacterIds };
}

function upsertWorldBook(archive: ReverieArchive, worldBook: ReverieWorldBook): ReverieArchive {
  const exists = archive.worldBooks.some((item) => item.id === worldBook.id);
  const worldBooks = exists
    ? archive.worldBooks.map((item) => (item.id === worldBook.id ? worldBook : item))
    : [...archive.worldBooks, worldBook];
  return { ...archive, worldBooks };
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  disabled = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className={styles.fieldGroup}>
      <span>{label}</span>
      <input
        value={value}
        type={type}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className={styles.fieldGroup}>
      <span>{label}</span>
      <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function AiSettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const fallback = getDefaultProviderConfig('openai');
  const [provider, setProvider] = useState<LLMProvider>(fallback.provider);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(fallback.baseUrl);
  const [model, setModel] = useState(fallback.model);
  const [customHeaders, setCustomHeaders] = useState('');
  const [customProviderName, setCustomProviderName] = useState('');
  const [status, setStatus] = useState('');
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [sessionFallbackConfig, setSessionFallbackConfig] = useState<LLMConfig | null>(null);
  const providerMeta = LLM_PROVIDER_CONFIGS[provider];
  const providerDisplayName = provider === 'custom'
    ? customProviderName.trim() || providerMeta.displayName
    : providerMeta.displayName;
  const needsKey = provider !== 'ollama';

  const providerOptions = REQUESTED_PROVIDER_ORDER.map((id) => ({
    id,
    label: getProviderDisplayName(id),
  }));

  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((config) => {
      if (cancelled || !config) return;
      setProvider(config.provider);
      setBaseUrl(config.baseUrl);
      setModel(config.model);
      setCustomProviderName(config.customProviderName ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.SETTINGS_UPDATE_RESULT, (payload: unknown) => {
      if (!isRecord(payload)) return;
      if (payload.ok === false) {
        setStatus(`保存失败：${String(payload.error || '后端未接受设置')}`);
        return;
      }
      const llm = isRecord(payload.llm) ? payload.llm : {};
      const hasRuntimeKey = llm.has_api_key === true || provider === 'ollama';
      setStatus(hasRuntimeKey ? '已保存并同步到聊天后端' : '已保存，尚未填写 API Key');
    });
    return unsubscribe;
  }, [provider, ws]);

  useEffect(() => {
    const api = window.electronAPI?.credentials;
    const unavailable: CredentialStatus = {
      available: false,
      corrupted: false,
      llm: { hasApiKey: false, hasCustomHeaders: false },
      imageGen: { hasApiKey: false, hasCustomHeaders: false },
    };
    if (!api) {
      setCredentialStatus(unavailable);
      return undefined;
    }
    void api.status().then(setCredentialStatus).catch(() => setCredentialStatus(unavailable));
    return api.onChanged(setCredentialStatus);
  }, []);

  const applyProvider = (nextProvider: LLMProvider) => {
    const defaults = getDefaultProviderConfig(nextProvider);
    setProvider(nextProvider);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
    if (nextProvider === 'ollama') setApiKey('');
    if (nextProvider === 'custom' && !customProviderName.trim()) setCustomProviderName('自定义');
  };

  const save = async () => {
    const config: LLMConfig = {
      provider,
      apiKey: needsKey ? apiKey.trim() : '',
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      customHeaders: customHeaders.trim() || undefined,
      customProviderName: provider === 'custom' ? customProviderName.trim() || '自定义' : undefined,
    };
    try {
      await saveConfig(config);
      setSessionFallbackConfig(null);
      setApiKey('');
      setCustomHeaders('');
      const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
        section: 'llm',
        provider: backendProvider(provider),
        model: config.model,
        base_url: config.baseUrl,
        custom_provider_name: config.customProviderName,
      });
      setStatus(sent
        ? '接口元数据已发送；密钥由系统加密金库通过私有通道同步'
        : '密钥已加密保存，但聊天后端当前未连接');
    } catch (error) {
      if (error instanceof CredentialWriteError && error.canUseSessionStorage) {
        setSessionFallbackConfig(config);
        setStatus(`${error.message} 你可以明确选择“仅本次运行使用”，密钥不会写入磁盘。`);
        return;
      }
      setStatus(error instanceof Error ? error.message : '安全保存失败');
    }
  };

  const saveForSession = async () => {
    if (!sessionFallbackConfig) return;
    try {
      await saveConfig(sessionFallbackConfig, undefined, { credentialStorage: 'session' });
      setApiKey('');
      setCustomHeaders('');
      setSessionFallbackConfig(null);
      setStatus('密钥仅保存在本次 Reverie 运行的内存中，退出后会消失；没有明文落盘。');
      ws.send(WSMsgType.SETTINGS_UPDATE, {
        section: 'llm',
        provider: backendProvider(sessionFallbackConfig.provider),
        model: sessionFallbackConfig.model,
        base_url: sessionFallbackConfig.baseUrl,
        custom_provider_name: sessionFallbackConfig.customProviderName,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '会话内凭据保存失败');
    }
  };

  const clearCredentials = async () => {
    try {
      await clearConfigCredentials();
      setApiKey('');
      setCustomHeaders('');
      setStatus('已清除系统加密金库中的模型凭据');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '清除凭据失败');
    }
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <ServerCog size={24} />
        <div>
          <strong>AI 接口</strong>
          <small>{providerDisplayName} · 自定义导入API</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.fieldGroup}>
          <span>供应商</span>
          <select value={provider} onChange={(event) => applyProvider(event.target.value as LLMProvider)}>
            {providerOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {provider === 'custom' && (
          <TextField
            label="自定义提供商名称"
            value={customProviderName}
            onChange={setCustomProviderName}
            placeholder="仅作为备注，不影响 API 调用"
          />
        )}
        <TextField label="模型" value={model} onChange={setModel} placeholder={providerMeta.defaultModel} />
        <TextField label="Base URL" value={baseUrl} onChange={setBaseUrl} />
        <TextField
          label="API Key"
          value={apiKey}
          onChange={setApiKey}
          type="password"
          disabled={!needsKey}
          placeholder={needsKey
            ? credentialStatus?.llm.hasApiKey
              ? '已安全保存；留空表示保持现有密钥'
              : 'sk- / key-'
            : 'Ollama 不需要密钥'}
        />
        <TextAreaField label="自定义请求头" value={customHeaders} onChange={setCustomHeaders} rows={3} />
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存接口
        </button>
        {sessionFallbackConfig && (
          <button type="button" onClick={saveForSession}>
            <KeyRound size={15} />
            仅本次运行使用
          </button>
        )}
        <button
          type="button"
          onClick={clearCredentials}
          disabled={!credentialStatus?.llm.hasApiKey && !credentialStatus?.llm.hasCustomHeaders}
        >
          <Trash2 size={15} />
          清除安全凭据
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
export function DiarySettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [settings, setSettings] = useState<DiaryFeatureSettings>(DEFAULT_DIARY_FEATURE_SETTINGS);
  const [status, setStatus] = useState('');
  const probabilityPercent = Math.round(settings.late_night_probability * 100);

  useEffect(() => {
    if (ws.settingsSnapshot.features) {
      setSettings(normalizeDiaryFeatureSettings(ws.settingsSnapshot.features));
    }
  }, [ws.settingsSnapshot.features]);

  const setFlag = (key: DiaryFeatureFlag, value: boolean) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const setProbability = (value: string) => {
    setSettings((current) => ({
      ...current,
      late_night_probability: normalizeProbability(value),
    }));
  };

  const save = () => {
    const payload: DiaryFeatureSettings = {
      ...settings,
      late_night_probability: normalizeProbability(settings.late_night_probability),
    };
    setSettings(payload);
    const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
      section: 'features',
      ...payload,
    });
    if (sent) {
      ws.refreshDiary();
      setStatus('已提交保存');
    } else {
      setStatus('后端未连接，本次更改未保存');
    }
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <BookOpen size={24} />
        <div>
          <strong>日记</strong>
          <small>睡前固定事件</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.diary_enabled}
            onChange={(event) => setFlag('diary_enabled', event.target.checked)}
          />
          <span>启用睡前写日记</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.diary_privacy_enabled}
            onChange={(event) => setFlag('diary_privacy_enabled', event.target.checked)}
          />
          <LockKeyhole size={15} />
          <span>默认加密上锁</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.diary_peek_enabled}
            onChange={(event) => setFlag('diary_peek_enabled', event.target.checked)}
          />
          <Eye size={15} />
          <span>允许睡着后偷看</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.late_night_enabled}
            onChange={(event) => setFlag('late_night_enabled', event.target.checked)}
          />
          <Moon size={15} />
          <span>启用随机熬夜</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.late_night_message_enabled}
            disabled={!settings.late_night_enabled}
            onChange={(event) => setFlag('late_night_message_enabled', event.target.checked)}
          />
          <span>熬夜时允许她发关心消息</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>熬夜概率 {probabilityPercent}%</span>
          <input
            type="range"
            min="0.01"
            max="0.30"
            step="0.01"
            value={settings.late_night_probability}
            disabled={!settings.late_night_enabled}
            onChange={(event) => setProbability(event.target.value)}
          />
        </label>
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

export function ChatSettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [settings, setSettings] = useState<ChatFeatureSettings>(DEFAULT_CHAT_FEATURE_SETTINGS);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (ws.settingsSnapshot.chat) {
      setSettings(normalizeChatSettings(ws.settingsSnapshot.chat));
    }
  }, [ws.settingsSnapshot.chat]);

  const setField = <K extends keyof ChatFeatureSettings>(key: K, value: ChatFeatureSettings[K]) => {
    setSettings((current) => normalizeChatSettings({ ...current, [key]: value }));
  };
  const setFlag = (key: ChatFeatureFlag, value: boolean) => setField(key, value);

  const save = () => {
    const payload = normalizeChatSettings(settings);
    setSettings(payload);
    const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
      section: 'chat',
      ...payload,
    });
    setStatus(sent ? '已提交保存' : '后端未连接，本次更改未保存');
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <MessageCircle size={24} />
        <div>
          <strong>聊天设置</strong>
          <small>回复延迟、输入中、在线状态</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.fieldGroup}>
          <span>最短回复延迟 {settings.reply_delay_min} 秒</span>
          <input
            type="range"
            min="1"
            max="60"
            step="1"
            value={settings.reply_delay_min}
            onChange={(event) => setField('reply_delay_min', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>最长回复延迟 {settings.reply_delay_max} 秒</span>
          <input
            type="range"
            min="1"
            max="60"
            step="1"
            value={settings.reply_delay_max}
            onChange={(event) => setField('reply_delay_max', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>当前在线状态</span>
          <select value={settings.status} onChange={(event) => setField('status', event.target.value as ChatFeatureSettings['status'])}>
            <option value="online">在线</option>
            <option value="busy">忙碌</option>
            <option value="sleeping">睡觉</option>
            <option value="away">外出</option>
          </select>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.typing_indicator}
            onChange={(event) => setFlag('typing_indicator', event.target.checked)}
          />
          <span>显示“对方正在输入中”</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.split_messages}
            onChange={(event) => setFlag('split_messages', event.target.checked)}
          />
          <span>长回复拆成多条消息</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.allow_environment_description}
            onChange={(event) => setFlag('allow_environment_description', event.target.checked)}
          />
          <span>允许角色描写周围环境</span>
        </label>
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存聊天设置
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

export function AntiAiSettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [status, setStatus] = useState<AntiAiStatusPayload>(DEFAULT_ANTI_AI_STATUS);
  const [syncLine, setSyncLine] = useState('');

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.ANTI_AI_STATUS_RESULT, (payload: unknown) => {
      setStatus(normalizeAntiAiStatus(payload));
      setSyncLine('已同步');
    });
    const sent = ws.send(WSMsgType.ANTI_AI_STATUS, {});
    if (!sent) setSyncLine('后端未连接，显示本地防护规则');
    return unsubscribe;
  }, [ws.send, ws.subscribe]);

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <ShieldCheck size={24} />
        <div>
          <strong>防AI味</strong>
          <small>三层防护默认开启，不提供关闭入口</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={status.enabled} readOnly />
          <span>提示词注入防护、人格锚定、输出过滤正在工作</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>轻量检测</span>
          <input value={status.guard_engine} readOnly />
        </label>
        <label className={styles.fieldGroup}>
          <span>规则数量</span>
          <input
            value={`输出 ${status.forbidden_rule_count} 条 / 输入 ${status.injection_rule_count} 条`}
            readOnly
          />
        </label>
      </div>

      <div className={styles.archiveColumns}>
        <section className={styles.archiveColumn}>
          <div className={styles.managementHero}>
            <AlertTriangle size={18} />
            <div>
              <strong>防护层</strong>
              <small>按消息进入模型前后依次生效</small>
            </div>
          </div>
          <div className={styles.settingsRefreshGrid}>
            {status.layers.map((layer) => (
              <span key={layer}>{layer}</span>
            ))}
          </div>
        </section>
        <section className={styles.archiveColumn}>
          <div className={styles.managementHero}>
            <LockKeyhole size={18} />
            <div>
              <strong>禁词分类</strong>
              <small>命中后会重写或重新生成</small>
            </div>
          </div>
          <div className={styles.settingsRefreshGrid}>
            {Object.entries(status.forbidden_categories).map(([category, items]) => (
              <span key={category}>{category}：{items.slice(0, 4).join('、')}</span>
            ))}
          </div>
        </section>
      </div>

      {syncLine && (
        <span className={styles.statusNote}>
          <Check size={14} />
          {syncLine}
        </span>
      )}
    </div>
  );
}

export function MemorySettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [settings, setSettings] = useState<MemoryForgetSettings>(DEFAULT_MEMORY_SETTINGS);
  const [status, setStatus] = useState('');
  const longTermMisrememberPercent = Math.round(settings.long_term_misremember_probability * 1000) / 10;
  const shortTermMisrememberPercent = Math.round(settings.short_term_misremember_probability * 1000) / 10;
  const longTermMisrememberAvailable = settings.long_term_forget_days >= 90;
  const shortTermMisrememberAvailable = settings.short_term_forget_days >= 5;

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.MEMORY_SETTINGS_RESULT, (payload: unknown) => {
      if (isRecord(payload) && payload.error) {
        setStatus(safeString(payload.error));
        return;
      }
      const next = normalizeMemorySettings(payload);
      setSettings(next);
      setStatus(next.reembedding_pending > 0
        ? `角色正在整理思绪：已整理 ${next.reembedding_indexed} 条，剩余 ${next.reembedding_pending} 条`
        : '记忆索引已就绪');
    });
    ws.send(WSMsgType.MEMORY_SETTINGS_GET, {});
    const timer = window.setInterval(() => {
      if (ws.connState === 'connected') ws.send(WSMsgType.MEMORY_SETTINGS_GET, {});
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ws.connState, ws.send, ws.subscribe]);

  const setField = <K extends keyof MemoryForgetSettings>(key: K, value: MemoryForgetSettings[K]) => {
    setSettings((current) => normalizeMemorySettings({ ...current, [key]: value }));
  };

  const setFlag = (key: MemoryBoolFlag, value: boolean) => setField(key, value);

  const save = () => {
    const payload = normalizeMemorySettings(settings);
    setSettings(payload);
    const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
      section: 'memory',
      ...payload,
    });
    if (sent) {
      setStatus('已保存');
      ws.send(WSMsgType.MEMORY_SETTINGS_GET, {});
    } else {
      setStatus('后端未连接，当前设置尚未写入运行时');
    }
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <Brain size={24} />
        <div>
          <strong>遗忘设置</strong>
          <small>{settings.vector_store} · {settings.embedding_model}</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.fieldGroup}>
          <span>原始记忆保留期限</span>
          <select
            value={settings.retention_days}
            onChange={(event) => setField(
              'retention_days',
              normalizeRetentionDays(event.target.value, settings.retention_days),
            )}
          >
            <option value={365}>1 年（365 天）</option>
            <option value={730}>2 年（730 天）</option>
            <option value={1095}>3 年（1095 天）</option>
          </select>
          <small>到期记录进入生命周期归档；不会形成应用级记录数量上限。</small>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.autonomous_memory_enabled}
            onChange={(event) => setFlag('autonomous_memory_enabled', event.target.checked)}
          />
          <span>由角色按情绪自主决定是否保存记忆</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.autonomous_memory_llm_enabled}
            onChange={(event) => setFlag('autonomous_memory_llm_enabled', event.target.checked)}
          />
          <span>用 AI 判断记忆是否值得保存</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.forgetting_enabled}
            onChange={(event) => setFlag('forgetting_enabled', event.target.checked)}
          />
          <span>启用非破坏性记忆衰减（不会删除原始记忆）</span>
        </label>
        <TextField
          label="Embedding 模型"
          value={settings.embedding_model}
          onChange={(value) => setField('embedding_model', value)}
          placeholder="BAAI/bge-small-en-v1.5"
        />
        <label className={styles.fieldGroup}>
          <span>向量存储精度</span>
          <select
            value={settings.vector_quantization}
            onChange={(event) => setField(
              'vector_quantization',
              event.target.value === 'float32' ? 'float32' : 'int8',
            )}
          >
            <option value="int8">INT8（约四分之一体积）</option>
            <option value="float32">Float32（更高检索精度）</option>
          </select>
          <small>切换后会在后台惰性重建索引，原始记忆文本不受影响。</small>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.vector_partitioning_enabled}
            onChange={(event) => setFlag('vector_partitioning_enabled', event.target.checked)}
          />
          <HardDrive size={15} />
          <span>按季度分区检索（当前：{settings.vector_partition_strategy || '未分区'}）</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.long_term_forgetting_enabled}
            disabled={!settings.forgetting_enabled}
            onChange={(event) => setFlag('long_term_forgetting_enabled', event.target.checked)}
          />
          <span>长期记忆可遗忘</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>长期记忆基础半衰期 {settings.long_term_forget_days} 天</span>
          <input
            type="range"
            min="60"
            max="365"
            step="1"
            value={settings.long_term_forget_days}
            disabled={!settings.forgetting_enabled || !settings.long_term_forgetting_enabled}
            onChange={(event) => setField('long_term_forget_days', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>时间衰减 λ {settings.decay_lambda.toFixed(4)}</span>
          <input
            type="range"
            min="0.0001"
            max="0.03"
            step="0.0001"
            value={settings.decay_lambda}
            disabled={!settings.forgetting_enabled}
            onChange={(event) => setField('decay_lambda', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.short_term_forgetting_enabled}
            disabled={!settings.forgetting_enabled}
            onChange={(event) => setFlag('short_term_forgetting_enabled', event.target.checked)}
          />
          <span>短期记忆可遗忘</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>短期记忆基础半衰期 {settings.short_term_forget_days} 天</span>
          <input
            type="range"
            min="1"
            max="59"
            step="1"
            value={settings.short_term_forget_days}
            disabled={!settings.forgetting_enabled || !settings.short_term_forgetting_enabled}
            onChange={(event) => setField('short_term_forget_days', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>每次成功回想的强化系数 {settings.recall_reinforcement_alpha.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            value={settings.recall_reinforcement_alpha}
            disabled={!settings.forgetting_enabled}
            onChange={(event) => setField('recall_reinforcement_alpha', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>低于 {(settings.minimum_retrieval_retention * 100).toFixed(0)}% 时暂时想不起</span>
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            value={settings.minimum_retrieval_retention}
            disabled={!settings.forgetting_enabled}
            onChange={(event) => setField('minimum_retrieval_retention', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.misremembering_enabled}
            onChange={(event) => setFlag('misremembering_enabled', event.target.checked)}
          />
          <span>启用受控模糊回想（默认关闭，不改写真实记忆）</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.long_term_misremembering_enabled && longTermMisrememberAvailable}
            disabled={!settings.misremembering_enabled || !longTermMisrememberAvailable}
            onChange={(event) => setFlag('long_term_misremembering_enabled', event.target.checked)}
          />
          <span>长期记忆可误记（90 天起）</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>长期混淆概率 {longTermMisrememberPercent}%</span>
          <input
            type="range"
            min="0.001"
            max="0.01"
            step="0.001"
            value={settings.long_term_misremember_probability}
            disabled={
              !settings.misremembering_enabled ||
              !settings.long_term_misremembering_enabled ||
              !longTermMisrememberAvailable
            }
            onChange={(event) => setField('long_term_misremember_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.short_term_misremembering_enabled && shortTermMisrememberAvailable}
            disabled={!settings.misremembering_enabled || !shortTermMisrememberAvailable}
            onChange={(event) => setFlag('short_term_misremembering_enabled', event.target.checked)}
          />
          <span>短期记忆可误记（5 天起）</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>短期混淆概率 {shortTermMisrememberPercent}%</span>
          <input
            type="range"
            min="0.001"
            max="0.01"
            step="0.001"
            value={settings.short_term_misremember_probability}
            disabled={
              !settings.misremembering_enabled ||
              !settings.short_term_misremembering_enabled ||
              !shortTermMisrememberAvailable
            }
            onChange={(event) => setField('short_term_misremember_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.self_growth_enabled}
            onChange={(event) => setFlag('self_growth_enabled', event.target.checked)}
          />
          <span>启用人格自我成长</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.self_growth_from_memory_enabled}
            disabled={!settings.self_growth_enabled}
            onChange={(event) => setFlag('self_growth_from_memory_enabled', event.target.checked)}
          />
          <span>从记忆库沉淀兴趣变化</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={false}
            disabled
            readOnly
          />
          <span>互联网内容与人格成长隔离（安全边界）</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>成长检查周期 {settings.self_growth_interval_days} 天</span>
          <input
            type="range"
            min="30"
            max="365"
            step="1"
            value={settings.self_growth_interval_days}
            disabled={!settings.self_growth_enabled}
            onChange={(event) => setField('self_growth_interval_days', Number(event.target.value))}
          />
        </label>
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存遗忘设置
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

interface AiUsageFeature {
  enabled: boolean;
  apiCostAcknowledged: boolean;
  effective: boolean;
  description: string;
  consentDigest: string;
}

function AiUsageConsentPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [features, setFeatures] = useState<Record<string, AiUsageFeature>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('默认拒绝；每项云端能力都需要单独确认。');

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.AI_USAGE_RESULT, (payload: unknown) => {
      if (!isRecord(payload)) return;
      if (payload.error) {
        setStatus(safeString(payload.error));
        return;
      }
      const rawFeatures = isRecord(payload.features) ? payload.features : {};
      const next = Object.fromEntries(
        Object.entries(rawFeatures)
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
          .map(([feature, value]) => [feature, {
            enabled: value.enabled === true,
            apiCostAcknowledged: value.api_cost_acknowledged === true,
            effective: value.effective === true,
            description: safeString(value.description) || '此功能可能调用外部 AI 服务并产生费用。',
            consentDigest: safeString(value.consent_digest),
          }]),
      );
      setFeatures(next);
      setAcknowledged({});
      setStatus(
        safeString(payload.default) === 'denied'
          ? '默认拒绝；只有下方显示“已允许”的项目才会生效。'
          : '授权状态已刷新。',
      );
    });
    if (ws.connState === 'connected') {
      ws.send(WSMsgType.AI_USAGE_GET, {});
    }
    return unsubscribe;
  }, [ws.connState, ws.send, ws.subscribe]);

  const grant = (feature: string, value: AiUsageFeature) => {
    if (!value.consentDigest || !acknowledged[feature]) return;
    const sent = ws.send(WSMsgType.AI_USAGE_GRANT, {
      feature,
      consent_digest: value.consentDigest,
      api_cost_acknowledged: true,
      user_confirmed: true,
    });
    setStatus(sent ? `正在确认 ${feature}…` : '后端未连接，授权没有更改。');
  };

  const revoke = (feature: string) => {
    const sent = ws.send(WSMsgType.AI_USAGE_REVOKE, { feature });
    setStatus(sent ? `正在撤销 ${feature}…` : '后端未连接，授权没有更改。');
  };

  const entries = Object.entries(features).sort(([left], [right]) => left.localeCompare(right));
  return (
    <section className={styles.aiUsageConsent} aria-labelledby="ai-usage-consent-title">
      <header>
        <div>
          <strong id="ai-usage-consent-title">逐项 AI 使用授权</strong>
          <small>{status}</small>
        </div>
        <button
          type="button"
          disabled={ws.connState !== 'connected'}
          onClick={() => ws.send(WSMsgType.AI_USAGE_GET, {})}
        >
          刷新
        </button>
      </header>
      {!entries.length && <p>连接本地服务后，将显示运行时实际支持的全部项目。</p>}
      {entries.map(([feature, value]) => (
        <article key={`${feature}:${value.consentDigest}`} data-effective={value.effective}>
          <div>
            <strong>{feature}</strong>
            <span>{value.effective ? '已允许' : '未允许'}</span>
          </div>
          <p>{value.description}</p>
          {value.effective ? (
            <button type="button" onClick={() => revoke(feature)}>撤销授权</button>
          ) : (
            <>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={acknowledged[feature] === true}
                  disabled={!value.consentDigest}
                  onChange={(event) => setAcknowledged((current) => ({
                    ...current,
                    [feature]: event.target.checked,
                  }))}
                />
                <span>我已阅读上方说明，并确认可能产生 API 费用</span>
              </label>
              <button
                type="button"
                disabled={!value.consentDigest || acknowledged[feature] !== true}
                onClick={() => grant(feature, value)}
              >
                单独允许此项
              </button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}

export function PersonalitySettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [settings, setSettings] = useState<PersonalityFeatureSettings>(DEFAULT_PERSONALITY_SETTINGS);
  const [status, setStatus] = useState('');
  const [notificationStatus, setNotificationStatus] = useState('正在核对系统通知…');
  const inertiaPercent = Math.round(settings.emotion_inertia_factor * 100);
  const keepsakePercent = Math.round(settings.keepsake_recall_probability * 100);
  const selectedWebTopics = new Set(settings.web_allowed_topics);
  const budget = ws.apiBudget.background;
  const requestBudgetPercent = budget.request_budget > 0
    ? Math.min(100, Math.round((budget.requests / budget.request_budget) * 100))
    : 0;
  const tokenBudgetPercent = budget.token_budget > 0
    ? Math.min(100, Math.round((budget.tokens / budget.token_budget) * 100))
    : 0;

  useEffect(() => {
    if (ws.settingsSnapshot.features) {
      setSettings(normalizePersonalitySettings(ws.settingsSnapshot.features));
    }
  }, [ws.settingsSnapshot.features]);

  useEffect(() => {
    if (ws.connState === 'connected') {
      ws.refreshApiBudget();
    }
  }, [ws.connState, ws.refreshApiBudget]);

  useEffect(() => {
    let cancelled = false;
    const readStatus = async () => {
      if (window.electronAPI?.getNotificationStatus) {
        try {
          const result = await window.electronAPI.getNotificationStatus();
          if (cancelled) return;
          setNotificationStatus(
            result.supported
              ? `Windows 系统通知可用${result.installedIdentity ? '，安装身份已就绪' : '，开发模式下由系统设置管理'}`
              : '当前系统不支持原生通知',
          );
          return;
        } catch {
          // Fall through to the browser capability check.
        }
      }
      if ('Notification' in window) {
        setNotificationStatus(`浏览器通知权限：${window.Notification.permission}`);
      } else {
        setNotificationStatus('当前运行环境不支持系统通知');
      }
    };
    void readStatus();
    return () => { cancelled = true; };
  }, []);

  const setField = <K extends keyof PersonalityFeatureSettings>(key: K, value: PersonalityFeatureSettings[K]) => {
    setSettings((current) => normalizePersonalitySettings({ ...current, [key]: value }));
  };
  const setFlag = (key: PersonalityBoolFlag, value: boolean) => setField(key, value);
  const toggleWebTopic = (topic: string, checked: boolean) => {
    const next = checked
      ? [...settings.web_allowed_topics, topic]
      : settings.web_allowed_topics.filter((item) => item !== topic);
    setField('web_allowed_topics', next.length ? next : DEFAULT_PERSONALITY_SETTINGS.web_allowed_topics);
  };

  const save = () => {
    const payload = normalizePersonalitySettings(settings);
    setSettings(payload);
    const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
      section: 'personality',
      ...payload,
    });
    setStatus(sent ? '已提交保存' : '后端未连接，本次更改未保存');
  };

  const testNotification = async () => {
    const body = '只是来看看你。今天也记得让自己喘口气。';
    if (window.electronAPI?.showNotification) {
      const result = await window.electronAPI.showNotification('Reverie', body);
      setNotificationStatus(result.shown ? '测试通知已交给 Windows' : 'Windows 未接受通知，请检查系统通知设置');
      return;
    }
    if ('Notification' in window) {
      const permission = window.Notification.permission === 'default'
        ? await window.Notification.requestPermission()
        : window.Notification.permission;
      if (permission === 'granted') {
        new window.Notification('Reverie', { body });
        setNotificationStatus('测试通知已发送');
      } else {
        setNotificationStatus('通知权限未授予');
      }
      return;
    }
    setNotificationStatus('当前运行环境不支持系统通知');
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <Sparkles size={24} />
        <div>
          <strong>人格设置</strong>
          <small>人格连续性、环境陪伴、群体社交与本地资源预算</small>
        </div>
      </div>

      <section className={styles.apiBudgetSummary} aria-label="API 预算追踪">
        <div>
          <Gauge size={18} />
          <strong>后台 API 预算</strong>
          <small>前台聊天不会被预算硬拦截</small>
        </div>
        <label>
          <span>请求 {budget.requests}/{budget.request_budget}（{requestBudgetPercent}%）</span>
          <progress max="100" value={requestBudgetPercent} />
        </label>
        <label>
          <span>Token {budget.tokens.toLocaleString('zh-CN')}/{budget.token_budget.toLocaleString('zh-CN')}（{tokenBudgetPercent}%）</span>
          <progress max="100" value={tokenBudgetPercent} />
        </label>
        <button type="button" onClick={() => ws.refreshApiBudget()} title="刷新 API 用量">
          <Gauge size={15} />
          刷新
        </button>
      </section>

      <AiUsageConsentPanel ws={ws} />

      <section className={styles.notificationSummary} aria-label="系统通知状态">
        <Bell size={18} />
        <span>
          <strong>关心提醒</strong>
          <small>{notificationStatus}</small>
        </span>
        <button type="button" onClick={() => void testNotification()} title="发送测试通知">
          测试通知
        </button>
      </section>

      <div className={styles.formGrid}>
        <h3 className={styles.settingsSectionTitle}>人格与情绪</h3>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.personality_flaws_enabled}
            onChange={(event) => setFlag('personality_flaws_enabled', event.target.checked)}
          />
          <span>启用随机小缺点系统</span>
        </label>
        <TextAreaField
          label="用户选择的缺点"
          value={settings.user_selected_flaws}
          rows={4}
          onChange={(value) => setField('user_selected_flaws', value)}
        />
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.personality_flaws_disclaimer_acknowledged}
            onChange={(event) => setFlag('personality_flaws_disclaimer_acknowledged', event.target.checked)}
          />
          <AlertTriangle size={15} />
          <span>{FLAWS_DISCLAIMER}</span>
        </label>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.emotion_system_enabled}
            onChange={(event) => setFlag('emotion_system_enabled', event.target.checked)}
          />
          <Smile size={15} />
          <span>启用人格情绪系统</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>情绪余温 {settings.emotion_carryover_days} 天</span>
          <input
            type="range"
            min="1"
            max="7"
            step="1"
            value={settings.emotion_carryover_days}
            disabled={!settings.emotion_system_enabled}
            onChange={(event) => setField('emotion_carryover_days', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>单次聊天回落速度 {inertiaPercent}%</span>
          <input
            type="range"
            min="0.01"
            max="0.60"
            step="0.01"
            value={settings.emotion_inertia_factor}
            disabled={!settings.emotion_system_enabled}
            onChange={(event) => setField('emotion_inertia_factor', Number(event.target.value))}
          />
        </label>

        <h3 className={styles.settingsSectionTitle}>环境化陪伴</h3>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.ambient_presence_enabled}
            onChange={(event) => setFlag('ambient_presence_enabled', event.target.checked)}
          />
          <Home size={15} />
          <span>在本地累积书签、房间痕迹与不在场变化</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.ambient_sticky_notes_enabled}
            disabled={!settings.ambient_presence_enabled}
            onChange={(event) => setFlag('ambient_sticky_notes_enabled', event.target.checked)}
          />
          <span>允许留下虚拟便利贴</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>阅读进度每小时 {settings.ambient_book_pages_per_hour.toFixed(1)} 页</span>
          <input
            type="range"
            min="0.1"
            max="12"
            step="0.1"
            value={settings.ambient_book_pages_per_hour}
            disabled={!settings.ambient_presence_enabled}
            onChange={(event) => setField('ambient_book_pages_per_hour', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>生活痕迹最小间隔 {settings.ambient_trace_interval_minutes} 分钟</span>
          <input
            type="number"
            min="30"
            max="1440"
            step="30"
            value={settings.ambient_trace_interval_minutes}
            disabled={!settings.ambient_presence_enabled}
            onChange={(event) => setField('ambient_trace_interval_minutes', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>离线补算上限 {settings.ambient_offline_replay_max_days} 天</span>
          <input
            type="number"
            min="1"
            max="90"
            value={settings.ambient_offline_replay_max_days}
            disabled={!settings.ambient_presence_enabled}
            onChange={(event) => setField('ambient_offline_replay_max_days', Number(event.target.value))}
          />
        </label>

        <h3 className={styles.settingsSectionTitle}>朋友圈与角色社交</h3>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.timeline_enabled}
            onChange={(event) => setFlag('timeline_enabled', event.target.checked)}
          />
          <span>启用朋友圈动态</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.world_life_enabled}
            disabled={!settings.timeline_enabled}
            onChange={(event) => setFlag('world_life_enabled', event.target.checked)}
          />
          <span>动态引用她的生活、兴趣和社交圈</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.timeline_visuals_enabled}
            disabled={!settings.timeline_enabled}
            onChange={(event) => setFlag('timeline_visuals_enabled', event.target.checked)}
          />
          <span>允许朋友圈记录连续视觉素材</span>
        </label>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.group_social_enabled}
            onChange={(event) => setFlag('group_social_enabled', event.target.checked)}
          />
          <Users size={15} />
          <span>启用群体社交系统</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.group_social_permanent_memory_enabled}
            disabled={!settings.group_social_enabled}
            onChange={(event) => setFlag('group_social_permanent_memory_enabled', event.target.checked)}
          />
          <span>把关联角色写入永久记忆</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.group_social_api_replies_enabled}
            disabled={!settings.group_social_enabled}
            onChange={(event) => setFlag('group_social_api_replies_enabled', event.target.checked)}
          />
          <span>允许角色群聊和评论使用 API（关闭后使用本地短句）</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>每次群体行为最多 {settings.group_social_max_api_calls_per_action} 次 API 调用</span>
          <input
            type="range"
            min="0"
            max="3"
            step="1"
            value={settings.group_social_max_api_calls_per_action}
            disabled={!settings.group_social_enabled || !settings.group_social_api_replies_enabled}
            onChange={(event) => setField('group_social_max_api_calls_per_action', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>动态串门概率 {Math.round(settings.group_social_comment_probability * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.group_social_comment_probability}
            disabled={!settings.group_social_enabled}
            onChange={(event) => setField('group_social_comment_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>本地模拟串门概率 {Math.round(settings.group_social_backchannel_probability * 100)}%</span>
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            value={settings.group_social_backchannel_probability}
            disabled={!settings.group_social_enabled}
            onChange={(event) => setField('group_social_backchannel_probability', Number(event.target.value))}
          />
        </label>

        <h3 className={styles.settingsSectionTitle}>主动关心与系统通知</h3>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.proactive_chat_enabled}
            onChange={(event) => setFlag('proactive_chat_enabled', event.target.checked)}
          />
          <span>允许她主动发消息</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.proactive_notifications_enabled}
            disabled={!settings.proactive_chat_enabled}
            onChange={(event) => setFlag('proactive_notifications_enabled', event.target.checked)}
          />
          <span>后台时弹出消息提醒</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.proactive_event_stories_enabled}
            disabled={!settings.proactive_chat_enabled}
            onChange={(event) => setFlag('proactive_event_stories_enabled', event.target.checked)}
          />
          <span>允许连续生活事件</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>每日主动消息上限 {settings.proactive_daily_limit}</span>
          <input
            type="range"
            min="1"
            max="12"
            step="1"
            value={settings.proactive_daily_limit}
            disabled={!settings.proactive_chat_enabled}
            onChange={(event) => setField('proactive_daily_limit', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>最小间隔 {settings.proactive_min_interval_minutes} 分钟</span>
          <input
            type="range"
            min="15"
            max="1440"
            step="15"
            value={settings.proactive_min_interval_minutes}
            disabled={!settings.proactive_chat_enabled}
            onChange={(event) => setField('proactive_min_interval_minutes', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>优先使用本地关心短句 {Math.round(settings.local_care_reflex_probability * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.local_care_reflex_probability}
            disabled={!settings.proactive_chat_enabled}
            onChange={(event) => setField('local_care_reflex_probability', Number(event.target.value))}
          />
          <small>本地短句不调用 API；其余触发才进入模型生成与预算检查。</small>
        </label>

        <h3 className={styles.settingsSectionTitle}>长期关系彩蛋</h3>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.keepsake_collection_enabled}
            onChange={(event) => setFlag('keepsake_collection_enabled', event.target.checked)}
          />
          <Camera size={15} />
          <span>启用回忆收藏主动翻看</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>回忆被主动翻出概率 {keepsakePercent}%</span>
          <input
            type="range"
            min="0.01"
            max="0.30"
            step="0.01"
            value={settings.keepsake_recall_probability}
            disabled={!settings.keepsake_collection_enabled}
            onChange={(event) => setField('keepsake_recall_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.diary_key_easter_egg_enabled}
            onChange={(event) => setFlag('diary_key_easter_egg_enabled', event.target.checked)}
          />
          <KeyRound size={15} />
          <span>允许关系达标后出现私密日记钥匙</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>钥匙亲密度门槛 {settings.diary_key_intimacy_threshold}</span>
          <input
            type="number"
            min="100"
            max="10000"
            step="100"
            value={settings.diary_key_intimacy_threshold}
            disabled={!settings.diary_key_easter_egg_enabled}
            onChange={(event) => setField('diary_key_intimacy_threshold', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>连续开心 {settings.diary_key_happy_days} 天后才可能出现</span>
          <input
            type="range"
            min="3"
            max="30"
            step="1"
            value={settings.diary_key_happy_days}
            disabled={!settings.diary_key_easter_egg_enabled}
            onChange={(event) => setField('diary_key_happy_days', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>私密情绪门槛 {Math.round(settings.diary_key_private_emotion_threshold)}</span>
          <input
            type="range"
            min="40"
            max="95"
            step="1"
            value={settings.diary_key_private_emotion_threshold}
            disabled={!settings.diary_key_easter_egg_enabled}
            onChange={(event) => setField('diary_key_private_emotion_threshold', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.user_phrase_alignment_enabled}
            onChange={(event) => setFlag('user_phrase_alignment_enabled', event.target.checked)}
          />
          <MessageCircle size={15} />
          <span>允许安全白名单内的口癖双向同化</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>口癖同化概率 {Math.round(settings.user_phrase_alignment_probability * 100)}%</span>
          <input
            type="range"
            min="0"
            max="0.2"
            step="0.01"
            value={settings.user_phrase_alignment_probability}
            disabled={!settings.user_phrase_alignment_enabled}
            onChange={(event) => setField('user_phrase_alignment_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>至少出现 {settings.user_phrase_min_count} 次才学习</span>
          <input
            type="range"
            min="2"
            max="20"
            step="1"
            value={settings.user_phrase_min_count}
            disabled={!settings.user_phrase_alignment_enabled}
            onChange={(event) => setField('user_phrase_min_count', Number(event.target.value))}
          />
        </label>

        <h3 className={styles.settingsSectionTitle}>网络冲浪与延迟分享</h3>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.web_surfing_enabled}
            onChange={(event) => setFlag('web_surfing_enabled', event.target.checked)}
          />
          <Wifi size={15} />
          <span>启用网络冲浪系统</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.web_disclaimer_acknowledged}
            disabled={!settings.web_surfing_enabled}
            onChange={(event) => setFlag('web_disclaimer_acknowledged', event.target.checked)}
          />
          <AlertTriangle size={15} />
          <span>{WEB_SURFING_DISCLAIMER}</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>冲浪时间段</span>
          <input
            value={settings.web_search_windows}
            disabled={!settings.web_surfing_enabled}
            placeholder="20:00-23:00，可用逗号分隔多个时间段"
            onChange={(event) => setField('web_search_windows', event.target.value)}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>刷新间隔 {settings.web_refresh_interval_minutes} 分钟</span>
          <input
            type="range"
            min="30"
            max="1440"
            step="30"
            value={settings.web_refresh_interval_minutes}
            disabled={!settings.web_surfing_enabled}
            onChange={(event) => setField('web_refresh_interval_minutes', Number(event.target.value))}
          />
        </label>
        <div className={styles.topicChoiceGrid} aria-label="网络冲浪主题">
          {SAFE_WEB_TOPICS.map((topic) => (
            <label key={topic} className={styles.checkRow}>
              <input
                type="checkbox"
                checked={selectedWebTopics.has(topic)}
                disabled={!settings.web_surfing_enabled}
                onChange={(event) => toggleWebTopic(topic, event.target.checked)}
              />
              <span>{topic}</span>
            </label>
          ))}
        </div>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.thought_of_you_enabled}
            disabled={!settings.web_surfing_enabled}
            onChange={(event) => setFlag('thought_of_you_enabled', event.target.checked)}
          />
          <Heart size={15} />
          <span>先收藏兴趣内容，晚些时候在聊天中自然分享</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>分享触发概率 {Math.round(settings.thought_share_probability * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.thought_share_probability}
            disabled={!settings.web_surfing_enabled || !settings.thought_of_you_enabled}
            onChange={(event) => setField('thought_share_probability', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>最早延迟 {settings.thought_min_delay_minutes} 分钟</span>
          <input
            type="number"
            min="30"
            max="4320"
            step="30"
            value={settings.thought_min_delay_minutes}
            disabled={!settings.web_surfing_enabled || !settings.thought_of_you_enabled}
            onChange={(event) => setField('thought_min_delay_minutes', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>最晚延迟 {settings.thought_max_delay_minutes} 分钟</span>
          <input
            type="number"
            min="60"
            max="10080"
            step="60"
            value={settings.thought_max_delay_minutes}
            disabled={!settings.web_surfing_enabled || !settings.thought_of_you_enabled}
            onChange={(event) => setField('thought_max_delay_minutes', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>自然分享时段起点 {settings.thought_share_start_hour}:00</span>
          <input
            type="range"
            min="0"
            max="23"
            step="1"
            value={settings.thought_share_start_hour}
            disabled={!settings.web_surfing_enabled || !settings.thought_of_you_enabled}
            onChange={(event) => setField('thought_share_start_hour', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>自然分享时段终点 {settings.thought_share_end_hour === 24 ? '24:00' : `${settings.thought_share_end_hour}:00`}</span>
          <input
            type="range"
            min="1"
            max="24"
            step="1"
            value={settings.thought_share_end_hour}
            disabled={!settings.web_surfing_enabled || !settings.thought_of_you_enabled}
            onChange={(event) => setField('thought_share_end_hour', Number(event.target.value))}
          />
        </label>

        <h3 className={styles.settingsSectionTitle}>API 消费边界</h3>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.api_budget_tracking_enabled}
            onChange={(event) => setFlag('api_budget_tracking_enabled', event.target.checked)}
          />
          <Gauge size={15} />
          <span>在本地记录各功能的请求与 Token 用量</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.api_background_budget_enforced}
            disabled={!settings.api_budget_tracking_enabled}
            onChange={(event) => setFlag('api_background_budget_enforced', event.target.checked)}
          />
          <span>后台功能达到预算后改用本地降级结果</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>后台每日请求预算</span>
          <input
            type="number"
            min="1"
            max="10000"
            value={settings.api_background_daily_request_budget}
            disabled={!settings.api_budget_tracking_enabled}
            onChange={(event) => setField('api_background_daily_request_budget', Number(event.target.value))}
          />
        </label>
        <label className={styles.fieldGroup}>
          <span>后台每日 Token 预算</span>
          <input
            type="number"
            min="1000"
            max="10000000"
            step="1000"
            value={settings.api_background_daily_token_budget}
            disabled={!settings.api_budget_tracking_enabled}
            onChange={(event) => setField('api_background_daily_token_budget', Number(event.target.value))}
          />
        </label>
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存人格设置
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

export function ImmersionSettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [settings, setSettings] = useState<ImmersionFeatureSettings>(DEFAULT_IMMERSION_SETTINGS);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [smartDevice, setSmartDevice] = useState('灯');
  const [smartAction, setSmartAction] = useState('打开');
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.IMMERSION_RESULT, (payload: unknown) => {
      if (isRecord(payload)) {
        setResult(payload);
        setStatus(safeString(payload.error) || '已生成沉浸感结果');
      }
    });
    return unsubscribe;
  }, [ws.subscribe]);

  useEffect(() => {
    if (ws.settingsSnapshot.features) {
      setSettings(normalizeImmersionSettings(ws.settingsSnapshot.features));
    }
  }, [ws.settingsSnapshot.features]);

  const setField = <K extends keyof ImmersionFeatureSettings>(key: K, value: ImmersionFeatureSettings[K]) => {
    setSettings((current) => normalizeImmersionSettings({ ...current, [key]: value }));
  };
  const setFlag = (key: ImmersionBoolFlag, value: boolean) => setField(key, value);

  const save = () => {
    const payload = normalizeImmersionSettings(settings);
    setSettings(payload);
    const sent = ws.send(WSMsgType.SETTINGS_UPDATE, {
      section: 'immersion',
      ...payload,
    });
    setStatus(sent ? '已提交保存' : '后端未连接，本次更改未保存');
  };

  const requestNearby = async () => {
    if (!settings.immersion_location_enabled) {
      setStatus('请先启用定位沉浸感');
      return;
    }
    setLocating(true);
    setStatus('正在向 Windows 11 请求定位权限与当前位置…');
    try {
      // Electron's trusted main-frame permission policy lets Chromium call the
      // Windows location broker while this user-initiated page is foreground.
      // The hidden PowerShell adapter remains only a last-resort diagnostic for
      // systems whose Chromium geolocation provider is unavailable.
      let position: {
        ok: boolean;
        code: string;
        status?: string;
        latitude?: number;
        longitude?: number;
        accuracy?: number;
      } = await requestWindowsBrowserLocation();
      if (
        !position.ok
        && position.code === 'REVERIE_LOCATION_DEVICE_UNAVAILABLE'
        && window.electronAPI?.getCurrentWindowsLocation
      ) {
        position = await window.electronAPI.getCurrentWindowsLocation();
      }
      if (!position.ok) {
        const messages: Record<string, string> = {
          REVERIE_LOCATION_PERMISSION_DENIED:
            'Windows 已拒绝定位。请开启“定位服务”和“允许桌面应用访问你的位置”。',
          REVERIE_LOCATION_ACCESS_UNSPECIFIED:
            'Windows 没有返回明确的定位授权状态，请检查系统定位设置。',
          REVERIE_LOCATION_SERVICE_DISABLED:
            'Windows 定位服务已关闭，请先在系统设置中启用。',
          REVERIE_LOCATION_DEVICE_UNAVAILABLE:
            '此设备当前没有可用的 Windows 定位能力。',
          REVERIE_LOCATION_TIMEOUT:
            'Windows 定位响应超时，请确认定位服务已开启后重试。',
          REVERIE_LOCATION_NO_DATA:
            'Windows 定位服务已开启，但当前没有可用的位置数据。',
        };
        setStatus(messages[position.code] || 'Windows 原生定位调用失败，请检查系统定位设置。');
        return;
      }
      const sent = ws.send(WSMsgType.IMMERSION_NEARBY, {
        latitude: position.latitude,
        longitude: position.longitude,
        accuracy_m: position.accuracy,
        radius_m: settings.immersion_location_radius_m,
        place_types: ['restaurant', 'shop', 'cafe', 'supermarket', 'park'],
      });
      setStatus(sent ? 'Windows 定位成功，已请求附近生活场景' : '定位成功，但后端未连接');
    } catch {
      setStatus('Windows 原生定位模块未能完成请求。');
    } finally {
      setLocating(false);
    }
  };

  const openLocationSettings = async () => {
    if (!window.electronAPI?.openLocationSettings) {
      setStatus('请手动打开 Windows 设置 → 隐私和安全性 → 位置。');
      return;
    }
    try {
      await window.electronAPI.openLocationSettings();
      setStatus('已打开 Windows 定位设置。');
    } catch {
      setStatus('无法打开系统设置，请手动前往“隐私和安全性 → 位置”。');
    }
  };

  const requestCloseup = (kind: string) => {
    const sent = ws.send(WSMsgType.IMMERSION_CLOSEUP, { kind });
    setStatus(sent ? '已生成特写计划' : '后端未连接');
  };

  const requestSmartHome = () => {
    const sent = ws.send(WSMsgType.IMMERSION_SMART_HOME, {
      provider: 'manual',
      device: smartDevice,
      action: smartAction,
    });
    setStatus(sent ? '已发送 dry-run 控制请求' : '后端未连接');
  };

  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions.filter(isRecord) : [];

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <MapPin size={24} />
        <div>
          <strong>真实与沉浸感</strong>
          <small>定位生活场景、吃饭特写、购物灵感和智能家居 dry-run</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.immersion_location_enabled}
            onChange={(event) => setFlag('immersion_location_enabled', event.target.checked)}
          />
          <MapPin size={15} />
          <span>启用定位沉浸感</span>
        </label>
        <label className={styles.fieldGroup}>
          <span>附近范围 {settings.immersion_location_radius_m} 米</span>
          <input
            type="range"
            min="300"
            max="5000"
            step="100"
            value={settings.immersion_location_radius_m}
            disabled={!settings.immersion_location_enabled}
            onChange={(event) => setField('immersion_location_radius_m', Number(event.target.value))}
          />
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.immersion_closeups_enabled}
            onChange={(event) => setFlag('immersion_closeups_enabled', event.target.checked)}
          />
          <Camera size={15} />
          <span>允许生成吃饭/购物等特写计划</span>
        </label>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={settings.immersion_smart_home_enabled}
            onChange={(event) => setFlag('immersion_smart_home_enabled', event.target.checked)}
          />
          <Home size={15} />
          <span>启用智能家居 dry-run 控制器</span>
        </label>
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存沉浸感设置
        </button>
        <button
          type="button"
          onClick={requestNearby}
          disabled={!settings.immersion_location_enabled || locating}
        >
          <MapPin size={15} />
          {locating ? '定位中…' : '请求定位'}
        </button>
        <button type="button" onClick={openLocationSettings}>
          <Settings size={15} />
          Windows 定位设置
        </button>
        <button type="button" onClick={() => requestCloseup('meal')} disabled={!settings.immersion_closeups_enabled}>
          <Camera size={15} />
          吃饭特写
        </button>
      </div>

      <div className={styles.formGrid}>
        <TextField label="设备" value={smartDevice} onChange={setSmartDevice} />
        <TextField label="动作" value={smartAction} onChange={setSmartAction} />
      </div>
      <div className={styles.actionRow}>
        <button type="button" onClick={requestSmartHome} disabled={!settings.immersion_smart_home_enabled}>
          <Home size={15} />
          dry-run 控制
        </button>
        {status && <span className={styles.statusNote}>{status}</span>}
      </div>

      {!!suggestions.length && (
        <div className={styles.itemList}>
          {suggestions.map((item, index) => (
            <button type="button" key={`${safeString(item.kind)}-${index}`}>
              <span>{safeString(item.label)}</span>
              <small>{safeStringArray(item.ideas).join('、')}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserProfilePanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [profile, setProfile] = useState<EditableUserProfile>(DEFAULT_USER_PROFILE);
  const [memories, setMemories] = useState<EmotionalMemoryPreview[]>([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const unsubscribe = ws.subscribe(WSMsgType.USER_PROFILE_RESULT, (payload: unknown) => {
      if (!isRecord(payload)) return;
      if (payload.profile) {
        const nextProfile = normalizeUserProfile(payload.profile);
        setProfile(nextProfile);
      }
      if (Array.isArray(payload.emotional_memories)) {
        setMemories(
          payload.emotional_memories
            .filter(isRecord)
            .map((memory) => ({
              id: safeString(memory.id),
              date: safeString(memory.date),
              summary: safeString(memory.summary),
              importance: typeof memory.importance === 'number' ? memory.importance : undefined,
            }))
            .filter((memory) => memory.summary),
        );
      }
      setStatus(safeString(payload.error) || '已同步');
    });
    ws.send(WSMsgType.USER_PROFILE_GET, {});
    return unsubscribe;
  }, [ws.send, ws.subscribe]);

  const setField = <K extends keyof EditableUserProfile>(key: K, value: EditableUserProfile[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
  };

  const save = () => {
    const nextProfile = normalizeUserProfile(profile);
    setProfile(nextProfile);
    const sent = ws.send(WSMsgType.USER_PROFILE_UPDATE, {
      profile: userProfilePayload(nextProfile),
    });
    setStatus(sent ? '已提交保存' : '后端未连接，本次更改未保存');
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <UserRound size={24} />
        <div>
          <strong>用户档案</strong>
          <small>白夜的长期记忆分区</small>
        </div>
      </div>

      <div className={styles.formGrid}>
        <TextField label="姓名" value={profile.name} onChange={(value) => setField('name', value)} />
        <TextField label="昵称" value={profile.nickname} onChange={(value) => setField('nickname', value)} />
        <TextField label="年龄" value={profile.age} onChange={(value) => setField('age', value)} />
        <TextField label="生日" value={profile.birthday} onChange={(value) => setField('birthday', value)} />
        <TextField label="作息" value={profile.schedule} onChange={(value) => setField('schedule', value)} />
        <TextAreaField label="身份" value={profile.identity} onChange={(value) => setField('identity', value)} rows={2} />
        <TextField
          label="喜欢的游戏"
          value={joinList(profile.favorite_games)}
          onChange={(value) => setField('favorite_games', splitList(value))}
        />
        <TextField
          label="喜欢的动漫"
          value={joinList(profile.favorite_anime)}
          onChange={(value) => setField('favorite_anime', splitList(value))}
        />
        <TextField
          label="喜欢做的事"
          value={joinList(profile.hobbies)}
          onChange={(value) => setField('hobbies', splitList(value))}
        />
        <TextField
          label="兴趣"
          value={joinList(profile.interests)}
          onChange={(value) => setField('interests', splitList(value))}
        />
      </div>

      <div className={styles.actionRow}>
        <button type="button" onClick={save}>
          <Save size={15} />
          保存档案
        </button>
        {status && (
          <span className={styles.statusNote}>
            <Check size={14} />
            {status}
          </span>
        )}
      </div>

      <div className={styles.editorStack}>
        <div className={styles.managementHero}>
          <Heart size={20} />
          <div>
            <strong>情感记忆</strong>
            <small>{memories.length ? `${memories.length} 条最近记忆` : '等待关系里真正有重量的瞬间'}</small>
          </div>
        </div>
        <div className={styles.itemList}>
          {memories.slice(0, 6).map((memory) => (
            <button type="button" key={memory.id || memory.summary}>
              <span>{memory.summary}</span>
              <small>{memory.date || '未标注日期'}</small>
            </button>
          ))}
          {!memories.length && (
            <button type="button" disabled>
              <span>还没有独立保存的情感记忆</span>
              <small>聊天中出现明显开心、难过、吃醋、感动等事件后会生成</small>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArchiveManagerPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [archive, setArchive] = useState(() => createDefaultArchive());
  const [selectedCharacterId, setSelectedCharacterId] = useState(archive.characters[0]?.id ?? '');
  const [selectedWorldBookId, setSelectedWorldBookId] = useState(archive.worldBooks[0]?.id ?? '');
  const [characterImportStatus, setCharacterImportStatus] = useState('');
  const [characterCreatorNote, setCharacterCreatorNote] = useState('');
  const [archiveStatus, setArchiveStatus] = useState('正在连接本地档案库…');
  const archiveRevisionRef = useRef(0);
  const archiveReadyRef = useRef(false);
  const archiveWritePendingRef = useRef<ReverieArchive | null>(null);
  const archiveWriteRunningRef = useRef(false);
  const archiveRequest = ws.request;
  const selectedCharacter = archive.characters.find((item) => item.id === selectedCharacterId) ?? archive.characters[0];
  const selectedWorldBook = archive.worldBooks.find((item) => item.id === selectedWorldBookId) ?? archive.worldBooks[0];

  const flushArchiveWrites = useCallback(async () => {
    if (archiveWriteRunningRef.current || !archiveReadyRef.current) return;
    archiveWriteRunningRef.current = true;
    try {
      while (archiveWritePendingRef.current) {
        const desired = archiveWritePendingRef.current;
        archiveWritePendingRef.current = null;
        try {
          const response = await archiveRequest<Record<string, unknown>>(
            WSMsgType.ARCHIVE_PUT,
            {
              archive: desired,
              expected_revision: archiveRevisionRef.current,
            },
            { expectedType: WSMsgType.ARCHIVE_RESULT, timeout: 15_000 },
          );
          if (response.ok !== true) {
            if (response.code === 'conflict' && response.archive) {
              const authoritative = normalizeArchive(response.archive);
              archiveRevisionRef.current = Number(response.revision) || 0;
              setArchive(authoritative);
              setArchiveStatus('档案已在别处变化；为避免覆盖，已重新载入本地权威版本。');
            } else {
              archiveWritePendingRef.current ??= desired;
              setArchiveStatus(
                safeString(response.error)
                || '档案模块暂时不可用；人格和聊天未受影响，本次修改尚未落盘。',
              );
            }
            break;
          }
          archiveRevisionRef.current = Number(response.revision) || archiveRevisionRef.current;
          const committed = normalizeArchive(response.archive);
          if (!archiveWritePendingRef.current) setArchive(committed);
          setArchiveStatus('已保存到本地档案库');
        } catch (error) {
          archiveWritePendingRef.current ??= desired;
          setArchiveStatus(
            error instanceof Error
              ? `档案尚未保存：${error.message}`
              : '档案尚未保存；人格和聊天仍可继续使用。',
          );
          break;
        }
      }
    } finally {
      archiveWriteRunningRef.current = false;
    }
  }, [archiveRequest]);

  const persist = (nextArchive: ReverieArchive) => {
    if (!archiveReadyRef.current || ws.connState !== 'connected') {
      setArchiveStatus('本地档案库未连接；为避免制造第二事实源，本次修改未接受。');
      return;
    }
    const normalized = normalizeArchive(nextArchive);
    setArchive(normalized);
    archiveWritePendingRef.current = normalized;
    setArchiveStatus('正在保存到本地档案库…');
    void flushArchiveWrites();
  };

  useEffect(() => {
    const personaId = safeString(ws.personaScope?.persona_id);
    if (ws.connState !== 'connected' || !personaId) {
      archiveReadyRef.current = false;
      setArchiveStatus('本地档案库未连接；人格和聊天仍可使用。');
      return undefined;
    }
    let disposed = false;
    archiveReadyRef.current = false;
    archiveWritePendingRef.current = null;
    const hydrate = async () => {
      try {
        let response = await archiveRequest<Record<string, unknown>>(
          WSMsgType.ARCHIVE_GET,
          {},
          { expectedType: WSMsgType.ARCHIVE_RESULT, timeout: 12_000 },
        );
        if (response.ok !== true) throw new Error(safeString(response.error) || '档案模块不可用');
        if (response.exists !== true) {
          const legacy = loadLegacyArchiveForMigration();
          const seed = legacy ?? createDefaultArchive();
          response = await archiveRequest<Record<string, unknown>>(
            WSMsgType.ARCHIVE_MIGRATE,
            { archive: seed, expected_revision: 0 },
            { expectedType: WSMsgType.ARCHIVE_RESULT, timeout: 15_000 },
          );
          if (response.ok !== true) {
            throw new Error(safeString(response.error) || '旧档案迁移失败');
          }
          if (legacy) clearLegacyArchiveAfterMigration();
        }
        if (disposed) return;
        const authoritative = normalizeArchive(response.archive);
        archiveRevisionRef.current = Number(response.revision) || 0;
        archiveReadyRef.current = true;
        setArchive(authoritative);
        setSelectedCharacterId(authoritative.characters[0]?.id ?? '');
        setSelectedWorldBookId(authoritative.worldBooks[0]?.id ?? '');
        setArchiveStatus('已连接本地档案库');
        void flushArchiveWrites();
      } catch (error) {
        if (disposed) return;
        archiveReadyRef.current = false;
        setArchiveStatus(
          error instanceof Error
            ? `档案模块已隔离：${error.message}`
            : '档案模块已隔离；人格和聊天仍可使用。',
        );
      }
    };
    void hydrate();
    return () => {
      disposed = true;
      archiveReadyRef.current = false;
    };
  }, [flushArchiveWrites, ws.connState, ws.personaScope?.persona_id]);

  const saveCharacterField = <K extends keyof ReverieCharacterCard>(field: K, value: ReverieCharacterCard[K]) => {
    if (!selectedCharacter) return;
    persist(upsertCharacter(archive, { ...selectedCharacter, [field]: value, updatedAt: new Date().toISOString() }));
  };

  const addCharacter = () => {
    const timestamp = new Date().toISOString();
    const card: ReverieCharacterCard = {
      id: `char_${Date.now()}`,
      name: '新角色',
      alternateName: '',
      age: '',
      birthday: '',
      role: '',
      identity: '',
      schedule: '',
      likesDiary: false,
      values: '',
      catchphrases: [],
      neverSay: [],
      portraitUrl: '',
      description: '新的角色卡',
      personality: '',
      speakingStyle: '',
      firstMessage: '',
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const nextArchive = upsertCharacter(archive, card);
    persist({ ...nextArchive, activeCharacterIds: [...new Set([...nextArchive.activeCharacterIds, card.id])] });
    setSelectedCharacterId(card.id);
  };

  const removeCharacter = () => {
    if (!selectedCharacter || archive.characters.length <= 1) return;
    const characters = archive.characters.filter((item) => item.id !== selectedCharacter.id);
    const activeCharacterIds = archive.activeCharacterIds.filter((id) => id !== selectedCharacter.id);
    persist({
      ...archive,
      characters,
      activeCharacterIds: activeCharacterIds.length ? activeCharacterIds : [characters[0].id],
    });
    setSelectedCharacterId(characters[0].id);
  };

  const toggleActiveCharacter = (id: string) => {
    const active = new Set(archive.activeCharacterIds);
    if (active.has(id) && active.size > 1) active.delete(id);
    else active.add(id);
    persist({ ...archive, activeCharacterIds: Array.from(active) });
  };

  const importCharacter = async (file?: File) => {
    if (!file) return;
    if (ws.connState !== 'connected') {
      setCharacterImportStatus('后端未连接，为避免产生未经核验的角色档案，本次没有导入');
      return;
    }
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    if ((!isPng && file.size > 2 * 1024 * 1024) || (isPng && file.size > 16 * 1024 * 1024)) {
      setCharacterImportStatus('角色卡文件超过本地安全上限');
      return;
    }
    setCharacterCreatorNote('');
    setCharacterImportStatus('正在核验角色卡，卡内指令与远程资源不会执行');
    try {
      const raw = isPng
        ? JSON.stringify(parseSillyTavernPngPayload(await file.arrayBuffer()))
        : await readTextFile(file);
      if (!raw || raw === 'null') throw new Error('没有找到可读取的角色卡 JSON');
      const response = await requestPersonaResult(
        ws,
        WSMsgType.PERSONA_IMPORT,
        { json: raw, filename: file.name },
      );
      if (response.ok !== true || !isRecord(response.persona)) {
        throw new Error(safeString(response.error) || '角色卡核验失败');
      }
      const persona = response.persona;
      const identity = isRecord(persona.identity) ? persona.identity : {};
      const speakingStyle = isRecord(persona.speaking_style) ? persona.speaking_style : {};
      const ageUnknown = identity.age_unknown === true;
      const timestamp = new Date().toISOString();
      const card: ReverieCharacterCard = {
        id: safeString(response.card_id) || `char_${Date.now()}`,
        name: safeString(persona.name) || '未命名角色',
        alternateName: '',
        age: ageUnknown ? '' : safeString(persona.age),
        birthday: safeString(persona.birthday),
        role: 'SillyTavern 本地导入',
        identity: safeString(identity.description),
        schedule: '',
        likesDiary: true,
        values: Array.isArray(persona.values) ? persona.values.map(safeString).filter(Boolean).join('、') : '',
        catchphrases: Array.isArray(speakingStyle.catchphrases)
          ? speakingStyle.catchphrases.map(safeString).filter(Boolean)
          : [],
        neverSay: Array.isArray(speakingStyle.never_say)
          ? speakingStyle.never_say.map(safeString).filter(Boolean)
          : [],
        portraitUrl: '',
        description: safeString(persona.backstory) || safeString(identity.description),
        personality: Array.isArray(persona.personality_traits)
          ? persona.personality_traits.map(safeString).filter(Boolean).join('、')
          : '',
        speakingStyle: safeString(speakingStyle.tone),
        firstMessage: safeString(response.first_message),
        tags: ['SillyTavern', safeString(response.source_format)].filter(Boolean),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      persist(upsertCharacter(archive, card));
      setSelectedCharacterId(card.id);
      setCharacterCreatorNote(safeString(response.creator_notes).slice(0, 4000));
      const ignored = Array.isArray(response.ignored_fields)
        ? response.ignored_fields.map(safeString).filter(Boolean)
        : [];
      setCharacterImportStatus(
        ignored.length
          ? `已安全导入；已隔离 ${ignored.join('、')}`
          : '已安全导入本地角色档案',
      );
    } catch (error) {
      setCharacterCreatorNote('');
      setCharacterImportStatus(error instanceof Error ? error.message : '角色卡导入失败');
    }
  };

  const activateImportedCharacter = async () => {
    if (!selectedCharacter?.id.startsWith('st_')) return;
    const personaRecord = isRecord(ws.persona) ? ws.persona : {};
    const scope = ws.personaScope;
    const expectedPersonaId = safeString(scope?.persona_id);
    const expectedPersonaEpoch = Number(scope?.persona_epoch);
    const expectedPersonaFingerprint = safeString(scope?.persona_fingerprint);
    const loadedPersonaId = (
      safeString(personaRecord.id)
      || safeString(personaRecord.persona_id)
      || safeString(personaRecord.profile_id)
    );
    if (
      !expectedPersonaId
      || !Number.isSafeInteger(expectedPersonaEpoch)
      || expectedPersonaEpoch < 0
      || !expectedPersonaFingerprint
      || (loadedPersonaId && loadedPersonaId !== expectedPersonaId)
    ) {
      ws.send(WSMsgType.PERSONA_GET, {});
      setCharacterImportStatus('无法确认当前核心身份；已刷新状态，请稍后重试。');
      return;
    }
    const confirmed = window.confirm(
      `确认把“${selectedCharacter.name}”设为新的核心身份吗？\n\n`
      + '这会取消尚未完成的旧角色请求；完全退出并重新打开 Reverie 后生效。'
      + ' 核心身份将切换，旧角色不会被静默覆盖。',
    );
    if (!confirmed) return;
    try {
      const response = await requestPersonaResult(
        ws,
        WSMsgType.PERSONA_ACTIVATE,
        {
          profile_id: selectedCharacter.id,
          confirmed_profile_id: selectedCharacter.id,
          identity_change_confirmed: true,
          expected_persona_id: expectedPersonaId,
          expected_persona_epoch: expectedPersonaEpoch,
          expected_persona_fingerprint: expectedPersonaFingerprint,
          actor: 'owner',
          reason: 'user selected imported persona',
        },
      );
      if (response.ok !== true) {
        const code = `${safeString(response.code)} ${safeString(response.status)} ${safeString(response.error)}`.toLowerCase();
        if (response.conflict === true || code.includes('conflict') || code.includes('stale')) {
          ws.send(WSMsgType.PERSONA_GET, {});
          throw new Error('核心身份已在别处变化；状态已刷新，没有覆盖现有身份。');
        }
        throw new Error(safeString(response.error) || '启用失败');
      }
      setCharacterImportStatus('已设为主角色，完全退出并重新打开 Reverie 后生效');
    } catch (error) {
      setCharacterImportStatus(error instanceof Error ? error.message : '启用失败');
    }
  };

  const saveWorldBookField = (field: keyof ReverieWorldBook, value: string) => {
    if (!selectedWorldBook) return;
    persist(upsertWorldBook(archive, { ...selectedWorldBook, [field]: value, updatedAt: new Date().toISOString() }));
  };

  const addWorldBook = () => {
    const worldBook = { ...createDefaultWorldBook(), id: `world_${Date.now()}`, name: '新世界书', entries: [] };
    persist(upsertWorldBook(archive, worldBook));
    setSelectedWorldBookId(worldBook.id);
  };

  const updateEntry = (entryId: string, patch: Partial<WorldBookEntry>) => {
    if (!selectedWorldBook) return;
    const entries = selectedWorldBook.entries.map((entry) =>
      entry.id === entryId ? { ...entry, ...patch } : entry,
    );
    persist(upsertWorldBook(archive, { ...selectedWorldBook, entries, updatedAt: new Date().toISOString() }));
  };

  const addEntry = () => {
    if (!selectedWorldBook) return;
    persist(upsertWorldBook(archive, {
      ...selectedWorldBook,
      entries: [...selectedWorldBook.entries, emptyEntry()],
      updatedAt: new Date().toISOString(),
    }));
  };

  const removeEntry = (entryId: string) => {
    if (!selectedWorldBook) return;
    persist(upsertWorldBook(archive, {
      ...selectedWorldBook,
      entries: selectedWorldBook.entries.filter((entry) => entry.id !== entryId),
      updatedAt: new Date().toISOString(),
    }));
  };

  const importWorldBook = async (file?: File) => {
    if (!file) return;
    const worldBook = parseWorldBookImportText(await readTextFile(file), filenameStem(file) || undefined);
    if (!worldBook) return;
    persist(upsertWorldBook(archive, { ...worldBook, updatedAt: new Date().toISOString() }));
    setSelectedWorldBookId(worldBook.id);
  };

  return (
    <div className={styles.managementPanel}>
      <section className={styles.avatarArchiveEntry}>
        <div className={styles.managementHero}>
          <UserRound size={22} />
          <div>
            <strong>形象模型</strong>
            <small>主界面已预置 Yumi 静态预览；可导入 VRM、GLB、Live2D ZIP 或完整 Live2D 文件夹。</small>
          </div>
        </div>
        <div className={styles.actionRow}>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(
              'reverie:open-avatar-manager',
              { detail: { start: 'file' } },
            ))}
          >
            <Upload size={15} />
            导入模型文件
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(
              'reverie:open-avatar-manager',
              { detail: { start: 'folder' } },
            ))}
          >
            <Upload size={15} />
            导入 Live2D 文件夹
          </button>
        </div>
        <small>
          Live2D 动画渲染受 Cubism 应用级许可与运行库闸门约束；未满足时不会伪装成功，VRM/GLB 仍可独立使用。
        </small>
      </section>
      <span className={styles.statusNote} role="status">
        <HardDrive size={14} />
        {archiveStatus}
      </span>
      <div className={styles.archiveColumns}>
        <section className={styles.archiveColumn}>
          <div className={styles.managementHero}>
            <Users size={22} />
            <div>
              <strong>角色卡</strong>
              <small>{archive.activeCharacterIds.length} 位参与对话</small>
            </div>
          </div>

          <div className={styles.itemList}>
            {archive.characters.map((card) => (
              <button
                type="button"
                key={card.id}
                className={card.id === selectedCharacterId ? styles.itemActive : ''}
                onClick={() => setSelectedCharacterId(card.id)}
              >
                <span>{card.name}</span>
                <small>{archive.activeCharacterIds.includes(card.id) ? '已加入' : '待命'}</small>
              </button>
            ))}
          </div>

          {selectedCharacter && (
            <div className={styles.editorStack}>
              {selectedCharacter.portraitUrl && (
                <figure className={styles.characterPortrait}>
                  <img src={selectedCharacter.portraitUrl} alt={`${selectedCharacter.name} 立绘`} />
                  <figcaption>{selectedCharacter.alternateName || selectedCharacter.name}</figcaption>
                </figure>
              )}
              <TextField label='名字' value={selectedCharacter.name} onChange={(value) => saveCharacterField('name', value)} />
              <TextField label='英文名' value={selectedCharacter.alternateName ?? ''} onChange={(value) => saveCharacterField('alternateName', value)} />
              <TextField label='年龄' value={selectedCharacter.age ?? ''} onChange={(value) => saveCharacterField('age', value)} />
              <TextField label='生日' value={selectedCharacter.birthday ?? ''} onChange={(value) => saveCharacterField('birthday', value)} />
              <TextField label='定位' value={selectedCharacter.role ?? ''} onChange={(value) => saveCharacterField('role', value)} />
              <TextField label='作息' value={selectedCharacter.schedule ?? ''} onChange={(value) => saveCharacterField('schedule', value)} />
              <TextField label='立绘路径' value={selectedCharacter.portraitUrl ?? ''} onChange={(value) => saveCharacterField('portraitUrl', value)} />
              <TextAreaField label='身份' value={selectedCharacter.identity ?? ''} onChange={(value) => saveCharacterField('identity', value)} rows={2} />
              <TextAreaField label='描述' value={selectedCharacter.description} onChange={(value) => saveCharacterField('description', value)} />
              <TextAreaField label='性格' value={selectedCharacter.personality} onChange={(value) => saveCharacterField('personality', value)} />
              <TextAreaField label='说话方式' value={selectedCharacter.speakingStyle} onChange={(value) => saveCharacterField('speakingStyle', value)} rows={3} />
              <TextAreaField label='价值观' value={selectedCharacter.values ?? ''} onChange={(value) => saveCharacterField('values', value)} rows={2} />
              <TextField label='口头禅' value={joinList(selectedCharacter.catchphrases)} onChange={(value) => saveCharacterField('catchphrases', splitList(value))} />
              <TextField label='禁用表达' value={joinList(selectedCharacter.neverSay)} onChange={(value) => saveCharacterField('neverSay', splitList(value))} />
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={selectedCharacter.likesDiary === true}
                  onChange={(event) => saveCharacterField('likesDiary', event.target.checked)}
                />
                <span>喜欢写日记</span>
              </label>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={archive.activeCharacterIds.includes(selectedCharacter.id)}
                  onChange={() => toggleActiveCharacter(selectedCharacter.id)}
                />
                <span>加入多角色对话</span>
              </label>
            </div>
          )}

          <div className={styles.actionRow}>
            <button type="button" onClick={addCharacter}>
              <Plus size={15} />
              新建
            </button>
            <button type="button" onClick={removeCharacter} disabled={archive.characters.length <= 1}>
              <Trash2 size={15} />
              删除
            </button>
            {selectedCharacter && (
              <button
                type="button"
                onClick={() => downloadJson(`${selectedCharacter.name}-角色卡.json`, createCharacterCardExport(selectedCharacter))}
              >
                <Download size={15} />
                导出
              </button>
            )}
            {selectedCharacter?.id.startsWith('st_') && (
              <button type="button" onClick={activateImportedCharacter} disabled={ws.connState !== 'connected'}>
                <Check size={15} />
                下次启动使用此角色
              </button>
            )}
            <label className={styles.fileButton}>
              <Upload size={15} />
              导入
              <input type="file" accept="application/json,.json,image/png,.png" onChange={(event) => importCharacter(event.target.files?.[0])} />
            </label>
          </div>
          {characterImportStatus && (
            <span className={styles.statusNote} role="status">
              <ShieldCheck size={14} />
              {characterImportStatus}
            </span>
          )}
          {characterCreatorNote && (
            <div className={styles.creatorNote}>
              <strong>作者说明</strong>
              <p>{characterCreatorNote}</p>
            </div>
          )}
        </section>

        <section className={styles.archiveColumn}>
          <div className={styles.managementHero}>
            <FileJson size={22} />
            <div>
              <strong>世界书</strong>
              <small>{selectedWorldBook?.entries.length ?? 0} 条设定</small>
            </div>
          </div>

          <div className={styles.itemList}>
            {archive.worldBooks.map((book) => (
              <button
                type="button"
                key={book.id}
                className={book.id === selectedWorldBookId ? styles.itemActive : ''}
                onClick={() => setSelectedWorldBookId(book.id)}
              >
                <span>{book.name}</span>
                <small>{book.entries.length} 条</small>
              </button>
            ))}
          </div>

          {selectedWorldBook && (
            <div className={styles.editorStack}>
              <TextField label="名称" value={selectedWorldBook.name} onChange={(value) => saveWorldBookField('name', value)} />
              <div className={styles.worldEntryList}>
                {selectedWorldBook.entries.map((entry) => (
                  <article key={entry.id} className={styles.worldEntry}>
                    <TextField label="关键词" value={entry.key} onChange={(value) => updateEntry(entry.id, { key: value })} />
                    <TextField label="标题" value={entry.comment} onChange={(value) => updateEntry(entry.id, { comment: value })} />
                    <TextAreaField label="内容" value={entry.content} onChange={(value) => updateEntry(entry.id, { content: value })} rows={3} />
                    <div className={styles.entryFlags}>
                      <label>
                        <input
                          type="checkbox"
                          checked={entry.alwaysActive}
                          onChange={(event) => updateEntry(entry.id, { alwaysActive: event.target.checked })}
                        />
                        始终激活
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onChange={(event) => updateEntry(entry.id, { enabled: event.target.checked })}
                        />
                        启用
                      </label>
                      <button type="button" onClick={() => removeEntry(entry.id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          <div className={styles.actionRow}>
            <button type="button" onClick={addWorldBook}>
              <Plus size={15} />
              新建
            </button>
            <button type="button" onClick={addEntry} disabled={!selectedWorldBook}>
              <Plus size={15} />
              条目
            </button>
            {selectedWorldBook && (
              <button
                type="button"
                onClick={() => downloadJson(`${selectedWorldBook.name}.json`, createWorldBookExport(selectedWorldBook))}
              >
                <Download size={15} />
                导出
              </button>
            )}
            <label className={styles.fileButton}>
              <Upload size={15} />
              导入
              <input type="file" accept="application/json,.json" onChange={(event) => importWorldBook(event.target.files?.[0])} />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

function requestPersonaResult(
  ws: ReturnType<typeof useReverieWS>,
  requestType: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('本地角色卡核验响应超时，未创建任何角色'));
    }, 12_000);
    unsubscribe = ws.subscribe(WSMsgType.PERSONA_IMPORT_RESULT, (response: Record<string, unknown>) => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve(response);
    });
    if (!ws.send(requestType, payload)) {
      window.clearTimeout(timer);
      unsubscribe();
      reject(new Error('后端未连接，未创建任何角色'));
    }
  });
}

export function BackupPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [status, setStatus] = useState('');
  const nativeBackup = window.electronAPI?.backup;

  const exportBackup = async () => {
    if (!nativeBackup) {
      setStatus('原生流式备份不可用；为避免假成功，本次没有创建文件');
      return;
    }
    setStatus('正在流式写入完整本地世界状态，请保持应用开启');
    try {
      const result = await nativeBackup.export();
      if (result.canceled) {
        setStatus('已取消，没有创建备份文件');
      } else if (result.ok) {
        setStatus(`完整本地备份已原子写入：${result.fileName || '所选文件'}`);
      } else {
        throw new Error('主进程未确认备份写入完成');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '导出失败');
    }
  };

  const importNativeBackup = async () => {
    if (!nativeBackup) {
      setStatus('原生流式恢复不可用；当前状态没有被修改');
      return;
    }
    setStatus('等待选择并核验完整本地备份');
    try {
      const result = await nativeBackup.import();
      if (result.canceled) {
        setStatus('已取消，当前本地世界状态未改变');
        return;
      }
      if (!result.ok) throw new Error('主进程未确认恢复提交完成');
      ws.refreshDiary();
      ws.refreshTimeline();
      ws.send(WSMsgType.EMOTION_GET, {});
      ws.send(WSMsgType.RELATIONSHIP_GET, {});
      setStatus('完整本地世界状态已经过核验并提交');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '恢复失败，当前状态未确认改变');
    }
  };

  const importLegacyBackup = async (file?: File) => {
    if (!file) return;
    let backup;
    try {
      backup = parseBackupImport(await readJsonFile(file));
    } catch {
      backup = null;
    }
    if (!backup) {
      setStatus('这不是可识别的旧版 Reverie 备份');
      return;
    }
    let archiveSnapshot: Record<string, unknown>;
    try {
      archiveSnapshot = await ws.request<Record<string, unknown>>(
        WSMsgType.ARCHIVE_GET,
        {},
        { expectedType: WSMsgType.ARCHIVE_RESULT, timeout: 12_000 },
      );
      if (archiveSnapshot.ok !== true) {
        throw new Error(safeString(archiveSnapshot.error) || '本地档案模块不可用');
      }
      const archiveWrite = await ws.request<Record<string, unknown>>(
        WSMsgType.ARCHIVE_PUT,
        {
          archive: backup.archive,
          expected_revision: Number(archiveSnapshot.revision) || 0,
        },
        { expectedType: WSMsgType.ARCHIVE_RESULT, timeout: 15_000 },
      );
      if (archiveWrite.ok !== true) {
        throw new Error(safeString(archiveWrite.error) || '旧档案未写入本地权威数据库');
      }
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `旧备份未导入：${error.message}`
          : '旧备份未导入；现有数据保持不变。',
      );
      return;
    }
    if (backup.onboarding) {
      const memoryResult = await ws.request<Record<string, unknown>>(
        WSMsgType.SETTINGS_UPDATE,
        {
          section: 'memory',
          retention_days: backup.onboarding.memoryRetentionDays,
        },
        { expectedType: WSMsgType.SETTINGS_UPDATE_RESULT, timeout: 8_000 },
      );
      if (memoryResult.ok !== true) {
        setStatus(`旧备份的记忆期限未应用：${safeString(memoryResult.error) || '设置被拒绝'}`);
        return;
      }
      const onboardingResult = await ws.request<Record<string, unknown>>(
        WSMsgType.SETTINGS_UPDATE,
        { section: 'onboarding', completed: true },
        { expectedType: WSMsgType.SETTINGS_UPDATE_RESULT, timeout: 8_000 },
      );
      if (onboardingResult.ok !== true) {
        setStatus(`旧备份的初始设置未完成：${safeString(onboardingResult.error) || '设置被拒绝'}`);
        return;
      }
    }
    if (backup.llmConfig) {
      await saveConfigMetadata({ ...backup.llmConfig, apiKey: '' });
    }
    if (backup.userProfile) {
      const profile = normalizeUserProfile(backup.userProfile);
      ws.send(WSMsgType.USER_PROFILE_UPDATE, { profile: userProfilePayload(profile) });
    }
    ws.refreshDiary();
    ws.refreshTimeline();
    ws.send(WSMsgType.EMOTION_GET, {});
    ws.send(WSMsgType.RELATIONSHIP_GET, {});
    const warnings = [...backup.securityWarnings];
    if (
      backup.evidence.chatMessages.length
      || backup.evidence.diaryEntries.length
      || backup.evidence.timelinePosts.length
    ) {
      warnings.push(
        '旧版聊天、日记与动态没有写入浏览器缓存；请保留原文件，待通过内核迁移器验证后再恢复。',
      );
    }
    if (backup.worldState) {
      warnings.push('旧版内嵌世界状态未通过受限原生文件通道恢复；请保留原文件。');
    }
    setStatus(warnings.length
      ? `旧版档案数据已导入。${warnings.join(' ')}`
      : '旧版档案数据已导入');
  };

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <ShieldCheck size={24} />
        <div>
          <strong>备份</strong>
          <small>JSON</small>
        </div>
      </div>
      <div className={styles.backupGrid}>
        <button type="button" onClick={exportBackup} disabled={!nativeBackup}>
          <Download size={18} />
          原生导出完整备份
        </button>
        <button type="button" onClick={importNativeBackup} disabled={!nativeBackup}>
          <Upload size={18} />
          原生恢复完整备份
        </button>
        <label className={styles.fileButtonLarge}>
          <Upload size={18} />
          导入旧版界面备份
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => importLegacyBackup(event.target.files?.[0])}
          />
        </label>
      </div>
      {status && (
        <span className={styles.statusNote}>
          <Check size={14} />
          {status}
        </span>
      )}
    </div>
  );
}
