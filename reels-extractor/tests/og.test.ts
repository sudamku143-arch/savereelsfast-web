/**
 * The share-image route must be safe for every language: the renderer's built-in font has no glyphs for
 * Indic or Arabic script (they would appear as empty boxes), and the query string must never supply text.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";
import { PLATFORM_KEYS } from "../lib/landing.ts";

const route = readFileSync(new URL("../app/api/og/route.tsx", import.meta.url), "utf8");

/** The text between the first "{" after `marker` and its matching "}". */
function block(marker: string): string {
  const start = route.indexOf("{", route.indexOf("= {", route.indexOf(marker)));  // the value, not the type annotation
  let depth = 0;
  for (let i = start; i < route.length; i++) {
    if (route[i] === "{") depth++;
    if (route[i] === "}" && --depth === 0) return route.slice(start, i + 1);
  }
  throw new Error(`no block after ${marker}`);
}

const names = block("const NAMES");
const homeHeadline = block("const HOME_HEADLINE");
const wording = block("const WORDING");

describe("share image route", () => {
  it("has wording for every language, so none falls back to another by accident", () => {
    for (const locale of locales) assert.match(wording, new RegExp(`\\b${locale}: \\{`), `no wording for ${locale}`);
  });

  it("has a home-page headline for every language too", () => {
    for (const locale of locales) assert.match(homeHeadline, new RegExp(`\\b${locale}: "`), `no home headline for ${locale}`);
  });

  it("names every platform slug, plus the audio downloader and home cards", () => {
    const keys = [...names.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(keys, [...Object.values(PLATFORM_KEYS), "audio"].sort());
  });

  it("only draws characters the renderer's font has (Latin), never Indic or Arabic script", () => {
    const literals = [
      ...(names + wording + homeHeadline).matchAll(/"([^"]*)"/g),
      ...wording.matchAll(/`([^`]*)`/g),
    ].map((m) => m[1]);
    assert.ok(literals.length > 20, "expected to find the strings");
    for (const text of literals) {
      for (const char of text) {
        assert.ok(char.codePointAt(0)! <= 0x24f || char === "\u00b7", `"${text}" contains ${char} (U+${char.codePointAt(0)!.toString(16)}), which would render as a box`);
      }
    }
  });

  it("chooses text from the fixed tables only: a query value is a lookup key, never printed", () => {
    assert.match(route, /const platform = query\.get\("p"\) \?\? "";/);
    assert.match(route, /const locale = query\.get\("l"\) \?\? "en";/);
    assert.match(route, /WORDING\[locale\] \?\? WORDING\.en/);
    assert.match(route, /HOME_HEADLINE\[locale\] \?\? HOME_HEADLINE\.en/);
    assert.match(route, /NAMES\[platform\] \?\? NAMES\.instagram/);
    assert.doesNotMatch(route, /query\.get\([^)]*\)\s*}\s*<\/|\{query\.get/, "a raw query value must not be rendered");
  });

  it("caches the image hard: it's fully determined by (p, l), nothing per-request", () => {
    assert.match(route, /"Cache-Control": "public, max-age=\d+, immutable"/);
  });

  it("every localized page points its share image at its own language and platform", () => {
    const meta = readFileSync(new URL("../lib/legal-metadata.ts", import.meta.url), "utf8");
    assert.match(meta, /\?p=\$\{key\}&l=\$\{locale\}/);
    const page = readFileSync(new URL("../app/[locale]/[platform]/page.tsx", import.meta.url), "utf8");
    assert.match(page, /platformOgImage\(PLATFORM_KEYS\[id\], locale\)/);
  });
});
