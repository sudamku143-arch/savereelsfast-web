import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Request contract:
 *   POST /api/extract
 *   body: { url: string }
 *
 * Success response (200):
 *   {
 *     success: true,
 *     data: {
 *       videoUrl: string,        // direct MP4 URL
 *       thumbnailUrl: string,
 *       caption: string | null,
 *       author: string | null,   // Instagram handle without "@"
 *       durationSeconds: number | null,
 *       formats?: { label, url, width, height, sizeBytes }[]  // best first
 *     }
 *   }
 *
 * Error response (4xx/5xx):
 *   { success: false, error: string }
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

  const url = body.url?.trim();

  if (!url) {
    return NextResponse.json(
      { success: false, error: "Missing required field: url." },
      { status: 400 }
    );
  }

  if (!REEL_URL_REGEX.test(url)) {
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
    console.error("[/api/extract] extraction failed:", err);
    return NextResponse.json(
      { success: false, error: "Something went wrong while fetching this Reel." },
      { status: 502 }
    );
  }
}

/**
 * Placeholder extraction logic.
 *
 * Wire this up to your actual video-resolution method, e.g.:
 *   - Instagram's public GraphQL/oEmbed endpoints (rate-limited, ToS-sensitive)
 *   - A headless-browser scraper (Playwright) that reads the page's
 *     shared-data JSON for the video_url field
 *   - A third-party extraction API
 *
 * Keep this function as the single seam between the route and the
 * extraction implementation so the contract above never has to change.
 */
async function extractReelData(reelUrl: string): Promise<ReelData | null> {
  // TODO: replace with real extraction. Throwing here on purpose so the
  // route's error path is exercised until a real implementation lands.
  throw new Error(
    `extractReelData() not implemented — received reelUrl: ${reelUrl}`
  );
}
