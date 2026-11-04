/** Canonical, epoch-bound Xiangqi state; no optimistic or browser fact source. */
import { WSMsgType, type WSRequestOptions } from '@/hooks/useReverieWS';
import type { ArchivePersonaProof } from '@/lib/archiveOperationScope';
import { replayXiangqi, type XiangqiMove } from './xiangqiEngine';
export interface XiangqiClient { request<T = unknown>(type: string, payload: unknown, options: WSRequestOptions): Promise<T> }
export interface XiangqiSnapshot { moves: ReadonlyArray<XiangqiMove>; revision: number; status: 'disconnected' | 'loading' | 'ready' | 'saving' | 'invalid' | 'failed'; notice: string; generation: number }
export class XiangqiState {
  private disposed = false;
  private lifecycle = 0;
  private listeners = new Set<() => void>();
  private snapshot: XiangqiSnapshot;
  constructor(private client: XiangqiClient, readonly proof: Readonly<ArchivePersonaProof> | null, connected: boolean) {
    this.snapshot = { moves: [], revision: 0, status: connected && proof ? 'loading' : 'disconnected', notice: '', generation: 0 };
  }
  activate() { this.disposed = false; this.lifecycle++; }
  private current(lifecycle: number) { return !this.disposed && lifecycle === this.lifecycle; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Omit<XiangqiSnapshot, 'generation'>) {
    if (this.disposed) return;
    this.snapshot = { ...next, generation: this.snapshot.generation + 1 };
    for (const listener of this.listeners) listener();
  }
  private request(type: string, payload: unknown) {
    if (this.disposed || !this.proof) return Promise.reject(new Error('Stale Xiangqi scope'));
    return this.client.request<Record<string, unknown>>(type, payload, { expectedType: WSMsgType.GAME_STATE_RESULT, timeout: 8000, personaScope: this.proof });
  }
  private accept(value: Record<string, unknown>, notice = '') {
    if (this.disposed) return;
    const revision = value.revision;
    if (value.ok !== true || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Game state unavailable');
    const replay = replayXiangqi(value.state);
    if (!replay.valid) {
      this.publish({ moves: [], revision, status: 'invalid', notice: `保存棋谱无法完整重放（第 ${replay.index + 1} 步）；原记录保留。请显式重置后开始新局。` });
      return;
    }
    this.publish({ moves: Object.freeze((value.state as XiangqiMove[]).map(m => Object.freeze({ ...m }))), revision, status: 'ready', notice });
  }
  async load(): Promise<void> {
    if (this.disposed || !this.proof || this.snapshot.status === 'disconnected') return;
    const lifecycle = this.lifecycle;
    this.publish({ ...this.snapshot, status: 'loading', notice: '' });
    try {
      const value = await this.request(WSMsgType.GAME_STATE_GET, { game_id: 'xiangqi' });
      if (!this.current(lifecycle)) return;
      if (value.ok !== true || typeof value.exists !== 'boolean') throw new Error('Game state unavailable');
      if (value.exists === true) this.accept(value);
      else {
        // A genuinely missing canonical row may start an empty game. Legacy
        // browser records are left untouched; this stage performs no migration.
        const created = await this.request(WSMsgType.GAME_STATE_PUT, { game_id: 'xiangqi', state: [], expected_revision: 0 });
        if (!this.current(lifecycle)) return;
        if (created.code === 'conflict') this.accept({ ...created, ok: true }, '棋谱已由另一操作保存，已读取当前版本。');
        else this.accept(created);
      }
    } catch {
      if (!this.current(lifecycle)) return;
      this.publish({ ...this.snapshot, status: 'failed', notice: '棋谱读取失败，原记录未更改。请重新读取后继续。' });
    }
  }
  submit(moves: ReadonlyArray<XiangqiMove>, explicitReset = false): boolean {
    if (this.disposed || !this.proof || (this.snapshot.status !== 'ready' && !(explicitReset && this.snapshot.status === 'invalid'))) return false;
    if (!replayXiangqi(moves).valid || explicitReset && moves.length !== 0) return false;
    const revision = this.snapshot.revision;
    this.publish({ ...this.snapshot, status: 'saving', notice: '' });
    void this.save(moves, revision, this.lifecycle);
    return true;
  }
  private async save(moves: ReadonlyArray<XiangqiMove>, revision: number, lifecycle: number) {
    try {
      const value = await this.request(WSMsgType.GAME_STATE_PUT, { game_id: 'xiangqi', state: moves, expected_revision: revision });
      if (!this.current(lifecycle)) return;
      if (value.code === 'conflict') this.accept({ ...value, ok: true }, '保存版本冲突，旧操作已取消，已读取当前棋谱。');
      else this.accept(value);
    } catch {
      if (!this.current(lifecycle)) return;
      this.publish({ ...this.snapshot, status: 'failed', notice: '棋谱保存结果未确认。请重新读取；不会自动重复提交。' });
    }
  }
  dispose() { this.disposed = true; this.lifecycle++; this.listeners.clear(); }
}
