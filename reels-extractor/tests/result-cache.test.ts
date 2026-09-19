/**
 * Unit tests for lib/result-cache.ts (the last-five-results sessionStorage cache).
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  MAX_CACHED_RESULTS,
  RESULT_TTL_MS,
  getCachedResult,
  getLastViewed,
  putCachedResult,
  setLastViewed,
} from "../lib/result-cache.ts";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const g = globalThis as unknown as { sessionStorage: unknown };
const result = (id: string) => ({ id, videoUrl: `https://x.cdninstagram.com/${id}.mp4` });
const T0 = 1_700_000_000_000;

describe("result cache", () => {
  beforeEach(() => {
    g.sessionStorage = new MemoryStorage();
  });

  it("returns a stored result immediately", () => {
    putCachedResult("https://youtu.be/a", result("a"), T0);
    assert.deepEqual(getCachedResult("https://youtu.be/a", T0 + 1000), result("a"));
    assert.equal(getCachedResult("https://youtu.be/other", T0), null);
  });

  it("keeps only the five most recent successful lookups", () => {
    for (let i = 1; i <= 7; i++) putCachedResult(`https://youtu.be/v${i}`, result(`v${i}`), T0 + i);
    assert.equal(MAX_CACHED_RESULTS, 5);
    assert.equal(getCachedResult("https://youtu.be/v1", T0 + 10), null); // evicted
    assert.equal(getCachedResult("https://youtu.be/v2", T0 + 10), null); // evicted
    for (let i = 3; i <= 7; i++) assert.ok(getCachedResult(`https://youtu.be/v${i}`, T0 + 10), `v${i} kept`);
  });

  it("re-storing a link moves it to the front instead of duplicating it", () => {
    for (let i = 1; i <= 5; i++) putCachedResult(`u${i}`, result(`v${i}`), T0 + i);
    putCachedResult("u1", result("v1-new"), T0 + 10); // u1 becomes newest
    putCachedResult("u6", result("v6"), T0 + 11); // pushes out the oldest, which is now u2
    assert.deepEqual(getCachedResult("u1", T0 + 12), result("v1-new"));
    assert.equal(getCachedResult("u2", T0 + 12), null);
  });

  it("expires entries before the server-side links do", () => {
    putCachedResult("u", result("a"), T0);
    assert.ok(getCachedResult("u", T0 + RESULT_TTL_MS - 1));
    assert.equal(getCachedResult("u", T0 + RESULT_TTL_MS + 1), null);
    assert.ok(RESULT_TTL_MS < 60 * 60 * 1000, "must be shorter than the 1 h server cache");
  });

  it("remembers which result was on screen, and forgets it on reset", () => {
    putCachedResult("u", result("a"), T0);
    setLastViewed("u");
    assert.deepEqual(getLastViewed(T0 + 5), { url: "u", result: result("a") });
    setLastViewed(null);
    assert.equal(getLastViewed(T0 + 5), null);
    // ...but the result itself is still cached, so pasting the link again is instant.
    assert.deepEqual(getCachedResult("u", T0 + 5), result("a"));
  });

  it("does not restore an expired result", () => {
    putCachedResult("u", result("a"), T0);
    setLastViewed("u");
    assert.equal(getLastViewed(T0 + RESULT_TTL_MS + 1), null);
  });

  it("survives corrupt storage contents", () => {
    (g.sessionStorage as MemoryStorage).setItem("srf:results:v1", "{not json");
    assert.equal(getCachedResult("u", T0), null);
    putCachedResult("u", result("a"), T0); // recovers by overwriting
    assert.deepEqual(getCachedResult("u", T0 + 1), result("a"));
  });

  it("never throws when storage is unavailable (private mode / blocked)", () => {
    g.sessionStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    };
    assert.doesNotThrow(() => putCachedResult("u", result("a"), T0));
    assert.equal(getCachedResult("u", T0), null);
    assert.doesNotThrow(() => setLastViewed("u"));
    assert.equal(getLastViewed(T0), null);
  });
});
