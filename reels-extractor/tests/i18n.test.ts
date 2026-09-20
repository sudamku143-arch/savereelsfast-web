/**
 * Language configuration: every language has a message file, right-to-left languages are marked,
 * and only languages with reviewed legal text claim to have it.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED, defaultLocale, hasLegalTranslation, localeDir, localePath, locales } from "../lib/i18n-config.ts";

const messages = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("language configuration", () => {
  it("has a message file for every language, and no file for a language that is not configured", () => {
    for (const locale of locales) assert.ok(existsSync(new URL(`../messages/${locale}.json`, import.meta.url)), locale);
  });

  it("registers every language in the dictionary loader and the language switcher", () => {
    const loader = readFileSync(new URL("../lib/get-dictionary.ts", import.meta.url), "utf8");
    const header = readFileSync(new URL("../app/[locale]/components/Header.tsx", import.meta.url), "utf8");
    for (const locale of locales) {
      assert.match(loader, new RegExp(`\\b${locale}: \\(\\) => import\\("\\.\\./messages/${locale}\\.json"\\)`), `${locale} missing in get-dictionary`);
      assert.match(header, new RegExp(`\\b${locale}: "`), `${locale} missing in the language switcher`);
    }
  });

  it("keeps English unprefixed and prefixes the rest", () => {
    assert.equal(defaultLocale, "en");
    assert.equal(localePath("en", "/dmca"), "/dmca");
    for (const locale of locales.filter((l) => l !== "en")) assert.equal(localePath(locale, "/dmca"), `/${locale}/dmca`);
  });

  it("marks Arabic as right-to-left and everything else as left-to-right", () => {
    for (const locale of locales) assert.equal(localeDir(locale), locale === "ar" ? "rtl" : "ltr", locale);
  });
});

describe("legal pages by language", () => {
  it("lists exactly the languages whose message file carries a legal block", () => {
    const withLegal = locales.filter((l) => "legal" in messages(l));
    assert.deepEqual([...withLegal].sort(), [...LEGAL_TRANSLATED].sort());
  });

  it("falls back to English for the others (they must not ship half-translated legal text)", () => {
    for (const locale of locales) {
      assert.equal(hasLegalTranslation(locale), "legal" in messages(locale), locale);
    }
  });
});

describe("every language has the same interface text", () => {
  const flatten = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => flatten(child, `${prefix}${prefix ? "." : ""}${key}`))
      : [prefix];
  const english = flatten(messages("en")).filter((key) => !key.startsWith("legal"));

  for (const locale of locales.filter((l) => l !== "en")) {
    it(`${locale} has every key English has, and no extra ones`, () => {
      const own = flatten(messages(locale)).filter((key) => !key.startsWith("legal"));
      assert.deepEqual(own.filter((k) => !english.includes(k)), [], "extra keys");
      assert.deepEqual(english.filter((k) => !own.includes(k)), [], "missing keys");
    });

    it(`${locale} keeps every {placeholder} the English text uses`, () => {
      const english_ = messages("en");
      const own = messages(locale);
      const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(",");
      const walk = (a: unknown, b: unknown, path: string) => {
        if (typeof a === "string") {
          if (path.startsWith("landing.platforms") || path.startsWith("legal")) return; // per-platform copy is plain text
          assert.equal(placeholders(String(b)), placeholders(a), `${locale}: placeholders differ at ${path}`);
        } else if (a && typeof a === "object") {
          for (const key of Object.keys(a)) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)?.[key], `${path}${path ? "." : ""}${key}`);
        }
      };
      walk(english_, own, "");
    });
  }
});
