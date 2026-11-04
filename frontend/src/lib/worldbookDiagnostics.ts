/** Ephemeral, code-only worldbook notices carried by archive:result. */
export const WORLD_BOOK_DIAGNOSTIC_LABELS = {
  invalid_regex: '正则表达式无效，本轮未使用此条目。',
  regex_timeout: '正则匹配超时，本轮未使用此条目。',
  regex_budget_exhausted: '本轮正则处理预算已用完，未使用此条目。',
  regex_worker_unavailable: '正则处理暂不可用，本轮未使用此条目。',
  regex_input_limit: '正则输入超出处理上限，本轮未使用此条目。',
  recursion_depth_limit: '已达到递归层数上限，本轮停止继续展开。',
  recursion_text_limit: '已达到递归文本上限，本轮停止继续展开。',
  snapshot_unavailable: '世界书档案暂不可读，本轮未注入世界书。',
} as const;

export type WorldbookDiagnosticCode = keyof typeof WORLD_BOOK_DIAGNOSTIC_LABELS;
export interface WorldbookDiagnostic {
  persona_id: string;
  revision: number;
  request_id: string;
  book_id: string;
  entry_id: string;
  book_index: number;
  entry_index: number;
  code: WorldbookDiagnosticCode;
}
export interface WorldbookDiagnostics {
  persona_id: string;
  revision: number;
  request_id: string;
  entries: WorldbookDiagnostic[];
  truncated: number;
}
export interface WorldbookDiagnosticState {
  personaId: string | null;
  revision: number;
  diagnostics: WorldbookDiagnostics | null;
}

const record = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
function identifier(value: unknown, max = 160, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
const revisionNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const ordinal = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= -1 && Number(value) <= 100_000;
const knownCode = (value: unknown): value is WorldbookDiagnosticCode => typeof value === 'string'
  && Object.hasOwn(WORLD_BOOK_DIAGNOSTIC_LABELS, value);

export function coerceWorldbookDiagnostics(value: unknown): WorldbookDiagnostics | null {
  if (!record(value) || !identifier(value.persona_id) || !revisionNumber(value.revision)
    || !identifier(value.request_id, 128, true) || !Array.isArray(value.entries) || value.entries.length > 200
    || (value.truncated !== undefined && (!revisionNumber(value.truncated) || value.truncated > 1_000_000))) return null;
  const { persona_id, revision, request_id } = value;
  const entries: WorldbookDiagnostic[] = [];
  const seen = new Set<string>();
  for (const item of value.entries) {
    if (!record(item) || !knownCode(item.code) || item.persona_id !== persona_id || item.revision !== revision
      || item.request_id !== request_id || !identifier(item.book_id, 160, true) || !identifier(item.entry_id, 160, true)
      || !ordinal(item.book_index) || !ordinal(item.entry_index)) continue;
    const snapshot = item.code === 'snapshot_unavailable'
      || (item.code === 'regex_worker_unavailable' && item.book_index === -1);
    const recursive = item.code === 'recursion_depth_limit' || item.code === 'recursion_text_limit';
    if (snapshot ? !(item.book_index === -1 && item.entry_index === -1 && item.book_id === '' && item.entry_id === '')
      : !(item.book_index >= 0 && item.book_id && (recursive && item.entry_index === -1
        ? item.entry_id === '' : item.entry_index >= 0 && item.entry_id))) continue;
    const key = JSON.stringify([item.book_index, item.entry_index, item.book_id, item.entry_id, item.code]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ persona_id, revision, request_id, book_id: item.book_id, entry_id: item.entry_id,
      book_index: item.book_index, entry_index: item.entry_index, code: item.code });
  }
  return { persona_id, revision, request_id, entries, truncated: Number(value.truncated ?? 0) };
}

export function initialWorldbookDiagnostics(personaId: string | null = null): WorldbookDiagnosticState {
  return { personaId, revision: 0, diagnostics: null };
}
export function selectWorldbookPersona(state: WorldbookDiagnosticState, personaId: string | null): WorldbookDiagnosticState {
  return state.personaId === personaId ? state : initialWorldbookDiagnostics(personaId);
}

export function acceptWorldbookArchiveResult(
  state: WorldbookDiagnosticState,
  activePersonaId: string | null,
  payload: unknown,
): WorldbookDiagnosticState {
  const current = selectWorldbookPersona(state, activePersonaId);
  if (!activePersonaId || !record(payload) || payload.persona_id !== activePersonaId
    || !revisionNumber(payload.revision) || payload.revision < current.revision) return current;
  // A committed revision invalidates prior notices even if an older backend
  // omitted this optional metadata. Unsuccessful writes never clear notices.
  const next = payload.ok === true && payload.revision > current.revision
    ? { ...current, revision: payload.revision, diagnostics: null } : current;
  const diagnostics = coerceWorldbookDiagnostics(payload.world_book_diagnostics);
  if (!diagnostics || diagnostics.persona_id !== activePersonaId || diagnostics.revision !== payload.revision
    || diagnostics.revision < next.revision) return next;
  if (payload.ok !== true && diagnostics.revision !== next.revision) return next;
  return { personaId: activePersonaId, revision: diagnostics.revision, diagnostics };
}

export function worldbookNotice(state: WorldbookDiagnosticState): string {
  const { diagnostics } = state;
  if (!diagnostics || (!diagnostics.entries.length && !diagnostics.truncated)) return '';
  const labels = [...new Set(diagnostics.entries.map((entry) => WORLD_BOOK_DIAGNOSTIC_LABELS[entry.code]))];
  const limited = diagnostics.truncated ? '还有部分诊断未展开。' : '';
  return `世界书提示：${labels.join(' ')}${limited} 可在世界书管理中检查；聊天可以继续。`;
}

export function worldbookEntryWarnings(
  state: WorldbookDiagnosticState, bookId: string, bookIndex: number, entryId: string, entryIndex: number,
): string[] {
  return (state.diagnostics?.entries ?? []).filter((entry) => entry.book_id === bookId && entry.book_index === bookIndex
    && entry.entry_id === entryId && entry.entry_index === entryIndex).map((entry) => WORLD_BOOK_DIAGNOSTIC_LABELS[entry.code]);
}
