import { NextRequest, NextResponse } from "next/server";
import {
  BROWSER_UA,
  decodeHtmlEntities,
  findFirst,
  isAllowedMediaUrl,
  parseShortcode,
  unescapeJsonFragment,
} from "@/lib/instagram";

export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * Request contract:
 *   POST /api/extract
 *   body: { url: string }
 *
 * Success response (200):
 *   {
 *     success: true,
 *     data: {
 *       videoUrl: string,        // direct MP4 URL (Instagram CDN)
 *       thumbnailUrl: string,    // "" when none could be found
 *       caption: string | null,
 *       author: string | null,   // Instagram handle without "@"
 *       durationSeconds: number | null,
 *       formats?: { label, url, width, height, sizeBytes }[]  // best first
 *     }
 *   }
 *
 * Error response (4xx/5xx):
 *   { success: false, error: string }
 *
 * Status codes: 400 bad body, 422 not a Reel URL, 404 nothing extractable
 * (private/deleted/removed), 429/503 Instagram is throttling us, 502 upstream
 * failure or unexpected error.
 */

type ExtractRequestBody = {
  url?: string;
};

export type ReelFormat = {
  label: string; // e.g. "720p"
  url: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
};

export type ReelData = {
  videoUrl: string;
  thumbnailUrl: string;
  caption: string | null;
  author: string | null;
  durationSeconds: number | null;
  formats?: ReelFormat[]; // optional; UI falls back to videoUrl when absent
};

const REEL_URL_REGEX = /instagram\.com\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/i;
const FETCH_TIMEOUT_MS = 8000;

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
      { success: false, error: "Missing required field: url." },
      { status: 400 }
    );
  }

  if (url.length > 300 || !REEL_URL_REGEX.test(url)) {
    return NextResponse.json(
      { success: false, error: "That doesn't look like a valid Instagram Reel URL." },
      { status: 422 }
    );
  }

  try {
    const data = await extractReelData(url);

    if (!data) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Couldn't extract this Reel. It may be private, deleted, or region-restricted.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status }
      );
    }
    console.error("[/api/extract] unexpected failure:", err);
    return NextResponse.json(
      { success: false, error: "Something went wrong while fetching this Reel." },
      { status: 502 }
    );
  }
}

type Strategy = (shortcode: string) => Promise<ReelData | null>;

/**
 * Tries each extraction strategy in order and returns the first result that
 * contains a playable, allow-listed video URL. A strategy that fails or
 * finds nothing never aborts the others.
 *
 * Returns null when nothing could be extracted (private/deleted content).
 * Throws ExtractionError only when every failure looked like throttling.
 */
async function extractReelData(reelUrl: string): Promise<ReelData | null> {
  const shortcode = parseShortcode(reelUrl);
  if (!shortcode) return null;

  const strategies: [string, Strategy][] = [
    ["embed", extractFromEmbed],
    ["page-meta", extractFromPageMeta],
  ];

  let throttled = false;
  let networkFailures = 0;

  for (const [name, strategy] of strategies) {
    try {
      const data = await strategy(shortcode);
      if (data) return data;
    } catch (err) {
      if (err instanceof HttpStatusError && [401, 403, 429].includes(err.status)) {
        throttled = true;
      } else if (!(err instanceof HttpStatusError)) {
        networkFailures += 1;
      }
      console.warn(`[/api/extract] strategy "${name}" failed:`, err);
    }
  }

  if (throttled) {
    throw new ExtractionError(
      "Instagram is temporarily limiting requests. Please try again in a minute.",
      429
    );
  }
  if (networkFailures === strategies.length) {
    throw new ExtractionError(
      "Couldn't reach Instagram right now. Please try again shortly.",
      502
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

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
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

function toSafeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = unescapeJsonFragment(value);
  return isAllowedMediaUrl(cleaned) ? cleaned : null;
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

  let videoUrl: string | null = null;
  let thumbnailUrl: string | null = null;
  let caption: string | null = null;
  let author: string | null = null;
  let duration: number | null = null;

  // Preferred path: parse the embedded JSON document.
  const contextMatch = /"contextJSON"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(html);
  if (contextMatch) {
    try {
      const inner = JSON.parse(JSON.parse(contextMatch[1]) as string);
      videoUrl = toSafeMediaUrl(findFirst(inner, "video_url"));
      thumbnailUrl =
        toSafeMediaUrl(findFirst(inner, "display_url")) ??
        toSafeMediaUrl(findFirst(inner, "thumbnail_src"));
      const captionNode = findFirst(inner, "edge_media_to_caption");
      const text = findFirst(captionNode, "text");
      caption = typeof text === "string" ? text : null;
      const username = findFirst(findFirst(inner, "owner"), "username");
      author = typeof username === "string" ? username : null;
      const seconds = findFirst(inner, "video_duration");
      duration = typeof seconds === "number" ? seconds : null;
    } catch {
      // Fall through to the regex path below.
    }
  }

  // Fallback path: scrape the raw markup for the same keys.
  if (!videoUrl) {
    const raw = /video_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"/.exec(html)?.[1];
    videoUrl = toSafeMediaUrl(raw);
  }
  if (!videoUrl) return null;

  if (!thumbnailUrl) {
    const raw = /display_url\\*"\s*:\s*\\*"(https?:[^"]+?)\\*"/.exec(html)?.[1];
    thumbnailUrl = toSafeMediaUrl(raw);
  }
  if (!caption) {
    const raw = /class="Caption"[^>]*>[\s\S]*?<div class="CaptionContent"[^>]*>([\s\S]*?)<\/div>/.exec(
      html
    )?.[1];
    if (raw) {
      caption = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
    }
  }

  return {
    videoUrl,
    thumbnailUrl: thumbnailUrl ?? "",
    caption: truncate(caption),
    author,
    durationSeconds: duration,
  };
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

/** Strategy 2: Open Graph tags on the public Reel page (og:video / og:image). */
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
    videoUrl,
    thumbnailUrl: toSafeMediaUrl(readMeta(html, "og:image")) ?? "",
    caption: truncate(captionMatch?.[1] ?? description),
    author: handleMatch?.[1] ?? authorMatch?.[1]?.trim() ?? null,
    durationSeconds: null,
  };
}
