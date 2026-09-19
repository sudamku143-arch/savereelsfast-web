import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../globals.css";
import { locales, isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import Header from "./components/Header";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

type Props = {
  children: ReactNode;
  params: { locale: string };
};

const SITE_URL = "https://savereelsfast.com";

export async function generateMetadata({
  params,
}: {
  params: { locale: string };
}): Promise<Metadata> {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);

  const languages: Record<string, string> = {};
  locales.forEach((l) => {
    languages[l] = l === defaultLocale ? `${SITE_URL}/` : `${SITE_URL}/${l}`;
  });

  const canonicalPath = locale === defaultLocale ? "" : `/${locale}`;

  return {
    title: dict.meta.title,
    description: dict.meta.description,
    alternates: {
      canonical: `${SITE_URL}${canonicalPath}`,
      languages,
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      url: `${SITE_URL}${canonicalPath}`,
      locale: locale === "en" ? "en_US" : locale === "es" ? "es_ES" : "pt_BR",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: dict.meta.title,
      description: dict.meta.description,
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
      </body>
    </html>
  );
}
