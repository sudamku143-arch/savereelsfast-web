import type { Metadata } from "next";
import { isLocale, defaultLocale, localePath, locales, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { getDictionary } from "@/lib/get-dictionary";
import { landingPath } from "@/lib/landing";
import { pageMetadata } from "@/lib/legal-metadata";
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
  const dict = await getDictionary(locale);
  const { audioDownloader } = dict;
  return pageMetadata(locale, "/audio-downloader", audioDownloader.metaTitle, audioDownloader.metaDescription);
}

/** JSON in a <script> must not be able to close the tag. */
function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function AudioDownloaderPage({ params }: Props) {
  const locale = resolveLocale(params.locale);
  const dict = await getDictionary(locale);
  const { audioDownloader } = dict;

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, dict.platforms[id].name])
  ) as Record<PlatformId, string>;

  const pageUrl = `${SITE_URL}${localePath(locale, "/audio-downloader")}`;
  const homeUrl = `${SITE_URL}${localePath(locale)}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${pageUrl}#app`,
        name: `${audioDownloader.h1} — ${SITE_NAME}`,
        alternateName: audioDownloader.metaTitle,
        url: pageUrl,
        description: audioDownloader.metaDescription,
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
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        inLanguage: locale,
        mainEntity: audioDownloader.faq.map((item) => ({
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
          { "@type": "ListItem", position: 2, name: audioDownloader.breadcrumb },
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
            {audioDownloader.breadcrumb}
          </li>
        </ol>
      </nav>

      <div className="w-full max-w-2xl">
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
          heroHeading={audioDownloader.h1}
          heroLead={audioDownloader.lead}
          audioOnly
        />
      </div>

      {/* Genuine, distinct content per section - not templated across platforms like the tool pages, since
          audio extraction works the same way regardless of platform. */}
      {audioDownloader.sections.map((section) => (
        <section key={section.heading} className="mt-16 w-full max-w-2xl">
          <h2 className="mb-4 text-xl font-bold text-zinc-50">{section.heading}</h2>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-300 sm:text-base">
            {section.paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}

      <FaqAccordion heading={audioDownloader.faqHeading} items={audioDownloader.faq} />

      <PlatformLinks
        locale={locale}
        names={names}
        heading={dict.landing.common.otherHeading}
        lead={dict.landing.common.otherLead}
      />

      {/* Slot 3: sticky bottom banner (tool pages only, never the legal pages). */}
      <AdBanner variant="sticky" dict={dict.ad} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
