import { NextRequest, NextResponse } from "next/server";
import {
  BROWSER_UA,
  decodeHtmlEntities,
  findFirst,
  isAllowedMediaUrl,
  parseShortcode,
  unescapeJsonFragment,
} from "@/lib/instagram";
import { parseSupportedUrl, type PlatformId } from "@/lib/platforms";
import { isErrorCode, type ErrorCode, type ResultWarning } from "@/lib/errors";
import { isAudioExtension } from "@/lib/download";
import { checkRateLimit, clientIp, type RateLimitStore } from "@/lib/rate-limit";
import { hasTimeFor, remainingMs } from "@/lib/time-budget";
import { AsyncLocalStorage } from "node:async_hooks";

export const runtime = "nodejs";
export const maxDuration = 40;

/**
 * Request contract:
 *   GET  /api/extract?url=<link>   (CDN-cacheable: s-maxage=3600, stale-while-revalidate=86400)
 *   POST /api/extract   body: { url: string }   (never cached)
 *   link:   // Instagram, YouTube, Facebook, Threads, X, Pinterest, TikTok, Reddit or Snapchat video link
 *
 * Success response (200):
 *   {
 *     success: true,
 *     id: string,                 // post/video id, used for the download filename
 *     platform: string,           // instagram | youtube | facebook | …
 *     sourceUrl: string,          // canonical post URL (lets /api/download fall back to the scraper)
 *     videoUrl: string,           // direct MP4 URL on the platform's CDN
 *     thumbnailUrl: string,       // "" when none could be found
 *     title: string | null,       // caption
 *     author: string | null,      // handle without "@"
 *     durationSeconds: number | null,
 *     quality?: string,           // e.g. "720p"
 *     audio?: "yes" | "no" | "unknown",
 *     warning?: "NO_AUDIO",       // only a video-only stream was available
 *     audioUrl?: string,          // separate audio-only stream (M4A/WebM; not transcoded)
 *     audioExt?: string,
 *     items?: ReelItem[],         // present only for multi-video posts (carousels)
 *     formats?: { quality, url, width, height }[]   // best first
 *   }
 *
 * Error response: { success: false, error: string, code: ErrorCode }
 *   LOGIN_REQUIRED 403, UNSUPPORTED_POST 422, STREAM_EXPIRED_OR_BLOCKED 429/502,
 *   PLATFORM_TIMEOUT 504, EXTRACTION_FAILED 404, INVALID_URL 400,
 *   NOT_CONFIGURED 503, SERVER_BUSY 503 (with Retry-After), FILE_TOO_LARGE 413, unexpected failures 500.
 */

type ExtractRequestBody = {
  url?: string;
};

export type ReelFormat = {
  quality: string; // e.g. "720p"
  url: string;
  width: number | null;
  height: number | null;
};

/** One video of a multi-video post (Instagram carousel, multi-video tweet). */
export type ReelItem = {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  durationSeconds: number | null;
  quality?: string;
  audio?: "yes" | "no" | "unknown";
  warning?: ResultWarning;
  audioUrl?: string;
  audioExt?: string;
};

export type ReelData = {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
  formats?: ReelFormat[]; // best first; UI falls back to videoUrl when absent
  quality?: string;
  audio?: "yes" | "no" | "unknown";
  warning?: ResultWarning;
  audioUrl?: string;
  audioExt?: string;
  items?: ReelItem[];
};

// Every step of one lookup shares this budget (the page gives up at 10 s, so the site must answer before that):
// the scraper first, then, for Instagram, the built-in strategies. Steps use what is left, never more.
const LOOKUP_BUDGET_MS = 9000;
const FETCH_TIMEOUT_MS = 4000; // a built-in strategy fetching one Instagram page
// YouTube gets more room at every step: its requests may take up to 8 s each on a small host, and a blocked
// lookup can try a second route. Every other platform keeps the short limits.
const YOUTUBE_LOOKUP_BUDGET_MS = 13000;
const YOUTUBE_SCRAPER_TIMEOUT_MS = 12000;
const lookupBudget = new AsyncLocalStorage<{ deadline: number; scraperMs: number }>();

/** How long the scraper may be waited for in this lookup (longer for YouTube). */
function scraperStepMs(): number {
  return lookupBudget.getStore()?.scraperMs ?? SCRAPER_TIMEOUT_MS;
}
class BudgetExhausted extends Error {}

/** Time a step may use right now: its own limit, capped by what is left of this lookup's budget. */
function stepTimeout(cap: number): number {
  const budget = lookupBudget.getStore();
  return budget ? remainingMs(budget.deadline, cap) : cap;
}
function timeLeft(): boolean {
  const budget = lookupBudget.getStore();
  return budget ? hasTimeFor(budget.deadline) : true;
}
// Render's free tier can cold-start slowly; past this we fall back to the built-in extractor.
// The scraper gives every lookup a hard 5 s limit and answers a block or a stall on its own, so the site
// waits only a little longer than that. A visitor never sits through a long hang.
const SCRAPER_TIMEOUT_MS = 7000;
// Only "busy" is worth a quiet second try. A block or a timeout would just repeat, and waiting twice is
// exactly the slow failure this is meant to avoid: the visitor gets the clear message straight away.
const TRANSIENT_CODES: ErrorCode[] = ["SERVER_BUSY"];
const RETRY_PAUSE_MS = 1000;

/** An error that carries the HTTP status and user-facing message to return. */
class ExtractionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

// Per-visitor limits. CDN-cached repeats never reach this code, so only real lookups count.
const EXTRACT_LIMIT = 20;
const EXTRACT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 4096;
const limiterStore: RateLimitStore = new Map();

function rateLimited(request: NextRequest): NextResponse | null {
  const ip = clientIp(request.headers);
  if (!ip) return null;
  const result = checkRateLimit(limiterStore, ip, EXTRACT_LIMIT, EXTRACT_WINDOW_MS);
  if (result.allowed) return null;
  return NextResponse.json(
    { success: false, error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(result.retryAfterSeconds) } }
  );
}

// Identical successful lookups are served from Vercel's edge cache for an hour (and may be
// served stale for a day while a fresh copy is fetched). Errors are never cached.
const CACHE_CONTROL_OK = "public, s-maxage=3600, stale-while-revalidate=86400";

function respond(
  body: Record<string, unknown>,
  status: number,
  { cacheable = false, retryAfter }: { cacheable?: boolean; retryAfter?: number } = {}
) {
  const headers: Record<string, string> = {
    "Cache-Control": cacheable && status === 200 ? CACHE_CONTROL_OK : "no-store",
  };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return NextResponse.json(body, { status, headers });
}

async function handleExtract(rawUrl: string, cacheable: boolean) {
  if (!rawUrl) {
    return respond(
      { success: false, error: "Please provide a video link.", code: "INVALID_URL" },
      400
    );
  }

  const parsed = parseSupportedUrl(rawUrl);
  if (!parsed) {
    return respond(
      {
        success: false,
        error:
          "That doesn't look like a supported video link (Instagram, YouTube, Facebook, Threads, X, Pinterest, TikTok, Reddit or Snapchat).",
        code: "INVALID_URL",
      },
      400
    );
  }

  try {
    const data = await extractReelData(parsed.url, parsed.platform);

    if (!data) {
      return respond(
        {
          success: false,
          error:
            "Couldn't extract this video. It may be private, deleted, or region-restricted.",
          code: "EXTRACTION_FAILED",
        },
        404
      );
    }

    return respond(
      { success: true, ...data, platform: parsed.platform, sourceUrl: parsed.url },
      200,
      { cacheable }
    );
  } catch (err) {
    if (err instanceof ExtractionError) {
      return respond(
        { success: false, error: err.message, code: err.code },
        err.status,
        { retryAfter: err.code === "SERVER_BUSY" ? 5 : undefined }
      );
    }
    console.error("[/api/extract] unexpected failure:", err);
    return respond(
      {
        success: false,
        error: "Something went wrong while fetching this video.",
        code: "EXTRACTION_FAILED",
      },
      500
    );
  }
}

/**
 * GET /api/extract?url=<video link>
 *
 * The browser uses this form so that identical lookups are cacheable by the
 * CDN: a viral link is extracted once per hour, not once per visitor.
 */
export async function GET(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;
  const url = request.nextUrl.searchParams.get("url")?.trim() ?? "";
  return handleExtract(url, true);
}

/** POST { url } — same result as GET, never cached (kept for API clients). */
export async function POST(request: NextRequest) {
  const limited = rateLimited(request);
  if (limited) return limited;

  // A link is tiny; refuse anything big before parsing it.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return respond({ success: false, error: "Request body is too large.", code: "INVALID_URL" }, 413);
  }
  let body: ExtractRequestBody;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return respond({ success: false, error: "Request body is too large.", code: "INVALID_URL" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return respond({ success: false, error: "Request body must be valid JSON." }, 400);
  }
  return handleExtract(typeof body?.url === "string" ? body.url.trim() : "", false);
}

type Strategy = (shortcode: string) => Promise<ReelData | null>;

/**
 * Tries each extraction strategy in order and returns the first result that
 * contains a playable, allow-listed video URL. A strategy that fails or
 * finds nothing never aborts the others.
 *
 * Instagram has built-in fallbacks (embed / GraphQL / page meta). Every other
 * platform relies on the yt-dlp scraper service alone.
 *
 * Returns null when nothing could be extracted (private/deleted content).
 * Throws ExtractionError only when every failure looked like throttling.
 */
async function extractReelData(
  pageUrl: string,
  platform: PlatformId
): Promise<ReelData | null> {
  const youtube = platform === "youtube";
  const budget = youtube ? YOUTUBE_LOOKUP_BUDGET_MS : LOOKUP_BUDGET_MS;
  const scraperMs = youtube ? YOUTUBE_SCRAPER_TIMEOUT_MS : SCRAPER_TIMEOUT_MS;
  return lookupBudget.run({ deadline: Date.now() + budget, scraperMs }, () =>
    extractReelDataWithinBudget(pageUrl, platform)
  );
}

async function extractReelDataWithinBudget(
  pageUrl: string,
  platform: PlatformId
): Promise<ReelData | null> {
  const scraperConfigured = getScraperBaseUrl() !== null;
  const strategies: [string, Strategy][] = [];
  let fallbackId: string | null = null;

  if (scraperConfigured) {
    strategies.push(["scraper", (id) => extractFromScraper(id, pageUrl)]);
  }

  if (platform === "instagram") {
    fallbackId = parseShortcode(pageUrl);
    // Share links (/share/reel/…) have no shortcode; only the scraper can resolve them.
    if (!fallbackId && !scraperConfigured) return null;
    if (fallbackId) strategies.push(
      ["embed", extractFromEmbed],
      ["graphql", extractFromGraphql],
      ["page-meta", extractFromPageMeta]
    );
  } else if (!scraperConfigured) {
    throw new ExtractionError(
      "Downloads from this platform aren't available right now. Please try again later.",
      503,
      "NOT_CONFIGURED"
    );
  }

  let throttled = false;
  let networkFailures = 0;
  let scraperFailure: ScraperFailure | null = null;

  for (const [name, strategy] of strategies) {
    if (!timeLeft()) {
      networkFailures += 1; // out of time: stop here rather than start requests that cannot finish
      break;
    }
    try {
      const data = await strategy(fallbackId ?? "");
      if (data) return data;
    } catch (err) {
      if (err instanceof ScraperFailure) {
        scraperFailure = err;
        if (err.code === "PLATFORM_TIMEOUT") networkFailures += 1;
      } else if (err instanceof HttpStatusError && [403, 429].includes(err.status)) {
        throttled = true;
      } else if (!(err instanceof HttpStatusError)) {
        networkFailures += 1;
      }
      console.warn(`[/api/extract] strategy "${name}" failed:`, err);
    }
  }

  // The scraper's diagnosis is the most specific one we have (it saw the real
  // yt-dlp error), so it wins over the built-in strategies' guesses.
  const specific: ErrorCode[] = [
    "LOGIN_REQUIRED",
    "UNSUPPORTED_POST",
    "STREAM_EXPIRED_OR_BLOCKED",
    "PLATFORM_TIMEOUT",
    "SERVER_BUSY",
    "FILE_TOO_LARGE",
    "NOT_CONFIGURED",
  ];
  if (scraperFailure && specific.includes(scraperFailure.code)) {
    throw new ExtractionError(scraperFailure.message, scraperFailure.status, scraperFailure.code);
  }

  if (throttled) {
    throw new ExtractionError(
      "The platform is temporarily limiting requests. Please try again in a minute.",
      429,
      "STREAM_EXPIRED_OR_BLOCKED"
    );
  }
  if (networkFailures === strategies.length) {
    throw new ExtractionError(
      "Couldn't reach the platform right now. Please try again shortly.",
      504,
      "PLATFORM_TIMEOUT"
    );
  }
  return null;
}

/** A coded failure reported by the scraper service. */
class ScraperFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode
  ) {
    super(message);
    this.name = "ScraperFailure";
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

async function fetchText(
  url: string,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  if (!timeLeft()) throw new BudgetExhausted("lookup time budget used up");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), stepTimeout(FETCH_TIMEOUT_MS));
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpStatusError(res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function getScraperBaseUrl(): string | null {
  const raw = process.env.SCRAPER_SERVICE_URL?.trim().replace(/\/+$/, "");
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

type ScraperItem = {
  id?: string | null;
  title?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  videoUrl?: string | null;
  quality?: string | null;
  audio?: string | null;
  warning?: string | null;
  audioUrl?: string | null;
  audioExt?: string | null;
};

type ScraperResponse = {
  success?: boolean;
  id?: string | null;
  title?: string | null;
  author?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  videoUrl?: string | null;
  audio?: "yes" | "no" | "unknown";
  warning?: string | null;
  quality?: string | null;
  audioUrl?: string | null;
  audioExt?: string | null;
  items?: ScraperItem[];
  formats?: { quality?: string; url?: string; width?: number | null; height?: number | null }[];
};

/** Sent with every scraper call when SCRAPER_SHARED_SECRET is configured. */
function scraperHeaders(): Record<string, string> {
  const key = process.env.SCRAPER_SHARED_SECRET;
  return key ? { "X-Scraper-Key": key } : {};
}

function audioFields(raw: { audioUrl?: string | null; audioExt?: string | null }) {
  const url = toSafeMediaUrl(raw.audioUrl);
  const ext = raw.audioExt;
  return url && isAudioExtension(ext) ? { audioUrl: url, audioExt: ext } : {};
}

function cleanQuality(value: string | null | undefined) {
  return typeof value === "string" && /^\d{3,4}p$/.test(value) ? { quality: value } : {};
}

function cleanAudioState(
  value: string | null | undefined
): { audio?: "yes" | "no" | "unknown" } {
  return value === "yes" || value === "no" || value === "unknown" ? { audio: value } : {};
}

function mapScraperItem(raw: ScraperItem, fallbackId: string, index: number): ReelItem | null {
  const videoUrl = toSafeMediaUrl(raw.videoUrl);
  if (!videoUrl) return null;
  const id = typeof raw.id === "string" ? raw.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";
  return {
    id: id || `${fallbackId}-${index + 1}`,
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(raw.thumbnail) ?? "",
    title: truncate(typeof raw.title === "string" ? raw.title : null),
    durationSeconds: typeof raw.duration === "number" ? raw.duration : null,
    ...cleanQuality(raw.quality),
    ...cleanAudioState(raw.audio),
    ...(raw.warning === "NO_AUDIO" ? { warning: "NO_AUDIO" as const } : {}),
    ...audioFields(raw),
  };
}

/**
 * Strategy 0: the external yt-dlp microservice (see /scraper). Any failure,
 * timeout or unusable payload returns null/throws so the built-in strategies
 * below take over.
 */
async function extractFromScraper(
  knownId: string,
  reelUrl: string
): Promise<ReelData | null> {
  // One quiet second attempt, so a passing block is not shown to the visitor as an error.
  try {
    return await extractFromScraperOnce(knownId, reelUrl);
  } catch (err) {
    if (!(err instanceof ScraperFailure) || !TRANSIENT_CODES.includes(err.code)) throw err;
    // Only if a whole second attempt still fits; otherwise the answer is "busy" right now.
    if (stepTimeout(scraperStepMs()) < RETRY_PAUSE_MS + 2500) throw err;
    console.warn(`[/api/extract] ${err.code}: retrying once`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return await extractFromScraperOnce(knownId, reelUrl);
  }
}

async function extractFromScraperOnce(
  knownId: string,
  reelUrl: string
): Promise<ReelData | null> {
  const base = getScraperBaseUrl();
  if (!base) return null;

  if (!timeLeft()) throw new BudgetExhausted("lookup time budget used up");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), stepTimeout(scraperStepMs()));
  let json: ScraperResponse;
  try {
    const res = await fetch(`${base}/extract?url=${encodeURIComponent(reelUrl)}`, {
      headers: { Accept: "application/json", ...scraperHeaders() },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      // Error bodies look like { detail: { code, message } }.
      const body = (await res.json().catch(() => null)) as {
        detail?: { code?: string; message?: string } | string;
      } | null;
      const detail = body && typeof body.detail === "object" ? body.detail : null;
      if (res.status === 401 || detail?.code === "NOT_CONFIGURED") {
        // Our key was refused, or the scraper is locked because it has none: a deployment mistake,
        // not the visitor's fault. Say so in the logs and don't blame their link. (A busy scraper is
        // also a 503, but it says SERVER_BUSY and is handled like any other coded failure below.)
        console.error(
          `[/api/extract] scraper answered ${res.status}: SCRAPER_SHARED_SECRET on this site and on the scraper do not match, or the scraper has none.`
        );
        throw new ScraperFailure(
          "Downloads are temporarily unavailable. Please try again later.",
          503,
          "NOT_CONFIGURED"
        );
      }
      const code: ErrorCode = isErrorCode(detail?.code) ? detail.code : "EXTRACTION_FAILED";
      console.warn(`[/api/extract] scraper service responded ${res.status} (${detail?.code ?? "no code"})`);
      throw new ScraperFailure(
        detail?.message ?? "Couldn't extract this video.",
        res.status >= 400 && res.status < 600 ? res.status : 404,
        code
      );
    }
    json = (await res.json()) as ScraperResponse;
  } catch (err) {
    if (err instanceof ScraperFailure) throw err;
    // Timeout or network error reaching the scraper itself.
    throw new ScraperFailure(
      "The platform didn't respond in time. Please try again shortly.",
      504,
      "PLATFORM_TIMEOUT"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!json || json.success === false) return null;

  const formats: ReelFormat[] = [];
  for (const f of json.formats ?? []) {
    const url = toSafeMediaUrl(f.url);
    if (!url) continue;
    formats.push({
      quality: f.quality || (f.height ? `${f.height}p` : "HD"),
      url,
      width: typeof f.width === "number" ? f.width : null,
      height: typeof f.height === "number" ? f.height : null,
    });
  }
  formats.sort(
    (a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0)
  );

  const videoUrl = formats[0]?.url ?? toSafeMediaUrl(json.videoUrl);
  if (!videoUrl) return null;

  const postId =
    knownId || (typeof json.id === "string" ? json.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "") || "video";
  const items = (json.items ?? [])
    .map((raw, index) => mapScraperItem(raw, postId, index))
    .filter((item): item is ReelItem => item !== null);

  const scraperId =
    typeof json.id === "string" ? json.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";

  return {
    id: knownId || scraperId || "video",
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(json.thumbnail) ?? "",
    title: truncate(typeof json.title === "string" ? json.title : null),
    author: typeof json.author === "string" ? json.author : null,
    durationSeconds: typeof json.duration === "number" ? json.duration : null,
    ...cleanQuality(json.quality),
    ...cleanAudioState(json.audio),
    ...(json.warning === "NO_AUDIO" ? { warning: "NO_AUDIO" as const } : {}),
    ...audioFields(json),
    ...(items.length > 1 ? { items } : {}),
    ...(formats.length > 0 ? { formats } : {}),
  };
}

function toSafeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = unescapeJsonFragment(value);
  return isAllowedMediaUrl(cleaned) ? cleaned : null;
}

/** Builds a best-first list of MP4 formats from Instagram's `video_versions` array. */
function buildFormats(versions: unknown): ReelFormat[] {
  if (!Array.isArray(versions)) return [];
  const byQuality = new Map<string, ReelFormat>();

  for (const item of versions) {
    if (!item || typeof item !== "object") continue;
    const { url, width, height } = item as Record<string, unknown>;
    const safeUrl = toSafeMediaUrl(url);
    if (!safeUrl) continue;
    const w = typeof width === "number" ? width : null;
    const h = typeof height === "number" ? height : null;
    const short = w && h ? Math.min(w, h) : null;
    const quality = short ? `${short}p` : "HD";
    const existing = byQuality.get(quality);
    if (
      !existing ||
      (w ?? 0) * (h ?? 0) > (existing.width ?? 0) * (existing.height ?? 0)
    ) {
      byQuality.set(quality, { quality, url: safeUrl, width: w, height: h });
    }
  }

  return [...byQuality.values()].sort(
    (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)
  );
}

/** Pulls video, poster, caption, author and duration out of an Instagram media JSON tree. */
function parseMediaJson(tree: unknown, shortcode: string): ReelData | null {
  const formats = buildFormats(findFirst(tree, "video_versions"));
  const videoUrl =
    formats[0]?.url ?? toSafeMediaUrl(findFirst(tree, "video_url"));
  if (!videoUrl) return null;

  const thumbnail =
    toSafeMediaUrl(findFirst(tree, "display_url")) ??
    toSafeMediaUrl(findFirst(tree, "thumbnail_src")) ??
    toSafeMediaUrl(findFirst(findFirst(tree, "image_versions2"), "url"));

  const captionNode = findFirst(tree, "edge_media_to_caption");
  const captionText =
    findFirst(captionNode, "text") ??
    findFirst(findFirst(tree, "caption"), "text");
  const username = findFirst(findFirst(tree, "owner"), "username");
  const seconds = findFirst(tree, "video_duration");

  return {
    id: shortcode,
    videoUrl,
    thumbnailUrl: thumbnail ?? "",
    title: truncate(typeof captionText === "string" ? captionText : null),
    author: typeof username === "string" ? username : null,
    durationSeconds: typeof seconds === "number" ? seconds : null,
    ...(formats.length > 0 ? { formats } : {}),
  };
}

function truncate(text: string | null, max = 300): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Strategy 1: the public embed page. Instagram inlines the media JSON
 * ("contextJSON") for embeddable public posts, so no login is required.
 */
async function extractFromEmbed(shortcode: string): Promise<ReelData | null> {
  const html = await fetchText(
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`
  );

  // Preferred path: parse the embedded JSON document.
  const contextMatch = /"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(html);
  if (contextMatch) {
    try {
      const inner = JSON.parse(JSON.parse(contextMatch[1]) as string);
      const parsed = parseMediaJson(inner, shortcode);
      if (parsed) return parsed;
    } catch {
      // Fall through to the regex path below.
    }
  }

  // Fallback path: scrape the raw markup for the same keys.
  const rawVideo = /video_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"/.exec(html)?.[1];
  const videoUrl = toSafeMediaUrl(rawVideo);
  if (!videoUrl) return null;

  const rawThumb = /display_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"/.exec(html)?.[1];
  const rawCaption = /class="CaptionContent"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  const caption = rawCaption
    ? decodeHtmlEntities(rawCaption.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
    : null;

  return {
    id: shortcode,
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(rawThumb) ?? "",
    title: truncate(caption),
    author: null,
    durationSeconds: null,
  };
}

/**
 * Strategy 2 (best effort): Instagram's public web GraphQL query. The
 * `doc_id` is a persisted-query hash that Instagram rotates, so this is
 * expected to fail occasionally; the other strategies cover for it.
 */
const GRAPHQL_DOC_ID = "8845758582119845";

async function extractFromGraphql(shortcode: string): Promise<ReelData | null> {
  const variables = encodeURIComponent(JSON.stringify({ shortcode }));
  const body = await fetchText(
    `https://www.instagram.com/graphql/query/?doc_id=${GRAPHQL_DOC_ID}&variables=${variables}`,
    {
      Accept: "application/json",
      "X-IG-App-ID": "936619743392459",
      "X-Requested-With": "XMLHttpRequest",
    }
  );
  const json: unknown = JSON.parse(body);
  return parseMediaJson(findFirst(json, "xdt_shortcode_media") ?? json, shortcode);
}

function readMeta(html: string, property: string): string | null {
  const tag = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i"
  ).exec(html)?.[0];
  if (!tag) return null;
  const content = /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const value = content?.[1] ?? content?.[2];
  return value ? decodeHtmlEntities(value) : null;
}

/** Strategy 3: Open Graph tags on the public Reel page (og:video / og:image). */
async function extractFromPageMeta(shortcode: string): Promise<ReelData | null> {
  const html = await fetchText(`https://www.instagram.com/reel/${shortcode}/`);

  const videoUrl =
    toSafeMediaUrl(readMeta(html, "og:video:secure_url")) ??
    toSafeMediaUrl(readMeta(html, "og:video"));
  if (!videoUrl) return null;

  const title = readMeta(html, "og:title");
  const description = readMeta(html, "og:description");
  // og:title looks like: 'Jane Doe on Instagram: "caption…"'
  const authorMatch = title ? /^(.+?) on Instagram/i.exec(title) : null;
  const handleMatch = description ? /@([A-Za-z0-9._]+)/.exec(description) : null;
  const captionMatch = title ? /on Instagram:\s*["“]([\s\S]*?)["”]?$/i.exec(title) : null;

  return {
    id: shortcode,
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(readMeta(html, "og:image")) ?? "",
    title: truncate(captionMatch?.[1] ?? description),
    author: handleMatch?.[1] ?? authorMatch?.[1]?.trim() ?? null,
    durationSeconds: null,
  };
}
