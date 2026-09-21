/**
 * The language switcher never offers a page that does not exist: the blog is English-only today, so on a blog page
 * there is nothing to switch to and the switcher is hidden, while every other page keeps all eleven languages.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { showSwitcher, switcherLocales, type BlogAvailability } from "../lib/switcher.ts";

const ALL = ["en", "es", "pt", "hi", "bn", "te", "ta", "mr", "id", "fr", "ar"] as const;
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const englishOnly: BlogAvailability = { index: ["en"], posts: { "a-post": ["en"], "other-post": ["en"] } };

describe("blog pages while the blog is English only", () => {
  it("offer no language to switch to, so the switcher is hidden", () => {
    for (const path of ["/blog", "/blog/", "/blog/a-post", "/blog/a-post/", "/en/blog", "/en/blog/a-post"]) {
      const options = switcherLocales(path, ALL, englishOnly);
      assert.deepEqual(options, ["en"], path);
      assert.equal(showSwitcher(options), false, path);
    }
  });

  it("also hide it when a visitor has landed on an address in another language that would 404", () => {
    for (const path of ["/es/blog", "/hi/blog/a-post"]) assert.equal(showSwitcher(switcherLocales(path, ALL, englishOnly)), false, path);
  });
});

describe("every other page keeps the full switcher", () => {
  it("home, tool pages and legal pages, in every language", () => {
    for (const path of ["/", "/es", "/youtube-video-downloader", "/hi/instagram-video-downloader", "/privacy-policy", "/fr/dmca", "/ar/contact", "/blogging-tips", "/es/blogger-video-downloader"]) {
      const options = switcherLocales(path, ALL, englishOnly);
      assert.deepEqual(options, ALL, path);
      assert.equal(showSwitcher(options), true, path);
    }
  });
});

describe("when the blog grows into other languages", () => {
  const grown: BlogAvailability = { index: ["en", "hi"], posts: { "a-post": ["en", "hi"], "english-only": ["en"] } };

  it("the index offers the languages that have a blog", () => {
    assert.deepEqual(switcherLocales("/blog", ALL, grown), ["en", "hi"]);
    assert.equal(showSwitcher(switcherLocales("/hi/blog", ALL, grown)), true);
  });

  it("a post offers only the languages it exists in", () => {
    assert.deepEqual(switcherLocales("/blog/a-post", ALL, grown), ["en", "hi"]);
    assert.equal(showSwitcher(switcherLocales("/blog/english-only", ALL, grown)), false, "no Hindi version: nothing to switch to");
  });

  it("an unknown post offers nothing rather than a 404", () => {
    assert.deepEqual(switcherLocales("/blog/no-such-post", ALL, grown), []);
  });
});

describe("the header uses the rule", () => {
  it("renders the switcher only when there is somewhere to switch to, and lists only the allowed languages", () => {
    const header = source("app/[locale]/components/Header.tsx");
    assert.match(header, /switcherLocales\(pathname, locales, blogAvailability\)/);
    assert.match(header, /\{canSwitch && \(/);
    assert.match(header, /languageOptions\.map\(/);
    assert.doesNotMatch(header, /\{locales\.map\(/, "the list must not fall back to every language");
    assert.match(source("app/[locale]/layout.tsx"), /blogAvailability=\{blogAvailability\(\)\}/);
  });
});
