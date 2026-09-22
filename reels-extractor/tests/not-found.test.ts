/**
 * Guards the fixes from the site's own SEO audit that aren't covered by a more specific test file:
 *   - robots.txt no longer carries the dead "Host" directive (Yandex-only, dropped by Yandex itself in 2018)
 *   - og:locale:alternate tells social crawlers the site exists in other languages too
 *   - a custom, branded, noindex 404 page instead of Next.js's generic default (served from app/not-found.tsx
 *     at the root, since every route here is dynamicParams: false and never reaches a nested one)
 *
 *   npm test        (needs Node >= 22.6 for --experimental-strip-types)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { locales } from "../lib/i18n-config.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("robots.txt has no dead directives", () => {
  it("does not send a Host line", () => {
    const code = source("app/robots.ts");
    assert.doesNotMatch(code, /host:/);
  });
});

describe("og:locale:alternate", () => {
  it("the home page (layout.tsx) declares the other 10 locales as alternates", () => {
    const code = source("app/[locale]/layout.tsx");
    assert.match(code, /alternateLocale: locales\.filter\(\(l\) => l !== locale\)\.map\(\(l\) => OG_LOCALE\[l\]\)/);
  });

  it("every other page (via pageMetadata) declares alternates limited to what is actually translated", () => {
    const code = source("lib/legal-metadata.ts");
    assert.match(code, /alternateLocale = translated\.filter\(\(l\) => l !== shown\)\.map\(\(l\) => OG_LOCALE\[l\]\)/);
    assert.match(code, /alternateLocale,/);
  });
});

describe("the custom 404 page", () => {
  const wrapper = source("app/[locale]/not-found.tsx");
  const content = source("app/[locale]/components/NotFoundContent.tsx");

  it("is a server component so it can force noindex (a client component cannot export metadata)", () => {
    assert.doesNotMatch(wrapper, /^"use client";/m, "not-found.tsx itself must not be a client component");
    assert.match(wrapper, /robots: \{ index: false, follow: true \}/);
  });

  it("reads the locale from the URL, since not-found.tsx receives no params", () => {
    assert.match(content, /usePathname/);
    assert.match(content, /localeFromPath/);
  });

  it("links to the homepage, the Instagram downloader and the audio downloader", () => {
    assert.match(content, /href=\{localePath\(locale\)\}/);
    assert.match(content, /landingPath\("instagram"\)/);
    assert.match(content, /localePath\(locale, "\/audio-downloader"\)/);
  });

  it("has real, non-empty translated copy for all 11 languages", () => {
    for (const locale of locales) {
      const m = content.match(new RegExp(`\\b${locale}: \\{([\\s\\S]*?)\\n  \\},`));
      assert.ok(m, `no COPY entry for ${locale}`);
      const block = m![1];
      for (const field of ["title", "body", "home", "instagram", "audio"]) {
        assert.match(block, new RegExp(`${field}: ".+?"`), `${locale}.${field} is missing or empty`);
      }
    }
  });

  it("corrects <html lang>/dir once the real locale is known, since nothing above it can set them", () => {
    assert.match(content, /document\.documentElement\.lang = locale/);
    assert.match(content, /document\.documentElement\.dir = localeDir\(locale\)/);
  });

  it("is styled with inline styles, not Tailwind classes that would need a stylesheet this route doesn't get", () => {
    assert.doesNotMatch(content, /className=/, "a Tailwind class here would silently do nothing (verified live)");
    assert.match(content, /style=\{\{/);
  });
});

describe("the root 404 (the one actually served, since every route is dynamicParams: false)", () => {
  const rootLayout = source("app/layout.tsx");
  const rootNotFound = source("app/not-found.tsx");

  it("the root layout exists (required for app/not-found.tsx to build) and is a bare pass-through", () => {
    // A pure `return children;` - not `<html>{children}</html>` - is what keeps normal pages at one <html>,
    // supplied by [locale]/layout.tsx as before.
    assert.match(rootLayout, /export default function RootLayout\([^)]*\) \{\s*return children;\s*\}/);
  });

  it("the root 404 provides its own <html>/<body>, noindex metadata and a title", () => {
    assert.match(rootNotFound, /<html lang="en">/);
    assert.match(rootNotFound, /<body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">/);
    assert.match(rootNotFound, /robots: \{ index: false, follow: true \}/);
    assert.match(rootNotFound, /title: "Page Not Found - SaveReelsFast"/);
  });

  it("renders the same NotFoundContent as the (unreachable) locale-scoped one, so there is one copy to maintain", () => {
    assert.match(rootNotFound, /import NotFoundContent from "\.\/\[locale\]\/components\/NotFoundContent"/);
    assert.match(rootNotFound, /<NotFoundContent \/>/);
  });
});
