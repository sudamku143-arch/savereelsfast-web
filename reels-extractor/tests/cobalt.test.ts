/**
 * The optional Cobalt fallback on the website: its download links are accepted only when COBALT_API_URL names
 * the host, and never otherwise.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cobaltHosts, isAllowedMediaUrl, isCobaltUrl } from "../lib/instagram.ts";

const TUNNEL = "https://cobalt.example.org/tunnel?id=abc&sig=x";

describe("cobalt hosts", () => {
  it("are empty (fallback off) unless configured", () => {
    assert.deepEqual(cobaltHosts(undefined), []);
    assert.deepEqual(cobaltHosts(""), []);
  });

  it("accept only plain https instance URLs", () => {
    const hosts = cobaltHosts("https://A.example.org/, http://insecure.org, https://u:p@evil.org, https://x.org:8443, junk, https://b.example.org/api");
    assert.deepEqual(hosts, ["a.example.org", "b.example.org"]);
  });

  it("recognise a download link on the instance and nothing look-alike", () => {
    const env = "https://cobalt.example.org/";
    assert.ok(isCobaltUrl(TUNNEL, env));
    for (const other of [
      "http://cobalt.example.org/tunnel",
      "https://cobalt.example.org:444/tunnel",
      "https://cobalt.example.org.evil.net/tunnel",
      "https://evilcobalt.example.org/tunnel",
      "https://169.254.169.254/latest/meta-data/",
      "not a url",
    ]) {
      assert.equal(isCobaltUrl(other, env), false, other);
    }
  });
});

describe("media URL allowlist with the fallback", () => {
  it("rejects a Cobalt link while the fallback is off, accepts it once configured, and never widens further", () => {
    const before = process.env.COBALT_API_URL;
    try {
      delete process.env.COBALT_API_URL;
      assert.equal(isAllowedMediaUrl(TUNNEL), false);
      process.env.COBALT_API_URL = "https://cobalt.example.org/";
      assert.equal(isAllowedMediaUrl(TUNNEL), true);
      assert.equal(isAllowedMediaUrl("https://evil.example.net/tunnel"), false);
      assert.equal(isAllowedMediaUrl("https://cobalt.example.org:8443/tunnel"), false);
      assert.equal(isAllowedMediaUrl("https://rr1.googlevideo.com/videoplayback?a=1"), true);
    } finally {
      if (before === undefined) delete process.env.COBALT_API_URL;
      else process.env.COBALT_API_URL = before;
    }
  });

  it("is fetched through the scraper, not straight from the website (its link is single-use)", () => {
    const route = readFileSync(new URL("../app/api/download/route.ts", import.meta.url), "utf8");
    assert.match(route, /function isIpBound\(target: string\): boolean \{\s*return isCobaltUrl\(target\);\s*\}/);
  });

  it("googlevideo.com is no longer forced through the scraper: it gets a direct attempt like any other CDN", () => {
    const route = readFileSync(new URL("../app/api/download/route.ts", import.meta.url), "utf8");
    assert.doesNotMatch(route, /IP_BOUND_HOSTS/, "the blanket googlevideo.com skip was removed on purpose");
  });

  it("tryDirect follows redirects by hand, never blindly, and only onto an allowed CDN host", () => {
    const route = readFileSync(new URL("../app/api/download/route.ts", import.meta.url), "utf8");
    // Still "manual", never "follow": fetch must never be allowed to silently follow a redirect on its own.
    assert.match(route, /redirect: "manual",/);
    // A redirect response (3xx) is the only case that loops for another hop; every other status breaks out.
    assert.match(route, /if \(upstream\.status < 300 \|\| upstream\.status >= 400\) break;/);
    // The redirect target is resolved against the current URL and checked against the same allow-list
    // as the original request before it is ever fetched.
    assert.match(route, /next = new URL\(location, current\)\.toString\(\);/);
    assert.match(route, /if \(!isAllowedMediaUrl\(next\)\) return null;/);
    // Bounded: a redirect loop (or a CDN that never stops redirecting) can't hang the request forever.
    assert.match(route, /for \(let hop = 0; hop < MAX_REDIRECTS; hop\+\+\)/);
  });
});
