const MAX_EVENT_TEXT = 12_000;
const MAX_STICKERS = 100;

export type PetChatEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string; messages?: string[] }
  | { type: 'typing'; typing: boolean }
  | { type: 'error'; message: string };

export type PetSticker = {
  id: string;
  label: string;
  imageUrl?: string;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_EVENT_TEXT) : '';
}

export function sanitizeChatEvent(value: unknown): PetChatEvent | null {
  const event = recordOf(value);
  if (!event || typeof event.type !== 'string') return null;
  const payload = recordOf(event.payload);
  const source = payload || event;

  if (event.type === 'chunk' || event.type === 'chat:chunk') {
    const text = boundedString(source.text);
    return text ? { type: 'chunk', text } : null;
  }
  if (event.type === 'done' || event.type === 'chat:done') {
    let text = boundedString(source.text);
    let messages: string[] | undefined;
    if (Array.isArray(source.messages)) {
      const bubbles = source.messages
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, MAX_EVENT_TEXT))
        .filter(Boolean)
        .slice(0, 16);
      if (bubbles.length) {
        messages = bubbles;
        if (!text) text = bubbles.join('').slice(0, MAX_EVENT_TEXT);
      }
    }
    return { type: 'done', text, messages };
  }
  if (event.type === 'typing' || event.type === 'chat:typing') {
    return typeof source.typing === 'boolean' ? { type: 'typing', typing: source.typing } : null;
  }
  if (event.type === 'error' || event.type === 'chat:error') {
    return { type: 'error', message: boundedString(source.message) };
  }
  return null;
}

function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    // Sticker assets resolved locally by the reverie-sticker protocol are
    // short; pasted/collected stickers may carry a full data URL.
    if (url.protocol === 'reverie-sticker:') return value.length > 512 ? undefined : value;
    if (url.protocol === 'data:') return value.length > 6_000_000 ? undefined : value;
    if (['blob:', 'https:', 'reverie-app:'].includes(url.protocol)) {
      return value.length > 16_000 ? undefined : value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSticker(value: unknown): PetSticker | null {
  const sticker = recordOf(value);
  if (!sticker) return null;
  const id = boundedString(sticker.id).trim();
  if (!id) return null;
  const label = boundedString(sticker.label ?? sticker.name ?? sticker.text).trim().slice(0, 80) || '贴纸';
  // StickerItem.to_dict() on the Python side ships the image as
  // `image_data_url` (either a data: URL or a reverie-sticker:// asset URL).
  const imageUrl = safeImageUrl(
    sticker.imageUrl ?? sticker.thumbnailUrl ?? sticker.url ?? sticker.image_data_url,
  );
  return imageUrl ? { id, label, imageUrl } : { id, label };
}

export function sanitizeStickerList(value: unknown): PetSticker[] {
  const record = recordOf(value);
  const items = Array.isArray(value) ? value : record?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_STICKERS).map(sanitizeSticker).filter((item): item is PetSticker => Boolean(item));
}
