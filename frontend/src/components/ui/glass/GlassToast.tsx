/**
 * GlassToast — 轻量毛玻璃通知（liquidglass 风格）。
 *
 * 自包含的 toast 栈：容器 + 队列 + 自动消失 + 手动关闭。
 * 供 DreamRoom / PetStage / MvpRoom 复用。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './GlassToast.module.scss';

export type GlassToastKind = 'info' | 'success' | 'warn' | 'error';

export interface GlassToastItem {
  id: number;
  kind: GlassToastKind;
  title: string;
  body?: string;
}

interface GlassToastProps {
  toasts: GlassToastItem[];
  onDismiss: (id: number) => void;
}

export function GlassToastStack({ toasts, onDismiss }: GlassToastProps) {
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.kind]}`} role="status">
          <strong>{toast.title}</strong>
          {toast.body && <p>{toast.body}</p>}
          <button
            type="button"
            className={styles.dismiss}
            aria-label="关闭通知"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function useGlassToasts(durationMs = 5_000) {
  const [toasts, setToasts] = useState<GlassToastItem[]>([]);
  const nextId = useRef(1);
  const timersRef = useRef<number[]>([]);

  const push = useCallback((
    kind: GlassToastKind,
    title: string,
    body?: string,
  ) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((prev) => [...prev.slice(-3), { id, kind, title, body }]);
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((value) => value !== timer);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, durationMs);
    timersRef.current.push(timer);
  }, [durationMs]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  return { toasts, push, dismiss };
}
