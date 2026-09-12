import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  Cloud,
  ImagePlus,
  KeyRound,
  MessageCircle,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useMvpBridge } from '@/hooks/useMvpBridge';
import { LLM_PROVIDER_CONFIGS, type LLMProvider } from '@/lib/llmModels';
import {
  mergeSavedDraft,
  useAuthoritativeProviderConfig,
  useCredentialStorageMode,
} from '@/lib/providerConfigSync';
import {
  imageAttachmentFromClipboard,
  imageAttachmentFromFile,
  type ChatImageAttachment,
} from '@/lib/chatImage';
import { ChatImage } from '@/components/chat/ChatImage';
import { ChatVideo, isVideoMime } from '@/components/chat/ChatVideo';
import {
  consumeFallbackDraft,
  loadReverieChatDraft,
  migrateReverieChatDraft,
  saveReverieChatDraft,
} from '@/lib/reverieChatStorage';
import BundledCharacter from './BundledCharacter';
import VoicePackManagerPanel from '@/components/settings/VoicePackManagerPanel';
import styles from './MvpRoom.module.scss';

// Raw backend delivery-state enums (ready_waiting, accepted, …) must not leak
// into the zh UI as-is.
const DELIVERY_STATE_LABELS: Record<string, string> = {
  queued: '已排队',
  generating: '正在组织回复',
  ready_waiting: '回复已准备好',
  delivering: '正在送达',
  done: '已送达',
  accepted: '已送达',
  cancelled: '已取消',
  failed: '生成失败',
  failed_uncertain: '连接中断，未自动重试',
  error: '发送失败',
};

type Tab = 'chat' | 'memory' | 'settings';

// User-specified liability disclaimer for the video download feature. Adopted
// verbatim (see 待实施计划/…/视频下载到聊天发送-实施设计方案.md §1.2). It gates the
// feature: the user must scroll it to the bottom and check the acknowledgement
// box before the backend will accept video_download_enabled=true. The backend
// enforces the same fail-closed invariant independently (ws_bridge features
// branch), so this UI gate is defence-in-depth, not the sole guard.
const VIDEO_DOWNLOAD_DISCLAIMER =
  '本功能仅供下载用户拥有版权或已获授权的视频，禁止用于下载受版权保护且未经授权的内容。'
  + '用户需自行承担使用本工具的全部法律责任，开发者不对用户的任何行为负责。'
  + '本工具按“原样”提供，开发者不承担任何直接或间接责任。';

// Sticker assets come back either as inline data URLs or as
// reverie-sticker://asset references served by the Electron protocol.
function stickerImageUrl(value: string): string {
  return value.startsWith('data:') || value.startsWith('reverie-sticker://') ? value : '';
}

function StickerBubbleImage({ sticker }: { sticker: Record<string, unknown> }) {
  const url = stickerImageUrl(text(sticker.image_data_url));
  if (!url) return null;
  return <img src={url} alt="表情" />;
}

type ProviderDraft = {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  customProviderName: string;
  apiKey: string;
  customHeaders: string;
  clearApiKey: boolean;
  clearCustomHeaders: boolean;
};

const DEFAULT_PROVIDER: ProviderDraft = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  model: '',
  customProviderName: '',
  apiKey: '',
  customHeaders: '',
  clearApiKey: false,
  clearCustomHeaders: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ProviderSettings() {
  const [draft, setDraft] = useState<ProviderDraft>(DEFAULT_PROVIDER);
  const { credentialMode, setCredentialMode, credentialStatus } = useCredentialStorageMode();
  const [testedDraft, setTestedDraft] = useState<{ key: string; receipt: string } | null>(null);
  const [status, setStatus] = useState('正在读取当前 Provider…');
  const [busy, setBusy] = useState(false);
  const operationRef = useRef(false);
  const touchedFieldsRef = useRef(new Set<string>());

  useAuthoritativeProviderConfig({
    load: () => window.electronAPI?.providerConfig?.get?.()
      ?? Promise.reject(new Error('provider config channel unavailable')),
    onLoaded: (value) => {
      const snapshot = value as PublicProviderConfig | null;
      if (!snapshot?.llm) return;
      const provider = snapshot.llm.provider;
      if (!(provider in LLM_PROVIDER_CONFIGS)) return;
      setDraft((current) => mergeSavedDraft(current, {
        provider,
        baseUrl: snapshot.llm.baseUrl,
        model: snapshot.llm.model,
        customProviderName: snapshot.llm.customProviderName || '',
      }, touchedFieldsRef.current));
      setStatus('当前配置来自本地服务；密钥不会进入页面。');
    },
    onUnavailable: () => setStatus('本地服务尚未就绪，暂时无法读取 Provider。'),
  });

  const publicConfig = useMemo(() => ({
    llm: {
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      customProviderName: draft.customProviderName,
    },
  }), [draft.provider, draft.baseUrl, draft.model, draft.customProviderName]);

  const credential = useMemo(() => ({
    apiKey: draft.apiKey,
    customHeaders: draft.customHeaders,
    clearApiKey: draft.clearApiKey,
    clearCustomHeaders: draft.clearCustomHeaders,
  }), [draft.apiKey, draft.clearApiKey, draft.clearCustomHeaders, draft.customHeaders]);
  const draftKey = useMemo(
    () => JSON.stringify({ config: publicConfig, credential }),
    [credential, publicConfig],
  );
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  const update = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    touchedFieldsRef.current.add(key);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const testProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    if (!api?.test || operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setStatus('正在测试连接…');
    const testedKey = draftKey;
    try {
      const result = await api.test(publicConfig, credential);
      if (result.ok) {
        if (draftKeyRef.current !== testedKey) {
          setTestedDraft(null);
          setStatus('测试期间输入已变化，请重新测试当前配置。');
        } else {
          setTestedDraft({ key: testedKey, receipt: result.receipt });
          setStatus(`连接成功（${result.latencyMs}ms，${result.finishReason}）。可以保存了。`);
        }
      } else {
        setTestedDraft(null);
        setStatus(`测试失败：${result.message}`);
      }
    } catch (error) {
      setTestedDraft(null);
      setStatus(error instanceof Error
        ? `测试失败：${error.message}`
        : '测试失败：本地服务未响应。');
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  const saveProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    if (!api?.commit || testedDraft?.key !== draftKey || operationRef.current) return;
    operationRef.current = true;
    const savedKey = draftKey;
    const receipt = testedDraft.receipt;
    setTestedDraft(null);
    setBusy(true);
    setStatus('正在保存并应用…');
    try {
      const result = await api.commit(
        publicConfig,
        credential,
        credentialMode,
        receipt,
      );
      if (result.status.writeError) {
        setStatus(`保存失败：${result.status.writeError.message}`);
      } else if (draftKeyRef.current !== savedKey) {
        setStatus('上一份配置已保存；当前输入已变化，请重新测试后保存。');
      } else if (result.status.runtimePending || result.status.runtimeApplied === false) {
        setStatus('配置已安全保存，聊天后端仍在同步；稍后即可使用。');
      } else {
        setStatus('已保存并应用到本地服务。');
      }
    } catch {
      setStatus('保存失败：本地服务拒绝了这次提交。');
    } finally {
      operationRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className={styles.settingsSection}>
      <header>
        <KeyRound size={18} />
        <div>
          <strong>AI 接口</strong>
          <span>OpenAI 兼容接口、Claude 或 Ollama 本地模型。</span>
        </div>
      </header>
      <label>
        <span>提供商</span>
        <select
          value={draft.provider}
          onChange={(event) => {
            const provider = event.target.value as LLMProvider;
            const config = LLM_PROVIDER_CONFIGS[provider];
            update('provider', provider);
            update('baseUrl', config.baseUrl || '');
            update('model', config.defaultModel || '');
          }}
        >
          {Object.entries(LLM_PROVIDER_CONFIGS).map(([id, config]) => (
            <option key={id} value={id}>{config.displayName}</option>
          ))}
        </select>
      </label>
      <label>
        <span>自定义提供商名称（可选）</span>
        <input
          value={draft.customProviderName}
          maxLength={80}
          spellCheck={false}
          placeholder="仅用于显示"
          onChange={(event) => update('customProviderName', event.target.value)}
        />
      </label>
      <label>
        <span>服务地址</span>
        <input
          value={draft.baseUrl}
          maxLength={512}
          spellCheck={false}
          placeholder="https://…"
          onChange={(event) => update('baseUrl', event.target.value)}
        />
      </label>
      <label>
        <span>模型</span>
        <input
          value={draft.model}
          maxLength={512}
          spellCheck={false}
          placeholder="必须明确填写，不偷偷选择默认模型"
          onChange={(event) => update('model', event.target.value)}
        />
      </label>
      <label>
        <span>API 密钥 {draft.provider === 'ollama' && '（通常留空）'}</span>
        <input
          type="password"
          value={draft.apiKey}
          autoComplete="off"
          maxLength={16_384}
          onChange={(event) => update('apiKey', event.target.value)}
        />
      </label>
      <label>
        <span>自定义请求头（可选，每行 Name: Value）</span>
        <textarea
          value={draft.customHeaders}
          rows={3}
          maxLength={16_384}
          spellCheck={false}
          onChange={(event) => update('customHeaders', event.target.value)}
        />
      </label>
      <label>
        <span>凭据保存</span>
        <select
          value={credentialMode}
          onChange={(event) => setCredentialMode(event.target.value as typeof credentialMode)}
        >
          <option value="persistent" disabled={credentialStatus?.persistentAvailable === false}>
            Windows 加密存储（重启后保留）
          </option>
          <option value="session">只保留到本次退出</option>
        </select>
        <span>
          {credentialMode === 'persistent'
            ? '密钥由 Windows DPAPI 加密保存，不会进入页面或浏览器存储。'
            : '密钥只保存在当前进程内存中，退出 Reverie 后消失。'}
        </span>
      </label>
      <label>
        <span>凭据删除意图</span>
        <span>
          <input
            type="checkbox"
            checked={draft.clearApiKey}
            onChange={(event) => update('clearApiKey', event.target.checked)}
          /> 删除已存 API Key
        </span>
        <span>
          <input
            type="checkbox"
            checked={draft.clearCustomHeaders}
            onChange={(event) => update('clearCustomHeaders', event.target.checked)}
          /> 删除已存自定义请求头
        </span>
      </label>
      <div className={styles.actionRow}>
        <button
          type="button"
          disabled={busy || !draft.baseUrl.trim() || !draft.model.trim()}
          onClick={() => void testProvider()}
        >
          测试连接
        </button>
        <button
          type="button"
          disabled={busy || testedDraft?.key !== draftKey}
          onClick={() => void saveProvider()}
        >
          测试通过后保存
        </button>
      </div>
      {!draft.model.trim() && (
        <p className={styles.modelHint}>填写模型名称后即可测试连接。</p>
      )}
      <p className={styles.statusLine} role="status">{status}</p>
    </section>
  );
}

export default function MvpRoom() {
  const bridge = useMvpBridge();
  const [tab, setTab] = useState<Tab>('chat');
  const [draft, setDraft] = useState<string>(() => loadReverieChatDraft('mvp-room'));
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState('');
  const [editingMemoryText, setEditingMemoryText] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState('');
  const [manualMemoryText, setManualMemoryText] = useState('');
  const [manualMemoryNotice, setManualMemoryNotice] = useState('');
  const [flawsText, setFlawsText] = useState('');
  const [flawsDisclaimerAccepted, setFlawsDisclaimerAccepted] = useState(false);
  const [flawsNotice, setFlawsNotice] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState('');
  const [stickerOpen, setStickerOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<ChatImageAttachment | null>(null);
  const [imageNotice, setImageNotice] = useState('');
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [replyDelayMin, setReplyDelayMin] = useState(3);
  const [replyDelayMax, setReplyDelayMax] = useState(30);
  const [splitMessages, setSplitMessages] = useState(true);
  const [typingIndicator, setTypingIndicator] = useState(true);
  const [chatStatus, setChatStatus] = useState<'online' | 'busy' | 'away' | 'sleeping'>('online');
  const [proactiveEnabled, setProactiveEnabled] = useState(false);
  const [proactiveNotifications, setProactiveNotifications] = useState(false);
  const [proactiveLimit, setProactiveLimit] = useState(2);
  const [proactiveInterval, setProactiveInterval] = useState(120);
  const [chatSettingsNotice, setChatSettingsNotice] = useState('');
  const [uiMode, setUiMode] = useState<'mvp' | 'dream'>('mvp');
  const [uiModeNotice, setUiModeNotice] = useState('');
  const [retention, setRetention] = useState(730);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const personaName = useMemo(() => (
    text(bridge.persona?.name)
    || text(bridge.persona?.display_name)
    || '她'
  ), [bridge.persona]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: 'end' });
  }, [bridge.messages, bridge.streamingText]);

  // Chat draft persistence: drafts survive app restarts, shared with DreamRoom
  // under the same persona id. Before the persona id is known they live under
  // the 'mvp-room' fallback key and are migrated once the id arrives.
  useEffect(() => {
    const personaKey = bridge.personaId;
    if (!personaKey) return;
    if (draftHydrated) return;
    setDraftHydrated(true);
    if (draft) {
      // Draft already present (from the mvp-room fallback or user typing):
      // move it under the persona id so DreamRoom sees the same text, then
      // consume the fallback slot so a future persona switch cannot revive it.
      saveReverieChatDraft(draft, personaKey);
      consumeFallbackDraft('mvp-room');
      return;
    }
    const migrated = migrateReverieChatDraft('mvp-room', personaKey);
    if (migrated) {
      setDraft(migrated);
    }
  }, [bridge.personaId, draft, draftHydrated]);

  // Persist subsequent edits under the active session key.
  useEffect(() => {
    if (!draftHydrated) return;
    const key = bridge.personaId || 'mvp-room';
    saveReverieChatDraft(draft, key);
  }, [draft, draftHydrated, bridge.personaId]);

  useEffect(() => {
    const value = bridge.memorySettings.retention_days;
    if ([365, 730, 1095].includes(Number(value))) setRetention(Number(value));
  }, [bridge.memorySettings.retention_days]);

  useEffect(() => {
    const chat = isRecord(bridge.settings.chat) ? bridge.settings.chat : null;
    if (chat) {
      if (typeof chat.reply_delay_min === 'number') setReplyDelayMin(chat.reply_delay_min);
      if (typeof chat.reply_delay_max === 'number') setReplyDelayMax(chat.reply_delay_max);
      if (typeof chat.split_messages === 'boolean') setSplitMessages(chat.split_messages);
      if (typeof chat.typing_indicator === 'boolean') setTypingIndicator(chat.typing_indicator);
      if (['online', 'busy', 'away', 'sleeping'].includes(String(chat.status))) {
        setChatStatus(String(chat.status) as typeof chatStatus);
      }
    }
    const features = isRecord(bridge.settings.features) ? bridge.settings.features : null;
    if (features) {
      if (typeof features.proactive_chat_enabled === 'boolean') setProactiveEnabled(features.proactive_chat_enabled);
      if (typeof features.proactive_notifications_enabled === 'boolean') {
        setProactiveNotifications(features.proactive_notifications_enabled);
      }
      if (typeof features.proactive_daily_limit === 'number') setProactiveLimit(features.proactive_daily_limit);
      if (typeof features.proactive_min_interval_minutes === 'number') {
        setProactiveInterval(features.proactive_min_interval_minutes);
      }
    }
    const ui = isRecord(bridge.settings.ui) ? bridge.settings.ui : null;
    if (ui && (ui.mode === 'mvp' || ui.mode === 'dream')) {
      setUiMode(ui.mode);
    }
  }, [bridge.settings]);

  const send = () => {
    const text = draft.trim() || (pendingImage ? '[图片]' : '');
    if (!bridge.sendChat(text, pendingImage || undefined)) return;
    setDraft('');
    setPendingImage(null);
    setImageNotice('');
  };

  const attachImageFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      setPendingImage(await imageAttachmentFromFile(file));
      setImageNotice('');
    } catch (reason) {
      setPendingImage(null);
      setImageNotice(reason instanceof Error ? reason.message : '图片无法发送');
    }
  };

  return (
    <main className={styles.shell} data-testid="mvp-room">
      <div className={styles.atmosphere} aria-hidden="true" />
      <section className={styles.characterColumn}>
        <div className={styles.identityNotice}>
          <Bot size={18} />
          <span>
            {personaName} 是本机运行的 AI 角色，不是真人，也不会替代现实关系或专业支持。
          </span>
        </div>
        <BundledCharacter
          emotions={bridge.emotions}
          speaking={Boolean(bridge.streamingText)}
        />
        <div className={styles.relationshipCard}>
          <span>关系状态</span>
          <strong>{text(bridge.relationship.stage) || '刚刚认识'}</strong>
          <small>只根据有来源的共同经历变化，不把使用时长当作依赖分数。</small>
        </div>
      </section>

      <section className={styles.panel}>
        <header className={styles.panelHeader}>
          <div>
            <strong>Reverie</strong>
            <span data-state={bridge.connection}>
              {bridge.connection === 'connected' ? '本地服务已连接' : '正在等待本地服务'}
            </span>
          </div>
          <nav aria-label="主要功能">
            <button type="button" data-active={tab === 'chat'} onClick={() => setTab('chat')}>
              <Send size={16} />聊天
            </button>
            <button
              type="button"
              data-active={groupOpen}
              onClick={() => {
                setGroupOpen((open) => !open);
                if (!groupOpen) bridge.refreshGroup();
              }}
            >
              <Users size={16} />群聊
            </button>
            <button type="button" data-active={tab === 'memory'} onClick={() => setTab('memory')}>
              <Brain size={16} />记忆
              {bridge.memoryCandidates.length > 0 && <b>{bridge.memoryCandidates.length}</b>}
            </button>
            <button type="button" data-active={tab === 'settings'} onClick={() => setTab('settings')}>
              <Settings size={16} />设置
            </button>
          </nav>
        </header>

        {bridge.error && (
          <div className={styles.errorBanner} role="alert">
            <span>{bridge.error}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                style={{ fontSize: 11, padding: '2px 8px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                onClick={() => {
                  const log = [
                    `Reverie 错误日志 — ${new Date().toISOString()}`,
                    '',
                    `错误信息: ${bridge.error}`,
                    '',
                    '— 请将此内容粘贴到 GitHub Issue 或发送给开发者 —',
                  ].join('\n');
                  void navigator.clipboard?.writeText(log).then(
                    () => window.electronAPI?.showNotification?.('已复制', '错误信息已复制到剪贴板，可直接粘贴。'),
                    () => undefined,
                  );
                }}
              >复制错误</button>
              <button type="button" aria-label="关闭错误" onClick={bridge.clearError}><X size={15} /></button>
            </div>
          </div>
        )}

        {tab === 'chat' && (
          <section className={styles.chat}>
            <div className={styles.messages} aria-live="polite">
              {bridge.isTyping && (
                <div className={styles.typingIndicator} role="status">
                  <span className={styles.typingDots} aria-hidden="true"><i /><i /><i /></span>
                  {personaName} 正在输入中…
                </div>
              )}
              {bridge.messages.length === 0 && (
                <div className={styles.empty}>
                  <Bot size={28} />
                  <strong>先说一句真正想说的话</strong>
                  <span>聊天证据会留在本机；只有你确认的候选事实才进入长期记忆。</span>
                </div>
              )}
              {bridge.messages.map((message) => (
                <article key={message.id} data-role={message.role}>
                  {message.role === 'user' && (message.attachmentPreview || (message.media?.length)) && (
                    <span className={styles.messageImage}>
                      {isVideoMime(message.media?.[0]?.mime) ? (
                        <ChatVideo
                          mediaId={message.media?.[0]?.media_id || ''}
                          mime={message.media?.[0]?.mime}
                        />
                      ) : (
                        <ChatImage
                          mediaId={message.media?.[0]?.media_id || ''}
                          previewUrl={message.attachmentPreview}
                          fetcher={bridge.fetchChatMedia}
                          alt="发送的图片"
                        />
                      )}
                    </span>
                  )}
                  {message.content && message.content !== '[图片]' && <p>{message.content}</p>}
                  {message.role === 'assistant' && isRecord(message.sticker) && (
                    <span className={styles.replySticker}>
                      {text(message.sticker.text) || (
                        <StickerBubbleImage sticker={message.sticker} />
                      )}
                    </span>
                  )}
                  <small>
                    {DELIVERY_STATE_LABELS[message.deliveryState || '']
                      || (message.role === 'user' ? '已提交' : personaName)}
                  </small>
                  {message.role === 'user' && message.content.trim().length <= 80 && (
                    <button
                      type="button"
                      className={styles.collectStickerButton}
                      title="收藏为表情"
                      onClick={() => {
                        bridge.collectSticker({
                          text: message.content.trim().slice(0, 80),
                          emotions: [],
                        });
                      }}
                    >
                      <ImagePlus size={12} />收藏为表情
                    </button>
                  )}
                </article>
              ))}
              {bridge.streamingText && (
                <article data-role="assistant" data-streaming="true">
                  <p>{bridge.streamingText}</p>
                  <small>生成中 · 可随时停止</small>
                </article>
              )}
              <div ref={messageEndRef} />
            </div>
            <footer className={styles.composer}>
              <div className={styles.stickerComposer}>
                <button
                  type="button"
                  className={styles.stickerButton}
                  aria-label="表情"
                  aria-expanded={stickerOpen}
                  disabled={bridge.connection !== 'connected'}
                  onClick={() => {
                    setStickerOpen((open) => !open);
                    if (!stickerOpen) bridge.refreshStickers();
                  }}
                >
                  <ImagePlus size={17} />
                </button>
                {stickerOpen && (
                  <div className={styles.stickerPanel}>
                    <strong>表情</strong>
                    <div className={styles.stickerGrid}>
                      {bridge.stickers.map((item) => {
                        const sticker = isRecord(item) ? item : null;
                        if (!sticker) return null;
                        const id = text(sticker.id);
                        const imageUrl = stickerImageUrl(text(sticker.image_data_url));
                        const label = text(sticker.text) || '表情';
                        if (imageUrl) {
                          return (
                            <button
                              key={id || label}
                              type="button"
                              title={label}
                              onClick={() => {
                                if (id) bridge.reactToSticker(id, true);
                                bridge.sendSticker(sticker, label);
                                setStickerOpen(false);
                              }}
                            >
                              <img src={imageUrl} alt={label} />
                            </button>
                          );
                        }
                        return (
                          <button
                            key={id || label}
                            type="button"
                            title={label}
                            onClick={() => {
                              if (id) bridge.reactToSticker(id, true);
                              setDraft((current) => `${current}${current.trim() ? ' ' : ''}${label}`);
                              setStickerOpen(false);
                            }}
                          >
                            <span>{label}</span>
                          </button>
                        );
                      })}
                      {bridge.stickers.length === 0 && (
                        <small>还没有表情。先收藏一个：发送短消息后点“收藏为表情”即可。</small>
                      )}
                    </div>
                    <button
                      type="button"
                      className={styles.stickerImportButton}
                      onClick={async () => {
                        try {
                          const picked = await window.electronAPI?.stickers?.pickImage();
                          if (!picked?.filePath) return;
                          await bridge.importSticker(picked.filePath, ['用户导入']);
                          bridge.refreshStickers();
                        } catch {
                          setImageNotice('表情导入失败');
                        }
                      }}
                    >
                      <Paperclip size={13} />导入表情图片…
                    </button>
                  </div>
                )}
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  void attachImageFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className={styles.stickerButton}
                aria-label="发送图片"
                disabled={bridge.connection !== 'connected'}
                onClick={() => imageInputRef.current?.click()}
              >
                <Paperclip size={17} />
              </button>
              <textarea
                value={draft}
                rows={3}
                maxLength={20_000}
                placeholder={bridge.connection === 'connected' ? `给 ${personaName} 发消息…` : '等待本地服务连接…'}
                disabled={bridge.connection !== 'connected'}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  void imageAttachmentFromClipboard(event.clipboardData).then((attachment) => {
                    if (attachment) {
                      setPendingImage(attachment);
                      setImageNotice('');
                    }
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              {pendingImage?.previewUrl && (
                <div className={styles.pendingImage} data-role="preview">
                  <img src={pendingImage.previewUrl} alt="待发送图片" />
                  <button
                    type="button"
                    aria-label="移除图片"
                    onClick={() => {
                      setPendingImage(null);
                      setImageNotice('');
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {imageNotice && <small className={styles.imageNotice} role="alert">{imageNotice}</small>}
              {bridge.activeRequestId ? (
                <button type="button" className={styles.stopButton} onClick={bridge.cancelChat}>
                  <Square size={16} />停止
                </button>
              ) : (
                <button
                  type="button"
                  disabled={(!draft.trim() && !pendingImage) || bridge.connection !== 'connected'}
                  onClick={send}
                >
                  <Send size={16} />发送
                </button>
              )}
            </footer>
          </section>
        )}

        {groupOpen && (
          <section className={styles.groupChat} aria-label="群聊">
            <header>
              <Users size={16} />
              <strong>群聊</strong>
              <span>把本地角色卡拉进同一个聊天室</span>
              <button type="button" aria-label="关闭群聊" onClick={() => setGroupOpen(false)}>
                <X size={15} />
              </button>
            </header>
            <div className={styles.groupMembers}>
              {(Array.isArray(bridge.groupState.characters) ? bridge.groupState.characters : [])
                .filter((item) => isRecord(item) && text(item.name))
                .map((item) => (
                  <span key={text(item.id)}>{text(item.name)}</span>
                ))}
            </div>
            <div className={styles.groupMessages}>
              {(() => {
                const threads = Array.isArray(bridge.groupState.threads)
                  ? bridge.groupState.threads
                  : [];
                const thread = threads.find(isRecord);
                const rawMessages = thread && Array.isArray(thread.messages) ? thread.messages : [];
                const messages = rawMessages.filter(isRecord);
                if (messages.length === 0) {
                  return (
                    <div className={styles.empty}>
                      <Users size={26} />
                      <strong>还没有群聊消息</strong>
                      <span>先发一句，看她们怎么接。</span>
                    </div>
                  );
                }
                return messages.map((message, index) => (
                  <article key={text(message.id) || index}>
                    <strong>{text(message.sender_name) || '角色'}</strong>
                    <p>{text(message.content)}</p>
                  </article>
                ));
              })()}
            </div>
            <footer>
              <input
                value={groupDraft}
                maxLength={2_000}
                placeholder="对群里的大家说…"
                disabled={bridge.connection !== 'connected'}
                onChange={(event) => setGroupDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!bridge.sendGroupMessage(groupDraft)) return;
                    setGroupDraft('');
                    bridge.refreshGroup();
                  }
                }}
              />
              <button
                type="button"
                disabled={!groupDraft.trim() || bridge.connection !== 'connected'}
                onClick={() => {
                  if (!bridge.sendGroupMessage(groupDraft)) return;
                  setGroupDraft('');
                  bridge.refreshGroup();
                }}
              >
                <Send size={15} />发送
              </button>
            </footer>
          </section>
        )}

        {tab === 'memory' && (
          <section className={styles.memory}>
            <div className={styles.memoryIntro}>
              <div>
                <strong>可审查的长期记忆</strong>
                <span>助手的回答永远不是你的事实证据。下面每条都显示用户原文来源。</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  bridge.refreshMemoryCandidates();
                  bridge.refreshConfirmedMemories();
                }}
              >
                <RefreshCw size={15} />刷新
              </button>
            </div>
            <form
              className={styles.searchRow}
              onSubmit={(event) => {
                event.preventDefault();
                if (memoryQuery.trim()) bridge.queryMemory(memoryQuery);
              }}
            >
              <input
                value={memoryQuery}
                maxLength={2_000}
                placeholder="搜索已确认记忆"
                onChange={(event) => setMemoryQuery(event.target.value)}
              />
              <button type="submit" disabled={!memoryQuery.trim()}><Search size={16} />搜索</button>
            </form>
            {bridge.memoryResults.length > 0 && (
              <div className={styles.memoryResults}>
                <strong>搜索结果</strong>
                {bridge.memoryResults.map((item, index) => (
                  <article key={text(item.id) || index}>
                    <p>{text(item.text) || text(item.content)}</p>
                    <small>{text(item.source_type) || '已确认记忆'}</small>
                  </article>
                ))}
              </div>
            )}
            <div className={styles.memoryResults}>
              <strong>已确认的长期事实</strong>
              {bridge.confirmedMemories.length === 0 && (
                <div className={styles.empty}>
                  <Brain size={24} />
                  <span>目前没有你确认过的长期事实。</span>
                </div>
              )}
              {bridge.confirmedMemories.map((memory) => (
                <article key={memory.id}>
                  {editingMemoryId === memory.id ? (
                    <textarea
                      value={editingMemoryText}
                      rows={3}
                      maxLength={2_000}
                      autoFocus
                      onChange={(event) => setEditingMemoryText(event.target.value)}
                    />
                  ) : (
                    <p>{memory.text}</p>
                  )}
                  <small>
                    修订 {memory.fact_revision} · {memory.source_type || '用户确认'}
                    {memory.source_hash ? ` · SHA-256 ${memory.source_hash.slice(0, 12)}…` : ''}
                  </small>
                  <div className={styles.actionRow}>
                    {editingMemoryId === memory.id ? (
                      <>
                        <button
                          type="button"
                          disabled={!editingMemoryText.trim()}
                          onClick={() => {
                            if (!bridge.editConfirmedMemory(memory.id, editingMemoryText)) return;
                            setEditingMemoryId('');
                            setEditingMemoryText('');
                          }}
                        >
                          <Check size={15} />保存纠正
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMemoryId('');
                            setEditingMemoryText('');
                          }}
                        >
                          <X size={15} />取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMemoryId(memory.id);
                          setEditingMemoryText(memory.text);
                          setDeleteArmedId('');
                        }}
                      >
                        <Pencil size={15} />纠正
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (deleteArmedId !== memory.id) {
                          setDeleteArmedId(memory.id);
                          setEditingMemoryId('');
                          return;
                        }
                        if (bridge.deleteConfirmedMemory(memory.id)) setDeleteArmedId('');
                      }}
                    >
                      <Trash2 size={15} />
                      {deleteArmedId === memory.id ? '再次点击永久删除' : '删除'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className={styles.candidateList}>
              {bridge.memoryCandidates.length === 0 && (
                <div className={styles.empty}>
                  <Check size={26} />
                  <strong>没有待确认候选</strong>
                  <span>Reverie 不会静默把推测写成你的事实。</span>
                </div>
              )}
              {bridge.memoryCandidates.map((candidate) => (
                <article key={candidate.id}>
                  <header>
                    <strong>{candidate.proposed_text}</strong>
                    <span>{Math.round(candidate.confidence * 100)}% 置信度</span>
                  </header>
                  <blockquote>{candidate.source_text}</blockquote>
                  <small>
                    来源：{candidate.source_type || '用户消息'} · SHA-256 {candidate.source_hash.slice(0, 12)}…
                  </small>
                  <div className={styles.actionRow}>
                    <button type="button" onClick={() => bridge.confirmMemoryCandidate(candidate.id)}>
                      <Check size={15} />确认
                    </button>
                    <button type="button" onClick={() => bridge.rejectMemoryCandidate(candidate.id)}>
                      <Trash2 size={15} />拒绝
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {tab === 'settings' && (
          <section className={styles.settingsPanel}>
            <ProviderSettings />
            <section className={styles.settingsSection}>
              <header>
                <Brain size={18} />
                <div>
                  <strong>记忆保留</strong>
                  <span>只提供明确、有限的保留期；不会宣称“无限记忆”。</span>
                </div>
              </header>
              <label>
                <span>保留期</span>
                <select value={retention} onChange={(event) => setRetention(Number(event.target.value))}>
                  <option value={365}>1 年</option>
                  <option value={730}>2 年</option>
                  <option value={1095}>3 年</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => bridge.updateSettings({ section: 'memory', retention_days: retention })}
              >
                保存保留期
              </button>
            </section>
            <section className={styles.settingsSection}>
              <header>
                <Pencil size={18} />
                <div>
                  <strong>手动记忆</strong>
                  <span>把你希望她记住的聊天内容主动存为长期或短期记忆。</span>
                </div>
              </header>
              <label>
                <span>想记住的内容</span>
                <textarea
                  value={manualMemoryText}
                  rows={3}
                  maxLength={2_000}
                  placeholder="例如：我最近在玩终末地，联动剧情看得好开心"
                  onChange={(event) => setManualMemoryText(event.target.value)}
                />
              </label>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  disabled={!manualMemoryText.trim() || bridge.connection !== 'connected'}
                  onClick={() => {
                    if (!bridge.storeMemory(manualMemoryText, 'long_term')) {
                      setManualMemoryNotice('保存失败：本地服务未连接。');
                      return;
                    }
                    setManualMemoryNotice('已存入长期记忆（遗忘周期 60~365 天）。');
                    setManualMemoryText('');
                  }}
                >
                  存为长期记忆
                </button>
                <button
                  type="button"
                  disabled={!manualMemoryText.trim() || bridge.connection !== 'connected'}
                  onClick={() => {
                    if (!bridge.storeMemory(manualMemoryText, 'short_term')) {
                      setManualMemoryNotice('保存失败：本地服务未连接。');
                      return;
                    }
                    setManualMemoryNotice('已存入短期记忆（遗忘周期 1~59 天）。');
                    setManualMemoryText('');
                  }}
                >
                  存为短期记忆
                </button>
                <button
                  type="button"
                  disabled={!manualMemoryText.trim() || bridge.connection !== 'connected'}
                  onClick={() => {
                    if (!bridge.storeMemory(manualMemoryText, 'permanent')) {
                      setManualMemoryNotice('保存失败：本地服务未连接。');
                      return;
                    }
                    setManualMemoryNotice('已存为珍贵回忆：不会遗忘，也不会记混。');
                    setManualMemoryText('');
                  }}
                >
                  存为珍贵回忆
                </button>
              </div>
              <p className={styles.statusLine} role="status">{manualMemoryNotice}</p>
            </section>
            <section className={styles.settingsSection}>
              <header>
                <ShieldCheck size={18} />
                <div>
                  <strong>性格小缺点</strong>
                  <span>你来定义她的“缺点”，让真人感来自瑕疵而不是完美。</span>
                </div>
              </header>
              <label>
                <span>小缺点（用逗号或分号分隔）</span>
                <textarea
                  value={flawsText}
                  rows={3}
                  maxLength={400}
                  placeholder="例如：路痴、偶尔拖延、怕黑、丢三落四、看到可爱东西会忍不住保存截图"
                  onChange={(event) => setFlawsText(event.target.value)}
                />
              </label>
              <label className={styles.checkboxStack}>
                <input
                  type="checkbox"
                  checked={flawsDisclaimerAccepted}
                  onChange={(event) => setFlawsDisclaimerAccepted(event.target.checked)}
                />
                <span>
                  我已知悉：因用户所设置的“缺点”而引发的一系列问题由用户自行承担，
                  与本项目及本项目的所有者不承担任何责任。
                </span>
              </label>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  disabled={
                    !flawsText.trim()
                    || !flawsDisclaimerAccepted
                    || bridge.connection !== 'connected'
                  }
                  onClick={() => {
                    if (!bridge.updateSettings({
                      section: 'personality',
                      user_selected_flaws: flawsText,
                      personality_flaws_enabled: true,
                      personality_flaws_disclaimer_acknowledged: true,
                    })) {
                      setFlawsNotice('保存失败：本地服务未连接。');
                      return;
                    }
                    setFlawsNotice('已保存：她会把这些当作自己真实的小缺点来表现。');
                  }}
                >
                  保存小缺点
                </button>
              </div>
              <p className={styles.statusLine} role="status">{flawsNotice}</p>
            </section>
            <section className={styles.settingsSection}>
              <header>
                <MessageCircle size={18} />
                <div>
                  <strong>聊天设置</strong>
                  <span>像人一样回消息：延迟、分段、输入中状态与在线状态。</span>
                </div>
              </header>
              <label>
                <span>回复延迟下限 {replyDelayMin} 秒（1~60）</span>
                <input
                  type="range"
                  min="1"
                  max="60"
                  step="1"
                  value={replyDelayMin}
                  onChange={(event) => setReplyDelayMin(Number(event.target.value))}
                />
              </label>
              <label>
                <span>回复延迟上限 {replyDelayMax} 秒（1~60，超长消息可到 60 秒）</span>
                <input
                  type="range"
                  min="1"
                  max="60"
                  step="1"
                  value={replyDelayMax}
                  onChange={(event) => setReplyDelayMax(Number(event.target.value))}
                />
              </label>
              <label className={styles.checkboxStack}>
                <input
                  type="checkbox"
                  checked={splitMessages}
                  onChange={(event) => setSplitMessages(event.target.checked)}
                />
                <span>几句话拆成多个气泡发送</span>
              </label>
              <label className={styles.checkboxStack}>
                <input
                  type="checkbox"
                  checked={typingIndicator}
                  onChange={(event) => setTypingIndicator(event.target.checked)}
                />
                <span>显示“正在输入中”</span>
              </label>
              <label>
                <span>在线状态</span>
                <select
                  value={chatStatus}
                  onChange={(event) => setChatStatus(event.target.value as typeof chatStatus)}
                >
                  <option value="online">在线（秒回）</option>
                  <option value="busy">忙碌（延迟几分钟）</option>
                  <option value="away">外出（延迟更久）</option>
                  <option value="sleeping">睡觉（醒来才回）</option>
                </select>
              </label>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  disabled={bridge.connection !== 'connected'}
                  onClick={() => {
                    if (!bridge.updateSettings({
                      section: 'chat',
                      reply_delay_min: replyDelayMin,
                      reply_delay_max: replyDelayMax,
                      split_messages: splitMessages,
                      typing_indicator: typingIndicator,
                      status: chatStatus,
                    })) {
                      setChatSettingsNotice('保存失败：本地服务未连接。');
                      return;
                    }
                    setChatSettingsNotice('聊天节奏已保存。');
                  }}
                >
                  保存聊天设置
                </button>
              </div>
              <div className={styles.divider} />
              <label className={styles.checkboxStack}>
                <input
                  type="checkbox"
                  checked={proactiveEnabled}
                  onChange={(event) => setProactiveEnabled(event.target.checked)}
                />
                <span>允许她主动找你聊天（会消耗 API）</span>
              </label>
              <label className={styles.checkboxStack}>
                <input
                  type="checkbox"
                  checked={proactiveNotifications}
                  disabled={!proactiveEnabled}
                  onChange={(event) => setProactiveNotifications(event.target.checked)}
                />
                <span>后台时也弹出系统通知</span>
              </label>
              <label>
                <span>每日主动消息上限 {proactiveLimit} 条（1~12）</span>
                <input
                  type="range"
                  min="1"
                  max="12"
                  step="1"
                  value={proactiveLimit}
                  disabled={!proactiveEnabled}
                  onChange={(event) => setProactiveLimit(Number(event.target.value))}
                />
              </label>
              <label>
                <span>最小间隔 {proactiveInterval} 分钟（15~1440）</span>
                <input
                  type="range"
                  min="15"
                  max="1440"
                  step="15"
                  value={proactiveInterval}
                  disabled={!proactiveEnabled}
                  onChange={(event) => setProactiveInterval(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                disabled={bridge.connection !== 'connected'}
                onClick={() => {
                  if (!bridge.updateSettings({
                    section: 'features',
                    proactive_chat_enabled: proactiveEnabled,
                    proactive_notifications_enabled: proactiveNotifications,
                    proactive_daily_limit: proactiveLimit,
                    proactive_min_interval_minutes: proactiveInterval,
                  })) {
                    setChatSettingsNotice('保存失败：本地服务未连接。');
                    return;
                  }
                  setChatSettingsNotice('主动聊天设置已保存。');
                }}
              >
                保存主动聊天设置
              </button>
              <p className={styles.statusLine} role="status">{chatSettingsNotice}</p>
            </section>
            <section className={styles.settingsSection}>
              <header>
                <ShieldCheck size={18} />
                <div>
                  <strong>隐私模式</strong>
                  <span>开启后，主进程和 Python 都禁止非回环网络访问。</span>
                </div>
              </header>
              <LocalModeControl />
            </section>
            <section className={styles.settingsSection}>
              <header>
                <Video size={18} />
                <div>
                  <strong>视频下载</strong>
                  <span>把冲浪时遇到的视频下载后，作为单条视频消息发给她。默认关闭，需先同意免责声明。</span>
                </div>
              </header>
              <VideoDownloadControl
                connection={bridge.connection}
                features={isRecord(bridge.settings.features) ? bridge.settings.features : null}
                updateSettings={bridge.updateSettings}
                saveSettings={bridge.saveSettings}
                downloadVideo={bridge.downloadVideo}
                sendChat={bridge.sendChat}
              />
            </section>
            <section className={styles.settingsSection}>
              <header>
                <Settings size={18} />
                <div>
                  <strong>界面模式</strong>
                  <span>“她的房间”是完整沉浸界面；切过去后可在房间设置里返回这里。</span>
                </div>
              </header>
              <label>
                <span>界面</span>
                <select
                  value={uiMode}
                  onChange={(event) => setUiMode(event.target.value as 'mvp' | 'dream')}
                >
                  <option value="mvp">主界面（简洁）</option>
                  <option value="dream">她的房间（沉浸）</option>
                </select>
              </label>
              <button
                type="button"
                disabled={bridge.connection !== 'connected'}
                onClick={() => {
                  if (!bridge.updateSettings({ section: 'ui', mode: uiMode })) {
                    setUiModeNotice('保存失败：本地服务未连接。');
                    return;
                  }
                  setUiModeNotice(uiMode === 'dream'
                    ? '已切换：即将打开她的房间。'
                    : '已切换：保留简洁主界面。');
                }}
              >
                保存界面模式
              </button>
              <p className={styles.statusLine} role="status">{uiModeNotice}</p>
            </section>
            <section className={styles.settingsSection}>
              <header>
                <Settings size={18} />
                <div>
                  <strong>语音包</strong>
                  <span>导入 GPT-SoVITS v2 四件套文件夹，保存在本机应用数据目录。</span>
                </div>
              </header>
              <VoicePackManagerPanel />
            </section>
            <section className={styles.settingsSection}>
              <header>
                <Cloud size={18} />
                <div>
                  <strong>云服务（开发中）</strong>
                  <span>云接口已预留、尚未开放：记忆、情绪、关系、日记与聊天目前全部只保存在这台电脑本地。</span>
                </div>
              </header>
              <p className={styles.statusLine}>云同步上线后，这里会提供开关与数据迁移入口；换机可以先在“她的房间 → 备份”里做本地导出/导入。</p>
            </section>
          </section>
        )}
      </section>

    </main>
  );
}

function LocalModeControl() {
  const [state, setState] = useState<LocalModeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const api = window.electronAPI?.localMode;
    if (!api) return undefined;
    void api.get().then(setState).catch(() => setMessage('无法读取隐私模式状态。'));
    return api.onChanged(setState);
  }, []);

  const toggle = async () => {
    const api = window.electronAPI?.localMode;
    if (!api || !state) return;
    setBusy(true);
    setMessage(state.enabled ? '正在恢复网络权限…' : '正在关闭远程网络权限…');
    try {
      setState(await api.set(!state.enabled));
      setMessage(!state.enabled ? '隐私模式已开启。' : '隐私模式已关闭。');
    } catch {
      setMessage('切换失败；系统保持更严格的原状态。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.localMode}>
      <button type="button" disabled={busy || !state?.available} onClick={() => void toggle()}>
        {state?.enabled ? '关闭隐私模式' : '开启隐私模式'}
      </button>
      <span role="status">{message || (state?.enabled ? '当前禁止远程网络。' : '当前允许所选 Provider 联网。')}</span>
    </div>
  );
}

// Video download compliance gate. Mirrors the fail-closed invariant enforced by
// the backend (ws_bridge features branch): the feature cannot be enabled unless
// the user has acknowledged the liability disclaimer. This UI adds a
// scroll-to-bottom requirement before the acknowledgement checkbox unlocks, so
// the user cannot blind-accept. The backend re-checks acknowledgement on save,
// so a tampered client still cannot enable the feature without acknowledgement.
function VideoDownloadControl({
  connection,
  features,
  updateSettings,
  saveSettings,
  downloadVideo,
  sendChat,
}: {
  connection: string;
  features: Record<string, unknown> | null;
  updateSettings: (payload: Record<string, unknown>) => unknown;
  saveSettings: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  downloadVideo: (sourceUrl: string, pageTitle?: string) => Promise<{
    mediaId: string;
    mime: string;
    pageTitle: string;
  }>;
  sendChat: (raw: string, attachment?: {
    path?: string;
    previewUrl?: string;
    videoMediaId?: string;
    videoMime?: string;
  }) => string | null;
}) {
  const [enabled, setEnabled] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [downloadBusy, setDownloadBusy] = useState(false);
  // Whether the disclaimer has been read to the bottom this session. Reset only
  // on mount; a saved acknowledgement pre-satisfies it so returning users are
  // not forced to re-scroll to toggle the feature.
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [notice, setNotice] = useState('');
  const disclaimerRef = useRef<HTMLParagraphElement | null>(null);

  // Hydrate from authoritative backend state. A previously acknowledged
  // disclaimer also unlocks the checkbox without re-scrolling.
  useEffect(() => {
    if (!features) return;
    const savedEnabled = features.video_download_enabled === true;
    const savedAck = features.video_download_disclaimer_acknowledged === true;
    setEnabled(savedEnabled);
    setAcknowledged(savedAck);
    if (savedAck) setScrolledToBottom(true);
  }, [features]);

  // Measurement guard (Murphy M): a short disclaimer that fits without a
  // scrollbar can never fire onScroll, which would lock the checkbox forever.
  // If the content is not actually scrollable, treat it as already read.
  const measureScrollable = useCallback((node: HTMLParagraphElement | null) => {
    disclaimerRef.current = node;
    if (node && node.scrollHeight - node.clientHeight <= 1) {
      setScrolledToBottom(true);
    }
  }, []);

  const onDisclaimerScroll = () => {
    const node = disclaimerRef.current;
    if (!node) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) {
      setScrolledToBottom(true);
    }
  };

  const save = () => {
    // Enforce the fail-closed pairing client-side too: an unacknowledged
    // disclaimer forces the feature off before the request is even sent.
    const nextEnabled = acknowledged ? enabled : false;
    if (!updateSettings({
      section: 'features',
      video_download_disclaimer_acknowledged: acknowledged,
      video_download_enabled: nextEnabled,
    })) {
      setNotice('保存失败：本地服务未连接。');
      return;
    }
    setNotice(nextEnabled
      ? '已开启视频下载。仅用于你拥有版权或已获授权的内容。'
      : acknowledged
        ? '已保存：视频下载当前关闭。'
        : '已撤销同意：视频下载已关闭。');
  };

  const downloadAndSend = async () => {
    const url = sourceUrl.trim();
    if (!url) {
      setNotice('请粘贴一条公开的 http(s) 视频地址。');
      return;
    }
    if (!acknowledged || !enabled) {
      setNotice('请先阅读免责声明并开启视频下载。');
      return;
    }
    if (connection !== 'connected' || downloadBusy) return;
    const nextEnabled = acknowledged ? enabled : false;
    setDownloadBusy(true);
    setNotice('正在保存设置并下载视频…');
    try {
      const saved = await saveSettings({
        section: 'features',
        video_download_disclaimer_acknowledged: acknowledged,
        video_download_enabled: nextEnabled,
      });
      if (saved.ok !== true) {
        setNotice('设置未保存成功，无法下载。');
        return;
      }
      setNotice('正在下载视频…');
      const downloaded = await downloadVideo(url);
      if (!sendChat(downloaded.pageTitle, {
        videoMediaId: downloaded.mediaId,
        videoMime: downloaded.mime,
      })) {
        setNotice('视频已下载，但未能作为聊天消息发出。');
        return;
      }
      setSourceUrl('');
      setNotice('视频已作为一条聊天消息发出。默认不自动播放。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '视频下载失败。');
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <>
      <p
        ref={measureScrollable}
        className={styles.videoDisclaimer}
        onScroll={onDisclaimerScroll}
        tabIndex={0}
        role="region"
        aria-label="视频下载免责声明"
      >
        {VIDEO_DOWNLOAD_DISCLAIMER}
      </p>
      <label className={styles.checkboxStack}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={!scrolledToBottom}
          onChange={(event) => {
            const next = event.target.checked;
            setAcknowledged(next);
            // Revoking acknowledgement immediately disables the feature intent,
            // matching the backend's fail-closed invariant.
            if (!next) setEnabled(false);
          }}
        />
        <span>
          我已阅读并同意上述免责声明{!scrolledToBottom && '（请先滑动阅读到底部）'}
        </span>
      </label>
      <label className={styles.checkboxStack}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!acknowledged}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>开启视频下载功能</span>
      </label>
      <label className={styles.field}>
        <span>视频地址（公开 http/https 直链或 m3u8）</span>
        <input
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://example.com/video.mp4"
          disabled={!enabled || downloadBusy}
        />
      </label>
      <div className={styles.actionRow}>
        <button
          type="button"
          disabled={connection !== 'connected'}
          onClick={save}
        >
          保存视频下载设置
        </button>
        <button
          type="button"
          disabled={connection !== 'connected' || !enabled || downloadBusy}
          onClick={() => void downloadAndSend()}
        >
          {downloadBusy ? '正在下载…' : '下载并发送到聊天'}
        </button>
      </div>
      <p className={styles.statusLine} role="status">{notice}</p>
    </>
  );
}
