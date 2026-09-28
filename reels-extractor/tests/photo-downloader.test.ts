/**
 * /instagram-photo-downloader: one page for Instagram photos AND carousels (the tool behind it handles single
 * photos, photo carousels, mixed photo + video carousels and videos alike).
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";
import { PHOTO_DOWNLOADER_PATH } from "../lib/landing.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`));
const page = source("app/[locale]/instagram-photo-downloader/page.tsx");

describe("the photo & carousel page", () => {
  it("lives at /instagram-photo-downloader", () => {
    assert.equal(PHOTO_DOWNLOADER_PATH, "/instagram-photo-downloader");
  });

  it("opens the full tool on the Instagram tab (photos, carousels and videos), not the audio-only one", () => {
    assert.match(page, /initialPlatform="instagram"/);
    assert.match(page, /heroHeading=\{photoDownloader\.h1\}/);
    assert.doesNotMatch(page, /audioOnly/);
  });

  it("describes itself with HowTo, FAQ and breadcrumb data built from the visible text", () => {
    for (const type of ["WebApplication", "HowTo", "FAQPage", "BreadcrumbList"]) assert.match(page, new RegExp(`"@type": "${type}"`), type);
    assert.match(page, /photoDownloader\.howToSteps\.map/);
    assert.match(page, /photoDownloader\.faq\.map/);
  });

  it("is in the sitemap, the footer and the 'downloaders for every platform' list", () => {
    assert.match(source("app/sitemap.ts"), /\{ path: PHOTO_DOWNLOADER_PATH, changeFrequency: "daily", priority: 0\.85 \}/);
    assert.match(source("app/[locale]/components/Footer.tsx"), /localePath\(locale, PHOTO_DOWNLOADER_PATH\)/);
    assert.match(source("app/[locale]/components/PlatformLinks.tsx"), /localePath\(locale, PHOTO_DOWNLOADER_PATH\)/);
    for (const file of ["app/[locale]/page.tsx", "app/[locale]/[platform]/page.tsx", "app/[locale]/audio-downloader/page.tsx"]) {
      assert.match(source(file), /photoLabel=\{dict\.photoDownloader\.breadcrumb\}/, file);
    }
  });

  it("English covers photos and carousels alike, and stays honest about what isn't supported", () => {
    const p = messages("en").photoDownloader;
    for (const text of [p.metaTitle, p.h1]) assert.match(text, /Photo.*Carousel/, text);
    const all = JSON.stringify(p);
    assert.match(all, /Download all/);
    assert.match(all, /mix pictures and short videos/);
    assert.match(all, /Stories, Highlights and profile pictures are not supported/);
    assert.match(all, /Only public posts/);
    assert.doesNotMatch(p.metaTitle + p.metaDescription + p.lead, /4k|unlimited|100%/i);
  });
});

describe("photo & carousel page text, in every language", () => {
  const shape = (p: { sections: { paragraphs: string[] }[] }) => p.sections.map((s) => s.paragraphs.length).join(",");
  const english = messages("en").photoDownloader;

  for (const locale of locales) {
    it(locale, () => {
      const m = messages(locale);
      const p = m.photoDownloader;
      assert.ok([...p.metaTitle].length < 60, `${locale} title is ${[...p.metaTitle].length}`);
      assert.ok([...p.metaDescription].length < 160, `${locale} description is ${[...p.metaDescription].length}`);
      assert.match(p.metaTitle + p.h1, /Instagram/);
      assert.equal(p.howToSteps.length, 3);
      assert.equal(p.faq.length, english.faq.length);
      assert.equal(shape(p), shape(english), `${locale}: same sections as English`);
      // Its own page in search results: never the same title or description as another page.
      const others = [m.meta.title, m.audioDownloader.metaTitle, ...Object.values(m.landing.platforms).map((x: { metaTitle: string }) => x.metaTitle)];
      assert.ok(!others.includes(p.metaTitle), `${locale}: title repeats another page's`);
      if (locale !== "en") assert.notEqual(p.metaTitle, english.metaTitle, `${locale} is translated`);
    });
  }
});
