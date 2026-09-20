/**
 * Visitors must never meet a raw error code, and transient failures get a quiet second attempt.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";
import { ERROR_CODES } from "../lib/errors.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const messages = (locale: string) =>
  JSON.parse(source(`messages/${locale}.json`)) as { errors: Record<string, { title?: string; message?: string } | Record<string, string>> };

describe("error messages are for people", () => {
  for (const locale of locales) {
    it(`${locale}: every error has a title and message, and none shows a machine code`, () => {
      const { errors } = messages(locale);
      for (const code of ERROR_CODES) {
        const entry = errors[code] as { title: string; message: string } | undefined;
        assert.ok(entry?.title?.length > 3 && entry?.message?.length > 10, `${locale}: ${code} has no text`);
        for (const text of [entry.title, entry.message]) {
          assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z_]{3,}/, `${locale}: ${code} shows a raw code: ${text}`);
          assert.doesNotMatch(text, /\b(403|429|HTTP|yt-dlp|stack|exception)\b/i, `${locale}: ${code} is technical: ${text}`);
        }
      }
    });

    it(`${locale}: the blocked-download message tells the visitor what to do next`, () => {
      const { message, title } = messages(locale).errors.STREAM_EXPIRED_OR_BLOCKED as { title: string; message: string };
      assert.ok(message.includes("{platform}"), "should name the platform");
      // The English text is checked for its actual advice; other languages must differ from it (translated).
      if (locale === "en") {
        assert.match(message, /try again in a minute/i);
        assert.match(message, /another link|come back/i);
      } else {
        const english = (messages("en").errors.STREAM_EXPIRED_OR_BLOCKED as { message: string }).message;
        assert.notEqual(message, english);
        assert.ok(message.length > 60, "should carry more than a one-line apology");
      }
      assert.ok(title.length > 3);
    });
  }

  it("the error card never renders the code on screen (it only goes into the report e-mail)", () => {
    const card = source("app/[locale]/components/ErrorCard.tsx");
    assert.doesNotMatch(card, />\s*\{code\}\s*</, "the code must not be rendered as visible text");
    assert.equal([...card.matchAll(/\$\{code\}/g)].length, 1, "interpolated once: inside the mailto body");
    assert.match(card, /Error: \$\{code\}/);
  });
});

describe("transient failures are retried quietly", () => {
  it("the extract route retries a block, a timeout or a busy scraper once before failing", () => {
    const route = source("app/api/extract/route.ts");
    assert.match(route, /TRANSIENT_CODES[^;]*STREAM_EXPIRED_OR_BLOCKED[^;]*PLATFORM_TIMEOUT[^;]*SERVER_BUSY/s);
    assert.match(route, /extractFromScraperOnce\(knownId, reelUrl\)[\s\S]{0,400}extractFromScraperOnce\(knownId, reelUrl\)/);
  });

  it("two scraper attempts still fit inside the route's time limit", () => {
    const route = source("app/api/extract/route.ts");
    const maxDuration = Number(route.match(/maxDuration = (\d+)/)?.[1]);
    const timeout = Number(route.match(/SCRAPER_TIMEOUT_MS = (\d+)/)?.[1]);
    const pause = Number(route.match(/RETRY_PAUSE_MS = (\d+)/)?.[1]);
    assert.ok(2 * timeout + pause < maxDuration * 1000, `${2 * timeout + pause} ms must be under ${maxDuration * 1000} ms`);
  });

  it("the download button retries once before showing an error, and only once", () => {
    const button = source("app/[locale]/components/DownloadButton.tsx");
    assert.match(button, /RETRYABLE = \[[^\]]*STREAM_EXPIRED_OR_BLOCKED[^\]]*\]/);
    assert.match(button, /async function start\(retried = false\)/);
    assert.match(button, /!retried && RETRYABLE\.includes\(code\)/);
    assert.match(button, /start\(true\)/);
  });
});
