import { localePath, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { landingPath, toolPageLinks } from "@/lib/landing";
import { buildPlatformInfo } from "@/lib/platform-info";
import type { getDictionary } from "@/lib/get-dictionary";
import ExtractorClient from "./ExtractorClient";
import FaqAccordion from "./FaqAccordion";
import AdBanner from "./AdBanner";
import PlatformLinks from "./PlatformLinks";
import type { CardFocus } from "./PreviewCard";

type Dictionary = Awaited<ReturnType<typeof getDictionary>>;

/** What every feature page's text has: the hero, a 3-step how-to, guide sections and an FAQ. */
export type ToolPageContent = {
  metaTitle: string;
  metaDescription: string;
  h1: string;
  lead: string;
  placeholder: string;
  copyHint: string;
  breadcrumb: string;
  footerLabel: string;
  howToHeading: string;
  howToSteps: string[];
  sections: { heading: string; paragraphs: string[] }[];
  faqHeading: string;
  faq: { q: string; a: string }[];
};

/** JSON in a <script> must not be able to close the tag. */
function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * A feature page (caption copier, thumbnail downloader...): the same tool as everywhere else with the page's
 * own tool first on the result card, then a real guide below it (how-to, sections, FAQ), so the page stands
 * on its own for the people who search for that one thing.
 */
export default function ToolLandingPage({
  locale,
  dict,
  content,
  path,
  initialPlatform,
  cardFocus,
}: {
  locale: Locale;
  dict: Dictionary;
  content: ToolPageContent;
  path: string;
  initialPlatform: PlatformId;
  cardFocus?: CardFocus;
}) {
  const names = Object.fromEntries(PLATFORM_IDS.map((id) => [id, dict.platforms[id].name])) as Record<PlatformId, string>;
  const pageUrl = `${SITE_URL}${localePath(locale, path)}`;
  const homeUrl = `${SITE_URL}${localePath(locale)}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        "@id": `${pageUrl}#app`,
        name: `${content.h1} — ${SITE_NAME}`,
        alternateName: content.metaTitle,
        url: pageUrl,
        description: content.metaDescription,
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
        name: content.howToHeading,
        step: content.howToSteps.map((text, index) => ({ "@type": "HowToStep", position: index + 1, text })),
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        inLanguage: locale,
        mainEntity: content.faq.map((item) => ({
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
          { "@type": "ListItem", position: 2, name: content.breadcrumb },
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
            {content.breadcrumb}
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
          initialPlatform={initialPlatform}
          heroHeading={content.h1}
          heroLead={content.lead}
          heroPlaceholder={content.placeholder}
          heroHint={content.copyHint}
          cardFocus={cardFocus}
        />
      </div>

      {/* The same steps the HowTo data above describes. */}
      <section id="how-it-works" className="mt-16 w-full max-w-2xl scroll-mt-24">
        <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{content.howToHeading}</h2>
        <ol className="space-y-3">
          {content.howToSteps.map((step, index) => (
            <li key={index} className="glass flex gap-3 rounded-2xl p-4 text-sm leading-relaxed text-zinc-300 sm:text-base">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-sm font-bold text-brand-300">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {content.sections.map((section) => (
        <section key={section.heading} className="mt-16 w-full max-w-2xl">
          <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{section.heading}</h2>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-300 sm:text-base">
            {section.paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}

      <FaqAccordion heading={content.faqHeading} items={content.faq} />

      <PlatformLinks
        locale={locale}
        names={names}
        heading={dict.landing.common.otherHeading}
        lead={dict.landing.common.otherLead}
        audioLabel={dict.audioDownloader.breadcrumb}
        photoLabel={dict.photoDownloader.breadcrumb}
        toolLinks={toolPageLinks(locale, dict).filter((tool) => tool.path !== path)}
      />

      {/* Slot 3: sticky bottom banner (tool pages only, never the legal pages). */}
      <AdBanner variant="sticky" dict={dict.ad} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
