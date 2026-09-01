import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSRequestOptions } from '@/hooks/useReverieWS';

// The companion persona picks the move; the local rules engine owns legality.
// Contract: one illegal move gets a clarification retry; after a second
// failure, an RPC error, or a timeout the heuristic bot plays and the panel
// says so — a companion game must never stall.
export type OpponentMode = 'companion' | 'practice';

export interface CompanionMoveClient {
  request<T = unknown>(
    type: string,
    payload: unknown,
    options: WSRequestOptions,
  ): Promise<T>;
}

export interface CompanionMoveInput {
  boardText: string;
  side: string;
  historyText?: string;
  /** Validate + apply the model's raw move string. null = applied; otherwise a human-readable legality note. */
  apply: (rawMove: string) => string | null;
  /** Heuristic fallback move (practice mode / companion unavailable / illegal twice). */
  fallback: () => void;
  /** False when the board that prompted this request has been replaced or reset. */
  isCurrent?: () => boolean;
}

interface GameMoveResult {
  ok?: boolean;
  move?: string;
  comment?: string;
  error?: string;
}

export type CompanionMoveOutcome =
  | { kind: 'companion'; comment: string }
  | { kind: 'fallback'; notice: string }
  | { kind: 'cancelled' };

export async function requestCompanionMove(
  game: string,
  client: CompanionMoveClient,
  input: CompanionMoveInput,
  isCurrent: () => boolean = () => true,
): Promise<CompanionMoveOutcome> {
  const current = () => isCurrent() && (input.isCurrent?.() ?? true);
  const state: Record<string, unknown> = {
    board_text: input.boardText,
    side: input.side,
    ...(input.historyText ? { history_text: input.historyText } : {}),
  };
  let retryNote = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: GameMoveResult;
    try {
      result = await client.request<GameMoveResult>(
        'game:move',
        { game, state, ...(retryNote ? { retry_note: retryNote } : {}) },
        { expectedType: 'game:move:result', timeout: 28_000 },
      );
    } catch {
      if (!current()) return { kind: 'cancelled' };
      input.fallback();
      return { kind: 'fallback', notice: '她暂时连不上，这一步由陪练代走。' };
    }
    if (!current()) return { kind: 'cancelled' };
    if (!result?.ok || typeof result.move !== 'string') {
      input.fallback();
      return { kind: 'fallback', notice: '她暂时不能走子，这一步由陪练代走。' };
    }
    const legality = input.apply(result.move);
    if (legality === null) {
      return { kind: 'companion', comment: result.comment ? `她说：${result.comment}` : '' };
    }
    if (attempt === 0) {
      retryNote = legality;
      continue;
    }
    input.fallback();
    return { kind: 'fallback', notice: '她的走法不合法，这一步由陪练代走。' };
  }
  return { kind: 'cancelled' };
}

export function useCompanionOpponent(
  game: string,
  client: CompanionMoveClient | null,
  connected: boolean,
) {
  const [mode, setMode] = useState<OpponentMode>('companion');
  const [comment, setComment] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const requestGenerationRef = useRef(0);

  const cancelPending = useCallback(() => {
    requestGenerationRef.current += 1;
    busyRef.current = false;
  }, []);

  useEffect(() => cancelPending, [cancelPending, client, connected, game, mode]);

  const chooseMove = useCallback(async (input: CompanionMoveInput) => {
    if (busyRef.current) return;
    if (mode !== 'companion' || !client || !connected) {
      input.fallback();
      return;
    }
    busyRef.current = true;
    const generation = ++requestGenerationRef.current;
    try {
      const outcome = await requestCompanionMove(
        game,
        client,
        input,
        () => requestGenerationRef.current === generation,
      );
      if (requestGenerationRef.current !== generation || outcome.kind === 'cancelled') return;
      if (outcome.kind === 'companion') {
        setNotice('');
        setComment(outcome.comment);
      } else {
        setComment('');
        setNotice(outcome.notice);
      }
    } finally {
      if (requestGenerationRef.current === generation) busyRef.current = false;
    }
  }, [client, connected, game, mode]);

  return { mode, setMode, comment, notice, chooseMove, cancelPending };
}
