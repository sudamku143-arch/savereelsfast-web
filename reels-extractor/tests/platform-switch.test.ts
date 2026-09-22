/**
 * The platform switcher: a tab click updates the form at once, then routes to that platform's page in the
 * same language; the visitor is never left waiting on a dead lookup.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { localePath, locales, switchLocalePath, type Locale } from "../lib/i18n-config.ts";
import { PLATFORM_SLUGS } from "../lib/landing.ts";
import { buildPlatformInfo } from "../lib/platform-info.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`));
const ids = Object.keys(PLATFORM_SLUGS) as (keyof typeof PLATFORM_SLUGS)[];

describe("what a tab switch shows, in every language", () => {
  for (const locale of locales) {
    it(`${locale}: every platform has its own heading, helper text, title and language-prefixed address`, () => {
      const content = messages(locale).landing.platforms;
      const info = buildPlatformInfo(content, (id) => localePath(locale as Locale, `/${PLATFORM_SLUGS[id]}`));
      assert.deepEqual(Object.keys(info).sort(), [...ids].sort());
      const hrefs = new Set<string>();
      for (const id of ids) {
        const entry = info[id];
        for (const field of ["h1", "lead", "copyHint", "metaTitle"] as const) {
          assert.ok(entry[field].length > 5, `${locale}/${id}: ${field} is empty`);
          assert.equal(entry[field], content[id][field], `${locale}/${id}: ${field} differs from the landing page`);
        }
        // the language is part of the address, so it survives the switch
        const expected = locale === "en" ? `/${PLATFORM_SLUGS[id]}` : `/${locale}/${PLATFORM_SLUGS[id]}`;
        assert.equal(entry.href, expected);
        hrefs.add(entry.href);
      }
      assert.equal(hrefs.size, ids.length, "two platforms share an address");
    });
  }

  it("helper text differs per platform (it is the platform's own 'how to copy the link')", () => {
    const en = messages("en").landing.platforms;
    const hints = ids.map((id) => en[id].copyHint);
    assert.equal(new Set(hints).size, hints.length);
  });
});

describe("switching language keeps the page", () => {
  it("swaps only the language prefix", () => {
    assert.equal(switchLocalePath("/es/youtube-video-downloader", "hi"), "/hi/youtube-video-downloader");
    assert.equal(switchLocalePath("/es/youtube-video-downloader", "en"), "/youtube-video-downloader");
    assert.equal(switchLocalePath("/twitter-x-video-downloader", "ar"), "/ar/twitter-x-video-downloader");
    assert.equal(switchLocalePath("/dmca", "fr"), "/fr/dmca");
  });

  it("handles the home page in either direction", () => {
    assert.equal(switchLocalePath("/", "es"), "/es");
    assert.equal(switchLocalePath("/hi", "en"), "/");
    assert.equal(switchLocalePath("/hi", "bn"), "/bn");
    assert.equal(switchLocalePath("/hi/", "en"), "/");
  });

  it("does not mistake a path segment for a language", () => {
    assert.equal(switchLocalePath("/tiktok-video-downloader", "es"), "/es/tiktok-video-downloader");
    assert.equal(switchLocalePath("/xx/tiktok-video-downloader", "es"), "/es/xx/tiktok-video-downloader");
  });

  it("round-trips through every language", () => {
    for (const from of locales) {
      for (const to of locales) {
        const there = switchLocalePath(localePath(from, "/reddit-video-downloader"), to);
        assert.equal(there, localePath(to, "/reddit-video-downloader"), `${from} -> ${to}`);
      }
    }
  });
});

describe("the tab component", () => {
  const tabs = source("app/[locale]/components/PlatformTabs.tsx");
  const client = source("app/[locale]/components/ExtractorClient.tsx");

  it("renders real, prefetched links (crawlable, open in a new tab) rather than buttons", () => {
    assert.match(tabs, /import Link from "next\/link"/);
    assert.match(tabs, /href=\{hrefs\[id\]\}/);
    assert.match(tabs, /scroll=\{false\}/);
    assert.match(tabs, /aria-current/);
    assert.doesNotMatch(tabs, /<button/);
  });

  it("leaves modified clicks (new tab, download) to the browser and handles a plain click itself", () => {
    assert.match(tabs, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
    assert.match(tabs, /event\.preventDefault\(\);\s*onSelect\(id\)/);
  });

  it("a click updates the form first, then routes without scrolling or reloading", () => {
    const handler = client.slice(client.indexOf("function handleSelectPlatform"), client.indexOf("const active ="));
    const order = ["setPlatform(id)", "setSwitched(true)", "document.title = info.metaTitle", "router.push(info.href, { scroll: false })"];
    let last = -1;
    for (const step of order) {
      const at = handler.indexOf(step);
      assert.ok(at > last, `"${step}" is missing or out of order`);
      last = at;
    }
    assert.match(handler, /startTransition/);
    assert.match(handler, /window\.location\.pathname !== info\.href/);
    assert.doesNotMatch(client, /window\.location\.(assign|href\s*=)|location\.reload/, "a tab click must never reload the page");
  });

  it("the heading, intro, placeholder and helper text all come from the selected platform", () => {
    assert.match(client, /follows \? platformInfo\[platform\]\.h1 : active\.title/);
    assert.match(client, /follows \? platformInfo\[platform\]\.lead : heroDict\.subtitle/);
    assert.match(client, /placeholder=\{active\.placeholder\}/);
    assert.match(client, /\{platformInfo\[platform\]\.copyHint\}/);
  });

  it("keeps the typed link across the page change, and shows the route's platform on a platform page", () => {
    assert.match(client, /getDraft\(\)/);
    assert.match(client, /onDraftChange=\{setDraft\}/);
    assert.match(client, /last\.result\.platform && !landing/);
  });

  it("both page types hand over the data, built with language-prefixed addresses", () => {
    for (const file of ["app/[locale]/page.tsx", "app/[locale]/[platform]/page.tsx"]) {
      const page = source(file);
      assert.match(page, /buildPlatformInfo\(dict\.landing\.platforms, \(pid\) => localePath\(locale, landingPath\(pid\)\)\)/, file);
    }
  });
});

describe("a lookup never leaves the visitor waiting", () => {
  const client = source("app/[locale]/components/ExtractorClient.tsx");
  const route = source("app/api/extract/route.ts");

  it("the page gives up shortly after the site does, and the site after the scraper", () => {
    const page = Number(client.match(/(?<![A-Z_])EXTRACT_TIMEOUT_MS = ([\d_]+)/)?.[1].replaceAll("_", ""));
    const site = Number(route.match(/(?<![A-Z_])SCRAPER_TIMEOUT_MS = (\d+)/)?.[1]);
    assert.ok(site >= 6000 && site <= 8000, `site waits ${site} ms`);
    assert.ok(page > site && page <= 12_000, `page waits ${page} ms`);
  });

  it("the page aborts the request and shows a timeout, not a spinner", () => {
    assert.match(client, /signal: controller\.signal/);
    assert.match(client, /setErrorCode\(timedOut \? "PLATFORM_TIMEOUT" : "NETWORK"\)/);
    assert.match(client, /if \(controller\.signal\.aborted && !timedOut\) return/, "a deliberate cancel must not show an error");
  });

  it("switching tab cancels the lookup that was running", () => {
    assert.match(client, /if \(status === "loading"\) \{[^}]*abortRef\.current\?\.abort\(\)/s);
  });

  it("only successful lookups may be cached; errors and timeouts never are", () => {
    assert.match(route, /cacheable && status === 200 \? CACHE_CONTROL_OK : "no-store"/);
    assert.match(route, /"Cache-Control": "no-store"/);
  });
});

describe("the tab bar does not fetch every other platform on load", () => {
  const tabs = source("app/[locale]/components/PlatformTabs.tsx");

  it("only the active tab is allowed to prefetch", () => {
    // All 10 tabs sit above the fold, so Next's default viewport prefetch would otherwise fire a background
    // RSC request for every other platform the moment the page loads - worst on a throttled mobile connection.
    assert.match(tabs, /prefetch=\{isActive \? undefined : false\}/);
  });

  it("is still a real, crawlable link to that platform's own page", () => {
    assert.match(tabs, /<Link\b/);
    assert.match(tabs, /href=\{hrefs\[id\]\}/);
  });
});
