// Kept free of runtime imports so it can be unit-tested with plain Node.
import type { PlatformId } from "./platforms";

/**
 * URL slug of each platform's landing page: /<slug>, or /<language>/<slug>.
 * The slug is the phrase people search for ("instagram video downloader"). X says "twitter-x" because
 * both names are searched.
 */
export const PLATFORM_SLUGS: Record<PlatformId, string> = {
  instagram: "instagram-video-downloader",
  youtube: "youtube-video-downloader",
  facebook: "facebook-video-downloader",
  threads: "threads-video-downloader",
  x: "twitter-x-video-downloader",
  pinterest: "pinterest-video-downloader",
  tiktok: "tiktok-video-downloader",
  reddit: "reddit-video-downloader",
  snapchat: "snapchat-video-downloader",
};

/**
 * Short, stable name of each platform for the share-image address (/api/og?p=<key>). It is not a page URL,
 * so renaming a slug never changes it.
 */
export const PLATFORM_KEYS: Record<PlatformId, string> = {
  instagram: "instagram",
  youtube: "youtube",
  facebook: "facebook",
  threads: "threads",
  x: "twitter",
  pinterest: "pinterest",
  tiktok: "tiktok",
  reddit: "reddit",
  snapchat: "snapchat",
};

/**
 * The addresses these pages had before (/downloader/<old>). They are redirected permanently to the new
 * ones (see next.config.js), so links and search results made earlier keep working.
 * "x" was the very first spelling for X (Twitter).
 */
export const LEGACY_SLUGS: Record<string, PlatformId> = {
  instagram: "instagram",
  youtube: "youtube",
  facebook: "facebook",
  threads: "threads",
  twitter: "x",
  x: "x",
  pinterest: "pinterest",
  tiktok: "tiktok",
  reddit: "reddit",
  snapchat: "snapchat",
};

export const LANDING_PLATFORMS = Object.keys(PLATFORM_SLUGS) as PlatformId[];

const SLUG_TO_PLATFORM = new Map<string, PlatformId>(
  LANDING_PLATFORMS.map((id) => [PLATFORM_SLUGS[id], id])
);

export function platformFromSlug(slug: string): PlatformId | null {
  return SLUG_TO_PLATFORM.get(slug) ?? null;
}

/** Path of a platform's landing page, without the locale prefix. */
export function landingPath(id: PlatformId): string {
  return `/${PLATFORM_SLUGS[id]}`;
}

/** Replaces {name} placeholders. Unknown placeholders are left visible so tests can catch them. */
export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
