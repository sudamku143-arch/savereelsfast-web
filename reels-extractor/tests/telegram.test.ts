/**
 * The Telegram bot links (floating button, header, footer, "sameAs" structured data) and the long-tail FAQs on
 * every platform page (shown on the page and sent as FAQPage data from the same list).
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LANDING_PLATFORMS, LONGTAIL_FAQ, fillTemplate } from "../lib/landing.ts";
import { TELEGRAM_BOT_URL, siteSchema } from "../lib/site.ts";

const LOCALES = ["en", "es", "pt", "hi", "bn", "te", "ta", "mr", "id", "fr", "ar"] as const;
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`));

describe("the bot address", () => {
  it("is exactly the requested one", () => {
    assert.equal(TELEGRAM_BOT_URL, "https://t.me/savereelsfast_bot");
  });
});

describe("site-wide structured data", () => {
  const graph = siteSchema()["@graph"];

  it("declares the bot as a sameAs profile of both the Organization and the WebSite", () => {
    const org = graph.find((n) => n["@type"] === "Organization");
    const site = graph.find((n) => n["@type"] === "WebSite");
    assert.deepEqual(org?.sameAs, ["https://t.me/savereelsfast_bot"]);
    assert.deepEqual(site?.sameAs, ["https://t.me/savereelsfast_bot"]);
  });

  it("links the WebSite to the Organization by id, and both ids resolve", () => {
    const ids = new Set(graph.map((n) => n["@id"]));
    const site = graph.find((n) => n["@type"] === "WebSite") as { publisher: { "@id": string } };
    assert.ok(ids.has(site.publisher["@id"]));
  });

  it("is rendered on every page, by a component the layout includes, with < escaped", () => {
    assert.match(source("app/[locale]/layout.tsx"), /<SiteSchema \/>/);
    const component = source("app/[locale]/components/SiteSchema.tsx");
    assert.match(component, /siteSchema\(\)/);
    assert.match(component, /application\/ld\+json/);
    assert.match(component, /replace\(\/<\/g, "\\u003c"\)/);
  });
});

describe("the links to the bot", () => {
  const fab = source("app/[locale]/components/TelegramFab.tsx");
  const header = source("app/[locale]/components/Header.tsx");
  const footer = source("app/[locale]/components/Footer.tsx");
  const layout = source("app/[locale]/layout.tsx");

  it("the header, the footer and the floating button all open the bot in a new tab, safely", () => {
    for (const [name, code] of [["fab", fab], ["header", header], ["footer", footer]] as const) {
      assert.match(code, /href=\{TELEGRAM_BOT_URL\}/, `${name} links the bot`);
      assert.match(code, /target="_blank"/, name);
      assert.match(code, /rel="noopener noreferrer"/, name);
    }
  });

  it("the layout shows the floating button and passes the words to the header and footer", () => {
    assert.match(layout, /<TelegramFab dict=\{dict\.telegram\} \/>/);
    assert.match(layout, /<Header [^>]*telegram=\{dict\.telegram\}/);
    assert.match(layout, /<Footer [^>]*telegram=\{dict\.telegram\}/);
  });

  it("the floating button never covers an ad, the cookie banner or the header", () => {
    // Layers: header z-50, cookie banner z-[60], ads z-40; the button is under all of them.
    assert.match(fab, /fixed bottom-3 start-3 z-30/);
    assert.doesNotMatch(fab, /\bend-\d|right-\d/, "it stays on the start side; the collapsed ad tab is on the right");
    // While the sticky banner is up the button moves above it.
    const ad = source("app/[locale]/components/AdBanner.tsx");
    assert.match(ad, /document\.body\.dataset\.stickyAd = "open"/);
    assert.match(ad, /delete document\.body\.dataset\.stickyAd/);
    const css = source("app/globals.css");
    assert.match(css, /body\[data-sticky-ad\] \.telegram-fab \{\s+bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 100px\)/);
    assert.match(css, /min-width: 768px\) and \(max-width: 1279px\)[\s\S]*\+ 140px/);
  });

  it("can be closed for the visit, and works with storage blocked", () => {
    assert.match(fab, /sessionStorage\.setItem\(HIDDEN_KEY, "1"\)/);
    assert.match(fab, /catch/);
    assert.match(fab, /aria-label=\{dict\.hide\}/);
  });
});

describe("words for the Telegram links, in every language", () => {
  for (const locale of LOCALES) {
    it(`${locale}: label, floating text and accessible names`, () => {
      const t = messages(locale).telegram as { label: string; fab: string; open: string; hide: string };
      assert.equal(t.label, "Telegram Bot");
      assert.ok(t.fab.includes("Telegram"), "the floating text names Telegram");
      assert.ok(t.fab.length <= 40, `the floating text must stay short: "${t.fab}"`);
      assert.ok(t.open.trim().length > 10 && t.hide.trim().length > 5);
      if (locale === "en") assert.equal(t.fab, "Use Telegram Bot");
      else assert.notEqual(t.fab, "Use Telegram Bot", `${locale} is translated`);
    });
  }
});

describe("long-tail FAQs per platform", () => {
  it("every platform gets the ones that are true for it, and none that are not", () => {
    assert.deepEqual(Object.keys(LONGTAIL_FAQ).sort(), [...LANDING_PLATFORMS].sort());
    for (const id of LANDING_PLATFORMS) assert.ok(LONGTAIL_FAQ[id].length >= 1, id);
    assert.deepEqual(LONGTAIL_FAQ.instagram, ["reelsQuality", "cameraRoll", "audio", "free"]);
    assert.ok(LONGTAIL_FAQ.youtube.includes("audio"), "Shorts audio is on the YouTube page");
    assert.ok(LONGTAIL_FAQ.snapchat.includes("snapchatNoApp"));
    assert.deepEqual(LONGTAIL_FAQ.facebook, ["freeFbThreads"]);
    assert.deepEqual(LONGTAIL_FAQ.threads, ["freeFbThreads"]);
    for (const id of LANDING_PLATFORMS) {
      if (id !== "instagram") assert.ok(!LONGTAIL_FAQ[id].includes("reelsQuality"), `${id} must not claim Instagram's quality`);
      if (id !== "snapchat") assert.ok(!LONGTAIL_FAQ[id].includes("snapchatNoApp"), id);
    }
  });

  it("English asks the four questions exactly as requested", () => {
    const l = messages("en").landing.common.longtail;
    assert.equal(l.reelsQuality.q, "How to download Instagram Reels in 1080p without watermark?");
    assert.equal(l.audio.q, "Can I download audio/MP3 from Instagram Reels and Shorts?");
    assert.equal(l.snapchatNoApp.q, "How to save Snapchat Spotlight videos without app install?");
    assert.equal(l.freeFbThreads.q, "Is it free to download Facebook & Threads videos online?");
  });

  it("English answers are honest: no MP3 conversion promised, no guaranteed 1080p, no invented watermark claims", () => {
    const l = messages("en").landing.common.longtail;
    assert.match(l.audio.a, /don't convert to MP3/);
    assert.match(l.reelsQuality.a, /up to 1080p when the Reel was uploaded in that quality/);
    assert.match(l.reelsQuality.a, /no watermark of our own/);
    assert.match(l.snapchatNoApp.a, /Stories and private snaps are not supported/);
    assert.match(l.freeFbThreads.a, /Only public videos/);
  });

  for (const locale of LOCALES) {
    it(`${locale}: five real questions and answers, with the steps where promised`, () => {
      const l = messages(locale).landing.common.longtail as Record<string, { q: string; a: string }>;
      assert.deepEqual(Object.keys(l).sort(), ["audio", "cameraRoll", "free", "freeFbThreads", "reelsQuality", "snapchatNoApp"]);
      for (const [key, item] of Object.entries(l)) {
        assert.ok(/[?؟]$/.test(item.q.trim()), `${key}: question mark`);
        assert.ok(item.a.trim().length >= 60, `${key}: answer too thin`);
      }
      for (const key of ["reelsQuality", "snapchatNoApp"]) {
        assert.match(l[key].a, /[1১]\)/, `${locale}.${key} lists step 1`);
        assert.match(l[key].a, /[3৩]\)/, `${locale}.${key} lists step 3`);
      }
      // cameraRoll is a deliberate 2-step answer.
      assert.match(l.cameraRoll.a, /[1১]\)/, `${locale}.cameraRoll lists step 1`);
      assert.match(l.cameraRoll.a, /[2২]\)/, `${locale}.cameraRoll lists step 2`);
      assert.doesNotMatch(l.cameraRoll.a, /[3৩]\)/, `${locale}.cameraRoll should stay 2 steps`);
      if (locale !== "en") assert.notEqual(l.free.q, messages("en").landing.common.longtail.free.q);
    });

    it(`${locale}: every platform page resolves its placeholders and repeats no question`, () => {
      const m = messages(locale);
      for (const id of LANDING_PLATFORMS) {
        const vars = { platform: m.platforms[id].name, noun: m.landing.platforms[id].noun, copyHint: m.landing.platforms[id].copyHint };
        const shown = LONGTAIL_FAQ[id].map((key) => m.landing.common.longtail[key] as { q: string; a: string });
        const all = [
          ...m.landing.platforms[id].faq,
          ...shown,
          ...m.landing.common.sharedFaq,
        ].map((f: { q: string; a: string }) => ({ q: fillTemplate(f.q, vars), a: fillTemplate(f.a, vars) }));
        for (const f of all) assert.doesNotMatch(f.q + f.a, /\{\w+\}/, `${locale}/${id}: unresolved placeholder in "${f.q}"`);
        assert.equal(new Set(all.map((f) => f.q)).size, all.length, `${locale}/${id}: a question appears twice`);
      }
    });
  }
});

describe("the FAQPage data is exactly what the page shows", () => {
  const page = source("app/[locale]/[platform]/page.tsx");

  it("one list feeds both the visible accordion and the JSON-LD", () => {
    assert.match(page, /const faqItems = \[[\s\S]*LONGTAIL_FAQ\[id\]\.map[\s\S]*common\.sharedFaq\.map/);
    assert.match(page, /mainEntity: faqItems\.map/);
    assert.match(page, /<FaqAccordion heading=\{fillTemplate\(common\.faqHeading, vars\)\} items=\{faqItems\} \/>/);
  });
});
