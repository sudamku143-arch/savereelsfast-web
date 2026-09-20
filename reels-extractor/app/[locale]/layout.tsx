import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../globals.css";
import {
  locales,
  isLocale,
  defaultLocale,
  localePath,
  type Locale,
} from "@/lib/i18n-config";
import { SITE_URL, SITE_NAME } from "@/lib/site";
import { getDictionary } from "@/lib/get-dictionary";
import Header from "./components/Header";
import Footer from "./components/Footer";
import InstallProvider from "./components/InstallProvider";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import IosInstallModal from "./components/IosInstallModal";

// Unknown locales 404 instead of rendering the default language.
export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

type Props = {
  children: ReactNode;
  params: { locale: string };
};

const OG_IMAGE = `${SITE_URL}/api/og`;
const OG_LOCALE: Record<Locale, string> = { en: "en_US", es: "es_ES", pt: "pt_BR", hi: "hi_IN" };

export const viewport: Viewport = {
  themeColor: "#09090b",
  colorScheme: "dark",
};

export async function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Promise<Metadata> {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);

  const languages: Record<string, string> = {};
  locales.forEach((l) => {
    languages[l] = `${SITE_URL}${localePath(l)}`;
  });

  const canonicalUrl = `${SITE_URL}${localePath(locale)}`;

  return {
    metadataBase: new URL(SITE_URL),
    applicationName: SITE_NAME,
    appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: "black-translucent" },
    icons: {
      icon: [
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: {
      canonical: canonicalUrl,
      languages,
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      url: canonicalUrl,
      siteName: SITE_NAME,
      locale: OG_LOCALE[locale],
      type: "website",
      images: [
        {
          url: OG_IMAGE,
          width: 1200,
          height: 630,
          alt: dict.meta.ogAlt,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: dict.meta.title,
      description: dict.meta.description,
      images: [OG_IMAGE],
    },
  };
}

export default async function LocaleLayout({ children, params }: Props) {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);
  const platformNames = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, dict.platforms[id].name])
  ) as Record<PlatformId, string>;

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <InstallProvider>
          <Header locale={locale} dict={dict.nav} />
          {children}
          <Footer locale={locale} dict={dict.footer} platformNames={platformNames} />
          <IosInstallModal dict={dict.pwa} />
        </InstallProvider>
      </body>
    </html>
  );
}
