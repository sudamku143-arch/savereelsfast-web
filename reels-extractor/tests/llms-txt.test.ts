/**
 * /llms.txt: a short, structured summary of the site for AI assistants and search tools, per the llmstxt.org
 * convention. Served straight from public/llms.txt (middleware skips any path with a dot, so no locale redirect
 * touches it).
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LANDING_PLATFORMS, PLATFORM_SLUGS } from "../lib/landing.ts";
import { SITE_URL } from "../lib/site.ts";

const text = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");

describe("public/llms.txt", () => {
  it("starts with an H1 title, then a one-line blockquote summary (the llmstxt.org shape)", () => {
    const lines = text.split("\n");
    assert.equal(lines[0], "# SaveReelsFast");
    const blockquote = lines.find((l) => l.startsWith("> "));
    assert.ok(blockquote && blockquote.length > 40, "missing or too-thin summary line");
  });

  it("only ever links the real site address (no bare, non-www URLs that just redirect)", () => {
    assert.match(text, /https:\/\/www\.savereelsfast\.com/);
    assert.doesNotMatch(text, /\(https:\/\/savereelsfast\.com/, "should link www.savereelsfast.com, not the redirecting bare domain");
    for (const url of text.match(/https:\/\/www\.savereelsfast\.com\S*/g) ?? []) {
      assert.ok(url.startsWith(SITE_URL), url);
    }
  });

  it("links every platform's downloader page under a Tools-style section", () => {
    for (const id of LANDING_PLATFORMS) {
      assert.match(text, new RegExp(`\\(${SITE_URL}/${PLATFORM_SLUGS[id]}\\)`), `missing link for ${id}`);
    }
  });

  it("links the blog and the legal pages, and uses ## section headings", () => {
    for (const path of ["/blog", "/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact"]) {
      assert.match(text, new RegExp(`\\(${SITE_URL}${path}\\)`), `missing link for ${path}`);
    }
    assert.match(text, /^## /m);
  });

  it("every link line has a description after a colon (useful without opening the page)", () => {
    const linkLines = text.split("\n").filter((l) => l.startsWith("- ["));
    assert.ok(linkLines.length >= 10);
    for (const line of linkLines) assert.match(line, /^- \[[^\]]+\]\([^)]+\): .+/, line);
  });
});
