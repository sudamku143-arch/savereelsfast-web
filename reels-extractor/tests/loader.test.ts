/**
 * What a visitor sees between pasting a link and getting the result: "Processing your link..." with a spinner, a
 * progress bar and a step line, a busy button, and the card scrolled into view; in every language, and calm for
 * people who ask for less motion.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";
import { SLOW_AFTER_MS, STEP_MS, isSlow, stepIndex } from "../lib/loading.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const loader = source("app/[locale]/components/SkeletonLoader.tsx");
const input = source("app/[locale]/components/InputBox.tsx");
const client = source("app/[locale]/components/ExtractorClient.tsx");

describe("step timing", () => {
  it("moves on every couple of seconds and stays on the last step", () => {
    assert.equal(stepIndex(0, 3), 0);
    assert.equal(stepIndex(STEP_MS - 1, 3), 0);
    assert.equal(stepIndex(STEP_MS, 3), 1);
    assert.equal(stepIndex(STEP_MS * 2, 3), 2);
    assert.equal(stepIndex(STEP_MS * 50, 3), 2, "it never runs past the last step");
  });

  it("copes with nonsense", () => {
    assert.equal(stepIndex(-500, 3), 0);
    assert.equal(stepIndex(10_000, 0), 0);
    assert.equal(stepIndex(10_000, 1), 0);
  });

  it("adds a 'still working' note only after a few seconds", () => {
    assert.equal(isSlow(SLOW_AFTER_MS - 1), false);
    assert.equal(isSlow(SLOW_AFTER_MS), true);
    assert.ok(SLOW_AFTER_MS >= 5000 && SLOW_AFTER_MS <= 12_000, "long enough not to nag, short enough to reassure");
  });
});

describe("the loader", () => {
  it("shows a spinner, a progress bar, the message and the step, and keeps the shape of the result card", () => {
    assert.match(loader, /role="status"/);
    assert.match(loader, /motion-safe:animate-spin/);
    assert.match(loader, /role="progressbar"/);
    assert.match(loader, /animate-indeterminate/);
    assert.match(loader, /\{dict\.processing\}/);
    assert.match(loader, /dict\.steps\[stepIndex\(elapsed, dict\.steps\.length\)\]/);
    assert.match(loader, /className="skeleton h-32 w-24/);
    assert.match(loader, /isSlow\(elapsed\) \? "" : "invisible"/, "the note is always laid out, so the card keeps its height");
  });

  it("is readable: the message is white and 14-16px, not the old tiny grey label", () => {
    assert.match(loader, /text-sm font-semibold text-zinc-50 sm:text-base/);
    assert.doesNotMatch(loader, /text-xs text-zinc-500">\{dict\.loading/);
  });

  it("does not shout the step changes at screen readers, and cleans its timer up", () => {
    assert.match(loader, /aria-hidden="true" className="mt-0\.5 truncate text-xs text-zinc-400"/);
    assert.match(loader, /return \(\) => clearInterval\(timer\)/);
  });

  it("brings itself into view, because on a phone it starts below the visible screen", () => {
    assert.match(loader, /scrollIntoView\(\{ behavior: reduced \? "auto" : "smooth", block: "nearest" \}\)/);
    assert.match(loader, /prefers-reduced-motion: reduce/);
  });

  it("is what the page shows while a lookup is running", () => {
    assert.match(client, /\{status === "loading" && <SkeletonLoader dict=\{heroDict\} \/>\}/);
  });
});

describe("the button while a link is processed", () => {
  it("shows a spinner and 'Processing...' instead of just greying out, and tells assistive technology it is busy", () => {
    assert.match(input, /aria-busy=\{disabled \? true : undefined\}/);
    assert.match(input, /\{disabled && \(\s*<svg[^>]*motion-safe:animate-spin/);
    assert.match(input, /\{disabled \? dict\.working : dict\.downloadCta\}/);
  });
});

describe("calm for people who ask for less motion", () => {
  const css = source("app/globals.css");

  it("the spinner is motion-safe only, and the bar and shimmer stop", () => {
    assert.match(loader, /motion-safe:animate-spin/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.animate-shimmer[\s\S]*animation: none/);
    assert.match(css, /\.animate-indeterminate \{\s+animation: none;\s+width: 100%;/);
  });
});

describe("loader text in every language", () => {
  const english = JSON.parse(source("messages/en.json")).hero as Record<string, unknown>;
  for (const locale of locales) {
    it(`${locale}: message, short button label, three steps and the 'still working' note`, () => {
      const hero = (JSON.parse(source(`messages/${locale}.json`)) as { hero: Record<string, unknown> }).hero as {
        processing: string;
        working: string;
        steps: string[];
        slow: string;
        loading: string;
      };
      assert.ok(hero.processing.trim().length > 5, "processing");
      assert.ok(hero.working.trim().length > 3 && hero.working.length <= 24, `the button label must be short: "${hero.working}"`);
      assert.equal(hero.steps.length, 3);
      for (const step of hero.steps) assert.ok(step.trim().length > 5);
      assert.equal(new Set(hero.steps).size, 3, "three different steps");
      assert.ok(hero.slow.trim().length > 10, "slow");
      if (locale !== "en") {
        assert.notEqual(hero.processing, english.processing, `${locale} is translated`);
        assert.notDeepEqual(hero.steps, english.steps);
      }
    });
  }

  it("English says exactly what was asked for", () => {
    assert.equal((english as { processing: string }).processing, "Processing your link…");
  });
});
