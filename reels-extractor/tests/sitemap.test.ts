/**
 * The sitemap lists every page that exists, in the shape requested: every language x every platform,
 * the home pages and the legal pages, with the right frequency and priority; and the old addresses redirect.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED, locales } from "../lib/i18n-config.ts";
import { LEGACY_SLUGS, PLATFORM_SLUGS } from "../lib/landing.ts";

// The counts below cover every post on disk, so the sitemap is read on a day when all of them are published.
process.env.BLOG_TODAY = "2099-12-31";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SITE = "https://www.savereelsfast.com";
const ids = Object.keys(PLATFORM_SLUGS) as (keyof typeof PLATFORM_SLUGS)[];

// app/sitemap.ts imports through the "@/" alias, which plain Node cannot resolve: run it from a copy.
const dir = mkdtempSync(join(tmpdir(), "srf-sitemap-"));
for (const file of ["i18n-config", "landing", "site", "blog"]) { // (blog.ts imports landing.ts)
  // (lib files import their neighbours without an extension, which plain Node cannot resolve)
  writeFileSync(join(dir, `${file}.ts`), source(`lib/${file}.ts`).replace(/from "\.\/([\w-]+)"/g, 'from "./$1.ts"'));
}
writeFileSync(
  join(dir, "sitemap.ts"),
  source("app/sitemap.ts").replace(/"@\/lib\/([\w-]+)"/g, '"./$1.ts"')
);
const { default: sitemap } = (await import(pathToFileURL(join(dir, "sitemap.ts")).href)) as {
  default: () => {
    url: string;
    lastModified?: Date;
    changeFrequency: string;
    priority: number;
    alternates: { languages: Record<string, string> };
  }[];
};
const entries = sitemap();
const blogEntries = entries.filter((e) => /\/blog(\/|$)/.test(e.url));
const blogEntryCount = blogEntries.length;
const allBlogPosts = readdirSync(new URL("../content/blog/en", import.meta.url)).filter((f) => f.endsWith(".md")).length;
const spanishBlogPosts = readdirSync(new URL("../content/blog/es", import.meta.url)).filter((f) => f.endsWith(".md")).length;
const byUrl = new Map(entries.map((e) => [e.url, e]));
const urlFor = (locale: string, path: string) => `${SITE}${locale === "en" ? path || "/" : `/${locale}${path}`}`;

describe("sitemap contents", () => {
  it("has no duplicate address", () => {
    assert.equal(byUrl.size, entries.length);
  });

  it("lists all 11 languages", () => {
    assert.deepEqual([...locales].sort(), ["ar", "bn", "en", "es", "fr", "hi", "id", "mr", "pt", "ta", "te"]);
  });

  it("lists every platform page in every language, at the requested addresses", () => {
    const wanted = [
      "instagram-video-downloader", "youtube-video-downloader", "facebook-video-downloader", "tiktok-video-downloader",
      "twitter-x-video-downloader", "pinterest-video-downloader", "reddit-video-downloader", "threads-video-downloader",
      "snapchat-video-downloader", "linkedin-video-downloader",
    ];
    assert.deepEqual(Object.values(PLATFORM_SLUGS).sort(), [...wanted].sort());
    for (const locale of locales) {
      for (const slug of wanted) assert.ok(byUrl.has(urlFor(locale, `/${slug}`)), `missing ${urlFor(locale, `/${slug}`)}`);
    }
  });

  it("lists the home page in every language (English at the root)", () => {
    for (const locale of locales) assert.ok(byUrl.has(urlFor(locale, "")), `missing home for ${locale}`);
    assert.ok(byUrl.has(`${SITE}/`));
    assert.ok(byUrl.has(`${SITE}/hi`));
  });

  it("lists the legal pages in the languages where they are translated, and never the untranslated copies", () => {
    for (const path of ["/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact"]) {
      for (const locale of locales) {
        assert.equal(byUrl.has(urlFor(locale, path)), LEGAL_TRANSLATED.includes(locale), `${locale}${path}`);
      }
    }
  });

  it("adds up: 11 home + 110 platform + 11 audio-downloader + 5 legal pages x every translated language", () => {
    assert.equal(entries.length, 11 + 11 * ids.length + locales.length + 5 * LEGAL_TRANSLATED.length + blogEntryCount);
    assert.equal(entries.length, 167 + 1 + allBlogPosts + 1 + spanishBlogPosts, "167 site pages + the English and Spanish blog indexes + one entry per post");
  });

  it("no address uses the old /downloader/ shape", () => {
    for (const e of entries) assert.doesNotMatch(e.url, /\/downloader\//);
  });

  it("carries lastmod only where it is genuinely known (blog posts), never a build-time 'now'", () => {
    // A lastmod that changes on every deploy regardless of real edits is a signal Google says it will start
    // to ignore - omitting it is the documented, honest alternative for pages with no per-page change date.
    for (const e of entries.filter((x) => !/\/blog(\/|$)/.test(x.url))) {
      assert.equal(e.lastModified, undefined, `${e.url} should not carry a build-time lastmod`);
    }
    for (const e of blogEntries) {
      assert.ok(e.lastModified instanceof Date, `${e.url} should carry its real post date`);
    }
  });
});

describe("scheduled posts stay out of the sitemap until their day", () => {
  it("lists only published posts, and the rest appear on their release day", () => {
    const urls = (day: string) => {
      process.env.BLOG_TODAY = day;
      try {
        return sitemap().map((e) => e.url).filter((u) => /\/blog\//.test(u));
      } finally {
        process.env.BLOG_TODAY = "2099-12-31";
      }
    };
    assert.equal(urls("2026-09-21").length, 5);
    assert.ok(!urls("2026-09-21").includes(`${SITE}/blog/save-instagram-reels-offline`));
    assert.equal(urls("2026-09-22").length, 8);
    assert.ok(urls("2026-09-22").includes(`${SITE}/blog/save-instagram-reels-offline`));
    assert.equal(urls("2026-09-27").length, allBlogPosts + spanishBlogPosts, "English posts, plus the Spanish posts (from 2026-09-25)");
  });
});

describe("frequency and priority", () => {
  const rule = (url: string) => {
    const path = url.replace(SITE, "").replace(new RegExp(`^/(${locales.join("|")})(?=/|$)`), "");
    if (path === "" || path === "/") return "home";
    if (Object.values(PLATFORM_SLUGS).includes(path.slice(1))) return "platform";
    if (path === "/audio-downloader") return "audio";
    if (/^\/blog(\/|$)/.test(path)) return "blog";
    return "legal";
  };

  it("home: daily, 1.0 - in every language", () => {
    for (const e of entries.filter((x) => rule(x.url) === "home")) {
      assert.equal(e.changeFrequency, "daily", e.url);
      assert.equal(e.priority, 1, e.url);
    }
  });

  it("platform pages: daily, 0.9 - in every language", () => {
    const pages = entries.filter((x) => rule(x.url) === "platform");
    assert.equal(pages.length, 110);
    for (const e of pages) {
      assert.equal(e.changeFrequency, "daily", e.url);
      assert.equal(e.priority, 0.9, e.url);
    }
  });

  it("blog: the index weekly at 0.7, each post monthly at 0.6, only in languages that have posts", () => {
    const pages = entries.filter((x) => rule(x.url) === "blog");
    assert.equal(pages.length, 1 + allBlogPosts + 1 + spanishBlogPosts, "the blog index and every post, in English and Spanish");
    for (const e of pages) {
      const spanish = e.url.startsWith(`${SITE}/es/blog`);
      assert.ok(spanish || e.url.startsWith(`${SITE}/blog`), `${e.url} should be an English or Spanish blog address`);
      const index = e.url === `${SITE}/blog` || e.url === `${SITE}/es/blog`;
      assert.equal(e.changeFrequency, index ? "weekly" : "monthly", e.url);
      assert.equal(e.priority, index ? 0.7 : 0.6, e.url);
      // English is the default: a Spanish page points x-default at its English original.
      assert.equal(e.alternates.languages["x-default"], spanish ? e.url.replace("/es/blog", "/blog") : e.url, e.url);
    }
    for (const locale of locales.filter((l) => l !== "en" && l !== "es")) {
      assert.equal(byUrl.has(`${SITE}/${locale}/blog`), false, `${locale} has no posts, so no blog page`);
    }
  });

  it("audio downloader: daily, 0.85 - in every language", () => {
    const pages = entries.filter((x) => rule(x.url) === "audio");
    assert.equal(pages.length, locales.length);
    for (const e of pages) {
      assert.equal(e.changeFrequency, "daily", e.url);
      assert.equal(e.priority, 0.85, e.url);
    }
  });

  it("legal pages: monthly", () => {
    const pages = entries.filter((x) => rule(x.url) === "legal");
    assert.equal(pages.length, 5 * LEGAL_TRANSLATED.length);
    for (const e of pages) assert.equal(e.changeFrequency, "monthly", e.url);
  });
});

describe("alternate languages", () => {
  it("every platform and home page lists all 11 languages plus x-default", () => {
    for (const e of entries.filter((x) => !/(privacy|terms|dmca|disclaimer|contact|\/blog)/.test(x.url))) {
      assert.deepEqual(Object.keys(e.alternates.languages).sort(), [...locales, "x-default"].sort(), e.url);
    }
  });

  it("each alternate is the same page in that language, and x-default is English", () => {
    const page = `/${PLATFORM_SLUGS.tiktok}`;
    const alt = byUrl.get(urlFor("ta", page))!.alternates.languages;
    for (const locale of locales) assert.equal(alt[locale], urlFor(locale, page));
    assert.equal(alt["x-default"], urlFor("en", page));
  });
});

describe("old addresses redirect to the new ones", () => {
  const config = source("next.config.js");
  const table = config.match(/const LEGACY = \{([\s\S]*?)\};/)?.[1] ?? "";
  const configured = Object.fromEntries([...table.matchAll(/(\w+): "([\w-]+)"/g)].map((m) => [m[1], m[2]]));

  it("every old name in lib/landing.ts is redirected to that platform's new slug", () => {
    assert.deepEqual(Object.keys(configured).sort(), Object.keys(LEGACY_SLUGS).sort());
    for (const [old, id] of Object.entries(LEGACY_SLUGS)) assert.equal(configured[old], PLATFORM_SLUGS[id], old);
  });

  it("the redirect covers every non-English language, and is permanent", () => {
    const languages = config.match(/const LANGUAGES = "([^"]+)"/)?.[1].split("|") ?? [];
    assert.deepEqual([...languages].sort(), locales.filter((l) => l !== "en").sort());
    assert.match(config, /permanent: true/);
    assert.doesNotMatch(config, /permanent: false/);
  });
});
