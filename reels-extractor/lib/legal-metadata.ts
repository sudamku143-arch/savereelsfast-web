import type { Metadata } from "next";
import { locales, localePath, hasLegalTranslation, LEGAL_TRANSLATED, defaultLocale, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";

const OG_LOCALE: Record<Locale, string> = { en: "en_US", es: "es_ES", pt: "pt_BR", hi: "hi_IN", bn: "bn_IN", te: "te_IN", ta: "ta_IN", mr: "mr_IN", id: "id_ID", fr: "fr_FR", ar: "ar_AR" };
const OG_IMAGE = `${SITE_URL}/api/og`;

/** Share image for a platform's landing page (see app/api/og/route.tsx for the accepted keys). */
export function platformOgImage(key: string, locale: Locale): string {
  return `${OG_IMAGE}?p=${key}&l=${locale}`;
}

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
  description: string,
  image: string = OG_IMAGE,
  translated: readonly Locale[] = locales
): Metadata {
  const languages: Record<string, string> = {};
  translated.forEach((l) => {
    languages[l] = `${SITE_URL}${localePath(l, path)}`;
  });
  languages["x-default"] = `${SITE_URL}${localePath(defaultLocale, path)}`;
  // A page shown in a language it has not been translated into duplicates the English one.
  const shown = translated.includes(locale) ? locale : defaultLocale;
  const url = `${SITE_URL}${localePath(shown, path)}`;

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
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/** Legal pages: only translated languages are alternates; the rest canonicalise to English. */
export function legalMetadata(locale: Locale, path: string, title: string, description: string): Metadata {
  const metadata = pageMetadata(locale, path, title, description, OG_IMAGE, LEGAL_TRANSLATED);
  return hasLegalTranslation(locale) ? metadata : { ...metadata, robots: { index: false, follow: true } };
}
