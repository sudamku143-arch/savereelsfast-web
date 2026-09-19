import type { Metadata } from "next";
import { locales, localePath, type Locale } from "@/lib/i18n-config";
import { SITE_URL } from "@/lib/site";

/** Canonical + hreflang metadata shared by the static legal pages. */
export function legalMetadata(
  locale: Locale,
  path: string,
  title: string,
  description: string
): Metadata {
  const languages: Record<string, string> = {};
  locales.forEach((l) => {
    languages[l] = `${SITE_URL}${localePath(l, path)}`;
  });
  const url = `${SITE_URL}${localePath(locale, path)}`;

  return {
    title,
    description,
    alternates: { canonical: url, languages },
    openGraph: { title, description, url, type: "website" },
  };
}
