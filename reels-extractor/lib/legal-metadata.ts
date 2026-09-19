import type { Metadata } from "next";
import { locales, localePath, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";

const OG_LOCALE: Record<Locale, string> = { en: "en_US", es: "es_ES", pt: "pt_BR" };
const OG_IMAGE = `${SITE_URL}/api/og`;

/**
 * Title, description, canonical URL, hreflang alternates and social tags for a
 * static page. Used by the legal pages and the platform landing pages.
 *
 * openGraph/twitter are replaced (not merged) by a page's own values, so the
 * share image has to be repeated here.
 */
export function pageMetadata(
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
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      locale: OG_LOCALE[locale],
      type: "website",
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE] },
  };
}

/** Same as pageMetadata; kept under its original name for the legal pages. */
export const legalMetadata = pageMetadata;
