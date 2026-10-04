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

export type DownloadKind = "video" | "audio" | "image" | "gif";

/** Longest GIF the scraper makes (its GIF_MAX_SECONDS): a GIF is encoded on a small server CPU. */
export const GIF_MAX_SECONDS = 8;

/** A part of a video, in seconds: cut by the scraper (MP4 or M4A, no re-encoding) or turned into a GIF. */
export type ClipWindow = { start: number; end: number };

/** Seconds with at most one decimal, as sent in a clip link. */
function seconds(value: number): string {
  return String(Math.round(Math.max(0, value) * 10) / 10);
}

/**
 * CDNs whose links only work from the IP that resolved them (the scraper's, often through the paid proxy).
 * A browser can't fetch them itself: /api/download streams them through the scraper, and the result card
 * shows no inline player for them (playing one would pull the whole video through the proxy).
 */
export const IP_BOUND_HOSTS = ["googlevideo.com"];

export function isIpBoundHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return IP_BOUND_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

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
  /** Only this part of it (video, audio, or a GIF). */
  clip?: ClipWindow;
}): string {
  const params = new URLSearchParams({ url: opts.url, id: opts.id });
  if (opts.src) params.set("src", opts.src);
  if (opts.kind === "gif") params.set("kind", "gif");
  if (opts.kind === "audio" || opts.kind === "image") {
    params.set("kind", opts.kind);
    if (opts.ext) params.set("ext", opts.ext);
  }
  if (opts.kind === "audio" && opts.extract) params.set("extract", "1");
  if (opts.clip) {
    params.set("start", seconds(opts.clip.start));
    params.set("end", seconds(opts.clip.end));
  }
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
  const suffix =
    kind === "audio" ? ext ?? "m4a" : kind === "image" ? (isImageExtension(ext) ? ext : "jpg") : kind === "gif" ? "gif" : "mp4";
  return `savereelsfast-${id}.${suffix}`;
}
