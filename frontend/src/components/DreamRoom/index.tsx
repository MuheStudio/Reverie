import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  BookOpen,
  Brain,
  Camera,
  Cpu,
  Gamepad2,
  Heart,
  ImagePlus,
  LibraryBig,
  LockKeyhole,
  KeyRound,
  HardDriveDownload,
  MapPin,
  MessageCircle,
  MessagesSquare,
  Moon,
  Music,
  Radio,
  RefreshCw,
  Save,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  UserRound,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  WSMsgType,
  useReverieWS,
  type DiaryEntry,
  type KeepsakeItem,
  type RelationshipData,
  type StickerItem,
  type TimelinePost,
  type GroupThread,
} from '@/hooks/useReverieWS';
import {
  AiSettingsPanel,
  AntiAiSettingsPanel,
  ArchiveManagerPanel,
  BackupPanel,
  ChatSettingsPanel,
  DiarySettingsPanel,
  MemorySettingsPanel,
  PersonalitySettingsPanel,
  ImmersionSettingsPanel,
  UserProfilePanel,
} from './ArchivePanels';
import {
  formatDiaryPreview,
  formatEvidenceConnectionLine,
  formatRecentInterest,
  formatRelationshipStage,
  getDiaryPrivacyLine,
  getLatestDiaryEntry,
  getLatestTimelinePost,
  getPersonaDisplayName,
  getPersonaIdentityLine,
  deriveRoomAtmosphere,
  type PhoneAppPanelId,
  type RoomMoodState,
  type RoomPanelId,
} from './roomState';
import { loadReverieChatDraft, saveReverieChatDraft } from '@/lib/reverieChatStorage';
import MiniGamePanel from './MiniGamePanel';
import RoomScene from './RoomScene';
import CompanionDock, { type DockTab } from './CompanionDock';
import FirstRunGuide, { isFirstRunGuideDone } from './FirstRunGuide';
import { type CharacterActivity } from './AvatarStage';
import { deriveCharacterActivity } from './characterActivity';
import styles from './index.module.scss';

type PanelMeta = {
  title: string;
  subtitle: string;
  refreshLabel?: string;
  icon: LucideIcon;
};

const PANEL_META: Record<RoomPanelId, PanelMeta> = {
  diary: {
    title: '日记',
    subtitle: '这里不是公开页面，只展示她允许房间看见的生活痕迹。',
    refreshLabel: '刷新日记',
    icon: BookOpen,
  },
  phone: {
    title: '手机',
    subtitle: '动态、音乐、回忆、视频和小游戏都收在这块屏幕里。',
    icon: Smartphone,
  },
  timeline: {
    title: '动态',
    subtitle: '像深夜刷到她的小动态，而不是打开另一个桌面应用。',
    refreshLabel: '刷新动态',
    icon: Radio,
  },
  group: {
    title: '群聊',
    subtitle: '多个本地角色共享的群聊记录。',
    refreshLabel: '刷新群聊',
    icon: MessagesSquare,
  },
  memory: {
    title: '回忆',
    subtitle: '把日记、动态和关系变化折成可以收藏的小纸片。',
    icon: Camera,
  },
  music: {
    title: '音乐',
    subtitle: '房间的情绪声场，也可以导入本地音频播放。',
    icon: Music,
  },
  stickers: {
    title: '表情',
    subtitle: '导入 PNG、JPEG、WebP 或 GIF，保存在本机表情库。',
    icon: ImagePlus,
  },
  video: {
    title: '视频',
    subtitle: '导入常见视频格式，在房间里直接播放。',
    icon: Video,
  },
  tetris: {
    title: '俄罗斯方块',
    subtitle: '手机里的本地小游戏。',
    icon: Gamepad2,
  },
  snake: {
    title: '贪吃蛇',
    subtitle: '手机里的本地小游戏。',
    icon: Gamepad2,
  },
  gomoku: {
    title: '五子棋',
    subtitle: '手机里的本地双人棋盘。',
    icon: Gamepad2,
  },
  chess: {
    title: '国际象棋',
    subtitle: '手机里的本地棋盘。',
    icon: Gamepad2,
  },
  xiangqi: {
    title: '中国象棋',
    subtitle: '手机里的本地棋盘。',
    icon: Gamepad2,
  },
  go: {
    title: '围棋',
    subtitle: '手机里的本地棋盘。',
    icon: Gamepad2,
  },
  ai: {
    title: 'AI 接口',
    subtitle: 'OpenAI、Claude、Gemini、Grok、DeepSeek、Kimi、Z.AI 与 Ollama。',
    icon: Cpu,
  },
  antiAiSettings: {
    title: '防AI味',
    subtitle: '提示词注入防护、人格锚定、输出过滤与重写。',
    icon: ShieldCheck,
  },
  archive: {
    title: '角色卡与世界书',
    subtitle: '创建、导入、导出 .json 档案，并选择多角色对话成员。',
    icon: LibraryBig,
  },
  backup: {
    title: '备份',
    subtitle: '导出或导入 Reverie JSON 备份。',
    icon: HardDriveDownload,
  },
  chatSettings: {
    title: '聊天设置',
    subtitle: '回复延迟、输入中、在线状态和消息节奏。',
    icon: MessageCircle,
  },
  diarySettings: {
    title: '日记设置',
    subtitle: '控制睡前写日记、加密、偷看和随机熬夜事件。',
    icon: BookOpen,
  },
  memorySettings: {
    title: '遗忘设置',
    subtitle: '控制长期/短期记忆的保存、语义检索、随机遗忘和记忆偏差。',
    icon: Brain,
  },
  personalitySettings: {
    title: '人格设置',
    subtitle: '缺点、情绪、朋友圈世界观与群体社交。',
    icon: Sparkles,
  },
  immersionSettings: {
    title: '真实与沉浸感',
    subtitle: '定位生活场景、吃饭特写、购物和智能家居 dry-run。',
    icon: MapPin,
  },
  userProfile: {
    title: '用户档案',
    subtitle: '维护“我”的长期资料与情感记忆。',
    icon: UserRound,
  },
  settings: {
    title: '设置',
    subtitle: '接口、日记、遗忘、档案、备份和刷新都放在这里。',
    icon: SettingsIcon,
  },
  status: {
    title: '状态',
    subtitle: '查看关系阶段、最近兴趣与它们的变化说明。',
    icon: Activity,
  },
};

type PhoneAppMeta = {
  id: PhoneAppPanelId;
  label: string;
  subtitle: string;
  icon: LucideIcon;
};

type GameInviteHandler = (game: PhoneAppPanelId, stateLine?: string) => void;

const PHONE_APPS: PhoneAppMeta[] = [
  { id: 'timeline', label: '动态', subtitle: '她今天的小动态', icon: Radio },
  { id: 'group', label: '群聊', subtitle: '本地角色的小群', icon: MessagesSquare },
  { id: 'music', label: '音乐', subtitle: '导入音频并播放', icon: Music },
  { id: 'stickers', label: '表情', subtitle: '导入图片与 GIF', icon: ImagePlus },
  { id: 'memory', label: '回忆', subtitle: '关系与共同痕迹', icon: Camera },
  { id: 'video', label: '视频', subtitle: '导入视频并播放', icon: Video },
  { id: 'tetris', label: '俄罗斯方块', subtitle: '方块练习', icon: Gamepad2 },
  { id: 'snake', label: '贪吃蛇', subtitle: '方向控制', icon: Gamepad2 },
  { id: 'gomoku', label: '五子棋', subtitle: '黑白轮流落子', icon: Gamepad2 },
  { id: 'chess', label: '国际象棋', subtitle: '本地棋盘', icon: Gamepad2 },
  { id: 'xiangqi', label: '中国象棋', subtitle: '本地棋盘', icon: Gamepad2 },
  { id: 'go', label: '围棋', subtitle: '黑白围地', icon: Gamepad2 },
];

const GAME_PANEL_IDS: PhoneAppPanelId[] = ['tetris', 'snake', 'gomoku', 'chess', 'xiangqi', 'go'];
const AI_PLAYABLE_GAME_IDS: PhoneAppPanelId[] = ['gomoku', 'chess', 'xiangqi', 'go'];
const EMBEDDED_GAME_ROUTES: Partial<Record<PhoneAppPanelId, string>> = {};

function isGamePanel(panel: RoomPanelId): panel is PhoneAppPanelId {
  return GAME_PANEL_IDS.includes(panel as PhoneAppPanelId);
}

function isEmbeddedGamePanel(panel: RoomPanelId): panel is PhoneAppPanelId {
  return Boolean(EMBEDDED_GAME_ROUTES[panel as PhoneAppPanelId]);
}

function resolveEmbeddedAppSrc(route: string): string {
  if (window.location.protocol === 'file:') {
    return `${window.location.pathname}#${route}`;
  }
  return route;
}

function formatDateLabel(value?: string): string {
  if (!value) return '时间还没写清楚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function readDataUrlFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

const STICKER_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function readStickerImage(file: File): Promise<{ dataUrl: string; mime: string }> {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const inferredMime = STICKER_MIME_BY_EXTENSION[extension] ?? '';
  const mime = Object.values(STICKER_MIME_BY_EXTENSION).includes(file.type)
    ? file.type
    : inferredMime;
  if (!mime) throw new Error('unsupported-sticker-format');

  // Windows may provide an empty or generic MIME type for otherwise valid
  // local files. Normalise it here; the Python boundary still verifies the
  // decoded file signature before persistence.
  const readable = file.type === mime
    ? file
    : new File([file], file.name, { type: mime, lastModified: file.lastModified });
  return { dataUrl: await readDataUrlFile(readable), mime };
}

function formatTimelinePreview(post?: TimelinePost): string {
  if (!post) return '手机屏幕还暗着，等她生活里发生一点小事。';
  if (post.content?.trim()) return post.content.trim();
  if (post.tags?.length) return `她给这一天贴了 ${post.tags.join('、')} 的标签。`;
  if (post.event_type) return `有一件 ${post.event_type} 类型的小事被记下来了。`;
  return '这条动态像刚亮起的屏幕，还没来得及显示更多。';
}

function sortDiary(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => {
    const left = Date.parse(a.date || '');
    const right = Date.parse(b.date || '');
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
}

function sortTimeline(posts: TimelinePost[]): TimelinePost[] {
  return [...posts].sort((a, b) => {
    const left = Date.parse(a.date || '');
    const right = Date.parse(b.date || '');
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });
}

function isDiaryLocked(entry: DiaryEntry): boolean {
  return Boolean(entry.is_locked || entry.status_label === 'locked');
}

function useDiaryWritingSound(active: boolean): void {
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  useEffect(() => {
    const unlock = () => setAudioUnlocked(true);
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    if (!active || !audioUnlocked || typeof window.AudioContext !== 'function') return undefined;

    let context: AudioContext | null = null;
    try {
      context = new window.AudioContext();
    } catch {
      return undefined;
    }

    const scratch = () => {
      if (!context || context.state === 'closed') return;
      const frameCount = Math.max(1, Math.floor(context.sampleRate * 0.055));
      const buffer = context.createBuffer(1, frameCount, context.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < channel.length; index += 1) {
        channel[index] = (Math.random() * 2 - 1) * (1 - index / channel.length);
      }
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      filter.type = 'bandpass';
      filter.frequency.value = 1300;
      filter.Q.value = 0.8;
      gain.gain.value = 0.008;
      source.buffer = buffer;
      source.connect(filter).connect(gain).connect(context.destination);
      source.start();
    };

    scratch();
    const timer = window.setInterval(scratch, 560);
    return () => {
      window.clearInterval(timer);
      void context?.close();
    };
  }, [active, audioUnlocked]);
}

export function PhoneChatPanel({
  ws,
  personaName,
  onClose,
}: {
  ws: ReturnType<typeof useReverieWS>;
  personaName: string;
  onClose: () => void;
}) {
  const [input, setInput] = useState(() => loadReverieChatDraft());
  const [showStickers, setShowStickers] = useState(false);
  const [stickerError, setStickerError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const connected = ws.connState === 'connected';
  const presenceLabel = ws.isTyping
    ? '对方正在输入中'
    : connected
      ? ws.chatPresence.label || '在线'
      : '离线';

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !connected) return;
    ws.addUserMessage(text);
    ws.sendChat(text);
    setInput('');
    saveReverieChatDraft('');
  }, [connected, input, ws]);

  const saveBubbleMemory = useCallback((content: string, layer: 'long_term' | 'short_term') => {
    const text = content.trim();
    if (!text || !connected) return;
    ws.storeMemory(text, layer);
  }, [connected, ws]);

  const sendSticker = useCallback((sticker: StickerItem) => {
    if (!connected) return;
    const text = sticker.text.trim() || '[用户发送了一个表情包]';
    ws.addUserMessage(text, sticker);
    ws.sendChat(text, sticker);
    setShowStickers(false);
    setStickerError('');
  }, [connected, ws]);

  const uploadSticker = useCallback(async (file?: File) => {
    if (!file || !connected) return;
    if (file.size < 1 || file.size > 1_800_000) {
      setStickerError('请选择不超过 1.8 MB 的图片');
      return;
    }
    try {
      const { dataUrl } = await readStickerImage(file);
      sendSticker({
        id: '',
        text: file.name.replace(/\.[^.]+$/, '').slice(0, 80),
        emotions: [],
        source: 'collected',
        image_data_url: dataUrl,
        style_tags: [],
      });
    } catch {
      setStickerError('仅支持 PNG、JPEG、WebP 与 GIF 图片');
    }
  }, [connected, sendSticker]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [ws.chatMessages.length, ws.currentChunk, ws.isTyping]);

  return (
    <aside className={styles.phoneChat} data-testid="dream-chat-panel">
      <header className={styles.phoneHeader}>
        <button className={styles.phoneClose} onClick={onClose} aria-label="关闭聊天">
          <X size={16} />
        </button>
        <div>
          <strong>{personaName}</strong>
          <span>{connected ? `${presenceLabel} · 正在房间里` : '离线 · 等待连接'}</span>
        </div>
      </header>

      <div className={styles.phoneMessages} role="log" aria-live="polite" aria-busy={ws.isTyping}>
        {ws.chatMessages.length === 0 && !ws.isTyping && (
          <div className={styles.phoneEmpty}>
            <Moon size={24} />
            <p>她的房间很安静。</p>
            <small>轻轻敲一下键盘，就像敲门。</small>
          </div>
        )}
        {ws.chatMessages.map((message) => (
          <div
            key={message.id}
            className={`${styles.phoneBubble} ${
              message.role === 'user'
                ? styles.phoneBubbleUser
                : message.role === 'system'
                  ? styles.phoneBubbleSystem
                  : styles.phoneBubbleHer
            }`}
          >
            {message.sticker?.image_data_url && (
              <img
                className={styles.phoneSticker}
                src={message.sticker.image_data_url}
                alt={message.sticker.text || 'sticker'}
              />
            )}
            {message.content.trim() && <span className={styles.phoneBubbleContent}>{message.content}</span>}
            {(message.content.trim() || message.sticker) && (
              <span className={styles.phoneBubbleActions}>
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => saveBubbleMemory(message.content, 'long_term')}
                >
                  长期
                </button>
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => saveBubbleMemory(message.content, 'short_term')}
                >
                  短期
                </button>
              </span>
            )}
          </div>
        ))}
        {ws.isTyping && (
          <div className={`${styles.phoneBubble} ${styles.phoneBubbleHer}`}>
            {ws.currentChunk || <span className={styles.typingDots}>...</span>}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.phoneComposer}>
        {showStickers && (
          <div className={styles.stickerTray} aria-label="已收藏表情包">
            <label className={styles.stickerUpload} title="收藏并发送本地表情包">
              <ImagePlus size={18} />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                onChange={(event) => {
                  uploadSticker(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            {ws.stickers.slice(0, 24).map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                className={styles.stickerChoice}
                onClick={() => sendSticker(sticker)}
                title={sticker.emotions.join('、') || '表情包'}
              >
                {sticker.image_data_url
                  ? <img src={sticker.image_data_url} alt={sticker.text || '表情包'} />
                  : <span>{sticker.text}</span>}
              </button>
            ))}
            {stickerError && <small className={styles.stickerError}>{stickerError}</small>}
          </div>
        )}
        <footer className={styles.phoneInputRow}>
          <button
            className={styles.emojiButton}
            type="button"
            aria-label="表情包"
            onClick={() => {
              const next = !showStickers;
              setShowStickers(next);
              if (next) ws.refreshStickers();
            }}
          >
            <Sparkles size={17} />
          </button>
          <input
            value={input}
            onChange={(event) => {
              const draft = event.target.value;
              setInput(draft);
              saveReverieChatDraft(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') sendMessage();
            }}
            placeholder={connected ? '小声说点什么...' : '离线草稿会保存在本地'}
          />
          <button
            className={styles.sendButton}
            type="button"
            onClick={sendMessage}
            disabled={!connected || !input.trim()}
            aria-label="发送"
          >
            <Send size={16} />
          </button>
        </footer>
      </div>
    </aside>
  );
}

function RoomDrawer({
  panel,
  connected,
  onClose,
  onRefresh,
  children,
}: {
  panel: RoomPanelId;
  connected: boolean;
  onClose: () => void;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  const meta = PANEL_META[panel];
  const Icon = meta.icon;
  const sheetRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = `room-drawer-title-${panel}`;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const shell = document.querySelector<HTMLElement>('[data-dream-shell-content]');
    shell?.setAttribute('inert', '');
    const sheet = sheetRef.current;
    const nodes = sheet
      ? Array.from(sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      : [];
    (nodes[0] || sheet)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) {
        event.preventDefault();
        sheet.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      shell?.removeAttribute('inert');
      document.removeEventListener('keydown', handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className={styles.roomDrawer}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="dream-room-panel"
    >
      <button
        type="button"
        className={styles.drawerScrim}
        onClick={onClose}
        aria-label="关闭房间抽屉"
      />
      <section ref={sheetRef} className={styles.drawerSheet} data-panel={panel} tabIndex={-1}>
        <header className={styles.drawerHeader}>
          <div className={styles.drawerTitle}>
            <span>
              <Icon size={20} />
            </span>
            <div>
              <strong id={titleId}>{meta.title}</strong>
              <small>{meta.subtitle}</small>
            </div>
          </div>
          <div className={styles.drawerActions}>
            {onRefresh && (
              <button type="button" onClick={onRefresh} disabled={!connected}>
                <RefreshCw size={14} />
                {meta.refreshLabel}
              </button>
            )}
            <button className={styles.drawerClose} type="button" onClick={onClose} aria-label="关闭">
              <X size={17} />
            </button>
          </div>
        </header>
        <div className={styles.drawerBody}>{children}</div>
      </section>
    </div>
  );
}

function PhoneHomePanel({
  apps,
  onOpenApp,
}: {
  apps: PhoneAppMeta[];
  onOpenApp: (app: PhoneAppPanelId) => void;
}) {
  return (
    <div className={styles.phoneShell} aria-label="手机屏幕">
      <div className={styles.phoneSpeaker} />
      <div className={styles.phoneScreen}>
        <div className={styles.phoneStatusBar}>
          <span>Reverie</span>
          <span>23:00</span>
        </div>
        <div className={styles.phoneAppGrid}>
          {apps.map((app) => {
            const Icon = app.icon;
            return (
              <button
                type="button"
                key={app.id}
                className={styles.phoneAppButton}
                onClick={() => onOpenApp(app.id)}
              >
                <span className={styles.phoneAppIcon}>
                  <Icon size={22} />
                </span>
                <strong>{app.label}</strong>
                <small>{app.subtitle}</small>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StickerLibraryPanel({
  ws,
  connected,
}: {
  ws: ReturnType<typeof useReverieWS>;
  connected: boolean;
}) {
  const [caption, setCaption] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (connected) ws.refreshStickers();
  }, [connected, ws.refreshStickers]);

  const selectImage = async (file?: File) => {
    if (!file) return;
    if (file.size < 1 || file.size > 1_800_000) {
      setStatus('图片需小于 1.8 MB，避免本地表情库过快膨胀。');
      return;
    }
    try {
      const { dataUrl: next, mime } = await readStickerImage(file);
      setImageDataUrl(next);
      setFileName(file.name);
      setCaption((current) => current || file.name.replace(/\.[^.]+$/, '').slice(0, 80));
      setStatus(mime === 'image/gif' ? 'GIF 已读取，动画会原样保留。' : '图片已读取，等待保存。');
    } catch {
      setStatus('仅支持有效的 PNG、JPEG、WebP 与 GIF 图片。');
    }
  };

  const saveSticker = () => {
    if (!connected) {
      setStatus('本地服务尚未连接，连接恢复后再保存。');
      return;
    }
    if (!imageDataUrl) {
      setStatus('请先选择一张图片或 GIF。');
      return;
    }
    const sent = ws.collectSticker({
      text: caption.trim().slice(0, 120),
      image_data_url: imageDataUrl,
      style_tags: ['用户导入'],
    });
    if (!sent) {
      setStatus('保存请求未送达本地服务，请稍后重试。');
      return;
    }
    setImageDataUrl('');
    setFileName('');
    setCaption('');
    setStatus('已交给本地表情库保存。');
  };

  return (
    <div className={styles.stickerLibrary}>
      <section className={styles.stickerImporter}>
        <div>
          <strong>导入表情</strong>
          <small>文件仅保存在本机；支持 PNG、JPEG、WebP 与动态 GIF，单张不超过 1.8 MB。</small>
        </div>
        <label className={styles.mediaImportButton}>
          <ImagePlus size={18} />
          选择图片或 GIF
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
            onChange={(event) => {
              void selectImage(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        {imageDataUrl && (
          <img className={styles.stickerImportPreview} src={imageDataUrl} alt={caption || fileName || '表情预览'} />
        )}
        <label>
          <span>表情名称（可选）</span>
          <input
            value={caption}
            maxLength={120}
            placeholder="例如：好耶、晚安、抱抱"
            onChange={(event) => setCaption(event.target.value)}
          />
        </label>
        <button type="button" disabled={!imageDataUrl || !connected} onClick={saveSticker}>
          <Save size={16} />
          保存到表情库
        </button>
        {status && <small role="status">{status}</small>}
      </section>
      <section>
        <header className={styles.stickerLibraryHeader}>
          <div>
            <strong>本地表情库</strong>
            <small>{ws.stickers.length} 个表情</small>
          </div>
          <button type="button" disabled={!connected} onClick={ws.refreshStickers}>
            <RefreshCw size={15} />
            刷新
          </button>
        </header>
        <div className={styles.stickerLibraryGrid}>
          {ws.stickers.map((sticker) => (
            <figure key={sticker.id}>
              {sticker.image_data_url
                ? <img src={sticker.image_data_url} alt={sticker.text || '表情包'} />
                : <span>{sticker.text}</span>}
              <figcaption>{sticker.text || sticker.emotions.join('、') || '未命名表情'}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}

function GroupChatPanel({
  thread,
  notice,
  connected,
  onSend,
}: {
  thread?: GroupThread;
  notice: string;
  connected: boolean;
  onSend: (text: string, threadId: string) => boolean;
}) {
  const [draft, setDraft] = useState('');
  const messagesEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages.length]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !thread || !connected) return;
    if (onSend(text, thread.id)) setDraft('');
  };

  return (
    <div className={styles.groupChatPanel}>
      <header className={styles.groupChatHeader}>
        <div>
          <strong>{thread?.title || '我们的小群'}</strong>
          <small>{thread?.members.map((member) => member.name).join('、') || '等待其他本地角色加入'}</small>
        </div>
        <MessagesSquare size={20} />
      </header>
      <p className={styles.simulationNotice}>{notice}</p>
      <div className={styles.groupMessageList} aria-live="polite">
        {thread?.messages.length ? thread.messages.map((message) => (
          <div
            className={styles.groupMessage}
            data-kind={message.kind}
            key={message.id}
          >
            <small>{message.sender_name}</small>
            <p>{message.content}</p>
          </div>
        )) : (
          <div className={styles.emptyPanel}>
            <Users size={28} />
            <strong>群里还很安静</strong>
            <span>导入并关联其他角色后，她们会出现在这里。</span>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>
      <form className={styles.groupComposer} onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={1200}
          placeholder={connected ? '发到群里…' : '离线中'}
          disabled={!connected || !thread}
          aria-label="群聊消息"
        />
        <button
          type="submit"
          disabled={!connected || !thread || !draft.trim()}
          title="发送"
          aria-label="发送群聊消息"
        >
          <Send size={17} />
        </button>
      </form>
    </div>
  );
}

function DiaryPanel({
  entries,
  onUnlockKey,
  onRead,
}: {
  entries: DiaryEntry[];
  onUnlockKey: (hostDate: string) => void;
  onRead: (date: string) => void;
}) {
  const diaryItems = sortDiary(entries).slice(0, 6);
  if (!diaryItems.length) {
    return (
      <div className={styles.emptyPanel}>
        <BookOpen size={28} />
        <strong>抽屉还很轻</strong>
        <span>等她写下第一页，房间只会展示安全、可见的痕迹。</span>
      </div>
    );
  }

  return (
    <div className={styles.paperStack}>
      {diaryItems.map((entry, index) => {
        const locked = isDiaryLocked(entry);
        const safeEntry = { ...entry, is_locked: locked };
        return (
          <article className={styles.paperCard} key={`${entry.date}-${entry.title ?? index}`}>
            <span className={styles.paperPin}>{formatDateLabel(entry.date)}</span>
            <h3>{entry.title || (locked ? '一页上锁的日记' : '没有标题的一页')}</h3>
            <p>{formatDiaryPreview(safeEntry)}</p>
            <small>
              <LockKeyhole size={13} />
              {getDiaryPrivacyLine(safeEntry)}
            </small>
            {entry.key_available && (
              <button
                className={styles.diaryKeyButton}
                type="button"
                onClick={() => onUnlockKey(entry.date)}
                title="用这把钥匙打开一页旧日记"
                aria-label="用日记钥匙解锁旧日记"
              >
                <KeyRound size={17} />
              </button>
            )}
            {!locked && entry.date && (
              <button
                className={styles.diaryReadButton}
                type="button"
                onClick={() => onRead(entry.date)}
                title="读这一页"
                aria-label={`读 ${entry.title || entry.date}`}
              >
                <BookOpen size={16} />
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}

function TimelinePanel({ posts }: { posts: TimelinePost[] }) {
  const timelineItems = sortTimeline(posts).slice(0, 7);
  if (!timelineItems.length) {
    return (
      <div className={styles.emptyPanel}>
        <Smartphone size={28} />
        <strong>屏幕暂时暗着</strong>
        <span>连接恢复后会优先刷新动态；离线时不会白屏，只保留本地安全快照。</span>
      </div>
    );
  }

  return (
    <div className={styles.timelineStack}>
      {timelineItems.map((post, index) => (
        <article className={styles.timelineCard} key={post.id ?? `${post.date}-${index}`}>
          <span>{formatDateLabel(post.date)}</span>
          <p>{formatTimelinePreview(post)}</p>
          {safeTimelineImage(post.media_url) && (
            <img
              className={styles.timelineMedia}
              src={safeTimelineImage(post.media_url)}
              alt={post.creative_title || '动态配图'}
            />
          )}
          {safeTimelineImage(post.sticker_data_url) ? (
            <img
              className={styles.timelineSticker}
              src={safeTimelineImage(post.sticker_data_url)}
              alt={post.sticker_text || '表情包'}
            />
          ) : post.sticker_text ? (
            <span className={styles.timelineStickerText}>{post.sticker_text}</span>
          ) : null}
          {post.creative_title && (
            <small className={styles.creativeReference}>创作成果 · {post.creative_title}</small>
          )}
          {!!post.tags?.length && (
            <div className={styles.tagRow}>
              {post.tags.slice(0, 4).map((tag) => (
                <small key={tag}>#{tag}</small>
              ))}
            </div>
          )}
          {post.visual_stage && (
            <small>{post.media_kind === 'sketch' ? '手绘进度' : '配图线索'} · {post.visual_stage}</small>
          )}
          {!!post.comments?.length && (
            <div className={styles.timelineComments} aria-label="角色评论">
              {post.comments.map((comment) => (
                <p key={comment.id}>
                  <strong>{comment.author_name}</strong>
                  <span>{comment.content}</span>
                </p>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function safeTimelineImage(value?: string): string | undefined {
  if (!value) return undefined;
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(value)
    ? value
    : undefined;
}

function AlbumPanel({
  ws,
  connected,
  personaName,
  personaIdentity,
  relationshipStage,
  latestDiary,
  latestPost,
  keepsakes,
}: {
  ws: ReturnType<typeof useReverieWS>;
  connected: boolean;
  personaName: string;
  personaIdentity: string;
  relationshipStage: string;
  latestDiary?: DiaryEntry;
  latestPost?: TimelinePost;
  keepsakes: KeepsakeItem[];
}) {
  const [kind, setKind] = useState('special_memory');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [mediaDataUrl, setMediaDataUrl] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [status, setStatus] = useState('');

  const memoryTiles = [
    {
      title: '她是谁',
      body: personaIdentity,
      icon: <Star size={18} />,
    },
    {
      title: '关系',
      body: relationshipStage,
      icon: <Heart size={18} />,
    },
    {
      title: '最近留下的纸页',
      body: formatDiaryPreview(latestDiary ? { ...latestDiary, is_locked: isDiaryLocked(latestDiary) } : undefined),
      icon: <BookOpen size={18} />,
    },
    {
      title: '最近的动态',
      body: formatTimelinePreview(latestPost),
      icon: <Radio size={18} />,
    },
  ];

  const importKeepsakeFile = async (file?: File) => {
    if (!file) return;
    setSourcePath(file.name);
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''));
    if (file.type.startsWith('image/')) {
      const dataUrl = await readDataUrlFile(file);
      setMediaDataUrl(dataUrl);
      if (kind === 'special_memory' || kind === 'text') setKind('photo');
    }
  };

  const saveKeepsake = () => {
    const cleanTitle = title.trim() || sourcePath || '一段回忆';
    const cleanContent = content.trim();
    if (!cleanTitle && !cleanContent && !mediaDataUrl) return;
    const sent = ws.send(WSMsgType.KEEPSAKE_ADD, {
      kind,
      title: cleanTitle,
      content: cleanContent,
      source_path: sourcePath,
      media_data_url: mediaDataUrl,
      tags: tags.split(/[、，,\s]+/).map((item) => item.trim()).filter(Boolean),
    });
    if (sent) {
      setTitle('');
      setContent('');
      setTags('');
      setMediaDataUrl('');
      setSourcePath('');
      setStatus('已收藏');
    } else {
      setStatus('后端未连接，暂时无法收藏');
    }
  };

  return (
    <div className={styles.albumPanel} aria-label={`${personaName} 的回忆`}>
      <div className={styles.albumGrid}>
        {memoryTiles.map((tile) => (
          <article className={styles.albumTile} key={tile.title}>
            <span>{tile.icon}</span>
            <strong>{tile.title}</strong>
            <p>{tile.body}</p>
          </article>
        ))}
      </div>

      <section className={styles.keepsakeComposer}>
        <div>
          <strong>收藏新的回忆</strong>
          <small>照片、表情包、聊天截图和特殊回忆会独立存放，不并入聊天记录。</small>
        </div>
        <div className={styles.keepsakeForm}>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="special_memory">特殊回忆</option>
            <option value="photo">照片</option>
            <option value="sticker">表情包</option>
            <option value="chat_screenshot">聊天截图</option>
            <option value="text">文字</option>
          </select>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" />
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用顿号分隔" />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={3} placeholder="这段回忆为什么重要" />
          <label className={styles.mediaImportButton}>
            导入图片
            <input type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.gif" onChange={(event) => importKeepsakeFile(event.target.files?.[0])} />
          </label>
          {mediaDataUrl && <img className={styles.keepsakePreview} src={mediaDataUrl} alt="回忆预览" />}
        </div>
        <div className={styles.actionRow}>
          <button type="button" onClick={saveKeepsake} disabled={!connected}>
            <Camera size={15} />
            收藏
          </button>
          {status && <span className={styles.statusNote}>{status}</span>}
        </div>
      </section>

      <section className={styles.keepsakeList}>
        <div>
          <strong>她收起来的东西</strong>
          <small>{keepsakes.length ? `${keepsakes.length} 件收藏` : '还没有手动收藏'}</small>
        </div>
        {keepsakes.slice(0, 8).map((item) => (
          <article className={styles.keepsakeCard} key={item.id}>
            {item.media_data_url && <img src={item.media_data_url} alt={item.title} />}
            <div>
              <strong>{item.title}</strong>
              <p>{item.content || '这件东西只留下了标题和影子。'}</p>
              {!!item.tags?.length && <small>{item.tags.join('、')}</small>}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function SettingsHubPanel({
  connected,
  onOpenPanel,
  onRefreshDiary,
  onRefreshTimeline,
}: {
  connected: boolean;
  onOpenPanel: (panel: RoomPanelId) => void;
  onRefreshDiary: () => void;
  onRefreshTimeline: () => void;
}) {
  const settingPanels: Array<{
    id: RoomPanelId;
    title: string;
    subtitle: string;
    icon: LucideIcon;
  }> = [
    { id: 'ai', title: 'AI 接口', subtitle: '供应商、自定义 API、Ollama', icon: Cpu },
    { id: 'chatSettings', title: '聊天设置', subtitle: '延迟、输入中、在线状态', icon: MessageCircle },
    { id: 'antiAiSettings', title: '防AI味', subtitle: '注入防护、人格锚定、输出过滤', icon: ShieldCheck },
    { id: 'diarySettings', title: '日记设置', subtitle: '写日记、加密、熬夜事件', icon: BookOpen },
    { id: 'memorySettings', title: '遗忘设置', subtitle: '记忆保存、遗忘、误记、成长', icon: Brain },
    { id: 'personalitySettings', title: '人格设置', subtitle: '缺点、情绪、朋友圈、社交', icon: Sparkles },
    { id: 'immersionSettings', title: '真实与沉浸感', subtitle: '定位、购物、特写、智能家居', icon: MapPin },
    { id: 'userProfile', title: '用户档案', subtitle: '“我”的长期资料与情感记忆', icon: UserRound },
    { id: 'archive', title: '档案', subtitle: '角色卡、世界书、多角色', icon: LibraryBig },
    { id: 'backup', title: '备份', subtitle: '导入或导出 JSON 备份', icon: HardDriveDownload },
  ];

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <SettingsIcon size={24} />
        <div>
          <strong>设置</strong>
          <small>系统功能和后续新增项都从这里进入</small>
        </div>
      </div>

      <div className={styles.settingsHubGrid}>
        {settingPanels.map((item) => {
          const Icon = item.icon;
          return (
            <button type="button" key={item.id} onClick={() => onOpenPanel(item.id)}>
              <Icon size={18} />
              <span>{item.title}</span>
              <small>{item.subtitle}</small>
            </button>
          );
        })}
      </div>

      <div className={styles.settingsRefreshGrid}>
        <button type="button" onClick={onRefreshDiary} disabled={!connected}>
          <RefreshCw size={15} />
          <span>刷新日记</span>
        </button>
        <button type="button" onClick={onRefreshTimeline} disabled={!connected}>
          <RefreshCw size={15} />
          <span>刷新动态</span>
        </button>
      </div>
    </div>
  );
}

function StatusPanel({
  relationshipStage,
  recentInterest,
  relationship,
  emotions,
}: {
  relationshipStage: string;
  recentInterest: string;
  relationship?: RelationshipData | null;
  emotions: Record<string, number>;
}) {
  const [activeDetail, setActiveDetail] = useState<'relationship' | 'interest' | 'emotion'>('relationship');
  const intimacyRaw = relationship?.intimacy;
  const trustRaw = relationship?.trust;
  const intimacy = typeof intimacyRaw === 'number' ? Math.round(intimacyRaw) : 0;
  const trust = typeof trustRaw === 'number' ? Math.round(trustRaw) : undefined;
  const atmosphere = deriveRoomAtmosphere(emotions, true);
  const emotionWeather = atmosphere.label;
  const detail =
    activeDetail === 'relationship'
      ? `当前关系是“${relationshipStage}”。亲密度 ${intimacy}，${trust == null ? '信任值还在积累' : `信任值 ${trust}`}。它会随着聊天频率、情绪事件、共同记忆和日记反馈慢慢变化。`
      : activeDetail === 'interest'
        ? `最近兴趣是“${recentInterest}”。它来自角色档案、记忆库和自我成长系统；当长期经历积累后，兴趣会自然迁移，而不是永远停在初始设定。`
        : `当前情绪更接近“${atmosphere.dominantLabel}”。其他情绪仍会同时存在，并通过聊天、主动消息、日记、动态与房间光影慢慢显露。`;

  return (
    <div className={styles.managementPanel}>
      <div className={styles.managementHero}>
        <Activity size={24} />
        <div>
          <strong>状态</strong>
          <small>关系、兴趣和情绪可以展开查看</small>
        </div>
      </div>

      <div className={styles.statusGrid}>
        <button
          type="button"
          className={activeDetail === 'relationship' ? styles.statusActive : undefined}
          onClick={() => setActiveDetail('relationship')}
        >
          <Users size={18} />
          <span>关系阶段</span>
          <strong>{relationshipStage}</strong>
        </button>
        <button
          type="button"
          className={activeDetail === 'interest' ? styles.statusActive : undefined}
          onClick={() => setActiveDetail('interest')}
        >
          <Star size={18} />
          <span>最近兴趣</span>
          <strong>{recentInterest}</strong>
        </button>
        <button
          type="button"
          className={activeDetail === 'emotion' ? styles.statusActive : undefined}
          onClick={() => setActiveDetail('emotion')}
        >
          <Heart size={18} />
          <span>当前情绪</span>
          <strong>{emotionWeather}</strong>
        </button>
      </div>

      <div className={styles.statusDetail}>
        <strong>{activeDetail === 'relationship' ? '关系说明' : activeDetail === 'interest' ? '兴趣说明' : '情绪说明'}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function MusicPanel({
  mood,
  connected,
  evidenceLine,
}: {
  mood: RoomMoodState;
  connected: boolean;
  evidenceLine: string;
}) {
  const [audioFile, setAudioFile] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    return () => {
      if (audioFile?.url) URL.revokeObjectURL(audioFile.url);
    };
  }, [audioFile?.url]);

  const importAudio = (file?: File) => {
    if (!file) return;
    setAudioFile({ name: file.name, url: URL.createObjectURL(file) });
  };

  return (
    <div className={styles.recordPlayer}>
      <div className={styles.recordScene}>
        <div className={styles.recordDisc}>
          <span />
        </div>
        <div className={styles.recordNeedle} />
      </div>
      <div className={styles.playlist}>
        <span>Tonight Track</span>
        <strong>{mood.label}</strong>
        <p>{connected ? '窗外、键盘声和她的呼吸感一起混进房间。' : '离线时唱片会变轻，只留下安全快照的沙沙声。'}</p>
        <small>{evidenceLine}</small>
        <label className={styles.mediaImportButton}>
          导入音频
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg"
            onChange={(event) => importAudio(event.target.files?.[0])}
          />
        </label>
        {audioFile && (
          <div className={styles.mediaPlayer}>
            <span>{audioFile.name}</span>
            <audio controls src={audioFile.url} />
          </div>
        )}
      </div>
    </div>
  );
}

function VideoPanel() {
  const [videoFile, setVideoFile] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    return () => {
      if (videoFile?.url) URL.revokeObjectURL(videoFile.url);
    };
  }, [videoFile?.url]);

  const importVideo = (file?: File) => {
    if (!file) return;
    setVideoFile({ name: file.name, url: URL.createObjectURL(file) });
  };

  return (
    <div className={styles.videoPanel}>
      <label className={styles.mediaImportButton}>
        导入视频
        <input
          type="file"
          accept="video/*,.mp4,.webm,.mov,.mkv,.avi,.m4v"
          onChange={(event) => importVideo(event.target.files?.[0])}
        />
      </label>
      {videoFile ? (
        <div className={styles.videoStage}>
          <video controls src={videoFile.url} />
          <span>{videoFile.name}</span>
        </div>
      ) : (
        <div className={styles.emptyPanel}>
          <Video size={28} />
          <strong>还没有导入视频</strong>
          <span>选择常见视频文件后，会直接在这里播放。</span>
        </div>
      )}
    </div>
  );
}

function EmbeddedGamePanel({
  game,
  connected,
  onInviteAI,
}: {
  game: PhoneAppPanelId;
  connected: boolean;
  onInviteAI: GameInviteHandler;
}) {
  const route = EMBEDDED_GAME_ROUTES[game];
  if (!route) return <GamePanel game={game} connected={connected} onInviteAI={onInviteAI} />;
  return (
    <div className={styles.embeddedAppPanel}>
      <div className={styles.embeddedAppToolbar}>
        <button
          type="button"
          disabled={!connected}
          onClick={() => onInviteAI(game, '当前棋盘在手机内嵌应用里。请先和我约定坐标格式，再按角色口吻陪我走下一步。')}
        >
          <Sparkles size={14} />
          邀请她陪玩
        </button>
      </div>
      <iframe
        title={PANEL_META[game].title}
        src={resolveEmbeddedAppSrc(route)}
        loading="lazy"
      />
    </div>
  );
}

function gameBoardSize(game: PhoneAppPanelId): { rows: number; cols: number } {
  if (game === 'tetris') return { rows: 16, cols: 10 };
  if (game === 'snake') return { rows: 12, cols: 12 };
  if (game === 'gomoku') return { rows: 15, cols: 15 };
  if (game === 'go') return { rows: 19, cols: 19 };
  if (game === 'xiangqi') return { rows: 10, cols: 9 };
  return { rows: 8, cols: 8 };
}

function initialGameCells(game: PhoneAppPanelId): Record<number, string> {
  if (game === 'chess') {
    const back = ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'];
    const whiteBack = ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖'];
    return Object.fromEntries([
      ...back.map((piece, index) => [index, piece]),
      ...Array.from({ length: 8 }, (_, index) => [8 + index, '♟']),
      ...Array.from({ length: 8 }, (_, index) => [48 + index, '♙']),
      ...whiteBack.map((piece, index) => [56 + index, piece]),
    ]);
  }
  if (game === 'xiangqi') {
    const top = ['車', '馬', '象', '士', '將', '士', '象', '馬', '車'];
    const bottom = ['车', '马', '相', '仕', '帅', '仕', '相', '马', '车'];
    return Object.fromEntries([
      ...top.map((piece, index) => [index, piece]),
      [19, '炮'],
      [25, '炮'],
      ...[27, 29, 31, 33, 35].map((index) => [index, '卒']),
      ...[54, 56, 58, 60, 62].map((index) => [index, '兵']),
      [64, '砲'],
      [70, '砲'],
      ...bottom.map((piece, index) => [81 + index, piece]),
    ]);
  }
  return {};
}

function tetrisCells(origin: number): number[] {
  return [origin + 1, origin + 10, origin + 11, origin + 12];
}

function GamePanel({
  game,
  connected,
  onInviteAI,
}: {
  game: PhoneAppPanelId;
  connected: boolean;
  onInviteAI: GameInviteHandler;
}) {
  const config = gameBoardSize(game);
  const [marks, setMarks] = useState<Record<number, string>>(() => initialGameCells(game));
  const [selectedCell, setSelectedCell] = useState<number | null>(null);
  const [turn, setTurn] = useState(0);
  const [tetrisOrigin, setTetrisOrigin] = useState(3);
  const [snake, setSnake] = useState({ body: [39, 38, 37], food: 78 });
  const total = config.rows * config.cols;

  const resetGame = useCallback(() => {
    setMarks(initialGameCells(game));
    setSelectedCell(null);
    setTurn(0);
    setTetrisOrigin(3);
    setSnake({ body: [39, 38, 37], food: 78 });
  }, [game]);

  useEffect(() => {
    resetGame();
  }, [resetGame]);

  const displayMarks = useMemo(() => {
    const next = { ...marks };
    if (game === 'tetris') {
      for (const index of tetrisCells(tetrisOrigin).filter((item) => item >= 0 && item < total)) {
        next[index] = '■';
      }
    }
    if (game === 'snake') {
      snake.body.forEach((index, bodyIndex) => {
        next[index] = bodyIndex === 0 ? '●' : '•';
      });
      next[snake.food] = '◆';
    }
    return next;
  }, [game, marks, snake.body, snake.food, tetrisOrigin, total]);

  const moveTetris = (delta: number) => {
    setTetrisOrigin((current) => {
      const next = current + delta;
      const cells = tetrisCells(next);
      const inside = cells.every((cell) => cell >= 0 && cell < total);
      const sameRow = delta === 1 || delta === -1
        ? cells.every((cell) => Math.floor(cell / config.cols) === Math.floor((cell - delta) / config.cols))
        : true;
      return inside && sameRow ? next : current;
    });
  };

  const moveSnake = (direction: 'up' | 'down' | 'left' | 'right') => {
    setSnake((current) => {
      const head = current.body[0];
      const row = Math.floor(head / config.cols);
      const col = head % config.cols;
      const nextRow = direction === 'up'
        ? (row + config.rows - 1) % config.rows
        : direction === 'down'
          ? (row + 1) % config.rows
          : row;
      const nextCol = direction === 'left'
        ? (col + config.cols - 1) % config.cols
        : direction === 'right'
          ? (col + 1) % config.cols
          : col;
      const nextHead = nextRow * config.cols + nextCol;
      const ate = nextHead === current.food;
      const body = [nextHead, ...current.body.slice(0, ate ? current.body.length : current.body.length - 1)];
      return {
        body,
        food: ate ? (current.food + 37) % total : current.food,
      };
    });
  };

  const handleCellClick = (index: number) => {
    if (game === 'gomoku' || game === 'go') {
      if (marks[index]) return;
      setMarks((current) => ({ ...current, [index]: turn % 2 === 0 ? '●' : '○' }));
      setTurn((current) => current + 1);
      return;
    }

    if (game === 'chess' || game === 'xiangqi') {
      if (selectedCell === null) {
        if (marks[index]) setSelectedCell(index);
        return;
      }
      setMarks((current) => {
        const piece = current[selectedCell];
        if (!piece) return current;
        const next = { ...current, [index]: piece };
        delete next[selectedCell];
        return next;
      });
      setSelectedCell(null);
      setTurn((current) => current + 1);
    }
  };

  const turnLabel = turn % 2 === 0 ? '黑方' : '白方';
  const isBoardGame = game === 'gomoku' || game === 'go' || game === 'chess' || game === 'xiangqi';
  const isAiPlayable = AI_PLAYABLE_GAME_IDS.includes(game);
  const summarizeBoard = useCallback(() => {
    const placements = Object.entries(displayMarks)
      .slice(0, 80)
      .map(([index, piece]) => {
        const numericIndex = Number(index);
        const row = Math.floor(numericIndex / config.cols) + 1;
        const col = (numericIndex % config.cols) + 1;
        return `${row}-${col}:${piece}`;
      });
    return `当前轮到${turnLabel}。棋盘非空格：${placements.join('，') || '暂无落子'}。`;
  }, [config.cols, displayMarks, turnLabel]);

  return (
    <div className={styles.gamePanel}>
      <div className={styles.gameToolbar}>
        <strong>{PANEL_META[game].title}</strong>
        {isBoardGame && <span>{turnLabel}</span>}
        {isAiPlayable && (
          <button type="button" disabled={!connected} onClick={() => onInviteAI(game, summarizeBoard())}>
            <Sparkles size={14} />
            邀请她陪玩
          </button>
        )}
        <button type="button" onClick={resetGame}>重置</button>
      </div>
      <div
        className={styles.gameBoard}
        data-game={game}
        style={{ '--cols': config.cols } as React.CSSProperties}
      >
        {Array.from({ length: total }, (_, index) => (
          <button
            type="button"
            key={index}
            className={selectedCell === index ? styles.gameCellSelected : undefined}
            onClick={() => handleCellClick(index)}
            aria-label={`${PANEL_META[game].title} ${index + 1}`}
          >
            {displayMarks[index] ?? ''}
          </button>
        ))}
      </div>
      {game === 'tetris' && (
        <div className={styles.gameControls}>
          <button type="button" onClick={() => moveTetris(-1)}>左</button>
          <button type="button" onClick={() => moveTetris(1)}>右</button>
          <button type="button" onClick={() => moveTetris(config.cols)}>下落</button>
        </div>
      )}
      {game === 'snake' && (
        <div className={styles.gameControls}>
          <button type="button" onClick={() => moveSnake('up')}>上</button>
          <button type="button" onClick={() => moveSnake('left')}>左</button>
          <button type="button" onClick={() => moveSnake('right')}>右</button>
          <button type="button" onClick={() => moveSnake('down')}>下</button>
        </div>
      )}
    </div>
  );
}

export default function DreamRoom() {
  const ws = useReverieWS();
  const [dockTab, setDockTab] = useState<DockTab>('status');
  const [focusActive, setFocusActive] = useState(false);
  const [companionWeather, setCompanionWeather] = useState<'none' | 'rain' | 'wind'>('none');
  const [activePanel, setActivePanel] = useState<RoomPanelId | null>(null);
  const [phoneAttention, setPhoneAttention] = useState(false);
  const previousTimelineRevision = useRef('');
  const timelineTrackingReady = useRef(false);
  const [onboardingDone, setOnboardingDone] = useState(isFirstRunGuideDone);

  useEffect(() => {
    console.info('[DreamRoom] route hit', {
      pathname: window.location.pathname,
      hash: window.location.hash,
      href: window.location.href,
    });
  }, []);

  const connected = ws.connState === 'connected';
  const mood = useMemo(
    () => deriveRoomAtmosphere(ws.emotions, connected),
    [connected, ws.emotions],
  );
  const personaName = getPersonaDisplayName(ws.persona);
  const personaIdentity = getPersonaIdentityLine(ws.persona);
  const relationshipStage = formatRelationshipStage(ws.relationship);
  const latestDiary = getLatestDiaryEntry(ws.diaryEntries);
  const latestPost = getLatestTimelinePost(ws.timelinePosts);
  const timelineRevision = ws.runtimeActivity.timeline_revision
    || [latestPost?.id, latestPost?.date].filter(Boolean).join('|');
  const recentInterest = formatRecentInterest(ws.persona);
  const evidenceConnectionLine = formatEvidenceConnectionLine({
    diaryCount: ws.diaryEntries.length,
    timelineCount: ws.timelinePosts.length,
    isConnected: connected,
  });

  useDiaryWritingSound(connected && ws.runtimeActivity.diary_writing);

  useEffect(() => {
    if (!connected) {
      timelineTrackingReady.current = false;
      previousTimelineRevision.current = timelineRevision;
      setPhoneAttention(false);
      return undefined;
    }
    if (!timelineTrackingReady.current) {
      timelineTrackingReady.current = true;
      previousTimelineRevision.current = timelineRevision;
      return undefined;
    }
    if (!timelineRevision || timelineRevision === previousTimelineRevision.current) return undefined;
    previousTimelineRevision.current = timelineRevision;
    setPhoneAttention(true);
    const timer = window.setTimeout(() => setPhoneAttention(false), 9000);
    return () => window.clearTimeout(timer);
  }, [connected, timelineRevision]);

  const openPanel = useCallback((panel: RoomPanelId) => {
    if (panel === 'diary') ws.refreshDiary();
    if (panel === 'timeline') ws.refreshTimeline();
    if (panel === 'group') ws.refreshGroup();
    if (panel === 'memory') ws.refreshKeepsakes();
    if (panel === 'phone') ws.refreshAmbient();
    setActivePanel(panel);
  }, [ws]);

  const openPhoneApp = useCallback((app: PhoneAppPanelId) => {
    openPanel(app);
  }, [openPanel]);

  const inviteGameCompanion = useCallback<GameInviteHandler>((game, stateLine) => {
    setDockTab('chat');
    if (!connected) return;
    const gameTitle = PANEL_META[game].title;
    const prompt = [
      `我们来玩${gameTitle}。`,
      `请以${personaName}的身份陪我玩，像真正坐在我旁边一样说话，不要用“作为AI”这种说法。`,
      stateLine || '请先问我当前局面，然后给出你的下一步。',
    ].join('');
    ws.addUserMessage(prompt);
    ws.sendChat(prompt);
  }, [connected, personaName, ws]);

  const refreshActivePanel = useCallback(() => {
    if (activePanel === 'diary') ws.refreshDiary();
    if (activePanel === 'timeline') ws.refreshTimeline();
    if (activePanel === 'group') ws.refreshGroup();
  }, [activePanel, ws]);

  const closePanel = useCallback(() => setActivePanel(null), []);
  const characterActivity: CharacterActivity = deriveCharacterActivity({
    focusActive,
    isTyping: ws.isTyping,
    requestStates: Object.values(ws.chatRequestStates).map((request) => request.state),
    needsAttention: phoneAttention || ws.ambient.pending_thoughts > 0,
  });

  return (
    <main
      className={styles.dreamShell}
      data-connection={ws.connState}
      data-emotion={mood.dominantEmotion}
      data-diary-writing={ws.runtimeActivity.diary_writing ? 'true' : 'false'}
      data-testid="dream-room"
    >
      <div className={styles.shellContent} data-dream-shell-content>
        <RoomScene
          mood={mood}
          personaName={personaName}
          identityLine={personaIdentity}
          activity={characterActivity}
          diaryWriting={ws.runtimeActivity.diary_writing}
          phoneAttention={phoneAttention || ws.ambient.pending_thoughts > 0}
          bookPage={ws.ambient.book_page}
          bookTotal={ws.ambient.book_total}
          companionWeather={companionWeather}
        />
        <CompanionDock
          ws={ws}
          personaName={personaName}
          identityLine={personaIdentity}
          relationship={ws.relationship}
          relationshipStage={relationshipStage}
          recentInterest={recentInterest}
          activeTab={dockTab}
          onTabChange={setDockTab}
          onOpenDiary={() => openPanel('diary')}
          onOpenPhone={() => {
            setPhoneAttention(false);
            openPanel('phone');
          }}
          onOpenSettings={() => openPanel('settings')}
          onFocusActivityChange={setFocusActive}
          onCompanionAtmosphereChange={setCompanionWeather}
        />
      </div>

      {activePanel && (
        <RoomDrawer
          panel={activePanel}
          connected={connected}
          onClose={closePanel}
          onRefresh={activePanel === 'diary' || activePanel === 'timeline' ? refreshActivePanel : undefined}
        >
          {activePanel === 'diary' && (
            <DiaryPanel
              entries={ws.diaryEntries}
              onUnlockKey={ws.unlockDiaryKey}
              onRead={ws.readDiaryEntry}
            />
          )}
          {activePanel === 'phone' && <PhoneHomePanel apps={PHONE_APPS} onOpenApp={openPhoneApp} />}
          {activePanel === 'timeline' && <TimelinePanel posts={ws.timelinePosts} />}
          {activePanel === 'group' && (
            <GroupChatPanel
              thread={ws.groupState.threads[0]}
              notice={ws.groupState.simulation_notice}
              connected={connected}
              onSend={ws.sendGroupMessage}
            />
          )}
          {activePanel === 'memory' && (
            <AlbumPanel
              ws={ws}
              connected={connected}
              personaName={personaName}
              personaIdentity={personaIdentity}
              relationshipStage={relationshipStage}
              latestDiary={latestDiary}
              latestPost={latestPost}
              keepsakes={ws.keepsakes}
            />
          )}
          {activePanel === 'music' && (
            <MusicPanel mood={mood} connected={connected} evidenceLine={evidenceConnectionLine} />
          )}
          {activePanel === 'stickers' && <StickerLibraryPanel ws={ws} connected={connected} />}
          {activePanel === 'video' && <VideoPanel />}
          {activePanel && isEmbeddedGamePanel(activePanel) && (
            <EmbeddedGamePanel game={activePanel} connected={connected} onInviteAI={inviteGameCompanion} />
          )}
          {activePanel && isGamePanel(activePanel) && !isEmbeddedGamePanel(activePanel) && (
            <MiniGamePanel game={activePanel} connected={connected} onInviteAI={inviteGameCompanion} />
          )}
          {activePanel === 'settings' && (
            <SettingsHubPanel
              connected={connected}
              onOpenPanel={openPanel}
              onRefreshDiary={ws.refreshDiary}
              onRefreshTimeline={ws.refreshTimeline}
            />
          )}
          {activePanel === 'status' && (
            <StatusPanel
              relationshipStage={relationshipStage}
              recentInterest={recentInterest}
              relationship={ws.relationship}
              emotions={ws.emotions}
            />
          )}
          {activePanel === 'ai' && <AiSettingsPanel ws={ws} />}
          {activePanel === 'chatSettings' && <ChatSettingsPanel ws={ws} />}
          {activePanel === 'antiAiSettings' && <AntiAiSettingsPanel ws={ws} />}
          {activePanel === 'diarySettings' && <DiarySettingsPanel ws={ws} />}
          {activePanel === 'memorySettings' && <MemorySettingsPanel ws={ws} />}
          {activePanel === 'personalitySettings' && <PersonalitySettingsPanel ws={ws} />}
          {activePanel === 'immersionSettings' && <ImmersionSettingsPanel ws={ws} />}
          {activePanel === 'userProfile' && <UserProfilePanel ws={ws} />}
          {activePanel === 'archive' && <ArchiveManagerPanel ws={ws} />}
          {activePanel === 'backup' && <BackupPanel ws={ws} />}
        </RoomDrawer>
      )}

      {!onboardingDone && (
        <FirstRunGuide ws={ws} onComplete={() => setOnboardingDone(true)} />
      )}
    </main>
  );
}
