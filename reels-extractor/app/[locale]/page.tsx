import { isLocale, defaultLocale, localePath, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { getDictionary } from "@/lib/get-dictionary";
import { landingPath } from "@/lib/landing";
import { buildPlatformInfo } from "@/lib/platform-info";
import ExtractorClient from "./components/ExtractorClient";
import SeoContent from "./components/SeoContent";
import FeatureGrid from "./components/FeatureGrid";
import FaqAccordion from "./components/FaqAccordion";
import AdBanner from "./components/AdBanner";
import InstallBanner from "./components/InstallBanner";
import PlatformLinks from "./components/PlatformLinks";
import LatestPosts from "./components/LatestPosts";

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

  const homeUrl = `${SITE_URL}${localePath(locale)}`;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${homeUrl}#app`,
        name: SITE_NAME,
        alternateName: dict.meta.title, // the localized page title, as shown in search results
        url: homeUrl,
        description: dict.meta.description,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Any (web browser)",
        browserRequirements: "Requires JavaScript",
        inLanguage: locale,
        isAccessibleForFree: true,
        image: `${SITE_URL}/icons/icon-512.png`,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
      },
      {
        "@type": "FAQPage",
        "@id": `${homeUrl}#faq`,
        inLanguage: locale,
        mainEntity: dict.faq.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };

  return (
    <main className="flex flex-col items-center px-4 pb-16 pt-12 sm:pt-20">
      <div className="w-full max-w-2xl">
        <ExtractorClient
          locale={locale}
          heroDict={dict.hero}
          platformsDict={dict.platforms}
          previewDict={dict.preview}
          errorsDict={dict.errors}
          downloadDict={dict.download}
          adDict={dict.ad}
          platformInfo={buildPlatformInfo(dict.landing.platforms, (pid) => localePath(locale, landingPath(pid)))}
        />
      </div>

      <InstallBanner dict={dict.pwa} />

      <FeatureGrid heading={dict.seo.featuresHeading} features={dict.seo.features} />

      <SeoContent heading={dict.seo.heading} paragraphs={dict.seo.paragraphs} />

      <PlatformLinks
        locale={locale}
        names={names}
        heading={dict.landing.common.otherHeading}
        lead={dict.landing.common.otherLead}
      />

      <FaqAccordion heading={dict.faq.heading} items={dict.faq.items} />

      {/* Newest blog posts (nothing in a language that has no blog). */}
      <LatestPosts locale={locale} dict={dict.blog} />

      {/* Slot 3: sticky bottom banner (tool pages only, never the legal pages). */}
      <AdBanner variant="sticky" dict={dict.ad} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
    </main>
  );
}
