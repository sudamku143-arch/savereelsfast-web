import type { Metadata } from "next";
import { isLocale, defaultLocale, locales, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { CAPTION_COPIER_PATH } from "@/lib/landing";
import { pageMetadata, platformOgImage } from "@/lib/legal-metadata";
import ToolLandingPage from "../components/ToolLandingPage";

type Props = { params: { locale: string } };

function resolveLocale(value: string): Locale {
  return isLocale(value) ? value : defaultLocale;
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// Pure static HTML, served from Vercel's Edge Network (see the home page).
export const dynamic = "force-static";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolveLocale(params.locale);
  const { captionCopier } = await getDictionary(locale);
  return pageMetadata(locale, CAPTION_COPIER_PATH, captionCopier.metaTitle, captionCopier.metaDescription, platformOgImage("instagram", locale));
}

export default async function Page({ params }: Props) {
  const locale = resolveLocale(params.locale);
  const dict = await getDictionary(locale);
  return (
    <ToolLandingPage
      locale={locale}
      dict={dict}
      content={dict.captionCopier}
      path={CAPTION_COPIER_PATH}
      initialPlatform="instagram"
      cardFocus="caption"
    />
  );
}
