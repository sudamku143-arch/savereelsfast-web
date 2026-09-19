import { isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import ExtractorClient from "./components/ExtractorClient";
import SeoContent from "./components/SeoContent";
import FaqAccordion from "./components/FaqAccordion";
import AdSlot from "./components/AdSlot";

export default async function LocalePage({
  params,
}: {
  params: { locale: string };
}) {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: dict.faq.items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <main className="flex flex-col items-center px-4 pb-16 pt-12 sm:pt-20">
      <span className="mb-4 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-300 ring-1 ring-brand-500/30">
        {dict.hero.badge}
      </span>
      <h1 className="max-w-2xl text-center text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-5xl">
        {dict.hero.title}
      </h1>
      <p className="mt-4 max-w-xl text-center text-sm text-zinc-400 sm:text-base">
        {dict.hero.subtitle}
      </p>

      <div className="mt-8 w-full max-w-xl">
        <ExtractorClient heroDict={dict.hero} previewDict={dict.preview} />
      </div>

      <AdSlot label={dict.ad.label} size="leaderboard" />

      <SeoContent heading={dict.seo.heading} paragraphs={dict.seo.paragraphs} />

      <AdSlot label={dict.ad.label} size="rectangle" />

      <FaqAccordion heading={dict.faq.heading} items={dict.faq.items} />

      <footer className="mt-16 max-w-2xl text-center text-xs text-zinc-500">
        {dict.footer.disclaimer}
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </main>
  );
}
