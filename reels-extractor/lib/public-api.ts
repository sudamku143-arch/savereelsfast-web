// The free public API (/api/public/extract): its platforms, limits, error codes and response shape.
// Kept free of runtime imports so it can be unit-tested with plain Node.
import type { PlatformId } from "./platforms";

/**
 * Platforms the public API serves: the ones looked up without the paid residential proxy. Instagram and
 * YouTube go through that proxy (a small daily budget shared with the website), so API traffic could use it
 * up and break the site for its own visitors; they are left out until the API gets its own budget.
 */
export const PUBLIC_API_PLATFORMS: readonly PlatformId[] = ["tiktok", "facebook", "x", "pinterest", "reddit", "threads", "snapchat", "linkedin"];

/** Lookups per IP per day, no key needed. Counted per server instance (see lib/rate-limit.ts), so approximate. */
export const PUBLIC_DAILY_LIMIT = 50;
export const PUBLIC_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The website's own per-IP burst limit also applies (app/api/extract/route.ts, EXTRACT_LIMIT). */
export const PUBLIC_BURST_PER_MINUTE = 20;

export type PublicErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PLATFORM"
  | "RATE_LIMITED"
  | "PRIVATE_CONTENT"
  | "NO_VIDEO"
  | "EXTRACTION_FAILED";

export const PUBLIC_ERROR_STATUS: Record<PublicErrorCode, number> = {
  INVALID_URL: 400,
  PRIVATE_CONTENT: 403,
  UNSUPPORTED_PLATFORM: 404,
  NO_VIDEO: 422,
  RATE_LIMITED: 429,
  EXTRACTION_FAILED: 503,
};

const PUBLIC_ERROR_MESSAGE: Record<PublicErrorCode, string> = {
  INVALID_URL: "The url parameter is missing or is not a link to a single public post.",
  UNSUPPORTED_PLATFORM: `This platform isn't available on the public API. Supported: ${PUBLIC_API_PLATFORMS.join(", ")}.`,
  RATE_LIMITED: `Rate limit reached: ${PUBLIC_DAILY_LIMIT} requests per day per IP (and ${PUBLIC_BURST_PER_MINUTE} per minute).`,
  PRIVATE_CONTENT: "This post is private, age-restricted or needs a login, so it can't be read.",
  NO_VIDEO: "This post has no video to extract.",
  EXTRACTION_FAILED: "The platform didn't answer in time or refused the lookup. Try again later.",
};

/** The website's error codes (lib/errors.ts), mapped onto the public API's smaller, stable set. */
export function publicErrorFor(siteCode: string | undefined): PublicErrorCode {
  switch (siteCode) {
    case "INVALID_URL":
      return "INVALID_URL";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "LOGIN_REQUIRED":
      return "PRIVATE_CONTENT";
    case "UNSUPPORTED_POST":
      return "NO_VIDEO";
    default:
      return "EXTRACTION_FAILED"; // blocked, timed out, busy, not configured, unknown
  }
}

export function publicErrorBody(code: PublicErrorCode, message?: string) {
  return { success: false as const, error: { code, message: message ?? PUBLIC_ERROR_MESSAGE[code] } };
}

type SiteItem = {
  id?: string;
  kind?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number | null;
  quality?: string;
};

type SiteResult = SiteItem & {
  title?: string | null;
  caption?: string | null;
  author?: string | null;
  audioUrl?: string;
  items?: SiteItem[];
};

const PLACEHOLDER_TITLE = /^(Video|Post) by [\w.]+$/;

/** The website's /api/extract result, in the public API's documented snake_case shape. */
export function toPublicResult(site: SiteResult, platform: PlatformId) {
  const title = site.title && !PLACEHOLDER_TITLE.test(site.title.trim()) ? site.title : null;
  const item = (i: SiteItem) => ({
    id: i.id ?? null,
    type: i.kind === "image" ? "image" : "video",
    url: i.videoUrl ?? null,
    thumbnail: i.thumbnailUrl || null,
    duration: typeof i.durationSeconds === "number" ? i.durationSeconds : null,
    quality: i.quality ?? null,
  });
  return {
    success: true as const,
    data: {
      platform,
      id: site.id ?? null,
      title,
      caption: site.caption ?? title,
      author: site.author ?? null,
      duration: typeof site.durationSeconds === "number" ? site.durationSeconds : null,
      thumbnail: site.thumbnailUrl || null,
      video_url: site.videoUrl ?? null,
      audio_url: site.audioUrl ?? null,
      quality: site.quality ?? null,
      items: site.items && site.items.length > 1 ? site.items.map(item) : [],
    },
  };
}
