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

export const runtime = "nodejs";
export const maxDuration = 40;

/**
 * Request contract:
 *   POST /api/extract
 *   body: { url: string }   // Instagram, YouTube, Facebook, Threads, X, Pinterest, TikTok, Reddit or Snapchat video link
 *
 * Success response (200):
 *   {
 *     success: true,
 *     id: string,                 // post/video id, used for the download filename
 *     videoUrl: string,           // direct MP4 URL on the platform's CDN
 *     thumbnailUrl: string,       // "" when none could be found
 *     title: string | null,       // caption
 *     author: string | null,      // handle without "@"
 *     durationSeconds: number | null,
 *     formats?: { quality, url, width, height }[]   // best first
 *   }
 *
 * Error response: { success: false, error: string }
 *   400 missing/unsupported link, 404 private/deleted/unavailable,
 *   429 the platform is rate-limiting us, 500 upstream or unexpected failure,
 *   503 the scraper service needed for a non-Instagram platform isn't configured.
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

export type ReelData = {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
  formats?: ReelFormat[]; // best first; UI falls back to videoUrl when absent
};

const FETCH_TIMEOUT_MS = 8000;
// Render's free tier can cold-start slowly; past this we fall back to the built-in extractor.
const SCRAPER_TIMEOUT_MS = 10000;

/** An error that carries the HTTP status and user-facing message to return. */
class ExtractionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export async function POST(request: NextRequest) {
  let body: ExtractRequestBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";

  if (!url) {
    return NextResponse.json(
      { success: false, error: "Please provide a video link." },
      { status: 400 }
    );
  }

  const parsed = parseSupportedUrl(url);
  if (!parsed) {
    return NextResponse.json(
      {
        success: false,
        error:
          "That doesn't look like a supported video link (Instagram, YouTube, Facebook, Threads, X, Pinterest, TikTok, Reddit or Snapchat).",
      },
      { status: 400 }
    );
  }

  try {
    const data = await extractReelData(parsed.url, parsed.platform);

    if (!data) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Couldn't extract this video. It may be private, deleted, or region-restricted.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status }
      );
    }
    console.error("[/api/extract] unexpected failure:", err);
    return NextResponse.json(
      { success: false, error: "Something went wrong while fetching this video." },
      { status: 500 }
    );
  }
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
      503
    );
  }

  let throttled = false;
  let networkFailures = 0;

  for (const [name, strategy] of strategies) {
    try {
      const data = await strategy(fallbackId ?? "");
      if (data) return data;
    } catch (err) {
      if (err instanceof HttpStatusError && [403, 429].includes(err.status)) {
        throttled = true;
      } else if (!(err instanceof HttpStatusError)) {
        networkFailures += 1;
      }
      console.warn(`[/api/extract] strategy "${name}" failed:`, err);
    }
  }

  if (throttled) {
    throw new ExtractionError(
      "The platform is temporarily limiting requests. Please try again in a minute.",
      429
    );
  }
  if (networkFailures === strategies.length) {
    throw new ExtractionError(
      "Couldn't reach the platform right now. Please try again shortly.",
      500
    );
  }
  return null;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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

type ScraperResponse = {
  success?: boolean;
  id?: string | null;
  title?: string | null;
  author?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  videoUrl?: string | null;
  formats?: { quality?: string; url?: string; width?: number | null; height?: number | null }[];
};

/**
 * Strategy 0: the external yt-dlp microservice (see /scraper). Any failure,
 * timeout or unusable payload returns null/throws so the built-in strategies
 * below take over.
 */
async function extractFromScraper(
  knownId: string,
  reelUrl: string
): Promise<ReelData | null> {
  const base = getScraperBaseUrl();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  let json: ScraperResponse;
  try {
    const res = await fetch(
      `${base}/extract?url=${encodeURIComponent(reelUrl)}`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      // The service answers 400 when yt-dlp can't extract; try the built-ins.
      console.warn(`[/api/extract] scraper service responded ${res.status}`);
      return null;
    }
    json = (await res.json()) as ScraperResponse;
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

  const scraperId =
    typeof json.id === "string" ? json.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";

  return {
    id: knownId || scraperId || "video",
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(json.thumbnail) ?? "",
    title: truncate(typeof json.title === "string" ? json.title : null),
    author: typeof json.author === "string" ? json.author : null,
    durationSeconds: typeof json.duration === "number" ? json.duration : null,
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
