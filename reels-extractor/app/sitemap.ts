import type { MetadataRoute } from "next";
import { locales, localePath } from "@/lib/i18n-config";
import { SITE_URL } from "@/lib/site";

const PAGES: { path: string; changeFrequency: "weekly" | "yearly"; priority: number }[] = [
  { path: "", changeFrequency: "weekly", priority: 1 },
  { path: "/privacy-policy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms-of-service", changeFrequency: "yearly", priority: 0.3 },
  { path: "/contact", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
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
