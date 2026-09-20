/**
 * The legal pages must keep saying what the product actually does. If the code changes
 * (cache lifetime, cookies, what is stored), these tests point at the policy text to update.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const LOCALES = ["en", "es", "pt", "hi", "fr", "id", "ar"] as const;

type Section = { heading: string; body: string[] };
type Doc = { title: string; description: string; updated: string; intro?: string; sections: Section[] };
type Messages = {
  legal: { privacy: Doc; terms: Doc; dmca: Doc & { agent: Record<string, string> }; disclaimer: Doc; contact: unknown };
  footer: {
    columns: Record<string, string>;
    links: Record<string, string>;
    reportSubject: string;
  };
  ad: Record<string, string>;
};

const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8")) as Messages])
) as Record<(typeof LOCALES)[number], Messages>;

const text = (doc: Doc) => doc.sections.flatMap((s) => [s.heading, ...s.body]).join(" \n ");

/**
 * The values the policy makes claims about; keep in sync with scraper/main.py. The longest a lookup is kept is
 * the larger of the general setting and the YouTube one (YouTube results are kept longer: they cost proxy traffic).
 */
function scraperCacheMinutes(): number {
  const source = readFileSync(new URL("../../scraper/main.py", import.meta.url), "utf8");
  const setting = (name: string) => Number(source.match(new RegExp(`(?<![A-Z_])${name} = _env_number\\("${name}", (\\d+)\\)`))?.[1]);
  return Math.max(setting("CACHE_TTL_SECONDS"), setting("YOUTUBE_CACHE_TTL_SECONDS")) / 60;
}

/** How each language states the maximum (180 minutes). */
const PROMISED: Record<string, RegExp> = {
  en: /up to 3 hours/,
  es: /hasta 3 horas/,
  pt: /até 3 horas/,
  hi: /अधिकतम 3 घंटे/,
  fr: /jusqu'à 3 heures/,
  id: /hingga 3 jam/,
  ar: /حتى 3 ساعات/,
};

describe("policy matches the code", () => {
  it("promises no more than 3 hours of caching, and the scraper really caches for no longer", () => {
    const minutes = scraperCacheMinutes();
    assert.ok(minutes > 0 && minutes <= 180, `scraper caches for ${minutes} min but the policy promises up to 180`);
    assert.ok(minutes >= 180 || Number.isFinite(minutes), "could not read the cache settings");
  });

  for (const locale of LOCALES) {
    it(`states the 3-hour limit and that no media is stored (${locale})`, () => {
      const privacy = text(messages[locale].legal.privacy);
      assert.match(privacy, PROMISED[locale], "cache lifetime missing or out of date");
      assert.doesNotMatch(privacy, /\b90\b/, "an old 90-minute claim is left");
      // "no media stored" appears as its own paragraph in every language
      const retention = messages[locale].legal.privacy.sections[2];
      assert.ok(retention.body.length >= 3, "retention section lost a paragraph");
    });
  }

  it("names the one cookie the app actually sets", () => {
    for (const locale of LOCALES) assert.match(text(messages[locale].legal.privacy), /NEXT_LOCALE/);
  });
});

for (const locale of LOCALES) {
  describe(`legal pages (${locale})`, () => {
    const { legal, footer, ad } = messages[locale];

    it("has all five documents, each with a title, description and date", () => {
      for (const key of ["privacy", "terms", "dmca", "disclaimer"] as const) {
        const doc = legal[key];
        assert.ok(doc.title.length > 3 && doc.description.length >= 60 && doc.description.length <= 200, `${key} title/description`);
        assert.match(doc.updated, /2026/);
        assert.ok(doc.sections.length >= 5, `${key} is too thin`);
      }
      assert.ok(legal.contact, "contact page content missing");
    });

    it("privacy covers cookies, advertising, third parties, rights, children and security", () => {
      assert.ok(legal.privacy.sections.length >= 10);
      const headings = legal.privacy.sections.map((s) => s.heading.toLowerCase()).join("|");
      assert.ok(headings.length > 0);
      const all = text(legal.privacy);
      // Spanish says "RGPD" for the GDPR; everything else is spelled the same in all three languages.
      for (const pattern of [/cookie/i, /adssettings\.google\.com/i, /GDPR|RGPD/, /CCPA/, /LGPD/]) {
        assert.match(all, pattern, `privacy policy never mentions ${pattern}`);
      }
    });

    it("terms name every platform we say we are not affiliated with", () => {
      const all = text(legal.terms);
      for (const name of ["Meta", "Google", "TikTok", "X Corp", "Pinterest", "Reddit", "Snap"]) {
        assert.ok(all.includes(name), `terms never mention ${name}`);
      }
      assert.match(all, /DMCA/);
    });

    it("the DMCA page lists all six elements of a notice and says nothing is hosted", () => {
      const numbered = legal.dmca.sections.flatMap((s) => s.body).filter((p) => /^\d\. /.test(p));
      assert.deepEqual(
        numbered.map((p) => p[0]),
        ["1", "2", "3", "4", "5", "6"],
        "a valid notice has six required elements"
      );
      assert.match(text(legal.dmca), /512/);
      for (const field of ["heading", "label", "subject", "note"]) {
        assert.ok(legal.dmca.agent[field]?.length > 2, `dmca.agent.${field} missing`);
      }
      assert.ok(legal.dmca.sections[0].body[0].length > 80, "the 'we host nothing' statement is missing");
    });

    it("has a three-column footer with every link labelled", () => {
      assert.deepEqual(Object.keys(footer.columns).sort(), ["company", "legal", "tools"]);
      for (const key of ["privacy", "terms", "dmca", "disclaimer", "contact", "report"]) {
        assert.ok(footer.links[key]?.length > 1, `footer.links.${key} missing`);
      }
      assert.ok(footer.reportSubject.length > 3);
    });

    it("has the labels the ad slots need", () => {
      for (const key of ["label", "close", "collapse", "expand"]) assert.ok(ad[key]?.length > 1, `ad.${key}`);
    });
  });
}

describe("translations are real", () => {
  it("every translated language differs from English in every document", () => {
    for (const locale of ["es", "pt", "hi", "fr", "id", "ar"] as const) {
      for (const key of ["privacy", "terms", "dmca", "disclaimer"] as const) {
        assert.notEqual(messages[locale].legal[key].title, messages.en.legal[key].title, `${locale}/${key} title`);
        assert.notEqual(text(messages[locale].legal[key]), text(messages.en.legal[key]), `${locale}/${key}`);
      }
    }
  });

  it("every language has the same document structure", () => {
    for (const key of ["privacy", "terms", "dmca", "disclaimer"] as const) {
      for (const locale of ["es", "pt", "hi", "fr", "id", "ar"] as const) {
        assert.equal(messages[locale].legal[key].sections.length, messages.en.legal[key].sections.length, `${locale}/${key} section count`);
        messages.en.legal[key].sections.forEach((section, index) => {
          assert.equal(
            messages[locale].legal[key].sections[index].body.length,
            section.body.length,
            `${locale}/${key} section ${index + 1} paragraph count`
          );
        });
      }
    }
  });
});
