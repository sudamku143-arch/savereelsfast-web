import type { Metadata } from "next";
import { toolPageLinks } from "@/lib/landing";
import { isLocale, defaultLocale, localePath, locales, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { getDictionary } from "@/lib/get-dictionary";
import { landingPath, PHOTO_DOWNLOADER_PATH } from "@/lib/landing";
import { pageMetadata, platformOgImage } from "@/lib/legal-metadata";
import { buildPlatformInfo } from "@/lib/platform-info";
import ExtractorClient from "../components/ExtractorClient";
import FaqAccordion from "../components/FaqAccordion";
import AdBanner from "../components/AdBanner";
import PlatformLinks from "../components/PlatformLinks";

type Props = { params: { locale: string } };

function resolveLocale(value: string): Locale {
  return isLocale(value) ? value : defaultLocale;
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// Pure static HTML, served from Vercel's Edge Network. See the home page for why this is declared
// explicitly rather than left implicit.
export const dynamic = "force-static";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolveLocale(params.locale);
  const { photoDownloader } = await getDictionary(locale);
  return pageMetadata(
    locale,
    PHOTO_DOWNLOADER_PATH,
    photoDownloader.metaTitle,
    photoDownloader.metaDescription,
    platformOgImage("instagram", locale)
  );
}

/** JSON in a <script> must not be able to close the tag. */
function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Instagram photos and carousels (photo, video or mixed slides). The tool is the same one as everywhere else,
 * opened on the Instagram tab; what this page adds is the guide for people who search for photos and
 * carousels rather than Reels.
 */
export default async function PhotoDownloaderPage({ params }: Props) {
  const locale = resolveLocale(params.locale);
  const dict = await getDictionary(locale);
  const { photoDownloader } = dict;

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, dict.platforms[id].name])
  ) as Record<PlatformId, string>;

  const pageUrl = `${SITE_URL}${localePath(locale, PHOTO_DOWNLOADER_PATH)}`;
  const homeUrl = `${SITE_URL}${localePath(locale)}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${pageUrl}#app`,
        name: `${photoDownloader.h1} — ${SITE_NAME}`,
        alternateName: photoDownloader.metaTitle,
        url: pageUrl,
        description: photoDownloader.metaDescription,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "All",
        browserRequirements: "Requires JavaScript",
        inLanguage: locale,
        isAccessibleForFree: true,
        image: `${SITE_URL}/icons/icon-512.png`,
        offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
      },
      {
        "@type": "HowTo",
        "@id": `${pageUrl}#howto`,
        inLanguage: locale,
        name: photoDownloader.howToHeading,
        step: photoDownloader.howToSteps.map((text, index) => ({ "@type": "HowToStep", position: index + 1, text })),
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        inLanguage: locale,
        mainEntity: photoDownloader.faq.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: dict.landing.common.breadcrumbHome, item: homeUrl },
          // The last item is the current page: Google's breadcrumb guidelines say to omit its URL.
          { "@type": "ListItem", position: 2, name: photoDownloader.breadcrumb },
        ],
      },
    ],
  };

  return (
    <main className="flex flex-col items-center px-4 pb-16 pt-8 sm:pt-12">
      <nav aria-label="Breadcrumb" className="mb-6 w-full max-w-2xl">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <li>
            <a
              href={localePath(locale)}
              className="rounded outline-none hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {dict.landing.common.breadcrumbHome}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-zinc-300">
            {photoDownloader.breadcrumb}
          </li>
        </ol>
      </nav>

      <div className="w-full max-w-5xl">
        <ExtractorClient
          locale={locale}
          heroDict={dict.hero}
          platformsDict={dict.platforms}
          previewDict={dict.preview}
          errorsDict={dict.errors}
          downloadDict={dict.download}
          adDict={dict.ad}
          modeSwitcherDict={dict.modeSwitcher}
          platformInfo={buildPlatformInfo(dict.landing.platforms, (pid) => localePath(locale, landingPath(pid)))}
          initialPlatform="instagram"
          heroHeading={photoDownloader.h1}
          heroLead={photoDownloader.lead}
          heroPlaceholder={photoDownloader.placeholder}
          heroHint={photoDownloader.copyHint}
        />
      </div>

      {/* The same steps the HowTo data above describes. */}
      <section id="how-it-works" className="mt-16 w-full max-w-2xl scroll-mt-24">
        <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{photoDownloader.howToHeading}</h2>
        <ol className="space-y-3">
          {photoDownloader.howToSteps.map((step, index) => (
            <li
              key={index}
              className="glass flex gap-3 rounded-2xl p-4 text-sm leading-relaxed text-zinc-300 sm:text-base"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-sm font-bold text-brand-300">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {photoDownloader.sections.map((section) => (
        <section key={section.heading} className="mt-16 w-full max-w-2xl">
          <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{section.heading}</h2>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-300 sm:text-base">
            {section.paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}

      <FaqAccordion heading={photoDownloader.faqHeading} items={photoDownloader.faq} />

      <PlatformLinks
        toolLinks={toolPageLinks(locale, dict)}
        locale={locale}
        names={names}
        heading={dict.landing.common.otherHeading}
        lead={dict.landing.common.otherLead}
        audioLabel={dict.audioDownloader.breadcrumb}
      />

      {/* Slot 3: sticky bottom banner (tool pages only, never the legal pages). */}
      <AdBanner variant="sticky" dict={dict.ad} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
