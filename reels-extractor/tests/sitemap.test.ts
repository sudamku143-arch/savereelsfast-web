/**
 * The sitemap lists every page that exists, in the shape requested: every language x every platform,
 * the home pages and the legal pages, with the right frequency and priority; and the old addresses redirect.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED, locales } from "../lib/i18n-config.ts";
import { LEGACY_SLUGS, PLATFORM_SLUGS } from "../lib/landing.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SITE = "https://savereelsfast.com";
const ids = Object.keys(PLATFORM_SLUGS) as (keyof typeof PLATFORM_SLUGS)[];

// app/sitemap.ts imports through the "@/" alias, which plain Node cannot resolve: run it from a copy.
const dir = mkdtempSync(join(tmpdir(), "srf-sitemap-"));
for (const file of ["i18n-config", "landing", "site"]) writeFileSync(join(dir, `${file}.ts`), source(`lib/${file}.ts`));
writeFileSync(
  join(dir, "sitemap.ts"),
  source("app/sitemap.ts").replace(/"@\/lib\/([\w-]+)"/g, '"./$1.ts"')
);
const { default: sitemap } = (await import(pathToFileURL(join(dir, "sitemap.ts")).href)) as {
  default: () => { url: string; changeFrequency: string; priority: number; alternates: { languages: Record<string, string> } }[];
};
const entries = sitemap();
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
      "snapchat-video-downloader",
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

  it("adds up: 11 home + 99 platform pages + 5 legal pages x 4 languages", () => {
    assert.equal(entries.length, 11 + 11 * ids.length + 5 * LEGAL_TRANSLATED.length);
    assert.equal(entries.length, 130);
  });

  it("no address uses the old /downloader/ shape", () => {
    for (const e of entries) assert.doesNotMatch(e.url, /\/downloader\//);
  });
});

describe("frequency and priority", () => {
  const rule = (url: string) => {
    const path = url.replace(SITE, "").replace(new RegExp(`^/(${locales.join("|")})(?=/|$)`), "");
    if (path === "" || path === "/") return "home";
    if (Object.values(PLATFORM_SLUGS).includes(path.slice(1))) return "platform";
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
    assert.equal(pages.length, 99);
    for (const e of pages) {
      assert.equal(e.changeFrequency, "daily", e.url);
      assert.equal(e.priority, 0.9, e.url);
    }
  });

  it("legal pages: monthly", () => {
    const pages = entries.filter((x) => rule(x.url) === "legal");
    assert.equal(pages.length, 20);
    for (const e of pages) assert.equal(e.changeFrequency, "monthly", e.url);
  });
});

describe("alternate languages", () => {
  it("every platform and home page lists all 11 languages plus x-default", () => {
    for (const e of entries.filter((x) => !/(privacy|terms|dmca|disclaimer|contact)/.test(x.url))) {
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
