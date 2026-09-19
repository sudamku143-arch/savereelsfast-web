import { NextRequest, NextResponse } from "next/server";
import { BROWSER_UA, isAllowedMediaUrl, refererFor } from "@/lib/instagram";

// Edge runtime streams the body straight through, so large videos are not
// subject to the buffered-response size limit of serverless functions.
export const runtime = "edge";

const HEADER_TIMEOUT_MS = 10000;
const MAX_BYTES = 200 * 1024 * 1024;

function safeFilename(rawId: string | null): string {
  const id = (rawId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `savereelsfast-${id || "reel"}.mp4`;
}

function fail(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

/**
 * GET /api/download?url=<CDN video URL>&id=<reel shortcode>
 *
 * Streams the video back from our own origin with
 * `Content-Disposition: attachment`, which is what makes browsers save the
 * file instead of playing it (the `download` attribute is ignored for
 * cross-origin URLs).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const target = searchParams.get("url");

  if (!target || !isAllowedMediaUrl(target)) {
    return fail("Invalid or unsupported video URL.", 400);
  }

  const filename = safeFilename(searchParams.get("id"));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: {
        "User-Agent": BROWSER_UA,
        Referer: refererFor(target),
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual", // never follow a redirect off the allow-list
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return fail("Couldn't fetch the video. Please try again.", 502);
  }
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    console.warn(
      `[/api/download] CDN responded ${upstream.status} for ${new URL(target).hostname}`
    );
    // Signed CDN links expire (or get refused) — fetching the Reel again issues a fresh one.
    const expired = [403, 404, 410].includes(upstream.status);
    return fail(
      expired
        ? "This video link has expired. Please fetch the Reel again."
        : "Couldn't fetch the video. Please try again.",
      expired ? 404 : 502
    );
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!type.startsWith("video/") && !type.startsWith("application/octet-stream")) {
    return fail("The requested file is not a video.", 415);
  }

  const length = Number(upstream.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) {
    return fail("This video is too large to download.", 413);
  }

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (length > 0) headers.set("Content-Length", String(length));

  return new Response(upstream.body, { status: 200, headers });
}
