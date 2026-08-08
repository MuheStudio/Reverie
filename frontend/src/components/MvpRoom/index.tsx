import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  ImagePlus,
  KeyRound,
  MessageCircle,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useMvpBridge } from '@/hooks/useMvpBridge';
import { LLM_PROVIDER_CONFIGS, type LLMProvider } from '@/lib/llmModels';
import {
  consumeFallbackDraft,
  loadReverieChatDraft,
  migrateReverieChatDraft,
  saveReverieChatDraft,
} from '@/lib/reverieChatStorage';
import BundledCharacter from './BundledCharacter';
import styles from './MvpRoom.module.scss';

type Tab = 'chat' | 'memory' | 'settings';

type ProviderDraft = {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  customProviderName: string;
  apiKey: string;
  customHeaders: string;
};

const DEFAULT_PROVIDER: ProviderDraft = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  model: '',
  customProviderName: '',
  apiKey: '',
  customHeaders: '',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ProviderSettings() {
  const [draft, setDraft] = useState<ProviderDraft>(DEFAULT_PROVIDER);
  const [credentialMode, setCredentialMode] = useState<'persistent' | 'session'>('persistent');
  const [receipt, setReceipt] = useState('');
  const [status, setStatus] = useState('正在读取当前 Provider…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI?.providerConfig?.get()
      .then((value) => {
        if (disposed || !value?.llm) return;
        const provider = value.llm.provider as LLMProvider;
        if (!(provider in LLM_PROVIDER_CONFIGS)) return;
        setDraft((current) => ({
          ...current,
          provider,
          baseUrl: value.llm.baseUrl,
          model: value.llm.model,
          customProviderName: value.llm.customProviderName || '',
        }));
        setStatus('当前配置来自本地服务；密钥不会进入页面。');
      })
      .catch(() => {
        if (!disposed) setStatus('本地服务尚未就绪，暂时无法读取 Provider。');
      });
    return () => {
      disposed = true;
    };
  }, []);

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
  }), [draft.apiKey, draft.customHeaders]);

  const update = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const testProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    if (!api?.test) return;
    setBusy(true);
    setStatus('正在测试连接…');
    try {
      const result = await api.test(publicConfig, credential);
      if (result.ok) {
        setReceipt(result.receipt);
        setStatus(`连接成功（${result.latencyMs}ms，${result.finishReason}）。可以保存了。`);
      } else {
        setReceipt('');
        setStatus(`测试失败：${result.message}`);
      }
    } catch {
      setReceipt('');
      setStatus('测试失败：本地服务未响应。');
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async () => {
    const api = window.electronAPI?.providerConfig;
    if (!api?.commit || !receipt) return;
    setBusy(true);
    setStatus('正在保存并应用…');
    try {
      await api.commit(publicConfig, credential, credentialMode, receipt);
      setReceipt('');
      setStatus('已保存并应用到本地服务。');
    } catch {
      setStatus('保存失败：本地服务拒绝了这次提交。');
    } finally {
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
        <span>Base URL</span>
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
        <span>API Key {draft.provider === 'ollama' && '（通常留空）'}</span>
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
          <option value="persistent">Windows 加密存储</option>
          <option value="session">只保留到本次退出</option>
        </select>
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
          disabled={busy || !receipt}
          onClick={() => void saveProvider()}
        >
          测试通过后保存
        </button>
      </div>
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
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [aiConfirmed, setAiConfirmed] = useState(false);
  const [age, setAge] = useState(18);
  const [nickname, setNickname] = useState('');
  const [onboardingSaving, setOnboardingSaving] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const personaName = useMemo(() => (
    text(bridge.persona?.name)
    || text(bridge.persona?.display_name)
    || '她'
  ), [bridge.persona]);
  const uiSettings = isRecord(bridge.settings.ui) ? bridge.settings.ui : null;
  const onboardingKnown = bridge.connection === 'connected' && uiSettings !== null;
  const onboardingCompleted = uiSettings?.onboarding_completed === true;

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
    if (!bridge.sendChat(draft)) return;
    setDraft('');
  };

  const completeOnboarding = async () => {
    if (!adultConfirmed || !aiConfirmed || age < 18 || age > 120) return;
    setOnboardingSaving(true);
    await bridge.completeOnboarding({
      name: '',
      nickname: nickname.trim(),
      age,
      birthday: '',
      identity: '',
      schedule: '',
      interests: [],
      hobbies: [],
      favorite_topics: [],
      favorite_games: [],
      favorite_anime: [],
      important_dates: {},
    });
    setOnboardingSaving(false);
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
            <button type="button" aria-label="关闭错误" onClick={bridge.clearError}><X size={15} /></button>
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
                  <p>{message.content}</p>
                  {message.role === 'assistant' && isRecord(message.sticker) && (
                    <span className={styles.replySticker}>
                      {text(message.sticker.text) || (text(message.sticker.image_data_url).startsWith('data:')
                        ? <img src={text(message.sticker.image_data_url)} alt="表情" />
                        : '')}
                    </span>
                  )}
                  <small>{message.deliveryState || (message.role === 'user' ? '已提交' : personaName)}</small>
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
                        const imageUrl = text(sticker.image_data_url);
                        const label = text(sticker.text) || '表情';
                        const isDataImage = imageUrl.startsWith('data:');
                        if (isDataImage) {
                          return (
                            <button
                              key={id || label}
                              type="button"
                              title={label}
                              onClick={() => {
                                if (id) bridge.reactToSticker(id, true);
                                setDraft((current) => `${current}${current.trim() ? ' ' : ''}[表情:${label}]`);
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
                  </div>
                )}
              </div>
              <textarea
                value={draft}
                rows={3}
                maxLength={20_000}
                placeholder={bridge.connection === 'connected' ? `给 ${personaName} 发消息…` : '等待本地服务连接…'}
                disabled={bridge.connection !== 'connected'}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              {bridge.activeRequestId ? (
                <button type="button" className={styles.stopButton} onClick={bridge.cancelChat}>
                  <Square size={16} />停止
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!draft.trim() || bridge.connection !== 'connected'}
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
                  if (event.key === 'Enter') {
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
              <label className={styles.checkbox}>
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
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={splitMessages}
                  onChange={(event) => setSplitMessages(event.target.checked)}
                />
                <span>几句话拆成多个气泡发送</span>
              </label>
              <label className={styles.checkbox}>
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
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={proactiveEnabled}
                  onChange={(event) => setProactiveEnabled(event.target.checked)}
                />
                <span>允许她主动找你聊天（会消耗 API）</span>
              </label>
              <label className={styles.checkbox}>
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
          </section>
        )}
      </section>

      {onboardingKnown && !onboardingCompleted && (
        <div className={styles.onboardingBackdrop}>
          <section className={styles.onboarding} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
            <ShieldCheck size={32} />
            <h1 id="onboarding-title">开始前，先确认边界</h1>
            <p>
              Reverie 面向 18 岁以上用户。{personaName} 是 AI 角色，可能出错；记忆候选需要你确认，
              危机、医疗、法律与财务问题应寻求现实中的专业支持。
            </p>
            <label>
              <span>你的年龄</span>
              <input
                type="number"
                min={18}
                max={120}
                value={age}
                onChange={(event) => setAge(Number(event.target.value))}
              />
            </label>
            <label>
              <span>希望被怎样称呼（可选）</span>
              <input
                value={nickname}
                maxLength={80}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={adultConfirmed}
                onChange={(event) => setAdultConfirmed(event.target.checked)}
              />
              <span>我已年满 18 岁。</span>
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={aiConfirmed}
                onChange={(event) => setAiConfirmed(event.target.checked)}
              />
              <span>我理解这是 AI 陪伴，不是真人，也不会替代现实支持。</span>
            </label>
            <button
              type="button"
              disabled={onboardingSaving || !adultConfirmed || !aiConfirmed || age < 18 || age > 120}
              onClick={() => { void completeOnboarding(); }}
            >
              确认并进入
            </button>
          </section>
        </div>
      )}
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
