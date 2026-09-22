import type { MetadataRoute } from "next";
import { locales, localePath, defaultLocale, LEGAL_TRANSLATED, type Locale } from "@/lib/i18n-config";
import { blogPath, allPosts, localesWithPosts, translationsOf } from "@/lib/blog";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import { SITE_URL } from "@/lib/site";

type Frequency = "daily" | "weekly" | "monthly";

const PAGES: { path: string; changeFrequency: Frequency; priority: number; legal?: boolean }[] = [
  { path: "", changeFrequency: "daily", priority: 1.0 },
  // One landing page per platform, in every language.
  ...LANDING_PLATFORMS.map((id) => ({
    path: landingPath(id),
    changeFrequency: "daily" as const,
    priority: 0.9,
  })),
  { path: "/audio-downloader", changeFrequency: "daily", priority: 0.85 },
  { path: "/privacy-policy", changeFrequency: "monthly", priority: 0.3, legal: true },
  { path: "/terms-of-service", changeFrequency: "monthly", priority: 0.3, legal: true },
  { path: "/dmca", changeFrequency: "monthly", priority: 0.3, legal: true },
  { path: "/disclaimer", changeFrequency: "monthly", priority: 0.3, legal: true },
  { path: "/contact", changeFrequency: "monthly", priority: 0.3, legal: true },
];

/** The blog index in each language that has posts, and every post, with its translations as alternates. */
function blogEntries(lastModified: Date): MetadataRoute.Sitemap {
  const alternates = (available: readonly Locale[], path: string) => {
    const languages: Record<string, string> = {};
    available.forEach((l) => {
      languages[l] = `${SITE_URL}${localePath(l, path)}`;
    });
    // English is the default when it exists; otherwise the first language that has the page.
    languages["x-default"] = languages[defaultLocale] ?? languages[available[0]];
    return { languages };
  };

  const withPosts = localesWithPosts();
  const index: MetadataRoute.Sitemap = withPosts.map((locale) => ({
    url: `${SITE_URL}${localePath(locale, blogPath())}`,
    lastModified: new Date(`${allPosts().find((p) => p.locale === locale)?.date ?? "2026-01-01"}T00:00:00Z`),
    changeFrequency: "weekly" as const,
    priority: 0.7,
    alternates: alternates(withPosts, blogPath()),
  }));
  const posts: MetadataRoute.Sitemap = allPosts().map((post) => ({
    url: `${SITE_URL}${localePath(post.locale, blogPath(post.slug))}`,
    lastModified: new Date(`${post.updated ?? post.date}T00:00:00Z`),
    changeFrequency: "monthly" as const,
    priority: 0.6,
    alternates: alternates(translationsOf(post.slug), blogPath(post.slug)),
  }));
  return [...index, ...posts];
}

export default function sitemap(): MetadataRoute.Sitemap {
  // Generated at build time, so every deploy refreshes lastmod.
  const lastModified = new Date();

  const pages = PAGES.flatMap(({ path, changeFrequency, priority, legal }) => {
    // Legal pages are listed only in the languages where they are really translated.
    const available = legal ? LEGAL_TRANSLATED : locales;
    const languages: Record<string, string> = {};
    available.forEach((l) => {
      languages[l] = `${SITE_URL}${localePath(l, path)}`;
    });
    languages["x-default"] = `${SITE_URL}${localePath(defaultLocale, path)}`;

    return available.map((locale) => ({
      url: `${SITE_URL}${localePath(locale, path)}`,
      lastModified,
      changeFrequency,
      priority, // the same in every language: a Hindi home page matters as much as the English one
      alternates: { languages },
    }));
  });

  return [...pages, ...blogEntries(lastModified)];
}
