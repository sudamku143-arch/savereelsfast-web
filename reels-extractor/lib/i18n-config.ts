export const locales = ["en", "es", "pt", "hi", "bn", "te", "ta", "mr", "id", "fr", "ar"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/**
 * Languages whose legal pages (privacy, terms, DMCA, disclaimer, contact) are fully translated.
 * The others show the English text there: a legal document is only useful if it is accurate, and
 * those translations have not been reviewed yet. They point their canonical URL at the English page.
 */
export const LEGAL_TRANSLATED: readonly Locale[] = ["en", "es", "pt", "hi"];

export function hasLegalTranslation(locale: Locale): boolean {
  return LEGAL_TRANSLATED.includes(locale);
}

const RTL_LOCALES: readonly Locale[] = ["ar"];

/** Text direction for the <html> element. */
export function localeDir(locale: Locale): "rtl" | "ltr" {
  return RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}

/**
 * The same page in another language: "/es/youtube-video-downloader" -> "/youtube-video-downloader" (English) or
 * "/hi/youtube-video-downloader". Pages that do not exist in every language (there are none today) would 404,
 * so this only swaps the prefix and leaves the rest alone.
 */
export function switchLocalePath(pathname: string, next: Locale): string {
  const match = pathname.match(/^\/([a-z]{2})(?=\/|$)/);
  const rest = match && isLocale(match[1]) ? pathname.slice(match[0].length) : pathname;
  return localePath(next, rest === "/" ? "" : rest);
}

/** Public path for a locale: English is unprefixed, others get "/es", "/hi" and so on. */
export function localePath(locale: Locale, path = ""): string {
  if (locale === defaultLocale) return path || "/";
  return `/${locale}${path}`;
}
