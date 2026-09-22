"use client";

import { useEffect, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { locales, localePath, localeDir, defaultLocale, type Locale } from "@/lib/i18n-config";
import { landingPath } from "@/lib/landing";

/**
 * The 404 page's content. A client component because the locale is read straight from the URL (Next.js's
 * not-found.tsx convention takes no props, not even params) - the same approach ModeSwitcher uses.
 *
 * This site is fully statically generated (dynamicParams: false everywhere, force-static on every page), so
 * a request for a URL outside the pre-built list never reaches [locale]/[platform]/page.tsx's own
 * notFound() call at all - Next.js's routing layer serves the site-wide 404 directly, before any [locale]
 * segment (and its layout, with the real Header/Footer) ever renders. That means this has to be the ROOT
 * app/not-found.tsx (a bare page with its own <html>/<body>, no layout above it to lean on) for it to ever
 * actually be shown; a locale-scoped app/[locale]/not-found.tsx is kept too, as a harmless, correctly-
 * documented fallback for the (currently unreachable) case where a route becomes dynamic later.
 *
 * Styled with inline styles, not Tailwind classes: a page-level global.css import with no matching layout in
 * its own render branch does not reliably get linked into app/not-found.tsx's output (confirmed - the built
 * page had no <link rel="stylesheet"> at all, moving the import to the root layout didn't change that
 * either), so Tailwind's utility classes would silently do nothing here. Colors are copied from
 * tailwind.config.ts (brand) and Tailwind's default zinc scale, so this still matches the site's look.
 */
type Copy = { title: string; body: string; home: string; instagram: string; audio: string };

const COPY: Record<Locale, Copy> = {
  en: {
    title: "Page not found",
    body: "The page you're looking for doesn't exist, or it may have moved.",
    home: "Go to the homepage",
    instagram: "Instagram downloader",
    audio: "Audio downloader",
  },
  es: {
    title: "Página no encontrada",
    body: "La página que buscas no existe, o puede que se haya movido.",
    home: "Ir a la página de inicio",
    instagram: "Descargador de Instagram",
    audio: "Descargador de audio",
  },
  pt: {
    title: "Página não encontrada",
    body: "A página que você procura não existe, ou pode ter sido movida.",
    home: "Ir para a página inicial",
    instagram: "Baixador do Instagram",
    audio: "Baixador de áudio",
  },
  hi: {
    title: "पेज नहीं मिला",
    body: "जो पेज आप ढूंढ रहे हैं वह मौजूद नहीं है, या हो सकता है वह हट गया हो।",
    home: "होमपेज पर जाएँ",
    instagram: "Instagram डाउनलोडर",
    audio: "ऑडियो डाउनलोडर",
  },
  bn: {
    title: "পেজ পাওয়া যায়নি",
    body: "আপনি যে পেজ খুঁজছেন তা নেই, অথবা সরানো হয়ে থাকতে পারে।",
    home: "হোমপেজে যান",
    instagram: "Instagram ডাউনলোডার",
    audio: "অডিও ডাউনলোডার",
  },
  te: {
    title: "పేజీ కనుగొనబడలేదు",
    body: "మీరు వెతుకుతున్న పేజీ లేదు, లేదా అది తరలించబడి ఉండవచ్చు.",
    home: "హోమ్‌పేజీకి వెళ్ళండి",
    instagram: "Instagram డౌన్‌లోడర్",
    audio: "ఆడియో డౌన్‌లోడర్",
  },
  ta: {
    title: "பக்கம் கிடைக்கவில்லை",
    body: "நீங்கள் தேடும் பக்கம் இல்லை, அல்லது அது நகர்த்தப்பட்டிருக்கலாம்.",
    home: "முகப்புப் பக்கத்திற்குச் செல்லவும்",
    instagram: "Instagram டவுன்லோடர்",
    audio: "ஆடியோ டவுன்லோடர்",
  },
  mr: {
    title: "पेज सापडले नाही",
    body: "तुम्ही शोधत असलेले पेज अस्तित्वात नाही, किंवा ते हलवले गेले असावे.",
    home: "होमपेजवर जा",
    instagram: "Instagram डाउनलोडर",
    audio: "ऑडिओ डाउनलोडर",
  },
  id: {
    title: "Halaman tidak ditemukan",
    body: "Halaman yang Anda cari tidak ada, atau mungkin telah dipindahkan.",
    home: "Buka halaman utama",
    instagram: "Pengunduh Instagram",
    audio: "Pengunduh audio",
  },
  fr: {
    title: "Page introuvable",
    body: "La page que vous cherchez n'existe pas, ou elle a peut-être été déplacée.",
    home: "Aller à la page d'accueil",
    instagram: "Téléchargeur Instagram",
    audio: "Téléchargeur audio",
  },
  ar: {
    title: "الصفحة غير موجودة",
    body: "الصفحة التي تبحث عنها غير موجودة، أو ربما تم نقلها.",
    home: "الذهاب إلى الصفحة الرئيسية",
    instagram: "أداة تحميل Instagram",
    audio: "أداة تحميل الصوت",
  },
};

function localeFromPath(pathname: string): Locale {
  const first = pathname.split("/")[1];
  return (locales as readonly string[]).includes(first) ? (first as Locale) : defaultLocale;
}

const ZINC_950 = "#09090b";
const ZINC_400 = "#a1a1aa";
const ZINC_100 = "#f4f4f5";
const ZINC_50 = "#fafafa";
const BRAND_400 = "#f2609a";
const BRAND_500 = "#e1306c";
const GLOW = "0 0 24px -4px rgba(225, 48, 108, 0.65)";

const buttonBase: CSSProperties = {
  borderRadius: "0.75rem",
  padding: "0.625rem 1.25rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  textDecoration: "none",
  outline: "none",
  display: "inline-block",
};

export default function NotFoundContent() {
  const pathname = usePathname() ?? "";
  const locale = localeFromPath(pathname);
  const t = COPY[locale];

  // There is no [locale]/layout.tsx wrapping this render (see the file docblock), so nothing else sets the
  // <html> tag's language and direction - do it once the real locale is known.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDir(locale);
  }, [locale]);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: ZINC_950, color: ZINC_100 }}>
      {/* A minimal, static header: the real Header needs context (install prompt, blog availability, the
          Telegram dict) that nothing provides on this bare page. Logo + name, linking home, is enough for a
          visitor to recognise the site and get back to it. */}
      <header style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <nav style={{ maxWidth: "64rem", margin: "0 auto", display: "flex", alignItems: "center", height: "3.5rem", padding: "0 1rem" }}>
          <a href={localePath(locale)} style={{ display: "flex", alignItems: "center", gap: "0.625rem", textDecoration: "none" }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="srf-404-logo-grad" x1="0" y1="0" x2="32" y2="32">
                  <stop offset="0" stopColor={BRAND_400} />
                  <stop offset="1" stopColor="#813cff" />
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="9" fill="url(#srf-404-logo-grad)" />
              <path d="M12 8.5v9.2a1 1 0 0 0 1.5.86l7.6-4.6a1 1 0 0 0 0-1.72l-7.6-4.6A1 1 0 0 0 12 8.5Z" fill="#fff" />
              <path d="M10 23h12" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: "1rem", fontWeight: 700, color: ZINC_50 }}>
              SaveReels<span style={{ color: BRAND_400 }}>Fast</span>
            </span>
          </a>
        </nav>
      </header>

      <main style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "4rem 1rem", textAlign: "center" }}>
        <p aria-hidden="true" style={{ fontSize: "4rem", fontWeight: 800, color: "rgba(225, 48, 108, 0.4)", margin: 0 }}>
          404
        </p>
        <h1 style={{ marginTop: "1rem", fontSize: "1.5rem", fontWeight: 800, color: ZINC_50 }}>{t.title}</h1>
        <p style={{ marginTop: "0.75rem", maxWidth: "24rem", fontSize: "0.875rem", lineHeight: 1.6, color: ZINC_400 }}>{t.body}</p>

        <div style={{ marginTop: "2rem", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "0.75rem" }}>
          <a href={localePath(locale)} style={{ ...buttonBase, backgroundColor: BRAND_500, color: "#fff", boxShadow: GLOW }}>
            {t.home}
          </a>
          <a
            href={localePath(locale, landingPath("instagram"))}
            style={{ ...buttonBase, border: "1px solid rgba(255,255,255,0.15)", backgroundColor: "rgba(255,255,255,0.05)", color: ZINC_100 }}
          >
            {t.instagram}
          </a>
          <a
            href={localePath(locale, "/audio-downloader")}
            style={{ ...buttonBase, border: "1px solid rgba(255,255,255,0.15)", backgroundColor: "rgba(255,255,255,0.05)", color: ZINC_100 }}
          >
            {t.audio}
          </a>
        </div>
      </main>
    </div>
  );
}
