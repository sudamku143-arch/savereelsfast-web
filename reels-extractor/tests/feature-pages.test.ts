/**
 * The caption copier and thumbnail downloader: the tools on the result card, and their own guide pages.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extractHashtags, hashtagLine, imageExtOf } from "../lib/caption.ts";
import { CAPTION_COPIER_PATH, THUMBNAIL_DOWNLOADER_PATH, toolPageLinks } from "../lib/landing.ts";
import { locales } from "../lib/i18n-config.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`));
const card = source("app/[locale]/components/PreviewCard.tsx");
const tools = source("app/[locale]/components/CaptionTools.tsx");
const route = source("app/api/extract/route.ts");

describe("hashtags", () => {
  it("finds every tag once, in any script, in order", () => {
    assert.deepEqual(extractHashtags("Sunset #Mumbai 🌅 #मुंबई #travel #Travel #café"), ["#Mumbai", "#मुंबई", "#travel", "#café"]);
  });

  it("is not fooled by URLs, words glued to a #, or plain numbers", () => {
    assert.deepEqual(extractHashtags("see https://x.com/a#b, mail#tag, rank #1, and &#39; then #ok"), ["#ok"]);
    assert.deepEqual(extractHashtags(null), []);
    assert.equal(hashtagLine("a #one b #two"), "#one #two");
  });

  it("names the cover image after the file the CDN serves", () => {
    assert.equal(imageExtOf("https://i.ytimg.com/vi/abc/maxresdefault.webp"), "webp");
    assert.equal(imageExtOf("https://x.fbcdn.net/v/t51/abc.jpg?stp=1"), "jpg");
    assert.equal(imageExtOf("not a url"), "jpg");
  });
});

describe("the result card", () => {
  it("receives the whole caption from the scraper, and from the built-in Instagram strategies", () => {
    assert.match(route, /caption: truncate\(typeof json\.caption === "string" \? json\.caption : null, CAPTION_MAX_CHARS\)/);
    assert.match(route, /const CAPTION_MAX_CHARS = 2200;/);
    assert.ok(route.split("CAPTION_MAX_CHARS)").length - 1 >= 3, "scraper + embed + graphql strategies");
  });

  it("offers the caption tools wherever there is a caption, except on the audio page", () => {
    assert.match(card, /\{fullCaption && !audioOnly && \(\s*<CaptionTools caption=\{fullCaption\} dict=\{dict\} expanded=\{focus === "caption"\} \/>/);
    assert.match(tools, /tags\.length > 0 &&/, "no hashtag button when there are none");
    assert.match(tools, /navigator\.clipboard\.writeText/);
    assert.match(tools, /document\.execCommand\("copy"\)/, "with a fallback for browsers without the clipboard API");
  });

  it("offers the cover image for a video (not for photos or on the audio page), first on the thumbnail page", () => {
    assert.match(card, /result\.thumbnailUrl && !isPhoto && !audioOnly/);
    assert.match(card, /kind: "image", ext: coverExt/);
    assert.match(card, /variant=\{focus === "cover" \? "primary" : "compact-secondary"\}/);
    assert.match(card, /\{coverButton && focus !== "cover" && /);
  });
});

describe("the feature pages", () => {
  const pages = [
    { path: CAPTION_COPIER_PATH, key: "captionCopier", file: "instagram-caption-copier", focus: "caption", platform: "instagram" },
    { path: THUMBNAIL_DOWNLOADER_PATH, key: "thumbnailDownloader", file: "video-thumbnail-downloader", focus: "cover", platform: "youtube" },
  ];

  for (const page of pages) {
    it(`${page.path}: puts its own tool first and has the full guide (HowTo, FAQ, breadcrumb data)`, () => {
      const file = source(`app/[locale]/${page.file}/page.tsx`);
      assert.match(file, new RegExp(`content=\\{dict\\.${page.key}\\}`));
      assert.match(file, new RegExp(`cardFocus="${page.focus}"`));
      assert.match(file, new RegExp(`initialPlatform="${page.platform}"`));
      assert.match(file, /export const dynamic = "force-static";/);
    });
  }

  it("share one tested layout with the structured data built from the visible text", () => {
    const layout = source("app/[locale]/components/ToolLandingPage.tsx");
    for (const type of ["WebApplication", "HowTo", "FAQPage", "BreadcrumbList"]) assert.match(layout, new RegExp(`"@type": "${type}"`), type);
    assert.match(layout, /content\.howToSteps\.map/);
    assert.match(layout, /content\.faq\.map/);
    assert.match(layout, /<FaqAccordion heading=\{content\.faqHeading\} items=\{content\.faq\} \/>/);
  });

  it("are linked from the sitemap, the footer and every 'other tools' list", () => {
    assert.match(source("app/sitemap.ts"), /\{ path: CAPTION_COPIER_PATH, changeFrequency: "weekly", priority: 0\.8 \}/);
    assert.match(source("app/sitemap.ts"), /\{ path: THUMBNAIL_DOWNLOADER_PATH, changeFrequency: "weekly", priority: 0\.8 \}/);
    assert.match(source("app/[locale]/layout.tsx"), /toolLinks=\{toolPageLinks\(dict\)\}/);
    for (const file of ["app/[locale]/page.tsx", "app/[locale]/[platform]/page.tsx", "app/[locale]/audio-downloader/page.tsx", "app/[locale]/instagram-photo-downloader/page.tsx"]) {
      assert.match(source(file), /toolLinks=\{toolPageLinks\(dict\)\}/, file);
    }
    assert.deepEqual(toolPageLinks(messages("en")).map((t) => t.path), [CAPTION_COPIER_PATH, THUMBNAIL_DOWNLOADER_PATH]);
  });

  it("are honest in English: no MP3, 4K or 'HD guaranteed' claims, and say what isn't possible", () => {
    const c = messages("en").captionCopier;
    const t = messages("en").thumbnailDownloader;
    const all = (p: { sections: { paragraphs: string[] }[]; faq: { a: string }[]; metaDescription: string; lead: string }) =>
      [p.metaDescription, p.lead, ...p.sections.flatMap((s) => s.paragraphs), ...p.faq.map((f) => f.a)].join(" ");
    assert.match(all(c), /2,200/);
    assert.match(all(c), /Only public posts/);
    assert.doesNotMatch(t.metaTitle + t.metaDescription + t.lead, /4k|\bHD\b|unlimited|100%/i);
    assert.match(all(t), /nothing is upscaled/i);
    assert.match(all(t), /Only public videos/);
  });

  for (const locale of locales) {
    it(`${locale}: both pages complete, the same shape as English, titles under 60 and descriptions under 160`, () => {
      for (const key of ["captionCopier", "thumbnailDownloader"]) {
        const p = messages(locale)[key];
        const en = messages("en")[key];
        assert.ok([...p.metaTitle].length <= 60, `${locale}/${key} title is ${[...p.metaTitle].length}`);
        assert.ok([...p.metaDescription].length <= 160, `${locale}/${key} description is ${[...p.metaDescription].length}`);
        assert.equal(p.howToSteps.length, 3);
        assert.equal(p.sections.length, en.sections.length);
        assert.equal(p.faq.length, en.faq.length);
        for (const s of p.sections) assert.equal(s.paragraphs.length, 2, `${locale}/${key}: ${s.heading}`);
        for (const f of p.faq) assert.ok(/[?؟]$/.test(f.q.trim()), `${locale}/${key}: question mark on "${f.q}"`);
        if (locale !== "en") assert.notEqual(p.metaTitle, en.metaTitle, `${locale}/${key} is translated`);
      }
      const preview = messages(locale).preview;
      for (const k of ["captionHeading", "copyCaption", "copyHashtags", "copied", "copyFailed", "downloadCover"]) assert.ok(preview[k]?.trim(), `${locale}: preview.${k}`);
      assert.match(preview.copyHashtags, /\{n\}/);
      assert.match(preview.downloadCover, /\{format\}/);
    });
  }
});
