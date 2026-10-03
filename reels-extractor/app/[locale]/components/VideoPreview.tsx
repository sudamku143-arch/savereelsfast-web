"use client";

import { useState } from "react";

/**
 * The result card's inline player. Nothing is fetched until the visitor presses play (preload="none", no
 * autoplay): until then only the cover image loads, the same one the card always showed.
 *
 * It plays the platform's own CDN link first. If that fails (a CDN that refuses other sites' pages, an expired
 * link), it tries once more through /api/download, which fetches with the right headers or via the scraper.
 * If that fails too, the cover image takes its place; the download buttons below are never affected.
 */
export default function VideoPreview({
  src,
  fallbackSrc,
  poster,
  label,
  vertical,
}: {
  src: string;
  /** Same-origin /api/download link, tried once if the CDN link won't play. */
  fallbackSrc: string;
  poster?: string;
  /** Accessible name: the caption or a generic "video thumbnail". */
  label: string;
  /** Reels-style 9:16 frame (Instagram, TikTok...); otherwise 16:9. */
  vertical: boolean;
}) {
  // 0: CDN link, 1: through /api/download, 2: gave up, show the cover instead
  const [attempt, setAttempt] = useState(0);
  const frame = `mx-auto block w-full max-h-[60vh] overflow-hidden rounded-xl bg-black ${vertical ? "aspect-[9/16] max-w-[340px]" : "aspect-video"}`;

  if (attempt >= 2) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- an external CDN cover, shown as-is
      <img src={poster} alt={label} className={`${frame} object-cover`} loading="lazy" decoding="async" />
    ) : null;
  }

  return (
    <video
      key={attempt}
      src={attempt === 0 ? src : fallbackSrc}
      poster={poster || undefined}
      controls
      preload="none"
      playsInline
      aria-label={label}
      onError={() => setAttempt((n) => n + 1)}
      className={`${frame} object-contain`}
    />
  );
}
