import type { MetadataRoute } from "next";
import { locales, localePath, LEGAL_TRANSLATED } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import { SITE_URL } from "@/lib/site";

type Frequency = "daily" | "weekly" | "yearly";

const PAGES: { path: string; changeFrequency: Frequency; priority: number; legal?: boolean }[] = [
  { path: "", changeFrequency: "daily", priority: 1 },
  // One landing page per platform, in every language.
  ...LANDING_PLATFORMS.map((id) => ({
    path: landingPath(id),
    changeFrequency: "daily" as const,
    priority: 0.9,
  })),
  { path: "/privacy-policy", changeFrequency: "yearly", priority: 0.3, legal: true },
  { path: "/terms-of-service", changeFrequency: "yearly", priority: 0.3, legal: true },
  { path: "/dmca", changeFrequency: "yearly", priority: 0.3, legal: true },
  { path: "/disclaimer", changeFrequency: "yearly", priority: 0.3, legal: true },
  { path: "/contact", changeFrequency: "yearly", priority: 0.3, legal: true },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // Generated at build time, so every deploy refreshes lastmod.
  const lastModified = new Date();

  return PAGES.flatMap(({ path, changeFrequency, priority, legal }) => {
    // Legal pages are listed only in the languages where they are really translated.
    const available = legal ? LEGAL_TRANSLATED : locales;
    const languages: Record<string, string> = {};
    available.forEach((l) => {
      languages[l] = `${SITE_URL}${localePath(l, path)}`;
    });

    return available.map((locale) => ({
      url: `${SITE_URL}${localePath(locale, path)}`,
      lastModified,
      changeFrequency,
      priority: locale === "en" ? priority : Math.max(priority - 0.1, 0.1),
      alternates: { languages },
    }));
  });
}
