import { NextRequest, NextResponse } from "next/server";
import { BROWSER_UA, isAllowedMediaUrl, refererFor } from "@/lib/instagram";
import { parseSupportedUrl } from "@/lib/platforms";
import type { ErrorCode } from "@/lib/errors";
import { isAudioExtension } from "@/lib/download";
import { checkRateLimit, clientIp, type RateLimitStore } from "@/lib/rate-limit";

// Edge runtime streams the body straight through, so large videos are not
// subject to the buffered-response size limit of serverless functions.
export const runtime = "edge";

const HEADER_TIMEOUT_MS = 10000;
const FALLBACK_HEADER_TIMEOUT_MS = 30000; // the scraper re-resolves the post first
const MAX_BYTES = 200 * 1024 * 1024;

// Downloads are the expensive endpoint (bandwidth), so they get the tighter guard. A carousel's
// "Download all" starts one download a second, which stays well inside this.
const DOWNLOAD_LIMIT = 40;
const DOWNLOAD_WINDOW_MS = 60_000;
const limiterStore: RateLimitStore = new Map();

// CDNs whose links are bound to the IP that resolved them. The scraper resolved
// these, so they can only be downloaded from the scraper's IP: skip the direct
// attempt (it would just 403) and stream through the scraper.
const IP_BOUND_HOSTS = ["googlevideo.com"];

function isIpBound(target: string): boolean {
  const host = new URL(target).hostname.toLowerCase();
  return IP_BOUND_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const AUDIO_CONTENT_TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  opus: "audio/ogg",
};

type Media = { kind: "video" | "audio"; ext: string; contentType: string };

function safeFilename(rawId: string | null, media: Media): string {
  const id = (rawId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `savereelsfast-${id || "reel"}.${media.ext}`;
}

function fail(message: string, status: number, code: ErrorCode) {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function scraperBase(): string | null {
  const raw = process.env.SCRAPER_SERVICE_URL?.trim().replace(/\/+$/, "");
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

/** Only a plain single range is forwarded upstream. */
function validRange(value: string | null): string | null {
  return value && /^bytes=\d*-\d*$/.test(value.trim()) ? value.trim() : null;
}

function attachmentHeaders(filename: string, length: number, contentType: string): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (length > 0) {
    headers.set("Content-Length", String(length));
    // Streaming responses can lose Content-Length on the way to the browser (it falls back to
    // chunked encoding), so the size is repeated in a header the download progress bar can rely on.
    headers.set("X-File-Size", String(length));
    headers.set("Access-Control-Expose-Headers", "X-File-Size");
  }
  return headers;
}

/**
 * Wrap an upstream video/audio response as our attachment response, keeping
 * the byte-range headers so resumed downloads and seeking keep working.
 */
function respondWith(upstream: Response, filename: string, media: Media): Response {
  const length = Number(upstream.headers.get("content-length") ?? 0);
  const headers = attachmentHeaders(filename, length, media.contentType);
  const partial = upstream.status === 206;
  const contentRange = upstream.headers.get("content-range");
  if (partial && contentRange) headers.set("Content-Range", contentRange);
  if (partial || upstream.headers.get("accept-ranges")?.toLowerCase() === "bytes") {
    headers.set("Accept-Ranges", "bytes");
  }
  return new Response(upstream.body, { status: partial ? 206 : 200, headers });
}

/** Fetch with a timeout that only covers waiting for the response headers. */
async function fetchWithHeaderTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Try the CDN URL directly. Returns a streaming response, or null when it can't be used. */
async function tryDirect(
  target: string,
  filename: string,
  media: Media,
  range: string | null
): Promise<Response | null> {
  let upstream: Response;
  try {
    upstream = await fetchWithHeaderTimeout(
      target,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: refererFor(target),
          Accept:
            media.kind === "audio" ? "audio/*,*/*;q=0.5" : "video/mp4,video/*;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
          ...(range ? { Range: range } : {}),
        },
        redirect: "manual", // never follow a redirect off the allow-list
      },
      HEADER_TIMEOUT_MS
    );
  } catch {
    return null;
  }

  if (!upstream.ok || !upstream.body) {
    console.warn(
      `[/api/download] CDN responded ${upstream.status} for ${new URL(target).hostname}`
    );
    return null;
  }

  const type = upstream.headers.get("content-type") ?? "";
  const accepted =
    media.kind === "audio"
      ? ["audio/", "video/mp4", "video/webm", "application/octet-stream"]
      : ["video/", "application/octet-stream"];
  if (!accepted.some((prefix) => type.startsWith(prefix))) return null;

  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return null;

  return respondWith(upstream, filename, media);
}

type ScraperFailure = { status: number; code: ErrorCode; message: string };

/** Call a streaming scraper endpoint and return its body as our attachment response. */
async function fromScraper(
  path: string,
  filename: string,
  media: Media,
  range: string | null = null
): Promise<Response | ScraperFailure> {
  const base = scraperBase();
  if (!base) {
    return {
      status: 502,
      code: "STREAM_EXPIRED_OR_BLOCKED",
      message: "The platform refused this download link. Please fetch the video again.",
    };
  }

  const key = process.env.SCRAPER_SHARED_SECRET;
  let res: Response;
  try {
    res = await fetchWithHeaderTimeout(
      `${base}${path}`,
      {
        headers: { ...(key ? { "X-Scraper-Key": key } : {}), ...(range ? { Range: range } : {}) },
        cache: "no-store",
      },
      FALLBACK_HEADER_TIMEOUT_MS
    );
  } catch {
    return {
      status: 504,
      code: "PLATFORM_TIMEOUT",
      message: "The download service didn't respond in time. Please try again shortly.",
    };
  }

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as {
      detail?: { code?: ErrorCode; message?: string };
    } | null;
    if (res.status === 401 || body?.detail?.code === "NOT_CONFIGURED") {
      console.error(
        `[/api/download] scraper answered ${res.status}: check that SCRAPER_SHARED_SECRET matches on the site and the scraper.`
      );
    }
    return {
      status: res.status >= 400 ? res.status : 502,
      code: body?.detail?.code ?? "STREAM_EXPIRED_OR_BLOCKED",
      message: body?.detail?.message ?? "Couldn't fetch the video. Please try again.",
    };
  }

  return respondWith(res, filename, media);
}

/**
 * Stream the CDN URL through the scraper (`/stream`). The scraper fetches it
 * from its own IP, which is the one the link was issued to.
 */
function viaScraperStream(
  target: string,
  id: string | null,
  filename: string,
  media: Media,
  range: string | null
) {
  const params = new URLSearchParams({
    url: target,
    referer: refererFor(target),
    id: id ?? "video",
    kind: media.kind,
    ext: media.ext,
  });
  return fromScraper(`/stream?${params.toString()}`, filename, media, range);
}

/**
 * Last resort: have the scraper re-resolve the post itself (`/download`), for
 * links that expired or that the CDN refuses even from the scraper.
 */
function viaScraperResolve(sourceUrl: string, id: string | null, filename: string, media: Media) {
  const params = new URLSearchParams({ url: sourceUrl, id: id ?? "video", kind: media.kind });
  return fromScraper(`/download?${params.toString()}`, filename, media);
}

/**
 * GET /api/download?url=<CDN URL>&id=<post id>&src=<post URL>&kind=video|audio&ext=m4a
 *
 * Streams the video back from our own origin with
 * `Content-Disposition: attachment`, which is what makes browsers save the
 * file instead of playing it (the `download` attribute is ignored for
 * cross-origin URLs).
 *
 * Order of attempts:
 *   1. Direct from the CDN (skipped for IP-bound CDNs such as YouTube).
 *   2. Through the scraper's /stream, so the CDN sees the IP that resolved the link.
 *   3. Through the scraper's /download, which re-resolves the post (needs `src`).
 */
export async function GET(request: NextRequest) {
  const ip = clientIp(request.headers);
  if (ip) {
    const result = checkRateLimit(limiterStore, ip, DOWNLOAD_LIMIT, DOWNLOAD_WINDOW_MS);
    if (!result.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many downloads. Please wait a moment and try again.", code: "RATE_LIMITED" },
        { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(result.retryAfterSeconds) } }
      );
    }
  }

  const { searchParams } = request.nextUrl;
  const target = searchParams.get("url");

  if (!target || !isAllowedMediaUrl(target)) {
    return fail("Invalid or unsupported video URL.", 400, "INVALID_URL");
  }

  const id = searchParams.get("id");
  const requestedExt = searchParams.get("ext");
  const media: Media =
    searchParams.get("kind") === "audio"
      ? {
          kind: "audio",
          ext: isAudioExtension(requestedExt) ? requestedExt : "m4a",
          contentType: AUDIO_CONTENT_TYPES[isAudioExtension(requestedExt) ? requestedExt : "m4a"],
        }
      : { kind: "video", ext: "mp4", contentType: "video/mp4" };
  const filename = safeFilename(id, media);
  const range = validRange(request.headers.get("range"));

  if (!isIpBound(target)) {
    const direct = await tryDirect(target, filename, media, range);
    if (direct) return direct;
  }

  let failure: ScraperFailure | null = null;

  const streamed = await viaScraperStream(target, id, filename, media, range);
  if (streamed instanceof Response) return streamed;
  failure = streamed;

  const src = searchParams.get("src");
  const parsedSource = src ? parseSupportedUrl(src) : null;
  if (parsedSource) {
    const resolved = await viaScraperResolve(parsedSource.url, id, filename, media);
    if (resolved instanceof Response) return resolved;
    failure = resolved;
  }

  return fail(
    failure.message || "This video link has expired or was blocked. Please fetch the video again.",
    failure.status,
    failure.code
  );
}
