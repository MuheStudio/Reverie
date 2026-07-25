/**
 * ReverieMain — 三栏式主界面布局。
 *
 * ┌──────────────────────────────────────────────────┐
 * │  Header: 角色名 + 在线状态 + 时间              │
 * ├──────────┬───────────────────┬──────────────────┤
 * │ 左侧面板 │   中间聊天区       │   右侧面板       │
 * │ Avatar   │   消息气泡列表     │   日记/记忆/     │
 * │ 情绪条   │   输入框+工具栏    │   世界书标签页   │
 * │ 关系阶段 │                   │                  │
 * │          │                   │                  │
 * ├──────────┴───────────────────┴──────────────────┤
 * │  Dock: 其他应用入口                            │
 * └──────────────────────────────────────────────────┘
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useReverieWS, WSMsgType } from '../../hooks/useReverieWS';
import { DiaryPanel, MemoryPanel, LorebookPanel } from './Panels';
import { Live2DCanvas } from '../AvatarView/Live2DAdapter';
import { loadReverieChatDraft, saveReverieChatDraft } from '../../lib/reverieChatStorage';
import styles from './ReverieMain.module.css';

// ── 子面板（逐步实现）─────────────────────────────────

function AvatarPanel({
  emotions, persona, relationship, connState,
}: {
  emotions: Record<string, number>;
  persona: any;
  relationship: { intimacy: number; stage: string };
  connState: string;
}) {
  const dominant = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0];
  const statusColor = connState === 'connected' ? '#7fb87f' : connState === 'connecting' ? '#d4a06d' : '#e87d8b';

  return (
    <div className={styles.avatarPanel}>
      {/* 虚拟形象区 */}
      <div className={styles.avatarPlaceholder}>
        <Live2DCanvas
          config={{ width: 160, height: 160, resolution: 1.5, backgroundAlpha: 0 }}
          expression={dominant?.[0] || 'neutral'}
          speaking={false}
        />
        <div className={styles.statusDot} style={{ background: statusColor }} />
      </div>

      {/* 角色信息 */}
      <div className={styles.charInfo}>
        <h2 className={styles.charName}>{persona?.name || '幻梦'}</h2>
        <p className={styles.charStage}>{relationship.stage} · 亲密度 {relationship.intimacy}</p>
      </div>

      {/* 情绪条 */}
      <div className={styles.emotionBars}>
        {Object.entries(emotions).slice(0, 5).map(([name, val]) => (
          <div key={name} className={styles.emotionRow}>
            <span className={styles.emotionLabel}>{name}</span>
            <div className={styles.emotionTrack}>
              <div
                className={styles.emotionFill}
                style={{
                  width: `${Math.min(100, val)}%`,
                  background: getEmotionColor(name),
                }}
              />
            </div>
            <span className={styles.emotionValue}>{Math.round(val)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 情绪颜色映射 ──────────────────────────────────────

function getEmotionColor(name: string): string {
  const map: Record<string, string> = {
    joy: '#7fb87f', happy: '#7fb87f', excitement: '#d48b6d',
    calm: '#6db3d4', neutral: '#6db3d4',
    sadness: '#8b8fa8', anger: '#e87d8b', anxiety: '#d4a06d',
    grievance: '#b8a0d4', touched: '#e87d8b',
  };
  return map[name.toLowerCase()] || '#9a9db8';
}

// ── 聊天区 ─────────────────────────────────────────────

function ChatPanel({
  messages, isTyping, currentChunk, onSend,
}: {
  messages: Array<{ role: string; content: string; id: string }>;
  isTyping: boolean;
  currentChunk: string;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState(() => loadReverieChatDraft());
  const [showStickers, setShowStickers] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, currentChunk]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
    saveReverieChatDraft('');
  }, [input, onSend]);

  return (
    <div className={styles.chatPanel}>
      {/* 消息列表 */}
      <div className={`${styles.messageList} reverie-scroll`} ref={listRef}>
        {messages.length === 0 && (
          <div className={styles.emptyChat}>
            <div className={styles.emptyIcon}>💫</div>
            <p>开始你们的对话吧</p>
            <p className={styles.emptyHint}>她正在等你…</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${styles.messageBubble} ${msg.role === 'user' ? styles.bubbleUser : styles.bubbleChar}`}
          >
            <div className={styles.bubbleContent}>{msg.content}</div>
          </div>
        ))}
        {/* 正在输入 */}
        {isTyping && (
          <div className={`${styles.messageBubble} ${styles.bubbleChar}`}>
            <div className={styles.bubbleContent}>
              {currentChunk || <span className={styles.typingDots}><span>.</span><span>.</span><span>.</span></span>}
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className={styles.inputArea}>
        {showStickers && (
          <div className={styles.stickerPopup}>
            {['😊','😂','🥰','😭','😡','👍','💕','🎉','😴','🤔','👋','✨','🔥','💀','🙏','😅'].map(s => (
              <button key={s} className={styles.stickerItem} onClick={() => { onSend(s); setShowStickers(false); }}>{s}</button>
            ))}
          </div>
        )}
        <div className={styles.inputRow}>
          <button className={styles.toolButton} title="表情包" onClick={() => setShowStickers(!showStickers)}>😊</button>
          <button className={styles.toolButton} title="发送图片">🖼️</button>
          <input
            className={styles.chatInput}
            placeholder="说点什么…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              saveReverieChatDraft(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
          />
          <button className={styles.sendButton} onClick={handleSubmit} disabled={!input.trim()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13" /><path d="M22 2L15 22L11 13L2 9L22 2Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 右侧面板 ───────────────────────────────────────────

function SidePanel({ ws, onTab }: { ws: ReturnType<typeof useReverieWS>; onTab?: (tab: string) => void }) {
  const [activeTab, setActiveTab] = useState('diary');

  return (
    <div className={styles.sidePanel}>
      <div className={styles.tabBar}>
        {[
          { id: 'diary', icon: '📔', label: '日记' },
          { id: 'memory', icon: '🧠', label: '记忆' },
          { id: 'lorebook', icon: '📖', label: '世界书' },
          { id: 'settings', icon: '⚙️', label: '设置' },
        ].map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab(tab.id); onTab?.(tab.id); }}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className={`${styles.tabContent} reverie-scroll`}>
        {activeTab === 'diary' && <DiaryPanel ws={ws} />}
        {activeTab === 'memory' && <MemoryPanel ws={ws} />}
        {activeTab === 'lorebook' && <LorebookPanel ws={ws} />}
        {activeTab === 'settings' && <SettingsPanel ws={ws} />}
      </div>
    </div>
  );
}

// ── 设置面板 ───────────────────────────────────────────

function SettingsPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState('openai');
  const [saved, setSaved] = useState(false);

  const saveSettings = () => {
    ws.send(WSMsgType.SETTINGS_UPDATE, { section: 'llm', provider, api_key: apiKey });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className={styles.panelContent}>
      <div className={styles.panelHeader}><span>⚙️ 设置</span></div>
      <div className={styles.editForm}>
        <label className={styles.editLabel}>AI 提供商</label>
        <select className={styles.editInput as any} value={provider} onChange={(e: any) => setProvider(e.target.value)}>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="claude">Claude</option>
          <option value="gemini">Gemini</option>
          <option value="ollama">Ollama (本地)</option>
        </select>
        <label className={styles.editLabel}>API Key</label>
        <input className={styles.editInput as any} type="password" placeholder="sk-..." value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} />
        <button className={styles.saveButton} onClick={saveSettings}>{saved ? '✅ 已保存' : '保存设置'}</button>
      </div>
      <div className={styles.previewPlaceholder} style={{ marginTop: 16 }}>
        <p className={styles.previewHint}>更多设置（人设编辑、网络冲浪配置）即将推出</p>
      </div>
    </div>
  );
}

// ── ── 主组件 ────────────────────────────────────────────

export default function ReverieMain() {
  const ws = useReverieWS();

  const handleSend = useCallback((text: string) => {
    ws.addUserMessage(text);
    ws.sendChat(text);
  }, [ws]);

  return (
    <div className={styles.mainContainer}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.appTitle}>Reverie 幻梦</h1>
          <span className={styles.connStatus}>
            <span className={styles.connDot} data-state={ws.connState} />
            {ws.connState === 'connected' ? '已连接' : ws.connState === 'connecting' ? '连接中…' : '未连接'}
          </span>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.timeDisplay}>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </header>

      {/* 三栏主体 */}
      <div className={styles.body}>
        <AvatarPanel
          emotions={ws.emotions}
          persona={ws.persona}
          relationship={ws.relationship}
          connState={ws.connState}
        />
        <ChatPanel
          messages={ws.chatMessages}
          isTyping={ws.isTyping}
          currentChunk={ws.currentChunk}
          onSend={handleSend}
        />
        <SidePanel ws={ws} />
      </div>
    </div>
  );
}
