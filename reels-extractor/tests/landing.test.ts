/**
 * Guards the platform landing pages: routing helpers and, more importantly, the copy.
 * Thin, duplicated or broken landing-page text is what gets pages ignored by search
 * engines, so these checks fail the build's test run instead of shipping it.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  LANDING_PLATFORMS,
  PLATFORM_SLUGS,
  fillTemplate,
  landingPath,
  platformFromSlug,
} from "../lib/landing.ts";

const LOCALES = ["en", "es", "pt", "hi"] as const;
const EXPECTED_IDS = ["instagram", "youtube", "facebook", "threads", "x", "pinterest", "tiktok", "reddit", "snapchat"];

type Faq = { q: string; a: string };
type PlatformContent = {
  noun: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  lead: string;
  copyHint: string;
  faq: Faq[];
};
type Messages = {
  platforms: Record<string, { name: string }>;
  landing: {
    common: {
      steps: string[];
      features: { title: string; text: string }[];
      sharedFaq: Faq[];
      howToHeading: string;
      featuresHeading: string;
      faqHeading: string;
      structuredDescription: string;
      [key: string]: unknown;
    };
    platforms: Record<string, PlatformContent>;
  };
};

const messages = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8")) as Messages,
  ])
) as Record<(typeof LOCALES)[number], Messages>;

describe("landing routes", () => {
  it("covers all nine platforms with unique, URL-safe slugs", () => {
    assert.deepEqual([...LANDING_PLATFORMS].sort(), [...EXPECTED_IDS].sort());
    const slugs = Object.values(PLATFORM_SLUGS);
    assert.equal(new Set(slugs).size, slugs.length, "slugs must be unique");
    for (const slug of slugs) assert.match(slug, /^[a-z]+$/, `unsafe slug: ${slug}`);
  });

  it("uses the searchable word 'twitter' for X", () => {
    assert.equal(PLATFORM_SLUGS.x, "twitter");
    assert.equal(landingPath("x"), "/downloader/twitter");
  });

  it("resolves slugs both ways and rejects unknown ones", () => {
    for (const id of LANDING_PLATFORMS) assert.equal(platformFromSlug(PLATFORM_SLUGS[id]), id);
    for (const bad of ["", "x", "tik-tok", "INSTAGRAM", "../etc", "vimeo"]) {
      assert.equal(platformFromSlug(bad), null, `"${bad}" must not resolve`);
    }
  });

  it("fills known placeholders and leaves unknown ones visible", () => {
    assert.equal(fillTemplate("Hi {platform}, {noun}!", { platform: "YouTube", noun: "Shorts" }), "Hi YouTube, Shorts!");
    assert.equal(fillTemplate("{missing}", {}), "{missing}");
  });
});

for (const locale of LOCALES) {
  describe(`landing content (${locale})`, () => {
    const { landing, platforms } = messages[locale];
    const ids = Object.keys(landing.platforms);

    it("has copy for every platform, and only for real platforms", () => {
      assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort());
    });

    it("has a title, description, h1, intro and three specific FAQs each", () => {
      for (const id of ids) {
        const c = landing.platforms[id];
        for (const field of ["noun", "metaTitle", "metaDescription", "h1", "lead", "copyHint"] as const) {
          assert.ok(c[field]?.trim().length > 0, `${id}.${field} is empty`);
        }
        assert.equal(c.faq.length, 3, `${id} should have 3 platform-specific FAQs`);
        for (const item of c.faq) {
          assert.ok(item.q.trim().endsWith("?"), `${id}: question should end with "?": ${item.q}`);
          assert.ok(item.a.trim().length >= 40, `${id}: answer too thin: ${item.q}`);
        }
      }
    });

    it("keeps titles and descriptions inside search-result limits", () => {
      for (const id of ids) {
        const c = landing.platforms[id];
        assert.ok(c.metaTitle.length >= 25 && c.metaTitle.length <= 70, `${id} title is ${c.metaTitle.length} chars`);
        assert.ok(
          c.metaDescription.length >= 90 && c.metaDescription.length <= 175,
          `${id} description is ${c.metaDescription.length} chars`
        );
      }
    });

    it("never repeats a title, description, heading or intro across pages", () => {
      for (const field of ["metaTitle", "metaDescription", "h1", "lead"] as const) {
        const values = ids.map((id) => landing.platforms[id][field]);
        assert.equal(new Set(values).size, values.length, `duplicate ${field}`);
      }
      const questions = ids.flatMap((id) => landing.platforms[id].faq.map((f) => f.q));
      assert.equal(new Set(questions).size, questions.length, "duplicate FAQ question across platforms");
    });

    it("names the platform in each title and h1 (that is the keyword being targeted)", () => {
      for (const id of ids) {
        const name = platforms[id].name.split(" ")[0].toLowerCase(); // "X (Twitter)" -> "x"
        const haystack = `${landing.platforms[id].metaTitle} ${landing.platforms[id].h1}`.toLowerCase();
        const keyword = id === "x" ? "twitter" : name;
        assert.ok(haystack.includes(keyword), `${id}: neither title nor h1 mentions "${keyword}"`);
      }
    });

    it("English titles lead with the exact search phrase and fit in a search result", (t) => {
      if (locale !== "en") return t.skip("English search phrases only");
      for (const id of ids) {
        const t = landing.platforms[id].metaTitle;
        assert.match(t, /^[A-Za-z ]+ (Video |Reels |Spotlight )?Downloader - /, `${id}: "${t}" should start "<Platform> ... Downloader - "`);
        assert.ok(t.split(" ").includes("HD"), `${id}: title should mention HD`);
        assert.ok(t.length <= 60, `${id}: title is ${t.length} chars, Google cuts around 60`);
      }
    });

    it("resolves every template placeholder", () => {
      const { common } = landing;
      for (const id of ids) {
        const c = landing.platforms[id];
        const vars = { platform: platforms[id].name, noun: c.noun, copyHint: c.copyHint };
        const texts = [
          ...common.steps,
          ...common.features.map((f) => f.text),
          ...common.sharedFaq.flatMap((f) => [f.q, f.a]),
          common.howToHeading,
          common.featuresHeading,
          common.faqHeading,
          common.structuredDescription,
        ];
        for (const text of texts) {
          const filled = fillTemplate(text, vars);
          assert.ok(!/\{\w+\}/.test(filled), `${id}: unresolved placeholder in "${filled}"`);
        }
      }
      // Platform-specific copy is plain text: a stray brace would be a typo.
      for (const id of ids) {
        const c = landing.platforms[id];
        const own = [c.noun, c.metaTitle, c.metaDescription, c.h1, c.lead, c.copyHint, ...c.faq.flatMap((f) => [f.q, f.a])];
        for (const text of own) assert.ok(!/[{}]/.test(text), `${id}: stray brace in "${text}"`);
      }
    });
  });
}

describe("landing content across languages", () => {
  it("has the same structure in every language", () => {
    const [first, ...rest] = LOCALES.map((l) => messages[l].landing);
    for (const other of rest) {
      assert.deepEqual(Object.keys(other.platforms).sort(), Object.keys(first.platforms).sort());
      assert.equal(other.common.steps.length, first.common.steps.length);
      assert.equal(other.common.features.length, first.common.features.length);
      assert.equal(other.common.sharedFaq.length, first.common.sharedFaq.length);
      for (const id of Object.keys(first.platforms)) {
        assert.equal(other.platforms[id].faq.length, first.platforms[id].faq.length, `${id} FAQ count differs`);
      }
    }
  });

  it("is genuinely translated, not copied from English", () => {
    for (const locale of ["es", "pt", "hi"] as const) {
      for (const id of EXPECTED_IDS) {
        assert.notEqual(messages[locale].landing.platforms[id].lead, messages.en.landing.platforms[id].lead, `${locale}/${id} lead`);
        assert.notEqual(messages[locale].landing.platforms[id].metaTitle, messages.en.landing.platforms[id].metaTitle, `${locale}/${id} title`);
      }
    }
  });
});

describe("honesty of platform-specific claims", () => {
  const en = messages.en.landing.platforms;
  const text = (id: string) =>
    [en[id].lead, ...en[id].faq.map((f) => f.a)].join(" ").toLowerCase();

  it("does not promise YouTube resolutions the tool can't deliver", () => {
    assert.match(text("youtube"), /360p/);
    assert.doesNotMatch(en.youtube.metaDescription + en.youtube.h1, /4k|1080|hd/i);
  });

  it("explains why Reddit videos are silent instead of hiding it", () => {
    assert.match(text("reddit"), /separate/);
  });

  it("says Snapchat Stories are not supported", () => {
    assert.match(text("snapchat"), /stories/);
    assert.match(text("snapchat"), /not supported|no\./);
  });

  it("makes no unverifiable claims about watermarks or quality", () => {
    for (const id of EXPECTED_IDS) {
      const all = `${en[id].metaTitle} ${en[id].metaDescription} ${en[id].lead}`;
      assert.doesNotMatch(all, /watermark|4k|unlimited|100%/i, `${id} makes a claim we can't guarantee`);
    }
  });
});

describe("Hindi search targeting", () => {
  const hi = messages.hi.landing.platforms;

  it("uses the exact phrases people type: '<Platform> Video Download करें'", () => {
    assert.equal(hi.instagram.metaTitle, "Instagram Reels Download करें - Free HD Video Downloader");
    assert.equal(hi.facebook.metaTitle, "Facebook Video Download करने का आसान तरीका");
    for (const id of EXPECTED_IDS) {
      assert.match(hi[id].metaTitle, /Download/, `${id} title lacks "Download"`);
      assert.match(hi[id].metaTitle, /[ऀ-ॿ]/, `${id} title has no Hindi`);
    }
  });

  it("is written in Devanagari throughout, not left in English", () => {
    for (const id of EXPECTED_IDS) {
      for (const text of [hi[id].metaDescription, hi[id].h1, hi[id].lead, hi[id].copyHint, ...hi[id].faq.flatMap((f) => [f.q, f.a])]) {
        assert.match(text, /[ऀ-ॿ]/, `${id}: no Hindi in "${text.slice(0, 50)}"`);
      }
    }
    for (const text of [...messages.hi.landing.common.steps, ...messages.hi.landing.common.sharedFaq.flatMap((f) => [f.q, f.a])]) {
      assert.match(text, /[ऀ-ॿ]/);
    }
  });

  it("does not promise HD for YouTube, which is capped at 360p", () => {
    assert.doesNotMatch(hi.youtube.metaTitle + hi.youtube.metaDescription + hi.youtube.h1, /HD|4k|1080/i);
  });
});
