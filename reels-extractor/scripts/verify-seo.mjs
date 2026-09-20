#!/usr/bin/env node
/**
 * Fetches every landing page from a RUNNING server and checks what a crawler would see:
 * status, <title>, description, canonical, hreflang, Open Graph image, a single <h1>,
 * structured data, internal links, plus sitemap.xml and robots.txt.
 *
 *   npm run build && npm start &        # in one terminal
 *   BASE_URL=http://127.0.0.1:3000 npm run verify:seo
 *
 * Exits non-zero if anything is wrong.
 */
import { readFileSync } from "node:fs";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const SITE = "https://savereelsfast.com"; // canonical URLs always point at production
const LOCALES = ["en", "es", "pt", "hi", "bn", "te", "ta", "mr", "id", "fr", "ar"];
// Legal pages are translated (and listed in the sitemap) only in these; the rest show English.
const LEGAL_LOCALES = ["en", "es", "pt", "hi"];
const RTL = ["ar"];
const SLUGS = { instagram: "instagram", youtube: "youtube", facebook: "facebook", threads: "threads", x: "twitter", pinterest: "pinterest", tiktok: "tiktok", reddit: "reddit", snapchat: "snapchat" };

const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(new URL(`../messages/${l}.json`, import.meta.url), "utf8"))])
);

const path = (locale, p) => (locale === "en" ? p : `/${locale}${p}`);
const home = (locale) => (locale === "en" ? "/" : `/${locale}`);
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

let checks = 0;
const failures = [];
function check(ok, label) {
  checks += 1;
  if (!ok) failures.push(label);
}

async function get(url, init) {
  return fetch(`${BASE}${url}`, { redirect: "manual", ...init });
}

function meta(html, attr, name) {
  const re = new RegExp(`<meta[^>]+${attr}="${name}"[^>]*content="([^"]*)"`, "i");
  const alt = new RegExp(`<meta[^>]+content="([^"]*)"[^>]*${attr}="${name}"`, "i");
  const m = html.match(re) ?? html.match(alt);
  return m ? decode(m[1]) : null;
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return blocks.map((b) => JSON.parse(b));
}

async function verifyLanding(locale, id, slug) {
  const url = path(locale, `/downloader/${slug}`);
  const tag = `[${locale}/${id}]`;
  const res = await get(url);
  check(res.status === 200, `${tag} ${url} returned ${res.status}`);
  if (res.status !== 200) return;
  const html = await res.text();
  const content = messages[locale].landing.platforms[id];

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  check(title && decode(title) === content.metaTitle, `${tag} <title> is "${title}"`);
  check(meta(html, "name", "description") === content.metaDescription, `${tag} meta description differs`);
  check(new RegExp(`<html[^>]+lang="${locale}"`).test(html), `${tag} <html lang> is not ${locale}`);
  check(new RegExp(`<html[^>]+dir="${RTL.includes(locale) ? "rtl" : "ltr"}"`).test(html), `${tag} <html dir> is wrong`);

  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
  check(canonical === `${SITE}${path(locale, `/downloader/${slug}`)}`, `${tag} canonical is ${canonical}`);
  for (const l of LOCALES) {
    const expected = `${SITE}${path(l, `/downloader/${slug}`)}`;
    check(html.includes(`hrefLang="${l}" href="${expected}"`) || html.includes(`hreflang="${l}" href="${expected}"`), `${tag} missing hreflang ${l}`);
  }
  check(meta(html, "property", "og:title") === content.metaTitle, `${tag} og:title differs`);
  check(meta(html, "property", "og:image") === `${SITE}/api/og?p=${slug}&l=${locale}`, `${tag} og:image is ${meta(html, "property", "og:image")}`);
  check(meta(html, "name", "twitter:image") === `${SITE}/api/og?p=${slug}&l=${locale}`, `${tag} twitter:image missing`);
  check(meta(html, "name", "twitter:card") === "summary_large_image", `${tag} twitter:card missing`);

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")));
  check(h1s.length === 1 && h1s[0] === content.h1, `${tag} h1s: ${JSON.stringify(h1s)}`);

  let data = [];
  try {
    data = jsonLd(html);
  } catch (e) {
    check(false, `${tag} JSON-LD does not parse: ${e.message}`);
  }
  const graph = data.flatMap((d) => d["@graph"] ?? [d]);
  const type = (t) => graph.find((n) => n["@type"] === t);
  const app = type("SoftwareApplication");
  const faq = type("FAQPage");
  const crumbs = type("BreadcrumbList");
  check(!!app && app.applicationCategory === "MultimediaApplication" && app.offers?.price === "0", `${tag} SoftwareApplication missing/invalid`);
  check(!app || !("aggregateRating" in app), `${tag} must not invent an aggregateRating`);
  check(faq?.mainEntity?.length === 6, `${tag} FAQPage has ${faq?.mainEntity?.length} questions (expected 6)`);
  check(crumbs?.itemListElement?.length === 2, `${tag} BreadcrumbList incomplete`);
  check(app?.url === `${SITE}${path(locale, `/downloader/${slug}`)}`, `${tag} schema url mismatch`);
  // Every FAQ in the markup must also be visible on the page (Google requires it).
  const visible = decode(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  check((faq?.mainEntity ?? []).every((q) => visible.includes(q.name)), `${tag} an FAQ question is in the schema but not on the page`);

  for (const other of Object.values(SLUGS)) {
    if (other === slug) continue;
    check(html.includes(`href="${path(locale, `/downloader/${other}`)}"`), `${tag} no internal link to ${other}`);
  }
}

async function main() {
  console.log(`Verifying ${BASE}\n`);

  for (const locale of LOCALES) {
    for (const [id, slug] of Object.entries(SLUGS)) await verifyLanding(locale, id, slug);
  }

  // Home pages link to every landing page.
  for (const locale of LOCALES) {
    const html = await (await get(home(locale))).text();
    for (const slug of Object.values(SLUGS)) {
      check(html.includes(`href="${path(locale, `/downloader/${slug}`)}"`), `[${locale}] home page has no link to ${slug}`);
    }
  }

  // The footer: three columns, with every legal page linked from every language.
  for (const locale of LOCALES) {
    const html = await (await get(home(locale))).text();
    const footer = html.slice(html.indexOf('<footer'));
    for (const legal of ["/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact"]) {
      check(footer.includes(`href="${path(locale, legal)}"`), `[${locale}] footer has no link to ${legal}`);
    }
    for (const slug of Object.values(SLUGS)) {
      check(footer.includes(`href="${path(locale, `/downloader/${slug}`)}"`), `[${locale}] footer has no link to the ${slug} tool`);
    }
    check(/href="mailto:[^"]+\?subject=/.test(footer), `[${locale}] footer has no "report a broken link" mailto`);
    const headings = [...footer.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
    check(headings.length === 3, `[${locale}] footer should have 3 columns, found ${headings.length}`);
  }

  // Ad slots must be in the server-rendered HTML (a client-only slot causes a hydration error
  // and shifts the layout), and must never appear on the legal pages.
  const countAds = (html, locale) => (html.match(new RegExp(`<aside aria-label="${messages[locale].ad.label}"`, "g")) ?? []).length;
  for (const locale of LOCALES) {
    for (const page of [home(locale), ...Object.values(SLUGS).map((slug) => path(locale, `/downloader/${slug}`))]) {
      const ads = countAds(await (await get(page)).text(), locale);
      // The leaderboard is always present; the others may be hidden while no network is configured for them.
      check(ads >= 1, `[${locale}] ${page} server HTML has ${ads} ad slots (expected at least the leaderboard)`);
    }
    for (const legal of ["/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact"]) {
      const ads = countAds(await (await get(path(locale, legal))).text(), locale);
      check(ads === 0, `[${locale}] ${legal} must not show ads (found ${ads})`);
    }
  }

  // A-ADS's verification bot reads the RAW server HTML for the exact embed code.
  const unit = readFileSync(new URL("../.env.production", import.meta.url), "utf8").match(/^NEXT_PUBLIC_AD_SLOT_LEADERBOARD=(\d+)/m)?.[1];
  if (unit) {
    const snippet = `<!-- BEGIN AADS AD UNIT ${unit} -->
<div id="frame" style="width: 100%; margin: auto; position: relative; z-index: 99998;">
  <iframe data-aa='${unit}' src='//acceptable.a-ads.com/${unit}/?size=Adaptive' style='border:0px; padding:0; width:100%; height:100%; overflow:hidden; background-color: transparent;'></iframe>
</div>
<!-- END AADS AD UNIT ${unit} -->`;
    for (const locale of LOCALES) {
      for (const page of [home(locale), ...Object.values(SLUGS).map((slug) => path(locale, `/downloader/${slug}`))]) {
        const html = await (await get(page)).text();
        check(html.includes(snippet), `[${locale}] ${page}: raw HTML lacks the exact A-ADS snippet for unit ${unit}`);
        check((html.match(/id="frame"/g) ?? []).length === 1, `[${locale}] ${page}: id="frame" must appear exactly once`);
      }
    }
  }

  // Routing edge cases.
  const legacy = await get("/downloader/x");
  check([301, 308].includes(legacy.status) && legacy.headers.get("location")?.endsWith("/downloader/twitter"), `/downloader/x should redirect to /twitter (got ${legacy.status} ${legacy.headers.get("location")})`);
  const legacyEs = await get("/es/downloader/x");
  check([301, 308].includes(legacyEs.status) && legacyEs.headers.get("location")?.endsWith("/es/downloader/twitter"), `/es/downloader/x redirect (got ${legacyEs.status} ${legacyEs.headers.get("location")})`);
  for (const bad of ["/downloader/vimeo", "/es/downloader/xyz", "/downloader"]) {
    const res = await get(bad);
    check(res.status === 404, `${bad} should be 404 (got ${res.status})`);
  }
  const explicitEn = await get("/en/downloader/youtube");
  check(explicitEn.status === 308 && explicitEn.headers.get("location")?.endsWith("/downloader/youtube"), `/en/... should redirect to the unprefixed URL (got ${explicitEn.status})`);

  // sitemap.xml
  const sitemapRes = await get("/sitemap.xml");
  check(sitemapRes.status === 200 && /xml/.test(sitemapRes.headers.get("content-type") ?? ""), "sitemap.xml not served as XML");
  const xml = await sitemapRes.text();
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const locs = entries.map((e) => e.match(/<loc>([^<]*)<\/loc>/)?.[1]);
  const expectedUrls = 10 * LOCALES.length + 5 * LEGAL_LOCALES.length;
  check(entries.length === expectedUrls, `sitemap has ${entries.length} URLs (expected ${expectedUrls})`);
  check(new Set(locs).size === locs.length, "sitemap has duplicate URLs");
  for (const locale of LOCALES) {
    for (const slug of Object.values(SLUGS)) {
      const loc = `${SITE}${path(locale, `/downloader/${slug}`)}`;
      const entry = entries.find((e) => e.includes(`<loc>${loc}</loc>`));
      check(!!entry, `sitemap is missing ${loc}`);
      if (entry) {
        check(/<changefreq>daily<\/changefreq>/.test(entry), `${loc} changefreq is not daily`);
        check(/<lastmod>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/lastmod>/.test(entry), `${loc} lastmod missing`);
        check(LOCALES.every((l) => new RegExp(`hreflang="${l}"`).test(entry)), `${loc} lacks hreflang alternates`);
      }
    }
    check(locs.includes(`${SITE}${home(locale)}`), `sitemap is missing the ${locale} home page`);
  }
  check(locs.every((l) => l?.startsWith(SITE)), "sitemap contains non-production URLs");

  // Every sitemap URL must actually exist on this server.
  for (const loc of locs) {
    const res = await get(loc.replace(SITE, ""));
    check(res.status === 200, `sitemap URL ${loc} returned ${res.status}`);
  }

  // Legal pages without a reviewed translation: English text, so they canonicalise to the English page,
  // stay out of the index and out of the sitemap.
  for (const locale of LOCALES.filter((l) => !LEGAL_LOCALES.includes(l))) {
    for (const legal of ["/privacy-policy", "/terms-of-service", "/dmca", "/disclaimer", "/contact"]) {
      const html = await (await get(path(locale, legal))).text();
      const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
      check(canonical === `${SITE}${legal}`, `[${locale}] ${legal} canonical is ${canonical} (expected the English page)`);
      check(/<meta name="robots" content="noindex/.test(html), `[${locale}] ${legal} should be noindex`);
      check(!locs.includes(`${SITE}${path(locale, legal)}`), `[${locale}] ${legal} must not be in the sitemap`);
    }
  }

  // robots.txt
  const robots = await (await get("/robots.txt")).text();
  check(/Sitemap: https:\/\/savereelsfast\.com\/sitemap\.xml/.test(robots), "robots.txt does not point at the sitemap");
  check(/Disallow: \/api\//.test(robots), "robots.txt should block /api/");
  check(/Allow: \/api\/og/.test(robots), "robots.txt should allow the share image /api/og");
  check(!/Disallow: \/\s*$/m.test(robots), "robots.txt must not block the whole site");

  console.log(`${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("All SEO checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
