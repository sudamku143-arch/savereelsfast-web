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

  it("is fetched through the scraper, not straight from the website", () => {
    const route = readFileSync(new URL("../app/api/download/route.ts", import.meta.url), "utf8");
    assert.match(route, /return isCobaltUrl\(target\) \|\|/);
  });
});
