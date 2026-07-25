import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, ImagePlus, Send, Sparkles, Square, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  type ChatMessageV2,
  type ChatRequestState,
} from './chatDeliveryMachine';
import { type StickerItem, useReverieWS } from '@/hooks/useReverieWS';
import { loadReverieChatDraft, saveReverieChatDraft } from '@/lib/reverieChatStorage';
import styles from './ChatPanel.module.scss';

type ReverieWS = ReturnType<typeof useReverieWS>;

interface ChatPanelProps {
  ws: ReverieWS;
  personaName: string;
}

function knownTimestamp(message: ChatMessageV2): number | null {
  if (message.timestamp_status !== 'known' || !message.created_at_utc) return null;
  const value = Date.parse(message.created_at_utc);
  return Number.isFinite(value) ? value : null;
}

function formatMessageTime(message: ChatMessageV2, unknownLabel: string): string {
  const value = knownTimestamp(message);
  if (value === null) return unknownLabel;
  return new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function shouldShowTime(messages: ChatMessageV2[], index: number): boolean {
  if (index === 0) return true;
  const current = knownTimestamp(messages[index]);
  const previous = knownTimestamp(messages[index - 1]);
  if (current === null || previous === null) return current !== previous;
  return current - previous >= 10 * 60 * 1000;
}

function pendingRequests(states: Record<string, ChatRequestState>): ChatRequestState[] {
  return Object.values(states)
    .filter((request) => !['done', 'cancelled', 'failed', 'failed_uncertain', 'error'].includes(request.state))
    .sort((left, right) => Date.parse(left.updated_at_utc) - Date.parse(right.updated_at_utc));
}

export default function ChatPanel({ ws, personaName }: ChatPanelProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [showStickers, setShowStickers] = useState(false);
  const [sendError, setSendError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const previousTerminals = useRef(new Set<string>());
  const connected = ws.connState === 'connected';
  const draftSessionId = ws.personaScope?.persona_id
    ? `${ws.personaScope.persona_id}:dream-room`
    : '';
  const requests = useMemo(() => pendingRequests(ws.chatRequestStates), [ws.chatRequestStates]);
  const deliveryLabel = useCallback(
    (state: ChatRequestState['state']) => t(`dream.state.${state}`),
    [t],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [ws.chatMessages.length, requests.length]);

  useEffect(() => {
    if (!draftSessionId) return;
    setInput((current) => current || loadReverieChatDraft(draftSessionId));
  }, [draftSessionId]);

  useEffect(() => {
    Object.values(ws.chatRequestStates).forEach((request) => {
      if (!['done', 'cancelled', 'failed', 'failed_uncertain', 'error'].includes(request.state)) return;
      const key = `${request.request_id}:${request.state}`;
      if (previousTerminals.current.has(key)) return;
      previousTerminals.current.add(key);
      setAnnouncement(`${personaName}: ${deliveryLabel(request.state)}`);
    });
  }, [deliveryLabel, personaName, ws.chatRequestStates]);

  const submit = useCallback((text: string, sticker?: StickerItem) => {
    const value = text.trim();
    if (!value || !connected || ws.localMode) {
      if (!connected) setSendError(t('dream.chatConnectingDraft'));
      else if (ws.localMode) setSendError(t('dream.chatLocalBlocked'));
      return false;
    }
    const requestId = ws.sendChat(value, sticker);
    if (!requestId) {
      setSendError(t('dream.chatSendFailed'));
      return false;
    }
    ws.addUserMessage(value, sticker, requestId);
    setInput('');
    saveReverieChatDraft('', draftSessionId);
    setSendError('');
    return true;
  }, [connected, draftSessionId, t, ws]);

  const submitSticker = (sticker: StickerItem) => {
    const text = sticker.text.trim() || t('dream.sentSticker');
    if (submit(text, sticker)) setShowStickers(false);
  };

  const uploadSticker = async () => {
    const importer = window.electronAPI?.stickers?.importFile;
    if (!importer) {
      setSendError(t('dream.stickerReadFailed'));
      return;
    }
    try {
      const result = await importer({ styleTags: ['用户导入'] });
      if (result.canceled || !result.item) return;
      ws.refreshStickers();
      submitSticker({
        ...result.item,
        source: 'collected',
      });
    } catch {
      setSendError(t('dream.stickerReadFailed'));
    }
  };

  const toggleLocalMode = async (enabled: boolean) => {
    if (!ws.localModeAvailable) {
      setSendError(t('dream.localModeUnavailable'));
      return;
    }
    const accepted = await ws.setLocalMode(enabled);
    if (accepted) {
      setSendError('');
    } else {
      setSendError(t('dream.modeSwitchFailed'));
    }
  };

  return (
    <section className={styles.chat} aria-labelledby="chat-title" data-local-mode={ws.localMode}>
      <header>
        <div>
          <h2 id="chat-title">{personaName}</h2>
          <span data-state={ws.connState}>
            {connected ? (ws.chatPresence.label || t('dream.online')) : t('dream.offline')}
          </span>
        </div>
        <label className={styles.localMode}>
          <input
            type="checkbox"
            checked={ws.localMode}
            disabled={!ws.localModeAvailable || ws.localModePending}
            aria-busy={ws.localModePending}
            onChange={(event) => void toggleLocalMode(event.target.checked)}
          />
          {t('dream.localMode')}
        </label>
      </header>

      <div className={styles.messages} role="log" aria-label={t('dream.chatHistory')}>
        {!ws.chatMessages.length && (
          <div className={styles.empty}>
            <Sparkles size={22} />
            <p>{t('dream.emptyChat')}</p>
            <small>{t('dream.emptyChatDetail')}</small>
          </div>
        )}
        {ws.chatMessages.map((message, index) => (
          <div key={message.id} className={styles.messageGroup}>
            {shouldShowTime(ws.chatMessages, index) && (
              <time dateTime={message.created_at_utc || undefined}>{formatMessageTime(message, t('dream.unknownTime'))}</time>
            )}
            <article
              className={styles.bubble}
              data-role={message.role}
              data-source={message.source}
              data-delivery-state={message.delivery_state}
            >
              {message.sticker?.image_data_url && (
                <img src={message.sticker.image_data_url} alt={message.sticker.text || t('dream.stickerAlt')} />
              )}
              {message.content && <p>{message.content}</p>}
              {message.role === 'user' && message.delivery_state && (
                <small>{t(`dream.state.${message.delivery_state}`)}</small>
              )}
              {message.error && <small className={styles.errorText}>{message.error}</small>}
            </article>
          </div>
        ))}

        {requests.map((request) => (
          <div key={request.request_id} className={styles.requestState} data-state={request.state}>
            <span>{deliveryLabel(request.state)}</span>
            {request.state === 'ready_waiting' && (
              <button
                type="button"
                disabled={request.reveal_sent}
                onClick={() => {
                  if (!ws.revealChat(request.request_id)) setSendError(t('dream.revealFailed'));
                }}
              >
                <Eye size={15} /> {t('dream.reveal')}
              </button>
            )}
            {['queued', 'generating', 'ready_waiting', 'delivering'].includes(request.state) && (
              <button
                type="button"
                onClick={() => {
                  if (!ws.cancelChat(request.request_id)) setSendError(t('dream.cancelFailed'));
                }}
              >
                <Square size={14} /> {t('dream.cancel')}
              </button>
            )}
          </div>
        ))}
        {ws.isTyping && (
          <div className={styles.deliveryPreview} aria-hidden="true">
            {ws.currentChunk || <span>···</span>}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.stableAnnouncement} aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {showStickers && (
        <div className={styles.stickers} aria-label={t('dream.localStickers')}>
          <button
            type="button"
            title={t('dream.selectLocalImage')}
            onClick={() => void uploadSticker()}
          >
            <ImagePlus size={18} />
          </button>
          {ws.stickers.slice(0, 18).map((sticker) => (
            <button key={sticker.id} type="button" onClick={() => submitSticker(sticker)}>
              {sticker.image_data_url
                ? <img src={sticker.image_data_url} alt={sticker.text || t('dream.stickerAlt')} />
                : <span>{sticker.text}</span>}
            </button>
          ))}
        </div>
      )}

      {ws.localMode && (
        <p className={styles.offlineNotice}><WifiOff size={15} /> {t('dream.localModeOn')}</p>
      )}
      {sendError && <p className={styles.sendError} role="alert">{sendError}</p>}

      <footer>
        <button
          type="button"
          aria-label={t('dream.localStickers')}
          aria-expanded={showStickers}
          onClick={() => {
            const next = !showStickers;
            setShowStickers(next);
            if (next) ws.refreshStickers();
          }}
        >
          <Sparkles size={17} />
        </button>
        <textarea
          rows={1}
          value={input}
          disabled={ws.localMode}
          placeholder={!connected ? t('dream.draftOffline') : ws.localMode ? t('dream.localModeOn') : t('dream.writeMessage')}
          onChange={(event) => {
            setInput(event.target.value);
            saveReverieChatDraft(event.target.value, draftSessionId);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit(input);
            }
          }}
        />
        <button
          type="button"
          disabled={!connected || ws.localMode || !input.trim()}
          aria-label={t('dream.send')}
          onClick={() => submit(input)}
        >
          <Send size={17} />
        </button>
      </footer>
    </section>
  );
}
