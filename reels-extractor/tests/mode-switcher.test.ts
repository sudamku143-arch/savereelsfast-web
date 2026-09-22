/**
 * The cute pill above the tool that jumps between the video downloader and the audio-only one: honest wording
 * (no "MP3"), points at the right page in each direction, and is wired into every page that has the tool.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";

type ModeSwitcher = {
  toAudioLabel: string;
  toAudioBadge: string;
  toAudioAria: string;
  toVideoLabel: string;
  toVideoBadge: string;
  toVideoAria: string;
};
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`)).modeSwitcher as ModeSwitcher;

describe("the mode-switcher component", () => {
  const code = source("app/[locale]/components/ModeSwitcher.tsx");

  it("figures out which page it's on from the URL, not a prop threaded through every page", () => {
    assert.match(code, /usePathname/);
    assert.match(code, /audio-downloader\\\/\?\$/, "detects the audio page by its path suffix");
  });

  it("links to /audio-downloader from a video page, and home from the audio page", () => {
    assert.match(code, /localePath\(locale, "\/audio-downloader"\)/);
    assert.match(code, /localePath\(locale\)/);
  });

  it("uses two different gradients, one per direction", () => {
    assert.match(code, /from-violet-600 via-purple-500 to-pink-500/);
    assert.match(code, /from-rose-500 via-pink-500 to-orange-400/);
  });

  it("is a rounded pill with a hover lift, and respects reduced motion", () => {
    assert.match(code, /rounded-full/);
    assert.match(code, /hover:-translate-y-0\.5/);
    assert.match(code, /motion-reduce:transition-none/);
    assert.match(code, /motion-safe:animate-pulse/);
  });

  it("the link text is never redundant with an on-page emoji (a real animated icon carries that job)", () => {
    assert.doesNotMatch(code, /[\u{1F3A7}\u{1F3AC}]/u, "no emoji baked into the pill; HeadphonesIcon/ClapperboardIcon carry it");
  });
});

describe("wired into every page that renders the tool", () => {
  for (const [label, file] of [
    ["home", "app/[locale]/page.tsx"],
    ["a platform page", "app/[locale]/[platform]/page.tsx"],
    ["the audio downloader", "app/[locale]/audio-downloader/page.tsx"],
  ] as const) {
    it(`${label} passes modeSwitcherDict to ExtractorClient`, () => {
      assert.match(source(file), /modeSwitcherDict=\{dict\.modeSwitcher\}/);
    });
  }

  it("ExtractorClient renders it right above the platform tabs / input box", () => {
    const client = source("app/[locale]/components/ExtractorClient.tsx");
    const modeIndex = client.indexOf("<ModeSwitcher");
    const tabsIndex = client.indexOf("<PlatformTabs");
    assert.ok(modeIndex > 0 && tabsIndex > modeIndex, "ModeSwitcher must render before PlatformTabs");
  });
});

describe("honest wording, in every language", () => {
  for (const locale of locales) {
    it(`${locale}: no MP3 claim, a NEW-style badge for audio, an HD badge for video`, () => {
      const d = messages(locale);
      for (const field of Object.values(d)) assert.ok(field.trim().length > 0, `${locale}: empty modeSwitcher field`);
      const all = Object.values(d).join(" ");
      assert.doesNotMatch(all, /mp3/i, `${locale}: the switcher must not claim MP3`);
      assert.ok(d.toVideoBadge.toUpperCase().includes("HD"), `${locale}: video badge should say HD`);
      assert.notEqual(d.toAudioLabel, d.toVideoLabel);
    });
  }

  it("English matches the two directions exactly", () => {
    const d = messages("en");
    assert.equal(d.toAudioLabel, "Extract Audio");
    assert.equal(d.toVideoLabel, "Download HD Video");
  });
});
