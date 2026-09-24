/**
 * One lookup, one time budget: the scraper and the built-in strategies together can never add up to a hang.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MIN_USEFUL_MS, hasTimeFor, remainingMs } from "../lib/time-budget.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const num = (text: string, name: string) => Number(text.match(new RegExp(`${name} = ([\\d_]+)`))?.[1].replaceAll("_", ""));

describe("time budget arithmetic", () => {
  it("a step gets its own limit while there is plenty of time", () => {
    assert.equal(remainingMs(10_000, 4000, 0), 4000);
  });

  it("but never more than what is left", () => {
    assert.equal(remainingMs(10_000, 4000, 8000), 2000);
    assert.equal(remainingMs(10_000, 4000, 9900), 100);
  });

  it("is zero once the budget is spent (never negative)", () => {
    assert.equal(remainingMs(10_000, 4000, 10_000), 0);
    assert.equal(remainingMs(10_000, 4000, 20_000), 0);
  });

  it("stops starting new requests when they could not finish", () => {
    assert.equal(hasTimeFor(1000, 0), true);
    assert.equal(hasTimeFor(1000, 1000 - MIN_USEFUL_MS), true);
    assert.equal(hasTimeFor(1000, 1000 - MIN_USEFUL_MS + 1), false);
    assert.equal(hasTimeFor(1000, 5000), false);
  });

  it("three sequential steps sharing a budget never exceed it", () => {
    const deadline = 9000;
    let now = 0;
    let spent = 0;
    for (const cap of [7000, 4000, 4000, 4000]) {
      if (!hasTimeFor(deadline, now)) break;
      const used = remainingMs(deadline, cap, now); // worst case: every step uses everything it may
      now += used;
      spent += used;
    }
    assert.ok(spent <= 9000, `spent ${spent} ms`);
  });
});

describe("the extract route uses the budget", () => {
  const route = source("app/api/extract/route.ts");
  const client = source("app/[locale]/components/ExtractorClient.tsx");

  it("the whole lookup is capped below what the page itself waits", () => {
    const budget = num(route, "LOOKUP_BUDGET_MS");
    const page = num(client, "EXTRACT_TIMEOUT_MS");
    assert.ok(budget >= 8000 && budget <= 9500, `budget is ${budget} ms`);
    assert.ok(budget < page, `the site (${budget} ms) must answer before the page gives up (${page} ms)`);
  });

  it("YouTube gets longer limits at every hop, each one outlasting the hop behind it", () => {
    const scraper = 22_000 + 750; // the scraper's YouTube budget plus its grace (scraper/main.py)
    const scraperWait = num(route, "YOUTUBE_SCRAPER_TIMEOUT_MS");
    const budget = num(route, "YOUTUBE_LOOKUP_BUDGET_MS");
    const page = num(client, "YOUTUBE_EXTRACT_TIMEOUT_MS");
    assert.ok(scraperWait > scraper, `site waits ${scraperWait} ms for a scraper that may take ${scraper} ms`);
    assert.ok(budget > scraperWait, "the lookup budget must outlast the scraper wait");
    assert.ok(page > budget, `the page (${page} ms) must outlast the site (${budget} ms)`);
    assert.ok(2 * 0 + budget < 40_000, "and stay inside the function's time limit");
    assert.ok(page <= 25_000, "but never a 30-second hang");
  });

  it("only YouTube lookups use the longer limits", () => {
    assert.match(route, /const youtube = platform === "youtube";/);
    assert.match(route, /youtube \? YOUTUBE_LOOKUP_BUDGET_MS : LOOKUP_BUDGET_MS/);
    assert.match(route, /youtube \? YOUTUBE_SCRAPER_TIMEOUT_MS : SCRAPER_TIMEOUT_MS/);
    assert.match(client, /parseSupportedUrl\(url\)\?\.platform === "youtube" \? YOUTUBE_EXTRACT_TIMEOUT_MS : EXTRACT_TIMEOUT_MS/);
  });

  it("a built-in strategy waits 5 s at most, not 8", () => {
    assert.ok(num(route, "FETCH_TIMEOUT_MS") <= 5000);
  });

  it("every request in a lookup draws from the shared budget", () => {
    assert.match(route, /setTimeout\(\(\) => controller\.abort\(\), stepTimeout\(FETCH_TIMEOUT_MS\)\)/);
    assert.match(route, /setTimeout\(\(\) => controller\.abort\(\), stepTimeout\(scraperStepMs\(\)\)\)/);
    assert.doesNotMatch(route, /setTimeout\(\(\) => controller\.abort\(\), (FETCH|SCRAPER|YOUTUBE_SCRAPER)_TIMEOUT_MS\)/, "an unbudgeted timer is left");
  });

  it("the lookup runs inside the budget, and strategies are skipped when time is up", () => {
    assert.match(route, /lookupBudget\.run\(\{ deadline: Date\.now\(\) \+ budget, scraperMs \}/);
    assert.match(route, /if \(!timeLeft\(\)\) \{\s*networkFailures \+= 1;[^}]*break;/);
    assert.match(route, /if \(!timeLeft\(\)\) throw new BudgetExhausted/);
  });

  it("the quiet retry for a busy scraper only happens if a whole second attempt still fits", () => {
    assert.match(route, /stepTimeout\(scraperStepMs\(\)\) < RETRY_PAUSE_MS \+ 2500\) throw err/);
  });
});
