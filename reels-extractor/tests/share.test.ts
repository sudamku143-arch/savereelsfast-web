/**
 * The "Share this tool" row: shown only after a video has been saved, made of plain links (nothing from WhatsApp or X
 * is loaded until a visitor taps one), in every language, pointing at the site's home page in the visitor's language.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// lib/share.ts imports its neighbours without a file extension (as the site build wants): run it from a copy.
const dir = mkdtempSync(join(tmpdir(), "srf-share-"));
for (const file of ["i18n-config", "site", "share"]) {
  writeFileSync(join(dir, `${file}.ts`), source(`lib/${file}.ts`).replace(/from "\.\/([\w-]+)"/g, 'from "./$1.ts"'));
}
const { shareUrl, whatsappHref, xHref } = (await import(pathToFileURL(join(dir, "share.ts")).href)) as typeof import("../lib/share.ts");

describe("share links", () => {
  it("point at the home page in the visitor's language, tagged with where the visit came from", () => {
    assert.equal(shareUrl("en", "whatsapp"), "https://savereelsfast.com/?utm_source=share&utm_medium=whatsapp&utm_campaign=after-download");
    assert.equal(shareUrl("hi", "x"), "https://savereelsfast.com/hi?utm_source=share&utm_medium=x&utm_campaign=after-download");
    assert.equal(shareUrl("ar", "copy"), "https://savereelsfast.com/ar?utm_source=share&utm_medium=copy&utm_campaign=after-download");
  });

  it("every language shares its own home page", () => {
    for (const locale of locales) {
      const url = new URL(shareUrl(locale, "copy"));
      assert.equal(url.origin, "https://savereelsfast.com");
      assert.equal(url.pathname, locale === "en" ? "/" : `/${locale}`);
    }
  });

  it("WhatsApp's link carries the message and the address, safely encoded", () => {
    const url = new URL(whatsappHref("I saved a video & it's free!", "https://savereelsfast.com/?a=1&b=2"));
    assert.equal(url.origin + url.pathname, "https://wa.me/");
    assert.equal(url.searchParams.get("text"), "I saved a video & it's free! https://savereelsfast.com/?a=1&b=2");
  });

  it("X's link carries the message and the address as separate, safely encoded values", () => {
    const url = new URL(xHref("Free video saver & more", "https://savereelsfast.com/?a=1&b=2"));
    assert.equal(url.origin + url.pathname, "https://x.com/intent/post");
    assert.equal(url.searchParams.get("text"), "Free video saver & more");
    assert.equal(url.searchParams.get("url"), "https://savereelsfast.com/?a=1&b=2");
  });

  it("a message cannot break out of the address into another one", () => {
    const evil = "\" onmouseover=\"alert(1)\" https://evil.example/ ";
    for (const href of [whatsappHref(evil, "https://savereelsfast.com/"), xHref(evil, "https://savereelsfast.com/")]) {
      const url = new URL(href);
      assert.ok(["wa.me", "x.com"].includes(url.host), url.host);
      assert.doesNotMatch(href, /[" ]/, "no raw quote or space in the address");
    }
  });
});

describe("the share row on the page", () => {
  const tool = source("app/[locale]/components/ShareTool.tsx");
  const card = source("app/[locale]/components/PreviewCard.tsx");
  const button = source("app/[locale]/components/DownloadButton.tsx");
  const slider = source("app/[locale]/components/ItemsSlider.tsx");

  it("opens both share links in a new tab without giving the other site access to this one", () => {
    const anchors = [...tool.matchAll(/<a\s[^>]*?>/gs)].map((m) => m[0]);
    assert.equal(anchors.length, 2, "WhatsApp and X");
    for (const anchor of anchors) {
      assert.match(anchor, /target="_blank"/);
      assert.match(anchor, /rel="noopener noreferrer"/);
    }
  });

  it("is plain links: no widget, script or SDK from WhatsApp, X or anyone else is loaded", () => {
    assert.doesNotMatch(tool, /<script|createElement\("script"\)|platform\.twitter|connect\.facebook|whatsapp\.com|\.src\s*=/);
    assert.doesNotMatch(tool, /fetch\(|XMLHttpRequest|sendBeacon/, "nothing is sent anywhere by this component");
  });

  it("copies the link only where the browser allows it, and says so", () => {
    assert.match(tool, /typeof navigator\.clipboard\?\.writeText === "function"/);
    assert.match(tool, /\{canCopy && \(/);
    assert.match(tool, /catch \{/, "a refused clipboard must not break the row");
    assert.match(tool, /aria-live="polite"/);
  });

  it("appears only after a download has been saved, never before", () => {
    assert.match(card, /const \[downloaded, setDownloaded\] = useState\(false\);/);
    assert.match(card, /\{downloaded && <ShareTool locale=\{locale\} dict=\{downloadDict\.share\} \/>\}/);
    assert.equal(card.split("onSaved={() => setDownloaded(true)}").length - 1, 2, "the video and the audio button");
    assert.match(card, /onDownloaded=\{\(\) => setDownloaded\(true\)\}/, "and a carousel's downloads");
  });

  it("the download button reports a save both when it finishes in the page and when the browser takes over", () => {
    assert.equal(button.split("onSaved?.();").length - 1, 3, "finished, and the two hand-overs to the download manager");
    assert.match(slider, /onSaved=\{onDownloaded\}/);
    assert.match(slider, /onDownloaded\?\.\(\);/, "download all");
  });

  it("the language reaches the card from both pages that show the tool", () => {
    assert.match(source("app/[locale]/page.tsx"), /<ExtractorClient\s+locale=\{locale\}/);
    assert.match(source("app/[locale]/[platform]/page.tsx"), /<ExtractorClient\s+locale=\{locale\}/);
    assert.match(source("app/[locale]/components/ExtractorClient.tsx"), /<PreviewCard\s+locale=\{locale\}/);
  });
});

describe("share text in every language", () => {
  for (const locale of locales) {
    it(`${locale}: heading, both services, copy, confirmation and a message that names the site`, () => {
      const { share } = (JSON.parse(source(`messages/${locale}.json`)) as { download: { share: Record<string, string> } }).download;
      for (const key of ["heading", "whatsapp", "x", "copy", "copied", "text"]) assert.ok(share[key]?.trim().length >= 1, `${locale}.${key}`);
      assert.ok(share.text.includes("SaveReelsFast"), "the message names the tool");
      assert.notEqual(share.copy, share.copied);
      assert.ok(share.text.length <= 200, `the message fits in a post (${share.text.length} characters)`);
    });
  }
});
