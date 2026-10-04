import type { Metadata } from "next";
import { isLocale, defaultLocale, NEW_PAGE_LOCALES, type Locale } from "@/lib/i18n-config";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/get-dictionary";
import { GIF_MAKER_PATH } from "@/lib/landing";
import { pageMetadata, platformOgImage } from "@/lib/legal-metadata";
import ToolLandingPage from "../components/ToolLandingPage";

type Props = { params: { locale: string } };

function resolveLocale(value: string): Locale {
  return isLocale(value) ? value : defaultLocale;
}

// Not written in Tamil or Telugu (see NEW_PAGE_LOCALES): those addresses don't exist.
export function generateStaticParams() {
  return NEW_PAGE_LOCALES.map((locale) => ({ locale }));
}
export const dynamicParams = false;

// Pure static HTML, served from Vercel's Edge Network (see the home page).
export const dynamic = "force-static";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolveLocale(params.locale);
  const { gifMaker } = await getDictionary(locale);
  if (!gifMaker) return {};
  return pageMetadata(locale, GIF_MAKER_PATH, gifMaker.metaTitle, gifMaker.metaDescription, platformOgImage("instagram", locale), NEW_PAGE_LOCALES);
}

export default async function Page({ params }: Props) {
  const locale = resolveLocale(params.locale);
  const dict = await getDictionary(locale);
  if (!NEW_PAGE_LOCALES.includes(locale) || !dict.gifMaker) notFound();
  return (
    <ToolLandingPage
      locale={locale}
      dict={dict}
      content={dict.gifMaker}
      path={GIF_MAKER_PATH}
      initialPlatform="instagram"
      cardFocus="gif"
    />
  );
}
