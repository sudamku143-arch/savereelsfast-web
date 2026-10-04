import { NextRequest, NextResponse } from "next/server";
import { parseSupportedUrl } from "@/lib/platforms";
import { checkRateLimit, clientIp, type RateLimitStore } from "@/lib/rate-limit";
import {
  PUBLIC_API_PLATFORMS,
  PUBLIC_DAILY_LIMIT,
  PUBLIC_ERROR_STATUS,
  PUBLIC_WINDOW_MS,
  publicErrorBody,
  publicErrorFor,
  toPublicResult,
  type PublicErrorCode,
} from "@/lib/public-api";
import { GET as siteExtract } from "../../extract/route";

// Same runtime and time limit as the website's lookup, which this calls.
export const runtime = "nodejs";
export const maxDuration = 40;

// 50 lookups a day per IP, no key. Per server instance (see lib/rate-limit.ts): a soft limit until a shared
// store (e.g. Upstash Redis) is added along with the optional API keys.
const dailyStore: RateLimitStore = new Map();

/**
 * GET /api/public/extract?url=<link to a public post>
 *
 * The free public API: the website's own lookup (same cache, timeouts and per-minute limit), for the
 * platforms in PUBLIC_API_PLATFORMS, answered as { success, data } or { success: false, error: { code, message } }.
 * Server-to-server use: no CORS headers, so other websites can't run their visitors' lookups through it.
 */
export async function GET(request: NextRequest) {
  const ip = clientIp(request.headers) ?? "unknown";
  const limit = checkRateLimit(dailyStore, ip, PUBLIC_DAILY_LIMIT, PUBLIC_WINDOW_MS);
  const resetAt = dailyStore.get(ip)?.resetAt ?? Date.now() + PUBLIC_WINDOW_MS;
  const rateHeaders = {
    "X-RateLimit-Limit": String(PUBLIC_DAILY_LIMIT),
    "X-RateLimit-Remaining": String(Math.max(0, limit.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
  };
  const fail = (code: PublicErrorCode, extra: Record<string, string> = {}, message?: string) =>
    NextResponse.json(publicErrorBody(code, message), {
      status: PUBLIC_ERROR_STATUS[code],
      headers: { "Cache-Control": "no-store", ...rateHeaders, ...extra },
    });

  if (!limit.allowed) return fail("RATE_LIMITED", { "Retry-After": String(limit.retryAfterSeconds) });

  const raw = request.nextUrl.searchParams.get("url")?.trim() ?? "";
  const parsed = raw ? parseSupportedUrl(raw) : null;
  if (!raw || raw.length > 2048) return fail("INVALID_URL");
  if (!parsed) {
    // A well-formed link to a site we don't support at all, or not a link.
    return /^https?:\/\//i.test(raw) ? fail("UNSUPPORTED_PLATFORM") : fail("INVALID_URL");
  }
  if (!PUBLIC_API_PLATFORMS.includes(parsed.platform)) return fail("UNSUPPORTED_PLATFORM");

  // The website's lookup, called in-process with the caller's own headers (so its per-minute limit applies
  // to the caller's IP too).
  const inner = new NextRequest(new URL(`/api/extract?url=${encodeURIComponent(parsed.url)}`, request.url), {
    headers: request.headers,
  });
  let site: Record<string, unknown>;
  let status: number;
  try {
    const response = await siteExtract(inner);
    status = response.status;
    site = (await response.json()) as Record<string, unknown>;
  } catch {
    return fail("EXTRACTION_FAILED");
  }

  if (status !== 200 || site.success !== true) {
    const code = publicErrorFor(typeof site.code === "string" ? site.code : undefined);
    const retry: Record<string, string> = code === "RATE_LIMITED" ? { "Retry-After": "60" } : {};
    return fail(code, retry, code === "RATE_LIMITED" ? `Too many requests in a minute (max 20). Wait a minute.` : undefined);
  }

  return NextResponse.json(toPublicResult(site, parsed.platform), {
    headers: { "Cache-Control": "no-store", ...rateHeaders },
  });
}
