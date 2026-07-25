/**
 * ReverieMain 子面板：日记 / 记忆 / 世界书
 *
 * 从 useReverieWS hook 获取后端数据，渲染实际内容。
 */
import { useState, useEffect, useCallback } from 'react';
import { useReverieWS, WSMsgType } from '../../hooks/useReverieWS';
import type { DiaryEntry, MemoryItem } from '../../hooks/useReverieWS';
import styles from './ReverieMain.module.css';

/* ═══════════════════════════════════════════════════════════
   DiaryPanel — 日记列表 + 查看单篇
   ═══════════════════════════════════════════════════════════ */

export function DiaryPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [selected, setSelected] = useState<DiaryEntry | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchDiary = useCallback(() => {
    if (ws.connState !== 'connected') return;
    setLoading(true);
    ws.send(WSMsgType.DIARY_REQUEST, {});
  }, [ws]);

  useEffect(() => {
    const unsub = ws.subscribe(WSMsgType.DIARY_RESULT, (payload: any) => {
      setEntries(payload.entries || []);
      setLoading(false);
    });
    return unsub;
  }, [ws]);

  useEffect(() => {
    if (ws.connState === 'connected') fetchDiary();
  }, [ws.connState, fetchDiary]);

  // 选中日记
  if (selected) {
    return (
      <div className={styles.panelContent}>
        <button className={styles.backButton} onClick={() => setSelected(null)}>
          ← 返回列表
        </button>
        <div className={styles.diaryDetail}>
          <div className={styles.diaryMeta}>
            <span className={styles.diaryDate}>{selected.date}</span>
            <span className={styles.diaryMood}>{selected.mood}</span>
            {selected.peekable ? (
              <span className={styles.diaryPeekBadge}>可偷看</span>
            ) : (
              <span className={styles.diaryLockBadge}>🔒 已加密</span>
            )}
          </div>
          <h3 className={styles.diaryTitle}>{selected.title}</h3>
          <div className={styles.diaryContent}>{selected.content}</div>
        </div>
      </div>
    );
  }

  // 列表视图
  return (
    <div className={styles.panelContent}>
      <div className={styles.panelHeader}>
        <span>📔 日记</span>
        <button className={styles.refreshButton} onClick={fetchDiary} disabled={loading}>
          {loading ? '⏳' : '🔄'}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className={styles.previewPlaceholder}>
          <p className={styles.previewIcon}>📔</p>
          <p>{ws.connState !== 'connected' ? '未连接后端' : '暂无日记'}</p>
          <p className={styles.previewHint}>
            {ws.connState !== 'connected' ? '启动 Python 后端后自动加载' : '角色休息后会生成日记'}
          </p>
        </div>
      ) : (
        <div className={`${styles.entryList} reverie-scroll`}>
          {entries.map((entry, i) => (
            <button
              key={i}
              className={styles.entryItem}
              onClick={() => setSelected(entry)}
            >
              <div className={styles.entryDate}>{entry.date}</div>
              <div className={styles.entryTitle}>{entry.title}</div>
              <div className={styles.entryMood}>{entry.mood}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MemoryPanel — 记忆浏览器（语义搜索 + 层级筛选）
   ═══════════════════════════════════════════════════════════ */

export function MemoryPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryItem[]>([]);
  const [layer, setLayer] = useState('all');
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(() => {
    if (!query.trim() || ws.connState !== 'connected') return;
    setLoading(true);
    ws.send(WSMsgType.MEMORY_QUERY, { query, layer, top_k: 15 });
  }, [query, layer, ws]);

  useEffect(() => {
    const unsub = ws.subscribe(WSMsgType.MEMORY_RESULT, (payload: any) => {
      setResults(payload.memories || []);
      setLoading(false);
    });
    return unsub;
  }, [ws]);

  return (
    <div className={styles.panelContent}>
      <div className={styles.panelHeader}>
        <span>🧠 记忆搜索</span>
      </div>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="搜索记忆…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <select
          className={styles.layerSelect}
          value={layer}
          onChange={(e) => setLayer(e.target.value)}
        >
          <option value="all">全部</option>
          <option value="permanent">永久</option>
          <option value="long_term">长期</option>
          <option value="short_term">短期</option>
        </select>
      </div>
      {results.length === 0 && !loading && (
        <div className={styles.previewPlaceholder}>
          <p className={styles.previewIcon}>🧠</p>
          <p>{ws.connState !== 'connected' ? '未连接后端' : '输入关键词搜索记忆'}</p>
        </div>
      )}
      {loading && <div className={styles.loadingHint}>搜索中…</div>}
      <div className={`${styles.memoryList} reverie-scroll`}>
        {results.map((item, i) => (
          <div key={i} className={styles.memoryItem}>
            <div className={styles.memoryContent}>{item.content}</div>
            <div className={styles.memoryMeta}>
              <span className={styles.memoryLayer}>{item.layer}</span>
              <span className={styles.memoryScore}>相关性: {(item.score * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LorebookPanel — 世界书编辑器（条目列表 + 新增/编辑）
   ═══════════════════════════════════════════════════════════ */

export function LorebookPanel({ ws }: { ws: ReturnType<typeof useReverieWS> }) {
  const [entries, setEntries] = useState<Array<{
    key: string; comment: string; content: string; always_active: boolean;
  }>>([]);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [editKey, setEditKey] = useState('');
  const [editComment, setEditComment] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editAlways, setEditAlways] = useState(false);

  const startEdit = (idx: number | 'new') => {
    setEditing(idx);
    if (idx === 'new') {
      setEditKey(''); setEditComment(''); setEditContent(''); setEditAlways(false);
    } else if (entries[idx]) {
      const e = entries[idx];
      setEditKey(e.key); setEditComment(e.comment); setEditContent(e.content); setEditAlways(e.always_active);
    }
  };

  const saveEntry = () => {
    if (!editKey.trim() || !editContent.trim()) return;
    const newEntries = [...entries];
    const entry = { key: editKey, comment: editComment, content: editContent, always_active: editAlways };
    if (editing === 'new') {
      newEntries.push(entry);
    } else if (typeof editing === 'number') {
      newEntries[editing] = entry;
    }
    setEntries(newEntries);
    setEditing(null);
    // 发送到后端保存
    ws.send(WSMsgType.SETTINGS_UPDATE, { section: 'lorebook', entries: newEntries });
  };

  const deleteEntry = (idx: number) => {
    const newEntries = entries.filter((_, i) => i !== idx);
    setEntries(newEntries);
    ws.send(WSMsgType.SETTINGS_UPDATE, { section: 'lorebook', entries: newEntries });
  };

  return (
    <div className={styles.panelContent}>
      <div className={styles.panelHeader}>
        <span>📖 世界书</span>
        <button className={styles.addButton} onClick={() => startEdit('new')}>+ 新增</button>
      </div>

      {/* 编辑表单 */}
      {editing !== null && (
        <div className={styles.editForm}>
          <input className={styles.editInput} placeholder="触发关键词（逗号分隔）" value={editKey} onChange={(e) => setEditKey(e.target.value)} />
          <input className={styles.editInput} placeholder="条目名称" value={editComment} onChange={(e) => setEditComment(e.target.value)} />
          <textarea className={styles.editTextarea} placeholder="世界书内容…" value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={4} />
          <label className={styles.editCheckbox}>
            <input type="checkbox" checked={editAlways} onChange={(e) => setEditAlways(e.target.checked)} />
            始终激活
          </label>
          <div className={styles.editActions}>
            <button className={styles.saveButton} onClick={saveEntry}>保存</button>
            <button className={styles.cancelButton} onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 条目列表 */}
      {entries.length === 0 && editing === null ? (
        <div className={styles.previewPlaceholder}>
          <p className={styles.previewIcon}>📖</p>
          <p>暂无世界书条目</p>
          <p className={styles.previewHint}>点击「+ 新增」创建第一条</p>
        </div>
      ) : (
        <div className={`${styles.entryList} reverie-scroll`}>
          {entries.map((entry, i) => (
            <div key={i} className={styles.loreItem}>
              <div className={styles.loreHeader}>
                <span className={styles.loreKey}>{entry.key || '(始终激活)'}</span>
                <span className={styles.loreComment}>{entry.comment}</span>
              </div>
              <div className={styles.loreContent}>{entry.content.slice(0, 80)}{entry.content.length > 80 ? '…' : ''}</div>
              <div className={styles.loreActions}>
                <button onClick={() => startEdit(i)}>✏️</button>
                <button onClick={() => deleteEntry(i)}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   附加样式（追加到 CSS Module 文件）
   ═══════════════════════════════════════════════════════════ */
