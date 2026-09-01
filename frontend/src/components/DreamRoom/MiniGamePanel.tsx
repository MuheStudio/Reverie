import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { Chess, type Move as ChessMove, type Square } from 'chess.js';
import GoBoard, { type Sign, type Vertex } from '@sabaki/go-board';
import { Xiangqi } from 'elephantops/xiangqi';
import { squareFromCoords } from 'elephantops/util';
import type { Move as XiangqiMove, Role, Square as XiangqiSquare } from 'elephantops/types';
import { Engine, type TetrisState } from 'tetris-engine';
import type { PhoneAppPanelId } from './roomState';
import { WSMsgType, type WSRequestOptions } from '@/hooks/useReverieWS';
import { useCompanionOpponent, type OpponentMode } from './useCompanionOpponent';
import {
  GOMOKU_SIZE,
  chooseGomokuMove,
  newGomokuState,
  newSnakeState,
  playGomoku,
  queueSnakeDirection,
  scoreChineseArea,
  snakeDirectionFromKey,
  tickSnake,
  toggleSnake,
  undoGomokuRound,
  type GomokuState,
  type SnakeDirection,
} from './gameEngines';
import styles from './MiniGamePanel.module.scss';

interface MiniGamePanelProps {
  game: PhoneAppPanelId;
  connected: boolean;
  gameStateClient: {
    request<T = unknown>(
      type: string,
      payload: unknown,
      options: WSRequestOptions,
    ): Promise<T>;
  };
  onInviteAI: (game: PhoneAppPanelId, stateLine?: string) => void;
}

const TITLES: Partial<Record<PhoneAppPanelId, string>> = {
  tetris: '俄罗斯方块',
  snake: '贪吃蛇',
  gomoku: '五子棋',
  chess: '国际象棋',
  xiangqi: '中国象棋',
  go: '围棋',
};

function readLegacyGameState<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null');
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function clearLegacyGameState(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // The retired browser state remains inert after backend migration.
  }
}

function useAuthoritativeGameState<T>(
  client: MiniGamePanelProps['gameStateClient'],
  connected: boolean,
  gameId: string,
  legacyKey: string,
  fallback: () => T,
  valid: (value: unknown) => value is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(fallback);
  const revisionRef = useRef(0);
  const hydratedRef = useRef(false);
  const writeRunningRef = useRef(false);
  const pendingRef = useRef<T | null>(null);
  const committedJsonRef = useRef('');
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const validRef = useRef(valid);
  const fallbackRef = useRef(fallback);
  validRef.current = valid;
  fallbackRef.current = fallback;
  const request = client.request;

  const flush = useCallback(async () => {
    if (writeRunningRef.current || !hydratedRef.current) return;
    writeRunningRef.current = true;
    let inFlight: T | null = null;
    try {
      while (pendingRef.current !== null) {
        const desired = pendingRef.current;
        pendingRef.current = null;
        inFlight = desired;
        const response = await request<Record<string, unknown>>(
          WSMsgType.GAME_STATE_PUT,
          {
            game_id: gameId,
            state: desired,
            expected_revision: revisionRef.current,
          },
          { expectedType: WSMsgType.GAME_STATE_RESULT, timeout: 8_000 },
        );
        if (response.ok !== true) {
          if (response.code === 'conflict' && validRef.current(response.state)) {
            revisionRef.current = Number(response.revision) || 0;
            committedJsonRef.current = JSON.stringify(response.state);
            setState(response.state);
          } else {
            pendingRef.current ??= desired;
          }
          break;
        }
        revisionRef.current = Number(response.revision) || revisionRef.current;
        committedJsonRef.current = JSON.stringify(desired);
        inFlight = null;
      }
    } catch {
      // The game keeps running in memory. Module health exposes persistence
      // failure without promoting renderer state to a second fact source.
      if (inFlight !== null) pendingRef.current ??= inFlight;
    } finally {
      writeRunningRef.current = false;
      if (
        pendingRef.current !== null
        && hydratedRef.current
        && retryTimerRef.current === null
      ) {
        // Exponential backoff with a hard stop: a persistently failing
        // backend must not spin an endless poll; the next user interaction
        // resets the delay and re-arms a flush.
        const failures = retryCountRef.current;
        if (failures >= 5) {
          retryCountRef.current = 0;
          return;
        }
        retryCountRef.current += 1;
        const delay = Math.min(1500 * (2 ** failures), 30_000);
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          void flushRef.current();
        }, delay);
      }
    }
  }, [gameId, request]);
  flushRef.current = flush;

  useEffect(() => {
    let disposed = false;
    hydratedRef.current = false;
    pendingRef.current = null;
    committedJsonRef.current = '';
    if (!connected) return undefined;
    const hydrate = async () => {
      try {
        let response = await request<Record<string, unknown>>(
          WSMsgType.GAME_STATE_GET,
          { game_id: gameId },
          { expectedType: WSMsgType.GAME_STATE_RESULT, timeout: 8_000 },
        );
        if (response.ok !== true) return;
        let loaded: T;
        if (response.exists === true && validRef.current(response.state)) {
          loaded = response.state;
        } else {
          const legacy = readLegacyGameState(legacyKey, validRef.current);
          loaded = legacy ?? fallbackRef.current();
          response = await request<Record<string, unknown>>(
            WSMsgType.GAME_STATE_PUT,
            { game_id: gameId, state: loaded, expected_revision: 0 },
            { expectedType: WSMsgType.GAME_STATE_RESULT, timeout: 8_000 },
          );
          if (response.ok !== true) return;
          if (legacy !== null) clearLegacyGameState(legacyKey);
        }
        if (disposed) return;
        revisionRef.current = Number(response.revision) || 0;
        committedJsonRef.current = JSON.stringify(loaded);
        hydratedRef.current = true;
        setState(loaded);
      } catch {
        // Optional persistence is isolated; gameplay remains available.
      }
    };
    void hydrate();
    return () => {
      disposed = true;
      hydratedRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryCountRef.current = 0;
    };
  }, [connected, gameId, legacyKey, request]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const serialized = JSON.stringify(state);
    if (serialized === committedJsonRef.current) return;
    pendingRef.current = state;
    retryCountRef.current = 0;
    void flush();
  }, [flush, state]);

  return [state, setState];
}

function isGomokuState(value: unknown): value is GomokuState {
  const item = value as GomokuState;
  return Boolean(
    item
    && Array.isArray(item.board)
    && item.board.length === 225
    && Array.isArray(item.moves),
  );
}

function isStoredXiangqiMoves(value: unknown): value is StoredXiangqiMove[] {
  return Array.isArray(value)
    && value.length <= 1000
    && value.every((move) => Number.isInteger(move?.from) && Number.isInteger(move?.to));
}

function isNonNegativeScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function GameHeader({
  game,
  status,
  connected,
  onInvite,
  onUndo,
  onReset,
  companionBar,
}: {
  game: PhoneAppPanelId;
  status: string;
  connected: boolean;
  onInvite?: () => void;
  onUndo?: () => void;
  onReset: () => void;
  companionBar?: React.ReactNode;
}) {
  return (
    <div className={styles.header}>
      <div className={styles.heading}>
        <strong>{TITLES[game]}</strong>
        <span>{status}</span>
      </div>
      <div className={styles.headerActions}>
        {onInvite && (
          <button type="button" title="邀请她聊聊这局" disabled={!connected} onClick={onInvite}>
            <Sparkles size={16} />
          </button>
        )}
        {onUndo && (
          <button type="button" title="悔棋" onClick={onUndo}>
            <Undo2 size={16} />
          </button>
        )}
        <button type="button" title="重新开始" onClick={onReset}>
          <RefreshCw size={16} />
        </button>
      </div>
      {companionBar}
    </div>
  );
}

// Header line under a game: AI-companion / practice toggle plus the
// persona's one-line comment (aria-live so screen readers hear the quip).
function CompanionBar({
  mode,
  onToggle,
  comment,
  notice,
}: {
  mode: OpponentMode;
  onToggle: () => void;
  comment: string;
  notice: string;
}) {
  return (
    <div className={styles.companionBar} aria-live="polite">
      <button
        type="button"
        data-mode={mode}
        onClick={onToggle}
        title={mode === 'companion' ? '切到练习模式（内置陪练）' : '切到 AI 陪玩（她来走子）'}
      >
        {mode === 'companion' ? 'AI 陪玩' : '练习模式'}
      </button>
      {(comment || notice) && <span>{comment || notice}</span>}
    </div>
  );
}

function GomokuGame({ connected, gameStateClient, onInviteAI }: Omit<MiniGamePanelProps, 'game'>) {
  const [state, setState] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'gomoku',
    'reverie:game:gomoku:v2',
    newGomokuState,
    isGomokuState,
  );
  const [thinking, setThinking] = useState(false);
  const opponent = useCompanionOpponent('gomoku', gameStateClient, connected);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.turn !== 2 || state.winner || state.draw) return;
    let cancelled = false;
    setThinking(true);
    const timer = window.setTimeout(() => {
      const requestedState = stateRef.current;
      const boardText = Array.from({ length: GOMOKU_SIZE }, (_, row) => (
        Array.from({ length: GOMOKU_SIZE }, (_, col) => {
          const cell = stateRef.current.board[row * GOMOKU_SIZE + col];
          return cell === 1 ? '△' : cell === 2 ? '▲' : '·';
        }).join(' ')
      )).join('\n');
      void opponent.chooseMove({
        boardText,
        side: '白棋',
        historyText: `共 ${stateRef.current.moves.length} 手`,
        isCurrent: () => stateRef.current === requestedState,
        apply: (rawMove) => {
          const index = Number(rawMove.trim());
          const current = stateRef.current;
          if (!Number.isInteger(index) || index < 0 || index >= current.board.length) {
            return '格子编号超出棋盘';
          }
          if (current.board[index]) return '那个位置已经有棋子';
          setState(playGomoku(current, index));
          return null;
        },
        fallback: () => {
          setState((current) => {
            const move = chooseGomokuMove(current);
            return move === null ? current : playGomoku(current, move);
          });
        },
      }).finally(() => {
        if (!cancelled) setThinking(false);
      });
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.turn, state.winner, state.draw]);

  const status = state.winner === 1
    ? '你赢了'
    : state.winner === 2
      ? '对手获胜'
      : state.draw
        ? '和棋'
        : thinking
          ? '对手思考中'
          : '轮到你落黑子';
  return (
    <div className={styles.gameRoot}>
      <GameHeader
        game="gomoku"
        status={status}
        connected={connected}
        onInvite={() => onInviteAI('gomoku', `五子棋已下 ${state.moves.length} 手，${status}。`)}
        onUndo={state.moves.length ? () => { opponent.cancelPending(); setThinking(false); setState(undoGomokuRound(state)); } : undefined}
        onReset={() => { opponent.cancelPending(); setThinking(false); setState(newGomokuState()); }}
        companionBar={(
          <CompanionBar
            mode={opponent.mode}
            onToggle={() => opponent.setMode(opponent.mode === 'companion' ? 'practice' : 'companion')}
            comment={opponent.comment}
            notice={opponent.notice}
          />
        )}
      />
      <div className={styles.gomokuBoard} role="grid" aria-label="五子棋棋盘">
        {state.board.map((cell, index) => (
          <button
            type="button"
            role="gridcell"
            key={index}
            className={state.moves[state.moves.length - 1] === index ? styles.lastMove : undefined}
            disabled={thinking || state.turn !== 1 || Boolean(state.winner) || state.draw || Boolean(cell)}
            aria-label={`${Math.floor(index / GOMOKU_SIZE) + 1} 行 ${index % GOMOKU_SIZE + 1} 列`}
            onClick={() => setState((current) => playGomoku(current, index))}
          >
            {cell ? <span className={cell === 1 ? styles.blackStone : styles.whiteStone} /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function chessFromPgn(pgn: string): Chess {
  const chess = new Chess();
  if (pgn) {
    try { chess.loadPgn(pgn); } catch { return new Chess(); }
  }
  return chess;
}

const CHESS_PIECES: Record<string, string> = {
  wp: '♙', wn: '♘', wb: '♗', wr: '♖', wq: '♕', wk: '♔',
  bp: '♟', bn: '♞', bb: '♝', br: '♜', bq: '♛', bk: '♚',
};
const CHESS_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

function chooseChessMove(chess: Chess): ChessMove | null {
  const moves = chess.moves({ verbose: true });
  let best: ChessMove | null = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const probe = new Chess(chess.fen());
    probe.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
    const score = (move.captured ? CHESS_VALUE[move.captured] * 20 : 0)
      + (probe.isCheckmate() ? 10_000 : probe.isCheck() ? 4 : 0)
      + Math.random() * 2;
    if (score > bestScore) { best = move; bestScore = score; }
  }
  return best;
}

function ChessGame({ connected, gameStateClient, onInviteAI }: Omit<MiniGamePanelProps, 'game'>) {
  const [pgn, setPgn] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'chess',
    'reverie:game:chess:v2',
    () => '',
    (value): value is string => typeof value === 'string' && value.length <= 200_000,
  );
  const [selected, setSelected] = useState<Square | null>(null);
  const [thinking, setThinking] = useState(false);
  const chess = useMemo(() => chessFromPgn(pgn), [pgn]);
  const targets = useMemo(() => selected
    ? chess.moves({ square: selected, verbose: true }).map((move) => move.to)
    : [], [chess, selected]);
  const opponent = useCompanionOpponent('chess', gameStateClient, connected);
  const chessRef = useRef(chess);
  chessRef.current = chess;

  useEffect(() => {
    if (chess.turn() !== 'b' || chess.isGameOver()) return;
    let cancelled = false;
    setThinking(true);
    const timer = window.setTimeout(() => {
      const requestedPgn = pgn;
      void opponent.chooseMove({
        boardText: chessRef.current.ascii(),
        side: '黑棋',
        historyText: chessRef.current.history().join(' ') || '（开局第一步）',
        isCurrent: () => chessRef.current.pgn() === requestedPgn,
        apply: (rawMove) => {
          const next = chessFromPgn(pgn);
          try {
            next.move(rawMove.trim());
          } catch {
            return '这不是一步合法的走法';
          }
          setPgn(next.pgn());
          return null;
        },
        fallback: () => {
          setPgn((current) => {
            const board = chessFromPgn(current);
            const move = chooseChessMove(board);
            if (move) board.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
            return board.pgn();
          });
        },
      }).finally(() => {
        if (!cancelled) setThinking(false);
      });
    }, 360);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chess]);

  const status = chess.isCheckmate()
    ? chess.turn() === 'w' ? '你被将死了' : '你获胜了'
    : chess.isDraw() ? '和棋'
      : thinking ? '对手思考中'
        : chess.isCheck() ? '将军，轮到你' : '轮到你走白棋';

  const clickSquare = (square: Square) => {
    if (thinking || chess.turn() !== 'w' || chess.isGameOver()) return;
    if (selected && targets.includes(square)) {
      const next = chessFromPgn(pgn);
      next.move({ from: selected, to: square, promotion: 'q' });
      setPgn(next.pgn());
      setSelected(null);
      return;
    }
    const piece = chess.get(square);
    setSelected(piece?.color === 'w' ? square : null);
  };
  const undo = () => {
    opponent.cancelPending();
    setThinking(false);
    const next = chessFromPgn(pgn);
    next.undo();
    next.undo();
    setPgn(next.pgn());
    setSelected(null);
  };

  return (
    <div className={styles.gameRoot}>
      <GameHeader
        game="chess"
        status={status}
        connected={connected}
        onInvite={() => onInviteAI('chess', `国际象棋共 ${chess.history().length} 手，${status}。PGN：${pgn.slice(-600)}`)}
        onUndo={chess.history().length ? undo : undefined}
        onReset={() => { opponent.cancelPending(); setThinking(false); setPgn(''); setSelected(null); }}
        companionBar={(
          <CompanionBar
            mode={opponent.mode}
            onToggle={() => opponent.setMode(opponent.mode === 'companion' ? 'practice' : 'companion')}
            comment={opponent.comment}
            notice={opponent.notice}
          />
        )}
      />
      <div className={styles.chessBoard} role="grid" aria-label="国际象棋棋盘">
        {Array.from({ length: 64 }, (_, index) => {
          const row = Math.floor(index / 8);
          const col = index % 8;
          const square = `${'abcdefgh'[col]}${8 - row}` as Square;
          const piece = chess.get(square);
          const selectedClass = selected === square ? styles.selected : '';
          const targetClass = targets.includes(square) ? styles.legalTarget : '';
          return (
            <button
              type="button"
              role="gridcell"
              key={square}
              className={`${selectedClass} ${targetClass}`}
              data-dark={(row + col) % 2 === 1}
              aria-label={square}
              onClick={() => clickSquare(square)}
            >
              {piece ? CHESS_PIECES[`${piece.color}${piece.type}`] : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface StoredXiangqiMove { from: number; to: number }

function xiangqiFromMoves(moves: StoredXiangqiMove[]): Xiangqi {
  const position = Xiangqi.default();
  for (const move of moves) {
    if (!position.isLegal(move)) break;
    position.play(move);
  }
  return position;
}

const XIANGQI_LABELS: Record<`red:${Role}` | `black:${Role}`, string> = {
  'red:king': '帅', 'red:advisor': '仕', 'red:elephant': '相', 'red:horse': '马',
  'red:chariot': '车', 'red:cannon': '炮', 'red:pawn': '兵',
  'black:king': '将', 'black:advisor': '士', 'black:elephant': '象', 'black:horse': '马',
  'black:chariot': '车', 'black:cannon': '炮', 'black:pawn': '卒',
};
const XIANGQI_VALUE: Record<Role, number> = {
  king: 1000, chariot: 90, cannon: 45, horse: 40, elephant: 20, advisor: 20, pawn: 10,
};

function chooseXiangqiMove(position: Xiangqi): XiangqiMove | null {
  let best: XiangqiMove | null = null;
  let bestScore = -Infinity;
  for (const [from, destinations] of position.allDests()) {
    for (const to of destinations) {
      const captured = position.board.get(to);
      const probe = position.clone();
      probe.play({ from, to });
      const score = (captured ? XIANGQI_VALUE[captured.role] * 10 : 0)
        + (probe.isCheckmate() ? 100_000 : probe.isCheck() ? 20 : 0)
        + Math.random() * 5;
      if (score > bestScore) { best = { from, to }; bestScore = score; }
    }
  }
  return best;
}

function XiangqiGame({ connected, gameStateClient, onInviteAI }: Omit<MiniGamePanelProps, 'game'>) {
  const [moves, setMoves] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'xiangqi',
    'reverie:game:xiangqi:v2',
    () => [] as StoredXiangqiMove[],
    isStoredXiangqiMoves,
  );
  const [selected, setSelected] = useState<XiangqiSquare | null>(null);
  const [thinking, setThinking] = useState(false);
  const position = useMemo(() => xiangqiFromMoves(moves), [moves]);
  const targets = useMemo(() => selected === null ? [] : [...position.dests(selected)], [position, selected]);
  const opponent = useCompanionOpponent('xiangqi', gameStateClient, connected);
  const positionRef = useRef(position);
  positionRef.current = position;

  useEffect(() => {
    if (position.turn !== 'black' || position.isEnd()) return;
    let cancelled = false;
    setThinking(true);
    const timer = window.setTimeout(() => {
      const requestedPosition = positionRef.current;
      const boardText = Array.from({ length: 10 }, (_, row) => (
        Array.from({ length: 9 }, (_, col) => {
          const square = squareFromCoords(col, 9 - row)!;
          const piece = positionRef.current.board.get(square);
          if (!piece) return '·';
          return piece.color === 'red' ? '△' : '▲';
        }).join(' ')
      )).join('\n');
      void opponent.chooseMove({
        boardText,
        side: '黑棋',
        historyText: `${moves.length} 手`,
        isCurrent: () => positionRef.current === requestedPosition,
        apply: (rawMove) => {
          const parts = rawMove.trim().split(/[，,\s]+/).map((value) => Number(value));
          if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) {
            return '走法需要四个整数坐标';
          }
          const [fx, fy, tx, ty] = parts;
          if ([fx, fy, tx, ty].some((value) => value < 0 || value > 9)) {
            return '坐标超出棋盘';
          }
          const from = squareFromCoords(fx, fy);
          const to = squareFromCoords(tx, ty);
          const current = positionRef.current;
          if (!from || !to || !current.isLegal({ from, to })) {
            return '这不是一步合法的走法';
          }
          setMoves((currentMoves) => [...currentMoves, { from, to }]);
          return null;
        },
        fallback: () => {
          setMoves((current) => {
            const currentPosition = xiangqiFromMoves(current);
            const move = chooseXiangqiMove(currentPosition);
            return move ? [...current, move] : current;
          });
        },
      }).finally(() => {
        if (!cancelled) setThinking(false);
      });
    }, 380);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position]);

  const outcome = position.outcome();
  const status = outcome
    ? outcome.winner === 'red' ? '你获胜了' : outcome.winner === 'black' ? '对手获胜' : '和棋'
    : thinking ? '对手思考中'
      : position.isCheck() ? '将军，轮到你' : '轮到红方';
  const clickSquare = (square: XiangqiSquare) => {
    if (thinking || position.turn !== 'red' || position.isEnd()) return;
    if (selected !== null && targets.includes(square)) {
      setMoves((current) => [...current, { from: selected, to: square }]);
      setSelected(null);
      return;
    }
    setSelected(position.board.get(square)?.color === 'red' ? square : null);
  };

  return (
    <div className={styles.gameRoot}>
      <GameHeader
        game="xiangqi"
        status={status}
        connected={connected}
        onInvite={() => onInviteAI('xiangqi', `中国象棋共 ${moves.length} 手，${status}。`)}
        onUndo={moves.length ? () => { opponent.cancelPending(); setThinking(false); setMoves(moves.slice(0, -Math.min(2, moves.length))); setSelected(null); } : undefined}
        onReset={() => { opponent.cancelPending(); setThinking(false); setMoves([]); setSelected(null); }}
        companionBar={(
          <CompanionBar
            mode={opponent.mode}
            onToggle={() => opponent.setMode(opponent.mode === 'companion' ? 'practice' : 'companion')}
            comment={opponent.comment}
            notice={opponent.notice}
          />
        )}
      />
      <div className={styles.xiangqiBoard} role="grid" aria-label="中国象棋棋盘">
        {Array.from({ length: 90 }, (_, index) => {
          const row = Math.floor(index / 9);
          const col = index % 9;
          const square = squareFromCoords(col, 9 - row)!;
          const piece = position.board.get(square);
          return (
            <button
              type="button"
              role="gridcell"
              key={square}
              className={`${selected === square ? styles.selected : ''} ${targets.includes(square) ? styles.legalTarget : ''}`}
              data-river={row === 4}
              aria-label={`${row + 1} 行 ${col + 1} 列`}
              onClick={() => clickSquare(square)}
            >
              {piece && (
                <span data-color={piece.color}>{XIANGQI_LABELS[`${piece.color}:${piece.role}`]}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface GoMove { sign: Sign; vertex: Vertex | null }
interface StoredGoState { moves: GoMove[]; ended: boolean }

function isStoredGoState(value: unknown): value is StoredGoState {
  const state = value as StoredGoState;
  return Boolean(
    state
    && typeof state.ended === 'boolean'
    && Array.isArray(state.moves)
    && state.moves.length <= 500
    && state.moves.every((move, index) => {
      if (!move || move.sign !== (index % 2 === 0 ? 1 : -1)) return false;
      return move.vertex === null || (
        Array.isArray(move.vertex)
        && move.vertex.length === 2
        && move.vertex.every((coordinate) => Number.isInteger(coordinate) && coordinate >= 0 && coordinate < 9)
      );
    })
  );
}

function goFromMoves(moves: GoMove[]): GoBoard {
  let board = GoBoard.fromDimensions(9);
  for (const move of moves) {
    if (!move.vertex) continue;
    try {
      board = board.makeMove(move.sign, move.vertex, {
        preventKo: true, preventOverwrite: true, preventSuicide: true,
      });
    } catch { break; }
  }
  return board;
}

function chooseGoMove(board: GoBoard, sign: Sign): Vertex | null {
  let best: Vertex | null = null;
  let bestScore = -Infinity;
  for (let y = 0; y < board.height; y += 1) {
    for (let x = 0; x < board.width; x += 1) {
      try {
        const before = board.getCaptures(sign);
        const probe = board.makeMove(sign, [x, y], {
          preventKo: true, preventOverwrite: true, preventSuicide: true,
        });
        const captures = probe.getCaptures(sign) - before;
        const neighbors = probe.getNeighbors([x, y]).filter((vertex) => probe.get(vertex) !== 0).length;
        const center = 8 - Math.abs(x - 4) - Math.abs(y - 4);
        const score = captures * 100 + neighbors * 3 + center + Math.random() * 4;
        if (score > bestScore) { best = [x, y]; bestScore = score; }
      } catch {
        // Illegal by overwrite, suicide, or ko.
      }
    }
  }
  return best;
}

function GoGame({ connected, gameStateClient, onInviteAI }: Omit<MiniGamePanelProps, 'game'>) {
  const [stored, setStored] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'go',
    'reverie:game:go:v2',
    () => ({ moves: [], ended: false }),
    isStoredGoState,
  );
  const [thinking, setThinking] = useState(false);
  const board = useMemo(() => goFromMoves(stored.moves), [stored.moves]);
  const turn: Sign = stored.moves.length % 2 === 0 ? 1 : -1;
  const consecutivePasses = stored.moves.slice(-2).filter((move) => move.vertex === null).length;
  const ended = stored.ended || consecutivePasses === 2;
  const score = useMemo(() => ended ? scoreChineseArea(board.signMap) : null, [board, ended]);
  const opponent = useCompanionOpponent('go', gameStateClient, connected);
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => {
    if (turn !== -1 || ended) return;
    let cancelled = false;
    setThinking(true);
    const timer = window.setTimeout(() => {
      const requestedBoard = boardRef.current;
      const boardText = boardRef.current.signMap
        .map((row) => row.map((sign) => (sign === 1 ? '△' : sign === -1 ? '▲' : '·')).join(' '))
        .join('\n');
      void opponent.chooseMove({
        boardText,
        side: '白棋',
        historyText: `共 ${stored.moves.length} 手；黑提子 ${boardRef.current.getCaptures(1)}，白提子 ${boardRef.current.getCaptures(-1)}`,
        isCurrent: () => boardRef.current === requestedBoard,
        apply: (rawMove) => {
          const current = boardRef.current;
          const text = rawMove.trim().toLowerCase();
          if (text === 'pass' || text === '停一手') {
            setStored((storedCurrent) => ({ ...storedCurrent, moves: [...storedCurrent.moves, { sign: -1, vertex: null }] }));
            return null;
          }
          const parts = text.split(/[，,\s]+/).map((value) => Number(value));
          if (parts.length !== 2 || !parts.every((value) => Number.isInteger(value) && value >= 0 && value <= 8)) {
            return '走法需要 x,y 两个 0-8 的整数，或 pass';
          }
          try {
            current.makeMove(-1, [parts[0], parts[1]], {
              preventKo: true, preventOverwrite: true, preventSuicide: true,
            });
          } catch {
            return '这步棋因打劫、自杀或已有棋子而不合法';
          }
          setStored((storedCurrent) => ({ ...storedCurrent, moves: [...storedCurrent.moves, { sign: -1, vertex: [parts[0], parts[1]] }] }));
          return null;
        },
        fallback: () => {
          setStored((current) => {
            const currentBoard = goFromMoves(current.moves);
            const vertex = chooseGoMove(currentBoard, -1);
            return { ...current, moves: [...current.moves, { sign: -1, vertex }] };
          });
        },
      }).finally(() => {
        if (!cancelled) setThinking(false);
      });
    }, 420);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn, ended]);

  const status = score
    ? score.black > score.white
      ? `黑方胜 ${Math.abs(score.black - score.white).toFixed(1)} 目`
      : `白方胜 ${Math.abs(score.white - score.black).toFixed(1)} 目`
    : thinking ? '白方思考中' : `轮到黑方 · 提子 ${board.getCaptures(1)}:${board.getCaptures(-1)}`;
  const play = (vertex: Vertex) => {
    if (turn !== 1 || ended || thinking) return;
    try {
      board.makeMove(1, vertex, { preventKo: true, preventOverwrite: true, preventSuicide: true });
    } catch { return; }
    setStored((current) => ({ ...current, moves: [...current.moves, { sign: 1, vertex }] }));
  };
  const pass = () => {
    if (turn !== 1 || ended || thinking) return;
    setStored((current) => ({ ...current, moves: [...current.moves, { sign: 1, vertex: null }] }));
  };

  return (
    <div className={styles.gameRoot}>
      <GameHeader
        game="go"
        status={status}
        connected={connected}
        onInvite={() => onInviteAI('go', `九路围棋已走 ${stored.moves.length} 手，${status}。`)}
        onUndo={stored.moves.length ? () => { opponent.cancelPending(); setThinking(false); setStored({ moves: stored.moves.slice(0, -Math.min(2, stored.moves.length)), ended: false }); } : undefined}
        onReset={() => { opponent.cancelPending(); setThinking(false); setStored({ moves: [], ended: false }); }}
        companionBar={(
          <CompanionBar
            mode={opponent.mode}
            onToggle={() => opponent.setMode(opponent.mode === 'companion' ? 'practice' : 'companion')}
            comment={opponent.comment}
            notice={opponent.notice}
          />
        )}
      />
      <div className={styles.goBoard} role="grid" aria-label="九路围棋棋盘">
        {board.signMap.flatMap((row, y) => row.map((sign, x) => (
          <button
            type="button"
            role="gridcell"
            key={`${x}-${y}`}
            aria-label={`${y + 1} 行 ${x + 1} 列`}
            onClick={() => play([x, y])}
          >
            {sign ? <span className={sign === 1 ? styles.blackStone : styles.whiteStone} /> : null}
          </button>
        )))}
      </div>
      <div className={styles.inlineActions}>
        <button type="button" disabled={turn !== 1 || ended} onClick={pass}>停一手</button>
        <button type="button" disabled={ended} onClick={() => setStored((current) => ({ ...current, ended: true }))}>结束并数目</button>
      </div>
    </div>
  );
}

function SnakeGame({
  connected,
  gameStateClient,
}: Pick<MiniGamePanelProps, 'connected' | 'gameStateClient'>) {
  const [state, setState] = useState(() => newSnakeState());
  const [highScore, setHighScore] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'snake-high-score',
    'reverie:game:snake:high',
    () => 0,
    isNonNegativeScore,
  );

  const direct = useCallback((direction: SnakeDirection) => {
    setState((current) => queueSnakeDirection(current, direction));
  }, []);
  useEffect(() => {
    if (state.status !== 'playing') return;
    const timer = window.setInterval(() => setState((current) => tickSnake(current)), 135);
    return () => window.clearInterval(timer);
  }, [state.status]);
  useEffect(() => {
    if (state.score <= highScore) return;
    setHighScore(state.score);
  }, [state.score, highScore]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      const direction = snakeDirectionFromKey(event.key);
      if (direction) { event.preventDefault(); direct(direction); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [direct]);

  const toggle = () => setState(toggleSnake);
  const status = state.status === 'over' ? '游戏结束' : state.status === 'paused' ? '已暂停' : `得分 ${state.score}`;
  return (
    <div className={styles.gameRoot}>
      <GameHeader game="snake" status={`${status} · 最高 ${highScore}`} connected={false} onReset={() => setState(newSnakeState())} />
      <div className={styles.snakeBoard} style={{ '--cols': state.width } as React.CSSProperties}>
        {Array.from({ length: state.width * state.height }, (_, index) => (
          <span
            key={index}
            data-snake={state.body.includes(index)}
            data-head={state.body[0] === index}
            data-food={state.food === index}
          />
        ))}
      </div>
      <div className={styles.dpad}>
        <button type="button" title="上" onClick={() => direct('up')}><ArrowUp size={18} /></button>
        <button type="button" title="左" onClick={() => direct('left')}><ArrowLeft size={18} /></button>
        <button type="button" title={state.status === 'playing' ? '暂停' : '开始'} onClick={toggle}>
          {state.status === 'playing' ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" title="右" onClick={() => direct('right')}><ArrowRight size={18} /></button>
        <button type="button" title="下" onClick={() => direct('down')}><ArrowDown size={18} /></button>
      </div>
    </div>
  );
}

const EMPTY_TETRIS_STATE: TetrisState = {
  gameStatus: 0,
  body: Array.from({ length: 20 }, () => Array.from({ length: 10 }, () => ({ val: 0, cssClasses: [] }))),
  shapeName: null,
  nextShape: { name: null, body: null },
  statistic: {
    countShapesFalled: 0, countLinesReduced: 0,
    countDoubleLinesReduced: 0, countTrippleLinesReduced: 0, countQuadrupleLinesReduced: 0,
  },
};

function TetrisGame({
  connected,
  gameStateClient,
}: Pick<MiniGamePanelProps, 'connected' | 'gameStateClient'>) {
  const engineRef = useRef<Engine | null>(null);
  const [state, setState] = useState<TetrisState>(EMPTY_TETRIS_STATE);
  const [highScore, setHighScore] = useAuthoritativeGameState(
    gameStateClient,
    connected,
    'tetris-high-score',
    'reverie:game:tetris:high',
    () => 0,
    isNonNegativeScore,
  );
  const score = state.statistic.countLinesReduced * 100 + state.statistic.countShapesFalled * 4;

  const reset = useCallback(() => {
    const engine = new Engine(10, 20, (next) => setState({ ...next }));
    engineRef.current = engine;
    engine.start();
    setState({ ...engine.state });
  }, []);
  useEffect(() => { reset(); }, [reset]);
  useEffect(() => {
    if (state.gameStatus !== 1) return;
    const speed = Math.max(180, 720 - state.statistic.countLinesReduced * 18);
    const timer = window.setInterval(() => engineRef.current?.moveDown(), speed);
    return () => window.clearInterval(timer);
  }, [state.gameStatus, state.statistic.countLinesReduced]);
  useEffect(() => {
    if (score <= highScore) return;
    setHighScore(score);
  }, [score, highScore]);

  const hardDrop = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const before = engine.state.statistic.countShapesFalled;
    while (engine.state.gameStatus === 1 && engine.state.statistic.countShapesFalled === before) {
      engine.moveDown();
    }
  }, []);
  const togglePause = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.state.gameStatus === 1) engine.pause();
    else if (engine.state.gameStatus === 2) engine.start();
    setState({ ...engine.state });
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const engine = engineRef.current;
      if (!engine) return;
      if (event.key === 'ArrowLeft') engine.moveLeft();
      else if (event.key === 'ArrowRight') engine.moveRight();
      else if (event.key === 'ArrowDown') engine.moveDown();
      else if (event.key === 'ArrowUp') engine.rotate();
      else if (event.key === ' ') hardDrop();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hardDrop]);

  const status = state.gameStatus === 3 ? '游戏结束' : state.gameStatus === 2 ? '已暂停' : `得分 ${score}`;
  return (
    <div className={styles.gameRoot}>
      <GameHeader game="tetris" status={`${status} · 最高 ${highScore}`} connected={false} onReset={reset} />
      <div className={styles.tetrisBoard}>
        {state.body.flatMap((row, y) => row.map((cell, x) => (
          <span
            key={`${x}-${y}`}
            data-value={cell.val}
            data-shape={cell.cssClasses.filter(Boolean).slice(-1)[0] || ''}
          />
        )))}
      </div>
      <div className={styles.tetrisControls}>
        <button type="button" title="左移" onClick={() => engineRef.current?.moveLeft()}><ArrowLeft size={18} /></button>
        <button type="button" title="旋转" onClick={() => engineRef.current?.rotate()}><RotateCw size={18} /></button>
        <button type="button" title="右移" onClick={() => engineRef.current?.moveRight()}><ArrowRight size={18} /></button>
        <button type="button" title="加速下落" onClick={() => engineRef.current?.moveDown()}><ArrowDown size={18} /></button>
        <button type="button" title="直接落底" onClick={hardDrop}><ArrowDown size={18} /><ArrowDown size={18} /></button>
        <button type="button" title={state.gameStatus === 2 ? '继续' : '暂停'} onClick={togglePause}>
          {state.gameStatus === 2 ? <Play size={18} /> : <Pause size={18} />}
        </button>
      </div>
    </div>
  );
}

export default function MiniGamePanel(props: MiniGamePanelProps) {
  const shared = {
    connected: props.connected,
    gameStateClient: props.gameStateClient,
    onInviteAI: props.onInviteAI,
  };
  switch (props.game) {
    case 'gomoku': return <GomokuGame {...shared} />;
    case 'chess': return <ChessGame {...shared} />;
    case 'xiangqi': return <XiangqiGame {...shared} />;
    case 'go': return <GoGame {...shared} />;
    case 'snake': return <SnakeGame connected={props.connected} gameStateClient={props.gameStateClient} />;
    case 'tetris': return <TetrisGame connected={props.connected} gameStateClient={props.gameStateClient} />;
    default: return null;
  }
}
