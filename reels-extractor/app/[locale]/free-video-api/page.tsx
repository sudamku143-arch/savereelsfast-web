import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, defaultLocale, localePath, type Locale } from "@/lib/i18n-config";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { getDictionary } from "@/lib/get-dictionary";
import { pageMetadata } from "@/lib/legal-metadata";
import { API_DOCS, API_DOCS_PATH, API_ENDPOINT } from "@/lib/api-docs";
import FaqAccordion from "../components/FaqAccordion";

type Props = { params: { locale: string } };

/** Developer documentation is in English only. */
const DOCS_LOCALES: readonly Locale[] = ["en"];

export function generateStaticParams() {
  return DOCS_LOCALES.map((locale) => ({ locale }));
}
export const dynamicParams = false;
export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata("en", API_DOCS_PATH, API_DOCS.metaTitle, API_DOCS.metaDescription, undefined, DOCS_LOCALES);
}

/** JSON in a <script> must not be able to close the tag. */
function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const CODE =
  "overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-4 text-xs leading-relaxed text-zinc-200 sm:text-sm";

/** The free public API's documentation: quickstart, platforms, limits, response format, errors, code samples. */
export default async function FreeVideoApiPage({ params }: Props) {
  const locale: Locale = isLocale(params.locale) ? params.locale : defaultLocale;
  if (!DOCS_LOCALES.includes(locale)) notFound();
  const dict = await getDictionary(locale);
  const pageUrl = `${SITE_URL}${localePath(locale, API_DOCS_PATH)}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebAPI",
        "@id": `${pageUrl}#api`,
        name: `${API_DOCS.h1} — ${SITE_NAME}`,
        description: API_DOCS.metaDescription,
        url: pageUrl,
        documentation: pageUrl,
        termsOfService: `${SITE_URL}${localePath(locale, "/terms-of-service")}`,
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
        provider: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        inLanguage: locale,
        mainEntity: API_DOCS.faq.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: dict.landing.common.breadcrumbHome, item: `${SITE_URL}${localePath(locale)}` },
          { "@type": "ListItem", position: 2, name: API_DOCS.breadcrumb },
        ],
      },
    ],
  };

  return (
    <main className="flex flex-col items-center px-4 pb-16 pt-8 sm:pt-12">
      <nav aria-label="Breadcrumb" className="mb-6 w-full max-w-3xl">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <li>
            <a href={localePath(locale)} className="rounded outline-none hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-brand-500">
              {dict.landing.common.breadcrumbHome}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-zinc-300">
            {API_DOCS.breadcrumb}
          </li>
        </ol>
      </nav>

      <header className="w-full max-w-3xl">
        <h1 className="font-display text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">{API_DOCS.h1}</h1>
        <p className="mt-4 text-base leading-relaxed text-zinc-300 sm:text-lg">{API_DOCS.lead}</p>
        <pre className={`${CODE} mt-6`}>
          <code>{`GET ${API_ENDPOINT}?url=<link to a public post>`}</code>
        </pre>
      </header>

      {API_DOCS.sections.map((section) => (
        <section key={section.heading} className="mt-14 w-full max-w-3xl">
          <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{section.heading}</h2>
          <div className="space-y-3 text-sm leading-relaxed text-zinc-300 sm:text-base">
            {section.paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </section>
      ))}

      <section className="mt-14 w-full max-w-3xl">
        <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{API_DOCS.responseHeading}</h2>
        <pre className={CODE}>
          <code>{API_DOCS.successExample}</code>
        </pre>
        <pre className={`${CODE} mt-3`}>
          <code>{API_DOCS.errorExample}</code>
        </pre>
      </section>

      <section className="mt-14 w-full max-w-3xl">
        <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{API_DOCS.errorsHeading}</h2>
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm text-zinc-300">
            <thead className="bg-white/5 text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="px-3 py-2">HTTP</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {API_DOCS.errors.map((e) => (
                <tr key={e.code} className="border-t border-white/10 align-top">
                  <td className="px-3 py-2 tabular-nums">{e.status}</td>
                  <td className="px-3 py-2 font-mono text-xs text-brand-300">{e.code}</td>
                  <td className="px-3 py-2">{e.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-14 w-full max-w-3xl">
        <h2 className="mb-4 font-display text-2xl font-bold tracking-tight text-zinc-50">{API_DOCS.examplesHeading}</h2>
        {API_DOCS.examples.map((example) => (
          <div key={example.language} className="mt-4">
            <h3 className="mb-2 text-sm font-semibold text-zinc-200">{example.language}</h3>
            <pre className={CODE}>
              <code>{example.code}</code>
            </pre>
          </div>
        ))}
      </section>

      <FaqAccordion heading={API_DOCS.faqHeading} items={[...API_DOCS.faq]} />

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
