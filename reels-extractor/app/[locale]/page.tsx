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
      <div className="w-full max-w-2xl">
        <ExtractorClient
          heroDict={dict.hero}
          platformsDict={dict.platforms}
          previewDict={dict.preview}
        />
      </div>

      <AdSlot label={dict.ad.label} size="leaderboard" />

      <SeoContent heading={dict.seo.heading} paragraphs={dict.seo.paragraphs} />

      <AdSlot label={dict.ad.label} size="rectangle" />

      <FaqAccordion heading={dict.faq.heading} items={dict.faq.items} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </main>
  );
}
