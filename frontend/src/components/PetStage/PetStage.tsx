/**
 * PetStage — 透明置顶桌宠窗口内容（Luna-ts 风格简化版）。
 *
 * 独立 renderer（reverie-app://app/index.html#pet）内渲染：
 * - 复用 BundledCharacter 的同款形象（Live2D 或静态图）
 * - 最新一条助手消息气泡（订阅 chat:done / chat:chunk / chat:typing）
 * - 整窗可拖动（-webkit-app-region: drag），按钮区排除
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL_VERSION } from '@/contracts/protocolV4.generated';
import { Live2DCanvas } from '@/components/AvatarView/Live2DAdapter';
import styles from './PetStage.module.scss';

type CharacterSnapshot = {
  record: {
    kind?: string;
    entryUrl?: string;
    name?: string;
  } | null;
};

export default function PetStage() {
  const [latestBubble, setLatestBubble] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [snapshot, setSnapshot] = useState<CharacterSnapshot>({ record: null });
  const chunkRef = useRef('');
  const bubbleTimer = useRef(0);
  const authSent = useRef(false);

  const flashBubble = useCallback((text: string) => {
    setLatestBubble(text);
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setLatestBubble(''), 12_000);
  }, []);

  useEffect(() => {
    void window.electronAPI?.character?.get?.()
      .then((value) => setSnapshot(value))
      .catch(() => setSnapshot({ record: null }));
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.bridge;
    if (!api) return undefined;
    const unsubscribe = api.onMessage((frame) => {
      let parsed: { type?: string; payload?: any };
      try {
        parsed = typeof frame === 'string'
          ? JSON.parse(frame) as { type?: string; payload?: any }
          : (frame as { type?: string; payload?: any });
      } catch {
        return; // malformed frame must not break the subscription loop
      }
      if (parsed.type === 'chat:chunk') {
        const text = typeof parsed.payload?.text === 'string' ? parsed.payload.text : '';
        if (text) {
          chunkRef.current += text;
          setLatestBubble(chunkRef.current);
        }
      } else if (parsed.type === 'chat:done') {
        const messages = Array.isArray(parsed.payload?.messages)
          ? parsed.payload.messages.filter((item: unknown): item is string => (
            typeof item === 'string' && item.trim().length > 0
          ))
          : [];
        const finalText = messages.join('') || chunkRef.current;
        chunkRef.current = '';
        if (finalText) flashBubble(finalText);
      } else if (parsed.type === 'chat:typing') {
        setSpeaking(Boolean(parsed.payload?.typing));
      } else if (parsed.type === 'chat:error') {
        chunkRef.current = '';
      }
    });
    let disposed = false;
    const tryAuthenticate = () => {
      if (disposed || !api.getConnectionConfig) return;
      void api.getConnectionConfig().then((connection) => {
        if (disposed) return;
        void api.send({
          type: 'bridge:auth',
          payload: {
            secret: connection?.secret ?? '',
            protocol_version: connection?.protocolVersion ?? PROTOCOL_VERSION,
          },
        });
      }).catch(() => {
        // The bridge may still be starting; retry once after a short delay.
        if (disposed) return;
        window.setTimeout(() => {
          if (!disposed) tryAuthenticate();
        }, 5_000);
      });
    };
    if (!authSent.current) {
      authSent.current = true;
      tryAuthenticate();
    }
    return () => {
      disposed = true;
      unsubscribe?.();
      window.clearTimeout(bubbleTimer.current);
    };
  }, [flashBubble]);

  const record = snapshot.record;
  const live2dEnabled = Boolean(record?.kind === 'live2d' && record?.entryUrl);

  return (
    <main className={styles.petStage} data-pet-stage>
      <div className={styles.dragRegion}>
        {live2dEnabled ? (
          <Live2DCanvas
            className={styles.avatarCanvas}
            config={{ width: 240, height: 330, resolution: 1, maxFps: 20 }}
            modelUrl={record!.entryUrl!}
            speaking={speaking}
          />
        ) : (
          <div className={styles.staticAvatar} aria-hidden="true">
            <span className={styles.petFace} />
          </div>
        )}
      </div>
      {latestBubble && (
        <div className={styles.bubble} role="status">
          <span className={styles.bubbleTail} />
          <p>{latestBubble}</p>
        </div>
      )}
      <button
        type="button"
        className={styles.closeButton}
        aria-label="隐藏桌宠"
        onClick={() => void window.electronAPI?.pet?.hide?.()}
      >
        ×
      </button>
    </main>
  );
}
