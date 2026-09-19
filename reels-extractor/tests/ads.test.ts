/**
 * Ad configuration: which network a slot uses, and when it falls back to a placeholder.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { planAd, resolveAdConfig } from "../lib/ads.ts";

const CLIENT = "ca-pub-1234567890123456";

describe("provider selection", () => {
  it("shows placeholders only when nothing is configured", () => {
    const config = resolveAdConfig({});
    assert.equal(config.provider, "none");
    for (const variant of ["leaderboard", "native", "sticky"] as const) {
      assert.deepEqual(planAd(config, variant), { kind: "placeholder" });
    }
    assert.equal(config.showPlaceholders, true);
  });

  it("defaults to AdSense as soon as a valid publisher id exists", () => {
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_CLIENT_ID: CLIENT }).provider, "adsense");
  });

  it("ignores a malformed publisher id instead of loading a broken script", () => {
    for (const bad of ["1234567890123456", "ca-pub-abc", "ca-pub-1", "<script>", " "]) {
      const config = resolveAdConfig({ NEXT_PUBLIC_AD_CLIENT_ID: bad });
      assert.equal(config.provider, "none", `"${bad}" must not enable AdSense`);
      assert.equal(config.clientId, null);
    }
  });

  it("does not run AdSense without a publisher id, even when asked to", () => {
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PROVIDER: "adsense" }).provider, "none");
  });

  it("accepts an explicit provider, case-insensitively, and rejects unknown ones", () => {
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PROVIDER: "AADS" }).provider, "aads");
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PROVIDER: "Custom" }).provider, "custom");
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PROVIDER: "evilnet", NEXT_PUBLIC_AD_CLIENT_ID: CLIENT }).provider, "none");
  });
});

describe("AdSense slots", () => {
  const env = {
    NEXT_PUBLIC_AD_CLIENT_ID: CLIENT,
    NEXT_PUBLIC_AD_SLOT_LEADERBOARD: "1111111111",
    NEXT_PUBLIC_AD_SLOT_STICKY: "3333333333",
  };

  it("uses a slot when it is configured and a placeholder when it is not", () => {
    const config = resolveAdConfig(env);
    assert.deepEqual(planAd(config, "leaderboard"), { kind: "adsense", clientId: CLIENT, slot: "1111111111" });
    assert.deepEqual(planAd(config, "sticky"), { kind: "adsense", clientId: CLIENT, slot: "3333333333" });
    assert.deepEqual(planAd(config, "native"), { kind: "placeholder" }); // no NATIVE slot set
  });

  it("rejects slot ids that are not plain digits", () => {
    const config = resolveAdConfig({ ...env, NEXT_PUBLIC_AD_SLOT_LEADERBOARD: '1"><script>alert(1)</script>' });
    assert.deepEqual(planAd(config, "leaderboard"), { kind: "placeholder" });
  });
});

describe("A-ADS units", () => {
  it("pairs a desktop unit with an optional phone unit", () => {
    const config = resolveAdConfig({
      NEXT_PUBLIC_AD_PROVIDER: "aads",
      NEXT_PUBLIC_AD_SLOT_LEADERBOARD: "2000001",
      NEXT_PUBLIC_AD_SLOT_LEADERBOARD_MOBILE: "2000002",
      NEXT_PUBLIC_AD_SLOT_NATIVE: "2000003",
    });
    assert.deepEqual(planAd(config, "leaderboard"), { kind: "aads", desktopUnit: "2000001", mobileUnit: "2000002" });
    assert.deepEqual(planAd(config, "native"), { kind: "aads", desktopUnit: "2000003", mobileUnit: null });
    assert.deepEqual(planAd(config, "sticky"), { kind: "placeholder" });
  });
});

describe("custom snippets (Propeller, Adsterra, ...)", () => {
  it("passes the operator's snippet through untouched", () => {
    const html = '<div id="x"></div><script async src="https://ads.example/serve.js"></script>';
    const config = resolveAdConfig({ NEXT_PUBLIC_AD_PROVIDER: "custom", NEXT_PUBLIC_AD_HTML_NATIVE: html });
    assert.deepEqual(planAd(config, "native"), { kind: "custom", html });
    assert.deepEqual(planAd(config, "leaderboard"), { kind: "placeholder" });
  });

  it("ignores snippets when a different provider is selected", () => {
    const config = resolveAdConfig({
      NEXT_PUBLIC_AD_CLIENT_ID: CLIENT,
      NEXT_PUBLIC_AD_HTML_NATIVE: "<script>evil()</script>",
    });
    assert.deepEqual(planAd(config, "native"), { kind: "placeholder" });
  });
});

describe("placeholders and placement", () => {
  it("can hide empty placeholders", () => {
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PLACEHOLDERS: "off" }).showPlaceholders, false);
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PLACEHOLDERS: "OFF" }).showPlaceholders, false);
    assert.equal(resolveAdConfig({ NEXT_PUBLIC_AD_PLACEHOLDERS: "on" }).showPlaceholders, true);
  });

});

describe("where the slots live", () => {
  const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("puts ads on the home page and the landing pages", () => {
    for (const file of ["app/[locale]/page.tsx", "app/[locale]/downloader/[platform]/page.tsx"]) {
      const page = source(file);
      for (const variant of ["leaderboard", "native", "sticky"]) {
        assert.ok(page.includes(`variant="${variant}"`), `${file} is missing the ${variant} slot`);
      }
    }
    assert.ok(source("app/[locale]/components/ExtractorClient.tsx").includes('variant="native"'), "no native slot under the result card");
  });

  it("keeps ads off the legal pages and out of the shared layout", () => {
    for (const file of [
      "app/[locale]/layout.tsx",
      "app/[locale]/privacy-policy/page.tsx",
      "app/[locale]/terms-of-service/page.tsx",
      "app/[locale]/dmca/page.tsx",
      "app/[locale]/disclaimer/page.tsx",
      "app/[locale]/contact/page.tsx",
    ]) {
      assert.ok(!source(file).includes("AdBanner"), `${file} must not render ads`);
    }
  });

  it("never reads the URL to decide whether to render (server and browser paths differ under rewrites)", () => {
    assert.ok(!source("app/[locale]/components/AdBanner.tsx").includes("usePathname"));
  });
});

