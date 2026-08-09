/**
 * GlassCommandPalette — 毛玻璃命令面板（liquidglass 风格）。
 *
 * Ctrl/Cmd+K 唤起；方向键导航 + Enter 执行；Esc 关闭。
 * 命令项由调用方提供（与现有 MVP 命令一一对应）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './GlassCommandPalette.module.scss';

export interface CommandPaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  onRun: () => void;
}

interface GlassCommandPaletteProps {
  items: CommandPaletteItem[];
  open?: boolean;
  onClose: () => void;
}

export default function GlassCommandPalette({ items, open = false, onClose }: GlassCommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    return items.filter((item) => (
      !needle
      || item.label.toLocaleLowerCase('zh-CN').includes(needle)
      || (item.hint ?? '').toLocaleLowerCase('zh-CN').includes(needle)
    ));
  }, [items, query]);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setCursor(0);
    inputRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((value) => Math.min(filtered.length - 1, value + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((value) => Math.max(0, value - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = filtered[cursor];
        if (item && !item.disabled) {
          onClose();
          item.onRun();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, filtered, cursor, onClose]);

  useEffect(() => {
    const active = listRef.current?.children[cursor] as HTMLElement | undefined;
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="命令面板" onClick={onClose}>
      <div className={styles.palette} onClick={(event) => event.stopPropagation()}>
        <div className={styles.searchRow}>
          <span className={styles.badge} aria-hidden="true">⌘</span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder="搜索命令…"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <div className={styles.list} ref={listRef}>
          {filtered.length === 0 && (
            <div className={styles.empty}>没有匹配的命令</div>
          )}
          {filtered.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.item} ${index === cursor ? styles.active : ''}`}
              disabled={item.disabled}
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onRun();
              }}
            >
              {item.icon && <span className={styles.icon}>{item.icon}</span>}
              <span className={styles.label}>{item.label}</span>
              {item.hint && <small className={styles.hint}>{item.hint}</small>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
