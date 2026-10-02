/** Audio containers the download proxy will label correctly (no transcoding happens). */
export const AUDIO_EXTENSIONS = ["m4a", "mp4", "aac", "mp3", "webm", "ogg", "opus"] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export function isAudioExtension(value: unknown): value is AudioExtension {
  return typeof value === "string" && (AUDIO_EXTENSIONS as readonly string[]).includes(value);
}

/** Picture files an Instagram photo is saved as (untouched, like everything else). */
export const IMAGE_EXTENSIONS = ["jpg", "webp", "png"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export function isImageExtension(value: unknown): value is ImageExtension {
  return typeof value === "string" && (IMAGE_EXTENSIONS as readonly string[]).includes(value);
}

export type DownloadKind = "video" | "audio" | "image";

/**
 * Same-origin download link. Cross-origin CDN links ignore the `download`
 * attribute, so everything is proxied through /api/download, which sends
 * `Content-Disposition: attachment`.
 *
 * `src` (the post URL) lets the server re-resolve the post if the CDN link
 * expired; leave it out for individual carousel items, where "the best video
 * of the post" would be the wrong one.
 */
export function buildDownloadHref(opts: {
  url: string;
  id: string;
  src?: string;
  kind?: DownloadKind;
  ext?: string;
  /** Audio only: `url` is a video with no separate audio track; the server takes its sound out (as M4A). */
  extract?: boolean;
}): string {
  const params = new URLSearchParams({ url: opts.url, id: opts.id });
  if (opts.src) params.set("src", opts.src);
  if (opts.kind === "audio" || opts.kind === "image") {
    params.set("kind", opts.kind);
    if (opts.ext) params.set("ext", opts.ext);
  }
  if (opts.kind === "audio" && opts.extract) params.set("extract", "1");
  return `/api/download?${params.toString()}`;
}

/**
 * The audio download for a video: its separate audio track when it has one (saved as-is), otherwise the sound
 * taken out of the video itself (YouTube, and posts whose sound is only inside the MP4). Photos have none.
 */
export function buildAudioHref(
  item: { id: string; videoUrl: string; audioUrl?: string; audioExt?: string; kind?: string },
  src?: string
): string | null {
  if (item.audioUrl) {
    return buildDownloadHref({ url: item.audioUrl, id: item.id, src, kind: "audio", ext: item.audioExt });
  }
  if (item.kind === "image" || !item.videoUrl) return null;
  return buildDownloadHref({ url: item.videoUrl, id: item.id, src, kind: "audio", ext: "m4a", extract: true });
}

/** File name a download will be saved as (mirrors the server's Content-Disposition). */
export function downloadFilename(id: string, kind: DownloadKind = "video", ext?: string): string {
  const suffix = kind === "audio" ? ext ?? "m4a" : kind === "image" ? (isImageExtension(ext) ? ext : "jpg") : "mp4";
  return `savereelsfast-${id}.${suffix}`;
}
