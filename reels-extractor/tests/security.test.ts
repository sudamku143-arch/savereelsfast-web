/**
 * Defensive security for the website: response headers, rate limiting and link validation.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { checkRateLimit, clientIp, type RateLimitStore } from "../lib/rate-limit.ts";

const require = createRequire(import.meta.url);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("security headers (next.config.js)", () => {
  const config = require("../next.config.js");

  async function globalHeaders(): Promise<Record<string, string>> {
    const rules: { source: string; headers: { key: string; value: string }[] }[] = await config.headers();
    const rule = rules.find((r) => r.source === "/:path*");
    assert.ok(rule, "no header rule applies to every path");
    return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
  }

  it("sends the three headers that were asked for, with safe values", async () => {
    const h = await globalHeaders();
    assert.equal(h["X-Frame-Options"], "DENY");
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
  });

  it("adds transport, framing and feature protections on top", async () => {
    const h = await globalHeaders();
    assert.match(h["Strict-Transport-Security"], /max-age=\d{7,}/);
    assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.match(h["Content-Security-Policy"], /object-src 'none'/);
    assert.match(h["Content-Security-Policy"], /base-uri 'self'/);
    assert.match(h["Permissions-Policy"], /camera=\(\)/);
    assert.match(h["Permissions-Policy"], /microphone=\(\)/);
    assert.match(h["Cross-Origin-Opener-Policy"], /same-origin/);
  });

  it("does not break what the site depends on", async () => {
    const h = await globalHeaders();
    // Ad networks and A-ADS need script/frame hosts we can't enumerate: no script-src/frame-src here.
    assert.doesNotMatch(h["Content-Security-Policy"], /script-src|frame-src|default-src/);
    // The Paste button reads the clipboard, so clipboard-read must not be switched off.
    assert.doesNotMatch(h["Permissions-Policy"], /clipboard/);
    // Social crawlers fetch /api/og from other sites, so no Cross-Origin-Resource-Policy.
    assert.equal(h["Cross-Origin-Resource-Policy"], undefined);
    // Popups (ad click-throughs) must keep working.
    assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  });

  it("hides the framework, disables the image optimizer, and keeps the service-worker rule", async () => {
    assert.equal(config.poweredByHeader, false);
    assert.equal(config.images.unoptimized, true);
    const rules: { source: string; headers: { key: string; value: string }[] }[] = await config.headers();
    const sw = rules.find((r) => r.source === "/sw.js");
    assert.ok(sw?.headers.some((x) => x.key === "Cache-Control" && /no-store/.test(x.value)));
    assert.ok(rules.some((r) => r.source === "/api/:path*" && r.headers.some((x) => x.key === "X-Robots-Tag")));
  });

  it("caches every page at the edge, but never the API or the service worker", async () => {
    const rules: { source: string; headers: { key: string; value: string }[] }[] = await config.headers();
    const rule = rules.find((r) => r.headers.some((h) => h.key === "Cache-Control" && /s-maxage/.test(h.value)));
    assert.ok(rule, "no page-caching Cache-Control rule found");
    const value = rule!.headers.find((h) => h.key === "Cache-Control")!.value;

    // s-maxage is what lets Vercel's Edge Network serve a cache hit without re-running middleware or the
    // origin function for an already-cached URL, which is most of what an external TTFB check measures.
    assert.match(value, /public/);
    assert.match(value, /s-maxage=86400/);
    assert.match(value, /stale-while-revalidate=59/);
    // A visitor's own browser must still revalidate every visit, so nobody is stuck looking at a stale copy.
    assert.match(value, /max-age=0/);
    assert.match(value, /must-revalidate/);

    // The pattern must exclude the API, /_next's own immutably-cached assets, and the service worker (whose
    // own rule above always revalidates it) - checked here at the source level, and against a live
    // `next start` server (curl -I on /, /es/instagram-video-downloader, /api/extract, /sw.js and a /_next
    // chunk) while this rule was written, confirming the API and the service worker keep their own headers.
    assert.match(rule!.source, /\(\?!.*\bapi\b/);
    assert.match(rule!.source, /_next/);
    assert.match(rule!.source, /sw\\\.js/);
  });

  it("every <Image> in the app is unoptimized (so turning the optimizer off breaks nothing)", () => {
    for (const file of [
      "app/[locale]/components/PreviewCard.tsx",
      "app/[locale]/components/ItemsSlider.tsx",
    ]) {
      const tsx = source(file);
      for (const image of tsx.match(/<Image[\s\S]*?\/>/g) ?? []) {
        assert.match(image, /unoptimized/, `${file} has an <Image> that needs the optimizer`);
      }
    }
  });
});

describe("rate limiter", () => {
  const WINDOW = 60_000;
  const T0 = 1_700_000_000_000;

  it("allows up to the limit, then blocks with a Retry-After", () => {
    const store: RateLimitStore = new Map();
    for (let i = 1; i <= 5; i++) {
      const r = checkRateLimit(store, "1.2.3.4", 5, WINDOW, T0 + i);
      assert.equal(r.allowed, true, `request ${i}`);
    }
    const blocked = checkRateLimit(store, "1.2.3.4", 5, WINDOW, T0 + 10_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 49 && blocked.retryAfterSeconds <= 60, `retry in ${blocked.retryAfterSeconds}s`);
  });

  it("lets the visitor back in when the window ends", () => {
    const store: RateLimitStore = new Map();
    for (let i = 0; i < 6; i++) checkRateLimit(store, "ip", 5, WINDOW, T0);
    assert.equal(checkRateLimit(store, "ip", 5, WINDOW, T0 + 1000).allowed, false);
    assert.equal(checkRateLimit(store, "ip", 5, WINDOW, T0 + WINDOW + 1).allowed, true);
  });

  it("counts each visitor separately", () => {
    const store: RateLimitStore = new Map();
    for (let i = 0; i < 20; i++) checkRateLimit(store, "attacker", 5, WINDOW, T0);
    assert.equal(checkRateLimit(store, "attacker", 5, WINDOW, T0).allowed, false);
    assert.equal(checkRateLimit(store, "innocent", 5, WINDOW, T0).allowed, true);
  });

  it("keeps memory bounded when a flood of distinct addresses arrives", () => {
    const store: RateLimitStore = new Map();
    for (let i = 0; i < 20_000; i++) checkRateLimit(store, `10.0.${i >> 8}.${i & 255}`, 5, WINDOW, T0);
    assert.ok(store.size <= 5000, `store grew to ${store.size}`);
  });

  it("reads the visitor address the way Vercel provides it", () => {
    const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
    assert.equal(clientIp(headers({ "x-forwarded-for": "203.0.113.9, 76.76.21.1" })), "203.0.113.9");
    assert.equal(clientIp(headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
    assert.equal(clientIp(headers({})), null);
    assert.equal(clientIp(headers({ "x-forwarded-for": "x".repeat(200) })), null);
  });

  it("guards both public API routes and caps the request body", () => {
    const extract = source("app/api/extract/route.ts");
    assert.match(extract, /export async function GET[\s\S]{0,200}rateLimited\(request\)/);
    assert.match(extract, /export async function POST[\s\S]{0,200}rateLimited\(request\)/);
    assert.match(extract, /MAX_BODY_BYTES/);
    assert.match(source("app/api/download/route.ts"), /checkRateLimit\(limiterStore, ip, DOWNLOAD_LIMIT/);
  });
});

describe("link validation", async () => {
  // platforms.ts imports through the "@/" alias, which plain Node can't resolve: run it from a copy.
  const dir = mkdtempSync(join(tmpdir(), "srf-"));
  writeFileSync(join(dir, "instagram.ts"), source("lib/instagram.ts"));
  writeFileSync(join(dir, "platforms.ts"), source("lib/platforms.ts").replace('"@/lib/instagram"', '"./instagram.ts"'));
  const { parseSupportedUrl } = await import(pathToFileURL(join(dir, "platforms.ts")).href);

  const hostile = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://www.youtube.com/watch?v=abcdefghijk",
    "https://youtube.com@evil.example/watch?v=abcdefghijk",
    "https://user:pass@www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com:8080/watch?v=abcdefghijk",
    "https://evil.example\\@www.youtube.com/watch?v=abcdefghijk",
    "https://evil.example#@www.youtube.com/watch?v=abcdefghijk",
    "https://evil.example/www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com.evil.example/watch?v=abcdefghijk",
    "https://evilyoutube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijk\r\nHost: evil.example",
    "https://www.youtube.com/watch?v=abc\u0000.evil.example",
    "http://127.0.0.1/reel/abc/",
    "http://localhost/watch?v=abcdefghijk",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://2130706433/",
    "https://www.youtube.com/watch?v=" + "a".repeat(600),
    "",
    "   ",
  ];

  it("rejects hostile input before anything is requested", () => {
    for (const link of hostile) {
      assert.equal(parseSupportedUrl(link), null, `accepted: ${link.slice(0, 70)}`);
    }
  });

  it("still accepts real links (including an explicit default port)", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "https://youtu.be/jNQXAC9IVRw?si=abc",
      "https://www.youtube.com:443/watch?v=jNQXAC9IVRw",
      "https://www.instagram.com/reel/AbC_123/?igsh=1",
      "https://www.tiktok.com/@user/video/7123456789",
    ]) {
      assert.ok(parseSupportedUrl(link), `rejected: ${link}`);
    }
  });

  it("accepts LinkedIn post links, drops their tracking, and rejects profile, company and look-alike links", () => {
    const post = "https://www.linkedin.com/posts/the-mathworks_what-is-mathworks-cloud-center-activity-7151241570371948544-4Gu7";
    const parsed = parseSupportedUrl(`${post}?utm_source=share&utm_medium=member_desktop&rcm=ACoAAB`);
    assert.deepEqual(parsed, { platform: "linkedin", url: post });
    assert.equal(parseSupportedUrl("https://www.linkedin.com/feed/update/urn:li:activity:7151241570371948544/")?.platform, "linkedin");
    assert.equal(parseSupportedUrl("linkedin.com/posts/jane-doe_hello-activity-7151241570371948544-AbCd")?.platform, "linkedin");
    for (const link of [
      "https://www.linkedin.com/in/jane-doe/",
      "https://www.linkedin.com/company/mathworks/",
      "https://www.linkedin.com/feed/",
      "https://linkedin.com.evil.example/posts/x-activity-7151241570371948544-4Gu7",
      "https://notlinkedin.com/posts/x-activity-7151241570371948544-4Gu7",
    ]) {
      assert.equal(parseSupportedUrl(link), null, `accepted: ${link}`);
    }
  });

  it("never hands credentials or ports on to the scraper", () => {
    const parsed = parseSupportedUrl("https://www.youtube.com:443/watch?v=jNQXAC9IVRw");
    assert.ok(parsed && !/@|:\d/.test(new URL(parsed.url).host));
  });
});
