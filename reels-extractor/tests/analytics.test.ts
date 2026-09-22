/**
 * Google Analytics is loaded only after a visitor accepts, can be withdrawn, and the privacy policy says so in every
 * language that has one.
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LEGAL_TRANSLATED, locales } from "../lib/i18n-config.ts";
import {
  CONSENT_KEY,
  analyticsCookieNames,
  cookieDomains,
  parseMeasurementId,
  readChoice,
  saveChoice,
} from "../lib/analytics.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
type Messages = {
  consent: Record<string, string>;
  legal?: { privacy: { updated: string; sections: { heading: string; body: string[] }[] } };
};
const messages = (locale: string) => JSON.parse(source(`messages/${locale}.json`)) as Messages;

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

describe("measurement ID", () => {
  it("accepts a GA4 ID and rejects everything else (then no banner and no analytics at all)", () => {
    assert.equal(parseMeasurementId("G-QZOZ9KJ7MH"), "G-QZOZ9KJ7MH");
    assert.equal(parseMeasurementId("  G-ABC123DEF4 "), "G-ABC123DEF4");
    for (const bad of [undefined, null, "", "UA-12345-1", "G-", "g-abc123def4", "G-QZOZ9KJ7MH;alert(1)", "G-QZO Z9KJ7MH", "https://x"]) {
      assert.equal(parseMeasurementId(bad as string | undefined), null, String(bad));
    }
  });

  it("the production setting is the ID that was created for this site", () => {
    const line = source(".env.production").split(/\r?\n/).find((l) => l.startsWith("NEXT_PUBLIC_GA_MEASUREMENT_ID="));
    assert.equal(line?.split("=")[1], "G-QZ0Z9KJ7MH");
  });
});

describe("the visitor's choice", () => {
  it("is remembered, and only 'granted' or 'denied' count", () => {
    const store = memoryStore();
    assert.equal(readChoice(store), null);
    saveChoice(store, "granted");
    assert.equal(readChoice(store), "granted");
    saveChoice(store, "denied");
    assert.equal(readChoice(store), "denied");
    assert.equal(readChoice(memoryStore({ [CONSENT_KEY]: "yes please" })), null, "anything else means: ask again");
  });

  it("falls back to asking when storage is unavailable or throws", () => {
    assert.equal(readChoice(null), null);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.equal(readChoice(broken), null);
    assert.doesNotThrow(() => saveChoice(broken, "granted"));
  });
});

describe("withdrawing consent", () => {
  it("finds Google's cookies and nothing else", () => {
    const cookie = "NEXT_LOCALE=hi; _ga=GA1.1.123.456; _ga_QZOZ9KJ7MH=GS1.1.789; _gid=x; other=1; _gat_gtag_G_QZOZ9KJ7MH=1; _gaming=no";
    assert.deepEqual(analyticsCookieNames(cookie), ["_ga", "_ga_QZOZ9KJ7MH", "_gid", "_gat_gtag_G_QZOZ9KJ7MH"]);
    assert.deepEqual(analyticsCookieNames(""), []);
  });

  it("clears them on every domain they may have been set on", () => {
    assert.deepEqual(cookieDomains("www.savereelsfast.com"), ["www.savereelsfast.com", ".www.savereelsfast.com", "savereelsfast.com", ".savereelsfast.com"]);
    assert.deepEqual(cookieDomains("localhost"), ["localhost", ".localhost"]);
  });
});

describe("nothing reaches Google before the visitor accepts", () => {
  const component = source("app/[locale]/components/AnalyticsConsent.tsx");

  it("Google's script address appears in exactly one place: the function that runs after acceptance", () => {
    assert.equal(component.split("googletagmanager.com").length - 1, 1);
    const load = component.slice(component.indexOf("function loadAnalytics"), component.indexOf("function stopAnalytics"));
    assert.ok(load.includes("googletagmanager.com"));
  });

  it("no other file loads Google Analytics or Tag Manager", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === ".git" || name === "tests") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|jsx?|mjs|html|css)$/.test(name) && /googletagmanager|google-analytics\.com|gtag\(/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    walk(new URL("../app", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    walk(new URL("../lib", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const files = hits.map((h) => h.replace(/\\/g, "/").split("/").slice(-1)[0]);
    assert.deepEqual(files, ["AnalyticsConsent.tsx"]);
  });

  it("loads only when the saved answer is 'granted', and declining stops it and removes the cookies", () => {
    assert.match(component, /if \(choice !== "granted"\) return;\s+if \(id\) loadAnalytics\(id\);/);
    assert.equal(component.split("loadAnalytics(id)").length - 1, 1, "loadAnalytics is called from one place");
    assert.match(component, /if \(next === "denied"\) \{\s+if \(id\) stopAnalytics\(id\);/);
    assert.match(component, /analyticsCookieNames\(document\.cookie\)/);
  });

  it("keeps Google's advertising features off", () => {
    assert.match(component, /allow_google_signals: false/);
    assert.match(component, /allow_ad_personalization_signals: false/);
    assert.match(component, /ad_storage: "denied"/);
    assert.match(component, /ad_personalization: "denied"/);
  });

  it("asks nothing and shows nothing when no measurement ID is configured", () => {
    assert.match(component, /if \(!active \|\| !open\) return null;/);
    assert.match(component, /const active = Boolean\(id \|\| ads\);/);
    assert.match(source("app/[locale]/layout.tsx"), /cookieLabel=\{analyticsId\(\) \|\| monetagConfig\(\) \? dict\.consent\.settings : undefined\}/);
  });

  it("declining is as easy as accepting: both buttons share one style class and size", () => {
    const buttons = [...component.matchAll(/className=\{`\$\{button\} ([^`]+)`\}/g)].map((m) => m[1]);
    assert.equal(buttons.length, 2);
    assert.match(component, /const button =\s+"min-w-\[6\.5rem\] flex-1 rounded-xl px-4 py-2 text-sm font-semibold/);
  });

  it("the site's layout renders the banner and the footer has a way to change the choice", () => {
    assert.match(source("app/[locale]/layout.tsx"), /<AnalyticsConsent locale=\{locale\} dict=\{dict\.consent\} \/>/);
    assert.match(source("app/[locale]/components/Footer.tsx"), /<CookieSettingsButton label=\{cookieLabel\} \/>/);
  });
});

describe("banner text exists in every language", () => {
  for (const locale of locales) {
    it(`${locale}: title, text, accept, decline, privacy link and the footer label`, () => {
      const { consent } = messages(locale);
      for (const key of ["title", "text", "accept", "decline", "privacy", "settings"]) {
        assert.ok(consent[key]?.trim().length > 1, `${locale}.consent.${key}`);
      }
      assert.notEqual(consent.accept, consent.decline);
      assert.ok(consent.text.includes("Google Analytics"), "the banner names the tool");
    });
  }
});

describe("the privacy policy tells the truth about analytics, in every language that has one", () => {
  for (const locale of LEGAL_TRANSLATED) {
    it(`${locale}: names Google Analytics, its cookies, the consent condition, the footer button and the retention limit`, () => {
      const m = messages(locale);
      const privacy = m.legal!.privacy;
      const all = privacy.sections.flatMap((s) => s.body).join("\n");
      assert.match(all, /Google Analytics/);
      assert.match(all, /_ga\b/);
      assert.match(all, /_ga_\*/);
      assert.match(all, /14/, "the retention limit");
      assert.ok(all.includes(m.consent.settings), `the policy names the same footer button as the banner ("${m.consent.settings}")`);
      assert.match(privacy.updated, /21/, "the date reflects this change");
      assert.doesNotMatch(all, /do not use analytics or tracking cookies of our own/i, "the old claim is gone");
    });
  }

  it("the section that names the analytics cookies is the cookies section, and third parties lists Google", () => {
    const sections = messages("en").legal!.privacy.sections;
    assert.match(sections[1].body.join(" "), /Google Analytics 4/);
    assert.match(sections[3].body.join(" "), /_ga/);
    assert.match(sections[5].body.join(" "), /Google Ireland Limited/);
  });

  it("languages without their own legal text fall back to the English policy, which already carries the change", () => {
    for (const locale of locales.filter((l) => !LEGAL_TRANSLATED.includes(l))) assert.equal("legal" in messages(locale), false, locale);
  });
});
