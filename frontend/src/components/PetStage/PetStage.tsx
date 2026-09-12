import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ImagePlus, Send, Smile, Square, X } from 'lucide-react';
import { Live2DCanvas } from '@/components/AvatarView/Live2DAdapter';
import { clearReverieChatDraft, loadReverieChatDraft, saveReverieChatDraft } from '@/lib/reverieChatStorage';
import {
  sanitizeChatEvent,
  sanitizeStickerList,
  type PetSticker,
} from './petStageContract';
import styles from './PetStage.module.scss';

const MAX_MESSAGE_LENGTH = 2_000;
const BUBBLE_LIFETIME_MS = 12_000;
const PET_DRAFT_SESSION_ID = 'pet-stage';

type CharacterSnapshot = {
  record: {
    kind?: string;
    entryUrl?: string;
    name?: string;
  } | null;
};

type PetApi = {
  hide?: () => Promise<unknown> | unknown;
  dragStart?: () => Promise<unknown> | unknown;
  dragMove?: (delta: { dx: number; dy: number }) => Promise<unknown> | unknown;
  dragEnd?: () => Promise<unknown> | unknown;
  onChatEvent?: (listener: (event: unknown) => void) => (() => void) | void;
  sendChat?: (text: string) => Promise<unknown> | unknown;
  cancelChat?: () => Promise<unknown> | unknown;
  listStickers?: () => Promise<unknown> | unknown;
  importSticker?: () => Promise<unknown> | unknown;
  sendSticker?: (stickerId: string) => Promise<unknown> | unknown;
};

function getPetApi(): PetApi | undefined {
  return (window.electronAPI as unknown as { pet?: PetApi } | undefined)?.pet;
}

export default function PetStage() {
  const [latestBubble, setLatestBubble] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [message, setMessage] = useState(
    () => loadReverieChatDraft(PET_DRAFT_SESSION_ID).slice(0, MAX_MESSAGE_LENGTH),
  );
  const [status, setStatus] = useState('');
  const [snapshot, setSnapshot] = useState<CharacterSnapshot>({ record: null });
  const [stickers, setStickers] = useState<PetSticker[]>([]);
  const [stickerTrayOpen, setStickerTrayOpen] = useState(false);
  const chunkRef = useRef('');
  const bubbleTimer = useRef(0);
  const bubbleQueueRef = useRef<string[]>([]);
  const composingRef = useRef(false);
  const petApi = getPetApi();

  const keepBubble = useCallback((text: string) => {
    setLatestBubble(text);
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setLatestBubble(''), BUBBLE_LIFETIME_MS);
  }, []);

  // A reply arrives as multiple backend bubbles; the pet plays them one by
  // one like a person sending consecutive messages instead of one wall of text.
  const playBubbleSequence = useCallback((messages: string[]) => {
    const queue = messages.map((item) => item.trim()).filter(Boolean).slice(0, 16);
    if (!queue.length) return;
    if (queue.length === 1) {
      keepBubble(queue[0]);
      return;
    }
    bubbleQueueRef.current = queue;
    window.clearTimeout(bubbleTimer.current);
    const step = () => {
      const next = bubbleQueueRef.current.shift();
      if (next === undefined) return;
      setLatestBubble(next);
      window.clearTimeout(bubbleTimer.current);
      if (bubbleQueueRef.current.length) {
        bubbleTimer.current = window.setTimeout(step, Math.min(6_000, 1_800 + next.length * 90));
      } else {
        bubbleTimer.current = window.setTimeout(() => setLatestBubble(''), BUBBLE_LIFETIME_MS);
      }
    };
    step();
  }, [keepBubble]);

  // Manual window drag (Luna-ts pattern): the model region starts the drag,
  // the window streams total screen-space deltas, and main re-places the
  // window absolutely from the drag origin. Every dock/bubble element lives
  // outside this region, so nothing needs drag-exemption islands anymore.
  const dragOriginRef = useRef<{ sx: number; sy: number } | null>(null);

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || dragOriginRef.current) return;
    const dragStart = getPetApi()?.dragStart;
    if (!dragStart) return;
    event.preventDefault();
    dragOriginRef.current = { sx: event.screenX, sy: event.screenY };
    void dragStart();
  };

  useEffect(() => {
    const onMove = (moveEvent: PointerEvent) => {
      const origin = dragOriginRef.current;
      const dragMove = getPetApi()?.dragMove;
      if (!origin || !dragMove) return;
      void dragMove({ dx: moveEvent.screenX - origin.sx, dy: moveEvent.screenY - origin.sy });
    };
    const endDrag = () => {
      if (!dragOriginRef.current) return;
      dragOriginRef.current = null;
      void getPetApi()?.dragEnd?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('blur', endDrag);
      if (dragOriginRef.current) {
        dragOriginRef.current = null;
        void getPetApi()?.dragEnd?.();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI?.character?.get?.()
      .then((value) => {
        if (!disposed) setSnapshot(value);
      })
      .catch(() => {
        if (!disposed) setSnapshot({ record: null });
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const onChatEvent = getPetApi()?.onChatEvent;
    if (!onChatEvent) return undefined;

    const handleEvent = (rawEvent: unknown) => {
      const event = sanitizeChatEvent(rawEvent);
      if (!event) return;

      if (event.type === 'chunk') {
        window.clearTimeout(bubbleTimer.current);
        bubbleQueueRef.current = [];
        chunkRef.current = `${chunkRef.current}${event.text}`;
        setLatestBubble(chunkRef.current);
        setStreaming(true);
        setStatus('');
        return;
      }
      if (event.type === 'done') {
        const finalText = event.text || chunkRef.current;
        chunkRef.current = '';
        setStreaming(false);
        setSpeaking(false);
        if (event.messages && event.messages.length > 1) {
          playBubbleSequence(event.messages);
        } else if (finalText) {
          keepBubble(finalText);
        }
        return;
      }
      if (event.type === 'typing') {
        if (event.typing) bubbleQueueRef.current = [];
        setSpeaking(event.typing);
        setStreaming(event.typing);
        return;
      }

      chunkRef.current = '';
      bubbleQueueRef.current = [];
      setStreaming(false);
      setSpeaking(false);
      setStatus(event.message || '消息发送失败，请重试。');
    };

    let unsubscribe: (() => void) | void;
    try {
      unsubscribe = onChatEvent(handleEvent);
    } catch {
      setStatus('桌宠聊天暂不可用。');
    }
    return () => {
      unsubscribe?.();
      window.clearTimeout(bubbleTimer.current);
      bubbleQueueRef.current = [];
    };
  }, [keepBubble, playBubbleSequence]);

  const loadStickers = useCallback(async () => {
    const listStickers = getPetApi()?.listStickers;
    if (!listStickers) return;
    try {
      setStickers(sanitizeStickerList(await listStickers()));
      setStatus('');
    } catch {
      setStatus('贴纸加载失败。');
    }
  }, []);

  const toggleStickerTray = () => {
    const nextOpen = !stickerTrayOpen;
    setStickerTrayOpen(nextOpen);
    if (nextOpen) void loadStickers();
  };

  const submitMessage = async () => {
    const text = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    const sendChat = getPetApi()?.sendChat;
    if (!text || !sendChat || streaming) return;

    setStatus('');
    try {
      await sendChat(text);
      setMessage('');
      clearReverieChatDraft(PET_DRAFT_SESSION_ID);
      setStreaming(true);
    } catch {
      setStatus('消息发送失败，请重试。');
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!composingRef.current) void submitMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    void submitMessage();
  };

  const cancelChat = async () => {
    const cancel = getPetApi()?.cancelChat;
    if (!cancel) return;
    try {
      await cancel();
      chunkRef.current = '';
      setStreaming(false);
      setSpeaking(false);
      setStatus('已停止生成。');
    } catch {
      setStatus('无法停止当前回复。');
    }
  };

  const importSticker = async () => {
    const importFromPicker = getPetApi()?.importSticker;
    if (!importFromPicker) return;
    try {
      await importFromPicker();
      await loadStickers();
    } catch {
      setStatus('贴纸导入失败。');
    }
  };

  const sendSticker = async (sticker: PetSticker) => {
    const send = getPetApi()?.sendSticker;
    if (!send || streaming) return;
    try {
      setStatus('');
      setStickerTrayOpen(false);
      await send(sticker.id);
      setStreaming(true);
    } catch {
      setStatus('贴纸发送失败。');
    }
  };

  const record = snapshot.record;
  const live2dEnabled = Boolean(record?.kind === 'live2d' && record?.entryUrl);
  const canSendText = Boolean(petApi?.sendChat && message.trim() && !streaming);

  return (
    <main className={styles.petStage} data-pet-stage>
      <section
        className={styles.modelRegion}
        aria-label={record?.name || '桌宠角色'}
        onPointerDown={beginDrag}
      >
        {live2dEnabled ? (
          <Live2DCanvas
            className={styles.avatarCanvas}
            config={{ width: 240, height: 330, resolution: 1, maxFps: 20 }}
            modelUrl={record!.entryUrl!}
            speaking={speaking}
          />
        ) : (
          <div className={styles.staticAvatar} aria-hidden="true">
            <span className={styles.petEarLeft} />
            <span className={styles.petEarRight} />
            <span className={styles.petFace} />
          </div>
        )}
      </section>

      {latestBubble && (
        <aside className={styles.bubble} role="status" aria-live="polite" aria-atomic="true">
          <p>{latestBubble}</p>
          <span className={styles.bubbleTail} aria-hidden="true" />
          {streaming && <span className={styles.streamingDot} aria-label="正在回复" />}
        </aside>
      )}

      <button
        type="button"
        className={styles.closeButton}
        aria-label="隐藏桌宠"
        onClick={() => void getPetApi()?.hide?.()}
      >
        <X aria-hidden="true" size={16} />
      </button>

      <div className={styles.composerArea}>
        {stickerTrayOpen && (
          <section className={styles.stickerTray} aria-label="贴纸列表">
            {stickers.length ? stickers.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                className={styles.stickerItem}
                onClick={() => void sendSticker(sticker)}
                disabled={!petApi?.sendSticker || streaming}
                aria-label={`发送贴纸：${sticker.label}`}
              >
                {sticker.imageUrl ? <img src={sticker.imageUrl} alt="" /> : <Smile aria-hidden="true" />}
                <span>{sticker.label}</span>
              </button>
            )) : (
              <p className={styles.emptyStickers}>暂无贴纸</p>
            )}
          </section>
        )}

        <form className={styles.composer} onSubmit={handleSubmit} aria-label="桌宠聊天">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="选择贴纸"
            aria-expanded={stickerTrayOpen}
            onClick={toggleStickerTray}
            disabled={!petApi?.listStickers}
          >
            <Smile aria-hidden="true" size={18} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="导入贴纸"
            onClick={() => void importSticker()}
            disabled={!petApi?.importSticker}
          >
            <ImagePlus aria-hidden="true" size={18} />
          </button>
          <label className={styles.inputWrap}>
            <span className={styles.srOnly}>消息</span>
            <input
              value={message}
              maxLength={MAX_MESSAGE_LENGTH}
              onChange={(event) => {
                const next = event.target.value.slice(0, MAX_MESSAGE_LENGTH);
                setMessage(next);
                saveReverieChatDraft(next, PET_DRAFT_SESSION_ID);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={petApi?.sendChat ? '和我说点什么…' : '聊天功能尚未连接'}
              disabled={!petApi?.sendChat}
              autoComplete="off"
            />
          </label>
          {streaming ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label="停止回复"
              onClick={() => void cancelChat()}
              disabled={!petApi?.cancelChat}
            >
              <Square aria-hidden="true" size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className={styles.sendButton} aria-label="发送消息" disabled={!canSendText}>
              <Send aria-hidden="true" size={17} />
            </button>
          )}
        </form>
        <p className={styles.status} role="status" aria-live="polite">{status}</p>
      </div>
    </main>
  );
}
