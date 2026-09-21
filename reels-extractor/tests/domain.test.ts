/**
 * One address for the site. Vercel serves www.savereelsfast.com and redirects savereelsfast.com to it, so every
 * canonical, sitemap, robots and structured-data address must name www. Otherwise Google sees a canonical that
 * points at a redirecting URL.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SITE_URL, siteSchema } from "../lib/site.ts";

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const source = (path: string) => readFileSync(join(root, path), "utf8");

function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

describe("the site address", () => {
  it("is the www address, https, with no trailing slash", () => {
    assert.equal(SITE_URL, "https://www.savereelsfast.com");
  });

  it("is what the structured data names", () => {
    const graph = siteSchema()["@graph"];
    for (const node of graph) assert.ok(String(node.url).startsWith("https://www.savereelsfast.com"), String(node["@id"]));
    for (const node of graph) assert.ok(String(node["@id"]).startsWith("https://www.savereelsfast.com/"), String(node["@id"]));
  });

  it("no code names the bare address as a page address (mail addresses and prose are fine)", () => {
    const bare = /https?:\/\/savereelsfast\.com/;
    for (const file of [...walk("lib"), ...walk("app"), "middleware.ts", "next.config.js", "scripts/verify-seo.mjs"]) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      assert.doesNotMatch(source(file), bare, `${file} still uses the non-www address`);
    }
  });

  it("the SEO check script agrees with the site", () => {
    assert.match(source("scripts/verify-seo.mjs"), /const SITE = "https:\/\/www\.savereelsfast\.com";/);
  });

  it("robots and the sitemap take their address from SITE_URL", () => {
    assert.match(source("app/robots.ts"), /SITE_URL/);
    assert.match(source("app/sitemap.ts"), /SITE_URL/);
  });
});
