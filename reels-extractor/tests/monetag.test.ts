/**
 * Monetag's site-verification tag is in the <head> of every page, exactly as given.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const CODE = "6f64f47bdb0c082eacb1c4aed39da10f";

describe("Monetag verification", () => {
  it("uses the code that was issued, and only that", () => {
    assert.match(source("lib/site.ts"), new RegExp(`MONETAG_VERIFICATION = "${CODE}"`));
    assert.equal(source("lib/site.ts").split(CODE).length - 1, 1, "the code lives in one place");
  });

  it("is added to the layout's metadata, which every page in every language inherits", () => {
    const layout = source("app/[locale]/layout.tsx");
    assert.match(layout, /other: \{ monetag: MONETAG_VERIFICATION \}/);
    assert.match(layout, /MONETAG_VERIFICATION \} from "@\/lib\/site"/);
  });
});
