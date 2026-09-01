/**
 * Protocol-projection for chat sticker attachments (batch M hardening).
 *
 * The backend `StickerAttachmentPayload` contract is strict (extra fields are
 * forbidden): the renderer must project the display-side sticker item down to
 * the exact wire shape. Sending a raw sticker:list item used to violate the
 * contract and the stdio bridge answered with fatal_error, which took the
 * whole backend down for the session.
 */

export interface StickerAttachmentPayload {
  id?: string;
  text?: string;
  emotions?: string[];
  style_tags?: string[];
  image_data_url?: string;
  source?: string;
}

const MAX_TAG_LENGTH = 80;

export function normalizeStickerTags(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((entry) => (typeof entry === 'string' ? entry.trim().slice(0, MAX_TAG_LENGTH) : ''))
    .filter(Boolean)
    .slice(0, max);
  return cleaned;
}

function stringList(value: unknown, max: number): string[] | undefined {
  const cleaned = normalizeStickerTags(value, max);
  return cleaned.length ? cleaned : undefined;
}

export function toStickerAttachmentPayload(item: unknown): StickerAttachmentPayload | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const text = typeof record.text === 'string' ? record.text : undefined;
  const imageDataUrl = typeof record.image_data_url === 'string' ? record.image_data_url : undefined;
  if (!id && !text && !imageDataUrl) return null;
  const payload: StickerAttachmentPayload = {};
  if (id) payload.id = id.slice(0, 128);
  if (text) payload.text = text.slice(0, 400);
  const emotions = stringList(record.emotions, 24);
  if (emotions) payload.emotions = emotions;
  const styleTags = stringList(record.style_tags, 24);
  if (styleTags) payload.style_tags = styleTags;
  if (imageDataUrl) payload.image_data_url = imageDataUrl.slice(0, 350_000);
  if (typeof record.source === 'string' && record.source) {
    payload.source = record.source.slice(0, 40);
  }
  return payload;
}
