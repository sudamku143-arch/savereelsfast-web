import { isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import ExtractorClient from "./components/ExtractorClient";
import SeoContent from "./components/SeoContent";
import FaqAccordion from "./components/FaqAccordion";

export default async function LocalePage({
  params,
}: {
  params: { locale: string };
}) {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-16 sm:py-24">
      <span className="mb-4 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-600">
        {dict.hero.badge}
      </span>
      <h1 className="max-w-2xl text-center text-3xl font-extrabold tracking-tight text-zinc-900 sm:text-5xl">
        {dict.hero.title}
      </h1>
      <p className="mt-4 max-w-xl text-center text-sm text-zinc-500 sm:text-base">
        {dict.hero.subtitle}
      </p>

      <div className="mt-8 w-full max-w-xl">
        <ExtractorClient heroDict={dict.hero} previewDict={dict.preview} />
      </div>

      <SeoContent heading={dict.seo.heading} paragraphs={dict.seo.paragraphs} />
      <FaqAccordion heading={dict.faq.heading} items={dict.faq.items} />

      <footer className="mt-16 max-w-2xl text-center text-xs text-zinc-400">
        {dict.footer.disclaimer}
      </footer>
    </main>
  );
}
