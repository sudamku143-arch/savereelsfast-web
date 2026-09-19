import { isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { getDictionary } from "@/lib/get-dictionary";
import ExtractorClient from "./components/ExtractorClient";
import SeoContent from "./components/SeoContent";
import FaqAccordion from "./components/FaqAccordion";
import AdSlot from "./components/AdSlot";
import InstallBanner from "./components/InstallBanner";
import PlatformLinks from "./components/PlatformLinks";

export default async function LocalePage({
  params,
}: {
  params: { locale: string };
}) {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = await getDictionary(locale);

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, dict.platforms[id].name])
  ) as Record<PlatformId, string>;

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
          errorsDict={dict.errors}
          downloadDict={dict.download}
        />
      </div>

      <InstallBanner dict={dict.pwa} />

      <AdSlot label={dict.ad.label} size="leaderboard" />

      <SeoContent heading={dict.seo.heading} paragraphs={dict.seo.paragraphs} />

      <AdSlot label={dict.ad.label} size="rectangle" />

      <PlatformLinks
        locale={locale}
        names={names}
        heading={dict.landing.common.otherHeading}
        lead={dict.landing.common.otherLead}
      />

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
