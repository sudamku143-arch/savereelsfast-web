import type { Metadata } from "next";
import { locales, isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { legalMetadata } from "@/lib/legal-metadata";
import LegalDoc from "../components/LegalDoc";
import { DMCA_EMAIL } from "@/lib/site";

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
    "/dmca",
    legal.dmca.metaTitle, // distinct from the on-page H1 (legal.dmca.title): keeps the two from being identical
    legal.dmca.description
  );
}

export default async function DmcaPage({ params }: Props) {
  const { legal } = await getDictionary(resolveLocale(params.locale));
  return (
    <LegalDoc
      title={legal.dmca.title}
      updated={legal.dmca.updated}
      intro={legal.dmca.intro}
      sections={legal.dmca.sections}
    >
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-bold text-zinc-100">{legal.dmca.agent.heading}</h2>
        <div className="glass rounded-2xl p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            {legal.dmca.agent.label}
          </p>
          <a
            href={`mailto:${DMCA_EMAIL}?subject=${encodeURIComponent(legal.dmca.agent.subject)}`}
            className="mt-1 inline-block break-all rounded text-lg font-semibold text-brand-300 outline-none hover:text-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {DMCA_EMAIL}
          </a>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">{legal.dmca.agent.note}</p>
        </div>
      </section>
    </LegalDoc>
  );
}
