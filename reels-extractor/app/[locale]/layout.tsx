import type { Metadata } from "next";
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
      locale: locale === "en" ? "en_US" : locale === "es" ? "es_ES" : "pt_BR",
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

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <Header locale={locale} dict={dict.nav} />
        {children}
        <Footer locale={locale} dict={dict.footer} />
      </body>
    </html>
  );
}
