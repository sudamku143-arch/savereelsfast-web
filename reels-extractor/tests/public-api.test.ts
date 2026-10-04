/**
 * The free public API (/api/public/extract) and its documentation page (/free-video-api).
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  PUBLIC_API_PLATFORMS,
  PUBLIC_DAILY_LIMIT,
  PUBLIC_ERROR_STATUS,
  publicErrorBody,
  publicErrorFor,
  toPublicResult,
} from "../lib/public-api.ts";
import { API_DOCS, API_DOCS_PATH } from "../lib/api-docs.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const route = source("app/api/public/extract/route.ts");

describe("what the API serves", () => {
  it("only platforms looked up without the paid proxy: never Instagram or YouTube", () => {
    assert.ok(!PUBLIC_API_PLATFORMS.includes("instagram"));
    assert.ok(!PUBLIC_API_PLATFORMS.includes("youtube"));
    assert.deepEqual([...PUBLIC_API_PLATFORMS].sort(), ["facebook", "linkedin", "pinterest", "reddit", "snapchat", "threads", "tiktok", "x"]);
    assert.match(route, /if \(!PUBLIC_API_PLATFORMS\.includes\(parsed\.platform\)\) return fail\("UNSUPPORTED_PLATFORM"\);/);
  });

  it("standard status codes: 400 bad input, 403 private, 404 unsupported platform, 422 no video, 429 limit, 503 failure", () => {
    assert.deepEqual(PUBLIC_ERROR_STATUS, {
      INVALID_URL: 400,
      PRIVATE_CONTENT: 403,
      UNSUPPORTED_PLATFORM: 404,
      NO_VIDEO: 422,
      RATE_LIMITED: 429,
      EXTRACTION_FAILED: 503,
    });
  });

  it("maps the site's error codes onto the API's stable set", () => {
    assert.equal(publicErrorFor("INVALID_URL"), "INVALID_URL");
    assert.equal(publicErrorFor("LOGIN_REQUIRED"), "PRIVATE_CONTENT");
    assert.equal(publicErrorFor("UNSUPPORTED_POST"), "NO_VIDEO");
    assert.equal(publicErrorFor("RATE_LIMITED"), "RATE_LIMITED");
    for (const code of ["STREAM_EXPIRED_OR_BLOCKED", "PLATFORM_TIMEOUT", "EXTRACTION_FAILED", "SERVER_BUSY", "NOT_CONFIGURED", undefined]) {
      assert.equal(publicErrorFor(code), "EXTRACTION_FAILED", String(code));
    }
    assert.deepEqual(Object.keys(publicErrorBody("NO_VIDEO")), ["success", "error"]);
  });

  it("answers in the documented snake_case shape, without yt-dlp's placeholder titles", () => {
    const out = toPublicResult(
      {
        id: "1",
        title: "Video by someone",
        caption: null,
        author: "someone",
        durationSeconds: 12.5,
        thumbnailUrl: "https://t/x.jpg",
        videoUrl: "https://v/x.mp4",
        quality: "720p",
      },
      "tiktok"
    );
    assert.deepEqual(Object.keys(out.data), ["platform", "id", "title", "caption", "author", "duration", "thumbnail", "video_url", "audio_url", "quality", "items"]);
    assert.equal(out.data.title, null);
    assert.equal(out.data.duration, 12.5);
    assert.equal(out.data.audio_url, null);
    assert.deepEqual(out.data.items, []);
  });
});

describe("the route", () => {
  it("limits each IP to 50 a day, and says so in the headers", () => {
    assert.equal(PUBLIC_DAILY_LIMIT, 50);
    assert.match(route, /checkRateLimit\(dailyStore, ip, PUBLIC_DAILY_LIMIT, PUBLIC_WINDOW_MS\)/);
    for (const header of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) assert.match(route, new RegExp(`"${header}"`));
  });

  it("reuses the website's own lookup (cache, timeouts, per-minute limit) with the caller's headers", () => {
    assert.match(route, /import \{ GET as siteExtract \} from "\.\.\/\.\.\/extract\/route";/);
    assert.match(route, /headers: request\.headers,/);
  });

  it("is server-to-server: no CORS headers, never cached by the CDN", () => {
    assert.doesNotMatch(route, /Access-Control-Allow-Origin/);
    assert.match(route, /"Cache-Control": "no-store"/);
  });
});

describe("the documentation page", () => {
  const page = source("app/[locale]/free-video-api/page.tsx");
  const text = [API_DOCS.lead, ...API_DOCS.sections.flatMap((s) => s.paragraphs), ...API_DOCS.faq.flatMap((f) => [f.q, f.a]), ...API_DOCS.errors.map((e) => e.meaning)].join(" ");
  const words = text.trim().split(/\s+/).length;

  it("lives at /free-video-api (English only), and /api redirects there", () => {
    assert.equal(API_DOCS_PATH, "/free-video-api");
    assert.match(page, /const DOCS_LOCALES: readonly Locale\[\] = \["en"\];/);
    assert.match(page, /export const dynamicParams = false;/);
    assert.match(source("next.config.js"), /\{ source: "\/api", destination: "\/free-video-api", permanent: true \}/);
    assert.match(source("app/[locale]/components/Footer.tsx"), /\{ href: "\/free-video-api", label: "Free API" \}/);
  });

  it("has 800-1000 words of copy around the target searches", () => {
    assert.ok(words >= 800 && words <= 1000, `${words} words`);
    assert.match(API_DOCS.metaTitle, /Free Video Extractor API/);
    assert.match(API_DOCS.metaTitle + API_DOCS.metaDescription, /social media download API/i);
    assert.ok(API_DOCS.metaTitle.length <= 60, `title is ${API_DOCS.metaTitle.length}`);
    assert.ok(API_DOCS.metaDescription.length <= 160, `description is ${API_DOCS.metaDescription.length}`);
  });

  it("gives copy-paste examples in JavaScript, Python and PHP against the real endpoint", () => {
    assert.deepEqual(API_DOCS.examples.map((e) => e.language.split(" ")[0]), ["JavaScript", "Python", "PHP"]);
    for (const e of API_DOCS.examples) assert.match(e.code, /https:\/\/www\.savereelsfast\.com\/api\/public\/extract/);
  });

  it("answers the six questions with FAQPage data, plus WebAPI and breadcrumb data", () => {
    assert.equal(API_DOCS.faq.length, 6);
    const qs = API_DOCS.faq.map((f) => f.q).join(" ");
    for (const topic of [/rate limits/i, /platforms/i, /legal/i, /Terms of Service/i, /commercial/i, /API key/i]) assert.match(qs, topic);
    for (const type of ["WebAPI", "FAQPage", "BreadcrumbList"]) assert.match(page, new RegExp(`"@type": "${type}"`));
  });

  it("documents exactly the error codes the API returns", () => {
    assert.deepEqual(
      API_DOCS.errors.map((e) => [e.code, e.status]),
      Object.entries(PUBLIC_ERROR_STATUS).sort((a, b) => a[1] - b[1])
    );
  });

  it("is honest: Instagram and YouTube are not on the free API, links expire, only public posts", () => {
    assert.match(text, /Instagram and YouTube are not part of the free API/);
    assert.match(text, /expire/);
    assert.match(text, /Only public posts/);
  });
});
