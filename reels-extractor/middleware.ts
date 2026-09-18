import { NextRequest, NextResponse } from "next/server";
import { locales, defaultLocale } from "./lib/i18n-config";

function getLocaleFromHeader(request: NextRequest): string {
  const acceptLang = request.headers.get("accept-language");
  if (!acceptLang) return defaultLocale;

  const preferred = acceptLang
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase().slice(0, 2));

  const match = preferred.find((lang) =>
    (locales as readonly string[]).includes(lang)
  );
  return match ?? defaultLocale;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static assets, API routes, and Next internals
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  const pathnameHasLocale = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );

  if (pathnameHasLocale) return NextResponse.next();

  // en stays unprefixed at "/"; only redirect if browser prefers es or pt
  const detected = getLocaleFromHeader(request);
  if (detected !== defaultLocale) {
    const url = request.nextUrl.clone();
    url.pathname = `/${detected}${pathname}`;
    return NextResponse.redirect(url);
  }

  // Rewrite "/" internally to "/en" so the [locale] segment always resolves
  const url = request.nextUrl.clone();
  url.pathname = `/${defaultLocale}${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
