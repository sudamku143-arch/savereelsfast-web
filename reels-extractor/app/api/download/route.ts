import { NextRequest, NextResponse } from "next/server";
import { BROWSER_UA, isAllowedMediaUrl, refererFor } from "@/lib/instagram";
import { parseSupportedUrl } from "@/lib/platforms";
import type { ErrorCode } from "@/lib/errors";

// Edge runtime streams the body straight through, so large videos are not
// subject to the buffered-response size limit of serverless functions.
export const runtime = "edge";

const HEADER_TIMEOUT_MS = 10000;
const FALLBACK_HEADER_TIMEOUT_MS = 30000; // the scraper re-resolves the post first
const MAX_BYTES = 200 * 1024 * 1024;

function safeFilename(rawId: string | null): string {
  const id = (rawId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `savereelsfast-${id || "reel"}.mp4`;
}

function fail(message: string, status: number, code: ErrorCode) {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

function scraperBase(): string | null {
  const raw = process.env.SCRAPER_SERVICE_URL?.trim().replace(/\/+$/, "");
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

function attachmentHeaders(filename: string, length: number): Headers {
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (length > 0) headers.set("Content-Length", String(length));
  return headers;
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
async function tryDirect(target: string, filename: string): Promise<Response | null> {
  let upstream: Response;
  try {
    upstream = await fetchWithHeaderTimeout(
      target,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: refererFor(target),
          Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
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
  if (!type.startsWith("video/") && !type.startsWith("application/octet-stream")) return null;

  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return null;

  return new Response(upstream.body, { status: 200, headers: attachmentHeaders(filename, length) });
}

/**
 * Fallback: ask the scraper service to fetch the video itself and stream it
 * back. It re-resolves the post from its own IP with yt-dlp's session, which
 * sidesteps IP-bound links (YouTube) and header-bound CDNs (TikTok, Facebook).
 */
async function tryScraperStream(
  sourceUrl: string,
  id: string | null,
  filename: string
): Promise<Response | { status: number; code: ErrorCode; message: string }> {
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
      `${base}/download?url=${encodeURIComponent(sourceUrl)}&id=${encodeURIComponent(id ?? "video")}`,
      { headers: key ? { "X-Scraper-Key": key } : {}, cache: "no-store" },
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
    return {
      status: res.status >= 400 ? res.status : 502,
      code: body?.detail?.code ?? "STREAM_EXPIRED_OR_BLOCKED",
      message: body?.detail?.message ?? "Couldn't fetch the video. Please try again.",
    };
  }

  const length = Number(res.headers.get("content-length") ?? 0);
  return new Response(res.body, { status: 200, headers: attachmentHeaders(filename, length) });
}

/**
 * GET /api/download?url=<CDN video URL>&id=<post id>&src=<post URL>
 *
 * Streams the video back from our own origin with
 * `Content-Disposition: attachment`, which is what makes browsers save the
 * file instead of playing it (the `download` attribute is ignored for
 * cross-origin URLs). If the CDN refuses us (403, expired or IP-bound link),
 * `src` lets us fall back to streaming through the scraper service.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const target = searchParams.get("url");

  if (!target || !isAllowedMediaUrl(target)) {
    return fail("Invalid or unsupported video URL.", 400, "INVALID_URL");
  }

  const id = searchParams.get("id");
  const filename = safeFilename(id);

  const direct = await tryDirect(target, filename);
  if (direct) return direct;

  const src = searchParams.get("src");
  const parsedSource = src ? parseSupportedUrl(src) : null;
  if (parsedSource) {
    const fallback = await tryScraperStream(parsedSource.url, id, filename);
    if (fallback instanceof Response) return fallback;
    return fail(fallback.message, fallback.status, fallback.code);
  }

  return fail(
    "This video link has expired or was blocked. Please fetch the video again.",
    502,
    "STREAM_EXPIRED_OR_BLOCKED"
  );
}
