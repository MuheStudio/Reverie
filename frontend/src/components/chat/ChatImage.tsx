import { useEffect, useState } from 'react';

// Media read-back is idempotent (content-addressed), so one module-level
// cache serves both chat rooms and survives re-mounts within a session.
const mediaCache = new Map<string, string>();
const pendingFetches = new Map<string, Promise<string>>();

export function primeChatMediaCache(mediaId: string, dataUrl: string): void {
  if (mediaId && dataUrl.startsWith('data:image/')) mediaCache.set(mediaId, dataUrl);
}

export function ChatImage({
  mediaId,
  previewUrl,
  fetcher,
  alt,
  className,
}: {
  mediaId: string;
  /** Optimistic preview (data/object URL) shown before the cache answers. */
  previewUrl?: string;
  fetcher: (mediaId: string) => Promise<string>;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState(() => mediaCache.get(mediaId) || (mediaId ? '' : (previewUrl || '')));

  useEffect(() => {
    if (!mediaId) {
      setSrc(previewUrl || '');
      return;
    }
    const cached = mediaCache.get(mediaId);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    const existing = pendingFetches.get(mediaId)
      ?? fetcher(mediaId).then((dataUrl) => {
        mediaCache.set(mediaId, dataUrl);
        return dataUrl;
      }).finally(() => {
        pendingFetches.delete(mediaId);
      });
    pendingFetches.set(mediaId, existing);
    existing.then((dataUrl) => {
      if (!cancelled) setSrc(dataUrl);
    }).catch(() => {
      if (!cancelled && previewUrl) setSrc(previewUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [fetcher, mediaId, previewUrl]);

  if (!src) return null;
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
