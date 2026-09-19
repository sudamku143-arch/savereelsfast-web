/** Audio containers the download proxy will label correctly (no transcoding happens). */
export const AUDIO_EXTENSIONS = ["m4a", "mp4", "aac", "mp3", "webm", "ogg", "opus"] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export function isAudioExtension(value: unknown): value is AudioExtension {
  return typeof value === "string" && (AUDIO_EXTENSIONS as readonly string[]).includes(value);
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
  kind?: "video" | "audio";
  ext?: string;
}): string {
  const params = new URLSearchParams({ url: opts.url, id: opts.id });
  if (opts.src) params.set("src", opts.src);
  if (opts.kind === "audio") {
    params.set("kind", "audio");
    if (opts.ext) params.set("ext", opts.ext);
  }
  return `/api/download?${params.toString()}`;
}

/** File name a download will be saved as (mirrors the server's Content-Disposition). */
export function downloadFilename(id: string, kind: "video" | "audio" = "video", ext = "m4a"): string {
  return `savereelsfast-${id}.${kind === "audio" ? ext : "mp4"}`;
}
