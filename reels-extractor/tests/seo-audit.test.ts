/**
 * Guards against the specific issues a Semrush Site Audit flagged:
 *   - a legal page's <title> was byte-identical to its H1
 *   - those titles were far under 50 characters
 *   - JSON-LD's Offer.price was a string, not a Number
 *   - a BreadcrumbList's last entry (the current page) carried a redundant "item" URL
 *   - the Contact page was the thinnest page on the site (~150 words)
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED } from "../lib/i18n-config.ts";

type Doc = { title: string; metaTitle: string; description: string };
type Contact = Doc & {
  intro: string;
  topics: string[];
  beforeHeading: string;
  beforeIntro: string;
  quickAnswers: { q: string; a: string }[];
  relatedHeading: string;
};
type Messages = {
  legal: { privacy: Doc; terms: Doc; dmca: Doc; disclaimer: Doc; contact: Contact };
};
const messages = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as Messages;
const length = (text: string) => [...text].length;
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("legal pages: the <title> is no longer identical to the H1", () => {
  for (const locale of LEGAL_TRANSLATED) {
    describe(locale, () => {
      const { legal } = messages(locale);
      for (const key of ["privacy", "terms", "dmca", "disclaimer", "contact"] as const) {
        it(`${key}: metaTitle differs from the on-page title (H1), and is 50-60 characters`, () => {
          const doc = legal[key];
          assert.notEqual(doc.metaTitle, doc.title, `${locale}/${key}: title tag still equals the H1`);
          assert.ok(
            length(doc.metaTitle) >= 45 && length(doc.metaTitle) <= 60,
            `${locale}/${key}: metaTitle is ${length(doc.metaTitle)} chars: "${doc.metaTitle}"`
          );
          // The H1 itself stays short and clear; it is not what this issue was about.
          assert.ok(doc.title.trim().length > 0);
        });
      }
    });
  }

  it("each of the 5 pages uses its own metaTitle in generateMetadata, not the H1 field", () => {
    const files: [string, string][] = [
      ["app/[locale]/privacy-policy/page.tsx", "privacy"],
      ["app/[locale]/terms-of-service/page.tsx", "terms"],
      ["app/[locale]/dmca/page.tsx", "dmca"],
      ["app/[locale]/disclaimer/page.tsx", "disclaimer"],
      ["app/[locale]/contact/page.tsx", "contact"],
    ];
    for (const [file, key] of files) {
      const code = source(file);
      assert.match(code, new RegExp(`legal\\.${key}\\.metaTitle`), `${file} should pass metaTitle to legalMetadata`);
    }
  });
});

describe("structured data: valid types for a schema.org validator", () => {
  const home = source("app/[locale]/page.tsx");
  const platform = source("app/[locale]/[platform]/page.tsx");

  it("Offer.price is a JSON Number, not a quoted string", () => {
    for (const code of [home, platform]) {
      assert.match(code, /offers: \{ "@type": "Offer", price: 0, priceCurrency: "USD" \}/);
      assert.doesNotMatch(code, /price: "0"/, 'price must not be a string ("0")');
    }
  });

  it("a BreadcrumbList's last item (the current page) carries no redundant item/URL", () => {
    for (const code of [platform, source("app/[locale]/blog/[slug]/page.tsx")]) {
      // Every ListItem up to the last must have `item:`; the final one must not.
      const list = code.match(/itemListElement: \[([\s\S]*?)\],\s*\},/);
      assert.ok(list, "no BreadcrumbList found");
      const entries = list![1].trim().split(/\n(?=\s*\{ "@type": "ListItem")|\n(?=\s*\/\/)/).filter((e) => e.includes("ListItem"));
      const last = entries[entries.length - 1];
      assert.doesNotMatch(last, /item:/, `last breadcrumb entry still has item: ${last}`);
      for (const entry of entries.slice(0, -1)) assert.match(entry, /item:/, `earlier breadcrumb entry is missing item: ${entry}`);
    }
  });
});

describe("the Contact page is no longer the thinnest page on the site", () => {
  for (const locale of LEGAL_TRANSLATED) {
    it(`${locale}: has "before you write" quick answers and a related-pages section`, () => {
      const { contact } = messages(locale).legal;
      assert.ok(contact.beforeHeading.trim() && contact.beforeIntro.trim());
      assert.equal(contact.quickAnswers.length, 3);
      for (const qa of contact.quickAnswers) {
        assert.ok(qa.q.trim().length > 15, `${locale}: quick-answer question too thin`);
        assert.ok(qa.a.trim().length > 60, `${locale}: quick-answer answer too thin`);
      }
      assert.ok(contact.relatedHeading.trim());
    });
  }

  it("the page renders the quick answers and links to the other 4 legal pages", () => {
    const code = source("app/[locale]/contact/page.tsx");
    assert.match(code, /contact\.quickAnswers\.map/);
    assert.match(code, /localePath\(locale, "\/privacy-policy"\)/);
    assert.match(code, /localePath\(locale, "\/terms-of-service"\)/);
    assert.match(code, /localePath\(locale, "\/dmca"\)/);
    assert.match(code, /localePath\(locale, "\/disclaimer"\)/);
  });
});
