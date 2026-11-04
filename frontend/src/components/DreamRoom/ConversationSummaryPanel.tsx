import type { ArchiveClient } from './archiveClient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WSMsgType } from '@/hooks/useReverieWS';
import { createArchiveOperationScope, type ArchiveOperationToken } from '@/lib/archiveOperationScope';
import { legacySummaryPayload, readLegacySummaryFile, summaryStatusLabel } from '@/lib/conversationSummary';
import styles from './index.module.scss';

type Result = Record<string, unknown>;
export function ConversationSummaryPanel({ ws }: { ws: ArchiveClient }) {
  const scope = useRef(createArchiveOperationScope()).current;
  const token = scope.select(ws.personaScope, ws.connState === 'connected');
  const [status, setStatus] = useState<Result>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ content: string; preview: Result; token: ArchiveOperationToken } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; scope.select(null, false); }; }, [scope]);
  const request = useCallback(async (type: string, payload: Result, expected = WSMsgType.SUMMARY_RESULT as string) => {
    const result = await scope.run(token, () => ws.request<Result>(type, payload, {
      expectedType: expected, timeout: 15_000, personaScope: token.proof!,
    }));
    if (!alive.current || !result.current) return null;
    const disabledWithPendingCleanup = type === WSMsgType.SETTINGS_UPDATE && result.value.code === 'summary_cleanup_unconfirmed';
    if (result.value.ok !== true && !disabledWithPendingCleanup) throw new Error('操作未完成；人格或服务状态可能已变化。');
    return result.value;
  }, [scope, token, ws.request]);
  const refresh = useCallback(async () => {
    try {
      const value = await request(WSMsgType.SUMMARY_STATUS, { conversation_id: 'dream-room' });
      if (value) setStatus(value);
    } catch { if (scope.isCurrent(token)) setNotice('摘要状态暂时不可用，聊天可继续。'); }
  }, [request, scope, token]);
  useEffect(() => {
    setSelection(null); setStatus({}); setNotice(''); setBusy(false);
    if (!token.proof || ws.viewActive === false) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    const unsubscribe = ws.subscribe(WSMsgType.CHAT_DONE, () => { void refresh(); });
    return () => { clearInterval(timer); unsubscribe(); };
  }, [token, refresh, ws.subscribe, ws.viewActive]);
  const enable = async (enabled: boolean) => {
    setBusy(true);
    try {
      const value = await request(WSMsgType.SETTINGS_UPDATE, { section: 'features', hypa_compression_enabled: enabled }, WSMsgType.SETTINGS_UPDATE_RESULT);
      if (value) { setNotice(value.code === 'summary_cleanup_unconfirmed' ? '已关闭并保存；后台清理尚未确认。' : enabled ? '已开启功能；生成仍需下方单独费用授权。' : '已关闭并取消后台摘要任务。'); await refresh(); }
    } catch { if (scope.isCurrent(token)) setNotice('设置未保存。'); }
    finally { if (scope.isCurrent(token)) setBusy(false); }
  };
  const choose = async (file: File | undefined) => {
    setSelection(null); setNotice(''); if (!file) return;
    setBusy(true);
    try {
      const content = await readLegacySummaryFile(file);
      if (!scope.isCurrent(token)) return;
      const preview = await request(WSMsgType.SUMMARY_LEGACY_PREVIEW, legacySummaryPayload(content));
      if (preview) setSelection({ content, preview, token });
    } catch (error) { if (scope.isCurrent(token)) setNotice(error instanceof Error ? error.message : '无法读取摘要文件。'); }
    finally { if (scope.isCurrent(token)) setBusy(false); }
  };
  const importFile = async () => {
    if (!selection || selection.token !== token || !scope.isCurrent(token)) return;
    setBusy(true);
    try {
      const result = await request(WSMsgType.SUMMARY_LEGACY_IMPORT, {
        ...legacySummaryPayload(selection.content), expected_sha256: selection.preview.sha256, confirmed: true,
      });
      if (result) { setSelection(null); setNotice('已加密隔离保存，所有导入摘要均未启用；原文件未更改。'); await refresh(); }
    } catch { if (scope.isCurrent(token)) setNotice('导入未完成；原文件未更改。'); }
    finally { if (scope.isCurrent(token)) setBusy(false); }
  };
  const currentSelection = selection?.token === token ? selection : null;
  return <section className={styles.managementPanel} data-testid="conversation-summary-panel">
    <h3>对话摘要</h3>
    <p>回复完成后，在后台整理同一会话的已提交历史，下一轮使用完成的摘要。不会删除原始消息。</p>
    <label className={styles.checkRow}>
      <input data-testid="summary-enabled" type="checkbox" checked={status.enabled === true} disabled={busy || !token.proof} onChange={event => { void enable(event.target.checked); }} />
      <span>开启对话摘要（默认关闭，需要单独确认 API 费用）</span>
    </label>
    <p role="status" data-testid="summary-status">{status.running === true ? '后台生成中' : summaryStatusLabel(status.enabled === false ? 'disabled' : status.authorized === false ? 'unauthorized' : status.errorCode ?? status.status ?? status.code)}{status.enabled === true && status.authorized === false ? ' · 尚未授权' : ''}</p>
    <p>旧摘要只隔离保存，不自动归属或加入聊天。请选择 UTF-8 JSON，最多 128 KiB。</p>
    <input data-testid="summary-legacy-file" type="file" accept=".json,application/json" disabled={busy || !token.proof} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }} />
    {currentSelection && <div data-testid="summary-import-preview">
      <p>共 {Number(currentSelection.preview.total ?? 0)} 条；来源可关联 {Number(currentSelection.preview.linked ?? 0)} 条；未归属 {Number(currentSelection.preview.unattributed ?? 0)} 条。全部保持未启用。</p>
      <button data-testid="summary-import-confirm" type="button" disabled={busy} onClick={() => { void importFile(); }}>确认加密隔离保存</button>
      <button type="button" disabled={busy} onClick={() => setSelection(null)}>取消</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
