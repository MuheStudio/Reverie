/** Bounded explicit file import; no path or automatic legacy-file discovery. */
export const LEGACY_SUMMARY_MAX_BYTES = 128 * 1024;
export function legacySummaryPayload(content: string): { content: string } {
  const bytes = new TextEncoder().encode(content);
  if (!bytes.length || bytes.length > LEGACY_SUMMARY_MAX_BYTES) throw new Error('摘要文件须在 128 KiB 以内，原文件未更改。');
  // Leave room for identity/request envelopes in the 256 KiB legacy bridge.
  if (new TextEncoder().encode(JSON.stringify({ content })).length > 240 * 1024) throw new Error('摘要内容超过传输上限，原文件未更改。');
  return { content };
}
export async function readLegacySummaryFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (!file.size || file.size > LEGACY_SUMMARY_MAX_BYTES) throw new Error('摘要文件须在 128 KiB 以内，原文件未更改。');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error('读取期间文件发生变化，请重新选择。');
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  legacySummaryPayload(content);
  return content;
}
export const summaryStatusLabel = (code: unknown): string => ({
  disabled: '已关闭', unauthorized: '等待单独费用授权', consent_required: '等待单独费用授权',
  cooldown: '冷却中', running: '后台生成中', completed: '摘要已完成', ready: '可用',
  below_threshold: '待处理历史尚未达到阈值', no_source: '暂无可处理历史',
  budget_denied: '后台预算不足', budget_exceeded: '后台预算不足',
  timeout_unknown: '请求超时，未自动重试', empty_output: '摘要结果为空，未自动重试', oversized_output: '摘要结果超限，未自动重试',
  provider_or_storage_failure: '生成或保存失败，未自动重试', consent_revoked: '授权已撤销', cancelled_unknown: '任务已取消，未自动重试',
  local_mode_blocked: '本地模式已阻止摘要请求', provider_binding_changed: '模型配置已变化，结果未保存',
  provider_changed: '模型配置已变化，结果未保存', provider_cleanup_unconfirmed: '后台清理尚未确认',
  timeout: '请求超时，未自动重试', outcome_unknown: '请求结果未知，未自动重试',
  cancelled: '已取消', invalid_output: '摘要结果无效', failed: '生成失败', idle: '等待已提交的历史',
}[String(code)] ?? '状态待刷新');
