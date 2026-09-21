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

// ---------------------------------------------------------------------------------------------------------------
// The Vignette ad script: loaded only after a visitor accepts, exactly as Monetag's snippet does it, never from <head>.
// ---------------------------------------------------------------------------------------------------------------
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SCRIPT_SRC, monetagConfig, parseScriptSrc, parseZone } from "../lib/monetag.ts";
import { CONSENT_KEY, readChoice } from "../lib/analytics.ts";
import { LEGAL_TRANSLATED } from "../lib/i18n-config.ts";

const ZONE = "11851975";
const SRC = "https://n6wxm.com/vignette.min.js";
const component = source("app/[locale]/components/AnalyticsConsent.tsx");

describe("Monetag Vignette: configuration", () => {
  it("zone and address are the ones Monetag issued", () => {
    assert.equal(DEFAULT_SCRIPT_SRC, SRC);
    const line = source(".env.production").split(/\r?\n/).find((l) => l.startsWith("NEXT_PUBLIC_MONETAG_ZONE="));
    assert.equal(line?.split("=")[1], ZONE);
  });

  it("a zone is digits only, so it can never carry markup into the page", () => {
    assert.equal(parseZone(ZONE), ZONE);
    assert.equal(parseZone(" 11851975 "), ZONE);
    for (const bad of [undefined, null, "", "abc", "118 51975", "11851975\"><script>", "1", "-5", "1e9"]) assert.equal(parseZone(bad as string | undefined), null, String(bad));
  });

  it("a script address must be a plain https URL", () => {
    assert.equal(parseScriptSrc(SRC), SRC);
    for (const bad of [undefined, "", "http://n6wxm.com/vignette.min.js", "//n6wxm.com/x.js", "javascript:alert(1)", "data:text/javascript,1", "https://user:pw@n6wxm.com/x.js",
      "https://n6wxm.com:8443/x.js", "https://n6wxm.com/x.js\" onload=\"1", "not a url"]) {
      assert.equal(parseScriptSrc(bad as string | undefined), null, String(bad));
    }
  });

  it("is off without a zone, and on with one (default or overridden address)", () => {
    const keep = { zone: process.env.NEXT_PUBLIC_MONETAG_ZONE, src: process.env.NEXT_PUBLIC_MONETAG_SCRIPT_SRC };
    try {
      delete process.env.NEXT_PUBLIC_MONETAG_ZONE;
      delete process.env.NEXT_PUBLIC_MONETAG_SCRIPT_SRC;
      assert.equal(monetagConfig(), null);
      process.env.NEXT_PUBLIC_MONETAG_ZONE = ZONE;
      assert.deepEqual(monetagConfig(), { zone: ZONE, src: SRC });
      process.env.NEXT_PUBLIC_MONETAG_SCRIPT_SRC = "https://other.example/v.js";
      assert.deepEqual(monetagConfig(), { zone: ZONE, src: "https://other.example/v.js" });
      process.env.NEXT_PUBLIC_MONETAG_SCRIPT_SRC = "http://insecure.example/v.js";
      assert.equal(monetagConfig(), null, "an unusable address switches the ad off instead of loading it");
    } finally {
      for (const [name, value] of [["NEXT_PUBLIC_MONETAG_ZONE", keep.zone], ["NEXT_PUBLIC_MONETAG_SCRIPT_SRC", keep.src]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("Monetag Vignette: nothing loads before the visitor accepts", () => {
  it("the ad's address is written in one place only, and no page or layout puts a script tag in the <head>", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", "tests"].includes(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|jsx?|mjs|html|css)$/.test(name) && /n6wxm\.com|vignette\.min\.js/.test(readFileSync(path, "utf8"))) hits.push(name);
      }
    };
    for (const folder of ["../app", "../lib"]) walk(new URL(folder, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    assert.deepEqual(hits, ["monetag.ts"], "the address lives only in lib/monetag.ts");
    const layout = source("app/[locale]/layout.tsx");
    assert.doesNotMatch(layout, /<script|next\/script|dataset\.zone|data-zone/, "the layout adds no ad script of its own");
  });

  it("is added by loadAds, which runs only inside the effect that requires a saved 'granted'", () => {
    assert.equal(component.split("loadAds(ads)").length - 1, 1, "called from one place");
    assert.match(component, /if \(choice !== "granted"\) return;\s+if \(id\) loadAnalytics\(id\);\s+if \(ads\) loadAds\(ads\);/);
    assert.match(component, /function loadAds\(ads: MonetagConfig\): void \{/);
  });

  it("does what Monetag's own snippet does: a script with data-zone, at the end of the page", () => {
    const load = component.slice(component.indexOf("function loadAds"), component.indexOf("/** Withdrawing consent"));
    assert.match(load, /document\.createElement\("script"\)/);
    assert.match(load, /script\.dataset\.zone = ads\.zone;/);
    assert.match(load, /script\.src = ads\.src;/);
    assert.match(load, /\(document\.body \?\? document\.documentElement\)\.appendChild\(script\)/);
    assert.match(load, /if \(document\.getElementById\(ADS_SCRIPT_ID\)\) return;/, "never twice");
  });

  it("runs from an effect after hydration and renders nothing itself, so it cannot cause a hydration mismatch", () => {
    assert.doesNotMatch(component.slice(component.indexOf("function loadAds"), component.indexOf("/** Withdrawing consent")), /useState|useRef/);
    assert.match(component, /useEffect\(\(\) => \{\s+if \(choice !== "granted"\) return;/);
  });

  it("declining after an accepted visit reloads the page without the ad script", () => {
    assert.match(component, /if \(document\.getElementById\(ADS_SCRIPT_ID\)\) window\.location\.reload\(\);/);
  });

  it("the earlier analytics-only answer is not taken as consent to ads: the saved answer has a new key", () => {
    assert.equal(CONSENT_KEY, "srf_consent_v2");
    const old = { getItem: (k: string) => (k === "srf_analytics_consent" ? "granted" : null), setItem: () => undefined };
    assert.equal(readChoice(old), null, "someone who only agreed to analytics is asked again");
  });
});

describe("Monetag Vignette: what the visitor is told", () => {
  it("the banner names the advertising in every language", () => {
    for (const locale of ["en", "es", "pt", "hi", "bn", "te", "ta", "mr", "id", "fr", "ar"]) {
      const { consent } = JSON.parse(source(`messages/${locale}.json`)) as { consent: { title: string; text: string } };
      assert.notEqual(consent.title, "Cookies and analytics", `${locale}: the title still covers analytics only`);
      if (locale !== "en") assert.notEqual(consent.text, JSON.parse(source("messages/en.json")).consent.text, `${locale} is translated`);
    }
    assert.match(JSON.parse(source("messages/en.json")).consent.text, /advertising partner/);
  });

  for (const locale of LEGAL_TRANSLATED) {
    it(`${locale}: the privacy policy names Monetag, says its script needs acceptance, and does not promise "no advertising cookies"`, () => {
      const privacy = (JSON.parse(source(`messages/${locale}.json`)) as { legal: { privacy: { sections: { body: string[] }[] } } }).legal.privacy;
      const advertising = privacy.sections[4].body.join("\n");
      assert.match(advertising, /Monetag/);
      assert.match(advertising, /A-ADS/);
      const cookies = privacy.sections[3].body.join("\n");
      assert.match(cookies, /_ga_\*/);
      assert.match(cookies, /Monetag|advertising|publicidad|publicitaire|विज्ञापन|iklan|إعلان|publicidade|publicitário/i);
    });
  }

  it("the English policy states the condition plainly", () => {
    const privacy = (JSON.parse(source("messages/en.json")) as { legal: { privacy: { sections: { body: string[] }[] } } }).legal.privacy;
    assert.match(privacy.sections[4].body[1], /loaded only if you accept in our cookie banner; if you decline, they are not loaded/);
    assert.match(privacy.sections[3].body[2], /reloads the page without the advertising script/);
  });
});
