// Renders a downloaded chat video as a single WeChat-style bubble. Unlike
// ChatImage (which fetches a base64 data URL), video streams directly from the
// Electron reverie-video://asset protocol so a large file never has to be
// inlined into renderer memory. The <video> defaults to NOT autoplaying
// (preload="metadata", controls, no autoPlay) so a video never surprises the
// user with sound — playback is click-to-start, and prefers-reduced-motion is
// respected by leaving the first frame paused.

const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Build the streaming asset URL for a stored video, or '' if unrenderable. */
export function videoAssetUrl(mediaId: string, mime?: string): string {
  const id = (mediaId || '').toLowerCase();
  const ext = VIDEO_EXT[mime || ''];
  if (!ext || !SHA256_RE.test(id)) return '';
  return `reverie-video://asset/${id}.${ext}`;
}

export function isVideoMime(mime?: string): boolean {
  return typeof mime === 'string' && mime.startsWith('video/');
}

export function ChatVideo({
  mediaId,
  mime,
  className,
}: {
  mediaId: string;
  mime?: string;
  className?: string;
}) {
  const src = videoAssetUrl(mediaId, mime);
  if (!src) return null;
  return (
    <video
      className={className}
      src={src}
      controls
      preload="metadata"
      // No autoPlay / no loop / no muted-autostart: a chat video must never
      // start playing (or making sound) on its own.
      playsInline
    />
  );
}
