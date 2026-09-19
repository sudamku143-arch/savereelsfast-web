import type { MetadataRoute } from "next";
import { locales, localePath } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import { SITE_URL } from "@/lib/site";

type Frequency = "daily" | "weekly" | "yearly";

const PAGES: { path: string; changeFrequency: Frequency; priority: number }[] = [
  { path: "", changeFrequency: "daily", priority: 1 },
  // One landing page per platform, in every language.
  ...LANDING_PLATFORMS.map((id) => ({
    path: landingPath(id),
    changeFrequency: "daily" as const,
    priority: 0.9,
  })),
  { path: "/privacy-policy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms-of-service", changeFrequency: "yearly", priority: 0.3 },
  { path: "/dmca", changeFrequency: "yearly", priority: 0.3 },
  { path: "/disclaimer", changeFrequency: "yearly", priority: 0.3 },
  { path: "/contact", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // Generated at build time, so every deploy refreshes lastmod.
  const lastModified = new Date();

  return PAGES.flatMap(({ path, changeFrequency, priority }) => {
    const languages: Record<string, string> = {};
    locales.forEach((l) => {
      languages[l] = `${SITE_URL}${localePath(l, path)}`;
    });

    return locales.map((locale) => ({
      url: `${SITE_URL}${localePath(locale, path)}`,
      lastModified,
      changeFrequency,
      priority: locale === "en" ? priority : Math.max(priority - 0.1, 0.1),
      alternates: { languages },
    }));
  });
}
