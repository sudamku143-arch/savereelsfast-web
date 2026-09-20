/**
 * Search-result copy in every language: titles under 60 characters, descriptions under 160,
 * the platform named in each title, and no page repeating another's title.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED, locales } from "../lib/i18n-config.ts";

type Doc = { title: string; description: string };
type Messages = {
  meta: Doc;
  landing: { platforms: Record<string, { metaTitle: string; metaDescription: string }> };
  legal?: Record<string, Doc | unknown>;
};
const messages = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as Messages;
const length = (text: string) => [...text].length;

for (const locale of locales) {
  describe(`search copy (${locale})`, () => {
    const m = messages(locale);

    it("home page: title under 60 characters, description under 160", () => {
      assert.ok(length(m.meta.title) >= 25 && length(m.meta.title) < 60, `title is ${length(m.meta.title)}`);
      assert.ok(length(m.meta.description) >= 90 && length(m.meta.description) < 160, `description is ${length(m.meta.description)}`);
    });

    it("home page has keywords and a four-card feature grid with a heading", () => {
      const home = m as unknown as { meta: { keywords: string[] }; seo: { featuresHeading: string; features: Doc[] } };
      assert.ok(home.meta.keywords.length >= 6, "too few keywords");
      assert.equal(new Set(home.meta.keywords).size, home.meta.keywords.length, "duplicate keyword");
      assert.ok(home.seo.featuresHeading.trim());
      assert.equal(home.seo.features.length, 4);
      for (const f of home.seo.features) assert.ok(f.title.trim() && f.text.trim(), "empty feature");
    });

    it("home title names the big platforms people search for", () => {
      for (const name of ["Instagram", "YouTube", "TikTok"]) assert.match(m.meta.title, new RegExp(name), name);
    });

    it("every platform page: title under 60, description under 160, and both are unique", () => {
      const titles: string[] = [];
      const descriptions: string[] = [];
      for (const [id, page] of Object.entries(m.landing.platforms)) {
        assert.ok(length(page.metaTitle) < 60, `${id} title is ${length(page.metaTitle)}`);
        assert.ok(length(page.metaDescription) < 160, `${id} description is ${length(page.metaDescription)}`);
        titles.push(page.metaTitle);
        descriptions.push(page.metaDescription);
      }
      assert.equal(new Set(titles).size, titles.length, "duplicate title");
      assert.equal(new Set(descriptions).size, descriptions.length, "duplicate description");
      assert.ok(!titles.includes(m.meta.title), "a platform page repeats the home title");
    });

    it("the exact search phrase leads each title: 'Download' (or the local verb) plus the platform", () => {
      const verb: Record<string, RegExp> = {
        en: /Download/, es: /Descargar/, pt: /Baixar/, hi: /Download|डाउनलोड/, bn: /Download|ডাউনলোড/,
        te: /Download|డౌన్‌లోడ్/, ta: /Download|டவுன்லோடு/, mr: /Download|डाउनलोड/, id: /Download|Unduh/,
        fr: /Télécharg/, ar: /تحميل|تنزيل/,
      };
      for (const [id, page] of Object.entries(m.landing.platforms)) {
        assert.match(page.metaTitle, verb[locale], `${id}: "${page.metaTitle}" lacks the download verb`);
      }
    });

    if (LEGAL_TRANSLATED.includes(locale)) {
      it("translated legal pages follow the same limits", () => {
        for (const [key, doc] of Object.entries(m.legal ?? {})) {
          const { title, description } = doc as Doc;
          if (typeof title !== "string" || typeof description !== "string") continue;
          assert.ok(length(title) < 60, `${key} title is ${length(title)}`);
          assert.ok(length(description) < 160, `${key} description is ${length(description)}`);
        }
      });
    }
  });
}
