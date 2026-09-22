import type { Metadata } from "next";
import { locales, isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { legalMetadata } from "@/lib/legal-metadata";
import LegalDoc from "../components/LegalDoc";

type Props = { params: { locale: string } };

function resolveLocale(value: string): Locale {
  return isLocale(value) ? value : defaultLocale;
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolveLocale(params.locale);
  const { legal } = await getDictionary(locale);
  return legalMetadata(
    locale,
    "/privacy-policy",
    legal.privacy.metaTitle, // distinct from the on-page H1 (legal.privacy.title): keeps the two from being identical
    legal.privacy.description
  );
}

export default async function PrivacyPolicyPage({ params }: Props) {
  const { legal } = await getDictionary(resolveLocale(params.locale));
  return (
    <LegalDoc
      title={legal.privacy.title}
      updated={legal.privacy.updated}
      sections={legal.privacy.sections}
    />
  );
}
