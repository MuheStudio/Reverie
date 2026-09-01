// Shared chat-image attachment helpers for MvpRoom and DreamRoom.
//
// Primary path: Electron's narrow preload bridge resolves a disk File with
// webUtils.getPathForFile, so the absolute path goes over the bridge (tiny
// frame) and Python reads + normalizes the bytes. Clipboard pastes are always
// compressed to a bounded JPEG data URL in the renderer (the bridge frame cap
// is 256 KiB, so the encoded URL must stay smaller).

export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_EDGE = 1280;
const MAX_DATA_URL_CHARS = 200_000;

export interface ChatImageAttachment {
  /** Absolute local path when the file came from a disk picker. */
  path?: string;
  /** Bounded data URL used for the optimistic bubble preview. */
  previewUrl: string;
}

export type ChatImagePayload =
  | { image_path: string }
  | { image_data_url: string }
  | Record<string, never>;

export function toChatImagePayload(
  attachment: Pick<ChatImageAttachment, 'path' | 'previewUrl'> | null | undefined,
): ChatImagePayload {
  if (attachment?.path) return { image_path: attachment.path };
  if (attachment?.previewUrl.startsWith('data:image/')) {
    return { image_data_url: attachment.previewUrl };
  }
  return {};
}

export function isImageFile(file: File | null | undefined): boolean {
  return Boolean(file && file.type.startsWith('image/'));
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('image read failed'));
    reader.readAsDataURL(blob);
  });
}

async function canvasCompress(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [0.82, 0.66, 0.5]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= MAX_DATA_URL_CHARS) return url;
  }
  throw new Error('image could not be compressed into a chat-sized attachment');
}

export async function imageAttachmentFromFile(file: File): Promise<ChatImageAttachment> {
  if (!isImageFile(file)) throw new Error('不是图片文件');
  if (file.size > MAX_CHAT_IMAGE_BYTES) throw new Error('图片超过 5MB 限制');
  const electronPath = window.electronAPI?.getPathForFile?.(file) || '';
  if (typeof electronPath === 'string' && electronPath) {
    try {
      return { path: electronPath, previewUrl: await readAsDataUrl(file) };
    } catch {
      // The preview is cosmetic; the path alone still carries the send.
      return { path: electronPath, previewUrl: '' };
    }
  }
  return { previewUrl: await canvasCompress(file) };
}

export async function imageAttachmentFromClipboard(
  clipboardData: DataTransfer | null,
): Promise<ChatImageAttachment | null> {
  const items = clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.size > MAX_CHAT_IMAGE_BYTES) throw new Error('图片超过 5MB 限制');
    return { previewUrl: await canvasCompress(file) };
  }
  return null;
}
