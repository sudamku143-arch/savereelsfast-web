import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { locales, isLocale, defaultLocale, localePath, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { pageMetadata } from "@/lib/legal-metadata";
import {
  LANDING_PLATFORMS,
  PLATFORM_SLUGS,
  fillTemplate,
  landingPath,
  platformFromSlug,
} from "@/lib/landing";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import ExtractorClient from "../../components/ExtractorClient";
import FaqAccordion from "../../components/FaqAccordion";
import AdSlot from "../../components/AdSlot";
import PlatformLinks from "../../components/PlatformLinks";

type Props = { params: { locale: string; platform: string } };

// Only the nine known platforms exist; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return locales.flatMap((locale) =>
    LANDING_PLATFORMS.map((id) => ({ locale, platform: PLATFORM_SLUGS[id] }))
  );
}

function resolve(params: Props["params"]): { locale: Locale; id: PlatformId } {
  const id = platformFromSlug(params.platform);
  if (!id) notFound();
  return { locale: isLocale(params.locale) ? params.locale : defaultLocale, id };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, id } = resolve(params);
  const { landing } = await getDictionary(locale);
  const content = landing.platforms[id];
  return pageMetadata(locale, landingPath(id), content.metaTitle, content.metaDescription);
}

/** JSON in a <script> must not be able to close the tag. */
function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function PlatformLandingPage({ params }: Props) {
  const { locale, id } = resolve(params);
  const dict = await getDictionary(locale);
  const { common } = dict.landing;
  const content = dict.landing.platforms[id];

  const platformName = dict.platforms[id].name;
  const names = Object.fromEntries(
    PLATFORM_IDS.map((pid) => [pid, dict.platforms[pid].name])
  ) as Record<PlatformId, string>;
  const vars = { platform: platformName, noun: content.noun, copyHint: content.copyHint };

  const pageUrl = `${SITE_URL}${localePath(locale, landingPath(id))}`;
  const homeUrl = `${SITE_URL}${localePath(locale)}`;

  // Platform-specific questions first (they carry the search intent), then the shared basics.
  const faqItems = [
    ...content.faq,
    ...common.sharedFaq.map((item) => ({
      q: fillTemplate(item.q, vars),
      a: fillTemplate(item.a, vars),
    })),
  ];

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": `${pageUrl}#app`,
        name: `${platformName} — ${SITE_NAME}`,
        url: pageUrl,
        description: fillTemplate(common.structuredDescription, vars),
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
        "@id": `${pageUrl}#faq`,
        inLanguage: locale,
        mainEntity: faqItems.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: common.breadcrumbHome, item: homeUrl },
          { "@type": "ListItem", position: 2, name: content.h1, item: pageUrl },
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
              {common.breadcrumbHome}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>{common.downloaders}</li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-zinc-300">
            {platformName}
          </li>
        </ol>
      </nav>

      <div className="w-full max-w-2xl">
        <ExtractorClient
          heroDict={dict.hero}
          platformsDict={dict.platforms}
          previewDict={dict.preview}
          errorsDict={dict.errors}
          downloadDict={dict.download}
          initialPlatform={id}
          fixedHeading={{ title: content.h1, subtitle: content.lead }}
        />
      </div>

      <AdSlot label={dict.ad.label} size="leaderboard" />

      <section className="mt-16 w-full max-w-2xl">
        <h2 className="mb-4 text-xl font-bold text-zinc-50">
          {fillTemplate(common.howToHeading, vars)}
        </h2>
        <ol className="space-y-3">
          {common.steps.map((step, index) => (
            <li
              key={index}
              className="glass flex gap-3 rounded-2xl p-4 text-sm leading-relaxed text-zinc-300 sm:text-base"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-sm font-bold text-brand-300">
                {index + 1}
              </span>
              <span>{fillTemplate(step, vars)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16 w-full max-w-2xl">
        <h2 className="mb-4 text-xl font-bold text-zinc-50">
          {fillTemplate(common.featuresHeading, vars)}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {common.features.map((feature) => (
            <li key={feature.title} className="glass rounded-2xl p-4">
              <h3 className="text-sm font-semibold text-zinc-100">{feature.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                {fillTemplate(feature.text, vars)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <FaqAccordion heading={fillTemplate(common.faqHeading, vars)} items={faqItems} />

      <PlatformLinks
        locale={locale}
        names={names}
        heading={common.otherHeading}
        lead={common.otherLead}
        currentId={id}
        currentLabel={common.here}
      />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }}
      />
    </main>
  );
}
