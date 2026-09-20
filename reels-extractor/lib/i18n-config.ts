export const locales = ["en", "es", "pt", "hi"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/** Public path for a locale: English is unprefixed, others get "/es", "/pt", "/hi". */
export function localePath(locale: Locale, path = ""): string {
  if (locale === defaultLocale) return path || "/";
  return `/${locale}${path}`;
}
