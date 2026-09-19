// Kept free of runtime imports so it can be unit-tested with plain Node.
import type { PlatformId } from "./platforms";

/**
 * URL slug of each platform's landing page (/downloader/<slug>).
 * X uses "twitter" because that is the word people actually search for.
 */
export const PLATFORM_SLUGS: Record<PlatformId, string> = {
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

export const LANDING_PLATFORMS = Object.keys(PLATFORM_SLUGS) as PlatformId[];

const SLUG_TO_PLATFORM = new Map<string, PlatformId>(
  LANDING_PLATFORMS.map((id) => [PLATFORM_SLUGS[id], id])
);

export function platformFromSlug(slug: string): PlatformId | null {
  return SLUG_TO_PLATFORM.get(slug) ?? null;
}

/** Path of a platform's landing page, without the locale prefix. */
export function landingPath(id: PlatformId): string {
  return `/downloader/${PLATFORM_SLUGS[id]}`;
}

/** Replaces {name} placeholders. Unknown placeholders are left visible so tests can catch them. */
export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
