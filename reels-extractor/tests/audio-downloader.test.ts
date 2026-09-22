/**
 * The /audio-downloader page: honest audio-extraction copy (no fake MP3 conversion, no invented bitrate),
 * proper SEO metadata, 600+ words of real content, and FAQPage-ready FAQs, in every language.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";

type Section = { heading: string; paragraphs: string[] };
type Faq = { q: string; a: string };
type AudioDownloader = {
  metaTitle: string;
  metaDescription: string;
  h1: string;
  lead: string;
  breadcrumb: string;
  footerLabel: string;
  sections: Section[];
  faqHeading: string;
  faq: Faq[];
};
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) =>
  JSON.parse(source(`messages/${locale}.json`)).audioDownloader as AudioDownloader;
const length = (text: string) => [...text].length;
const wordCount = (text: string) => text.trim().split(/\s+/).length;

describe("audio downloader: honest about format and quality (English, word for word)", () => {
  const d = messages("en");

  it("never claims MP3 conversion or that private content works; a fixed bitrate appears only as a warning", () => {
    const all = [d.metaTitle, d.metaDescription, d.h1, d.lead, ...d.sections.flatMap((s) => s.paragraphs)].join(" ");
    assert.doesNotMatch(all, /convert(s|ed|ing)? .* (to |into )?mp3/i, "no page copy claims MP3 conversion");
    assert.doesNotMatch(all, /without (login|an? app)/i, "no wording implies private/no-login content works");
    // 320kbps appears once, only as a red flag about OTHER tools' false promises, never one of our own.
    const mentions = all.match(/320\s*kbps/gi) ?? [];
    assert.equal(mentions.length, 1, "320kbps should appear at most once, in the honesty warning");
    assert.match(all, /320kbps no matter the source, treat that as a red flag/);
  });

  it("never uses the MP3-converter search phrases the page was asked to target", () => {
    const all = [d.metaTitle, d.metaDescription, d.h1, d.lead, ...d.sections.flatMap((s) => s.paragraphs)]
      .join(" ")
      .toLowerCase();
    assert.doesNotMatch(all, /mp3 converter/, "the tool is not an MP3 converter and must not claim to be");
    assert.doesNotMatch(all, /sound to mp3/, "no wording promises an MP3 file");
  });

  it("the FAQ answers the MP3 question honestly instead of avoiding it", () => {
    const mp3 = d.faq.find((f) => /mp3/i.test(f.q));
    assert.ok(mp3, "expected a FAQ addressing MP3 directly");
    assert.match(mp3!.a, /doesn't convert|not.*convert/i);
    assert.match(mp3!.a, /M4A/);
    assert.doesNotMatch(mp3!.a, /320/);
  });

  it("private accounts are explicitly out of scope, consistent with the rest of the site", () => {
    const priv = d.faq.find((f) => /private/i.test(f.q));
    assert.ok(priv, "expected a FAQ about private content");
    assert.match(priv!.a, /^No\./);
  });

  it("has 4 distinct sections and 7 FAQs totalling 600+ words", () => {
    assert.equal(d.sections.length, 4);
    assert.equal(new Set(d.sections.map((s) => s.heading)).size, 4, "duplicate section heading");
    assert.equal(d.faq.length, 7);
    assert.equal(new Set(d.faq.map((f) => f.q)).size, 7, "duplicate FAQ question");
    const words =
      d.sections.reduce((n, s) => n + s.paragraphs.reduce((m, p) => m + wordCount(p), 0), 0) +
      d.faq.reduce((n, f) => n + wordCount(f.q) + wordCount(f.a), 0);
    assert.ok(words >= 600, `only ${words} words`);
  });

  it("names both Instagram and YouTube up front (H1, lead and the two SEO sections), honestly", () => {
    assert.equal(d.h1, "Instagram & YouTube Audio Downloader");
    assert.match(d.lead, /Instagram Reels, YouTube Shorts/);
    assert.equal(d.sections[1].heading, "How to Extract Audio from Instagram & YouTube Online");
    assert.equal(d.sections[2].heading, "Why Choose SaveReelsFast Audio Downloader?");
    // Still says, honestly, that 8 more platforms work too - narrower headings, not a narrower product.
    assert.match(d.sections[2].paragraphs[0], /Facebook, Threads, X, Pinterest, TikTok, Reddit, Snapchat/);
  });

  it("new FAQs answer honestly: both platforms work, quality is the platform's own, no fixed download cap", () => {
    const both = d.faq.find((f) => /both/i.test(f.q));
    assert.ok(both, "expected a FAQ about Instagram + YouTube together");
    assert.match(both!.a, /^Yes\./);

    const quality = d.faq.find((f) => /keep.*quality|original quality/i.test(f.q));
    assert.ok(quality, "expected a FAQ about audio quality");
    assert.match(quality!.a, /^Yes\./);
    assert.doesNotMatch(quality!.a, /320|guarantee/i);

    const limit = d.faq.find((f) => /limit/i.test(f.q));
    assert.ok(limit, "expected a FAQ about download limits");
    assert.doesNotMatch(limit!.a, /\d+\s*(MB|GB|requests?|downloads?)\b/, "no exact threshold is published");
  });
});

for (const locale of locales) {
  describe(`audio downloader (${locale})`, () => {
    const d = messages(locale);

    it("has a title 25-60 chars, a description 90-160 chars, and every field non-empty", () => {
      assert.ok(length(d.metaTitle) >= 25 && length(d.metaTitle) <= 60, `title is ${length(d.metaTitle)} chars`);
      assert.ok(
        length(d.metaDescription) >= 90 && length(d.metaDescription) <= 160,
        `description is ${length(d.metaDescription)} chars`
      );
      for (const field of [d.h1, d.lead, d.breadcrumb, d.footerLabel, d.faqHeading]) assert.ok(field.trim().length > 0);
    });

    it("has 4 sections with real paragraphs, and 7 FAQs with a question mark", () => {
      assert.equal(d.sections.length, 4);
      for (const s of d.sections) {
        assert.ok(s.heading.trim().length > 0);
        assert.ok(s.paragraphs.length >= 1);
        for (const p of s.paragraphs) assert.ok(p.trim().length > 40, `${locale}: thin paragraph under "${s.heading}"`);
      }
      assert.equal(d.faq.length, 7);
      for (const f of d.faq) {
        assert.ok(/[?؟]$/.test(f.q.trim()), `${locale}: question mark on "${f.q}"`);
        assert.ok(f.a.trim().length >= 40, `${locale}: thin answer to "${f.q}"`);
      }
    });
  });
}

describe("the page wires the honest content in, and reuses the tested extraction UI", () => {
  const page = source("app/[locale]/audio-downloader/page.tsx");

  it("passes its own heading/intro to ExtractorClient instead of a platform's", () => {
    assert.match(page, /heroHeading=\{audioDownloader\.h1\}/);
    assert.match(page, /heroLead=\{audioDownloader\.lead\}/);
    assert.doesNotMatch(page, /initialPlatform=/, "no single platform is preselected: audio works across all of them");
  });

  it("renders all 4 sections and the FAQ from the same dictionary the metadata uses", () => {
    assert.match(page, /audioDownloader\.sections\.map/);
    assert.match(page, /audioDownloader\.faq/);
    assert.match(page, /pageMetadata\(locale, "\/audio-downloader", audioDownloader\.metaTitle, audioDownloader\.metaDescription\)/);
  });

  it("Offer.price is a Number, and the breadcrumb's last item has no redundant URL (same as every other page)", () => {
    assert.match(page, /offers: \{ "@type": "Offer", price: 0, priceCurrency: "USD" \}/);
    assert.match(page, /name: audioDownloader\.breadcrumb \},\s*\n\s*\],/);
  });

  it("ExtractorClient accepts the override, and falls back to the usual heading/intro when it is not given", () => {
    const client = source("app/[locale]/components/ExtractorClient.tsx");
    assert.match(client, /heroHeading\?: string/);
    assert.match(client, /heroLead\?: string/);
    assert.match(client, /heroHeading \?\? active\.title/);
    assert.match(client, /heroLead \?\? heroDict\.subtitle/);
  });
});

describe("linked from the footer and the sitemap", () => {
  it("the footer lists it alongside the platform tools", () => {
    const footer = source("app/[locale]/components/Footer.tsx");
    assert.match(footer, /href: localePath\(locale, "\/audio-downloader"\), label: audioDownloaderLabel/);
    const layout = source("app/[locale]/layout.tsx");
    assert.match(layout, /audioDownloaderLabel=\{dict\.audioDownloader\.footerLabel\}/);
  });

  it("app/sitemap.ts includes the page once per language, at 0.85 daily", () => {
    const sitemap = source("app/sitemap.ts");
    assert.match(sitemap, /\{ path: "\/audio-downloader", changeFrequency: "daily", priority: 0\.85 \}/);
  });
});
