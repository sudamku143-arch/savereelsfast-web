import type { Metadata } from "next";
import { locales, isLocale, defaultLocale, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { legalMetadata } from "@/lib/legal-metadata";
import { CONTACT_EMAIL } from "@/lib/site";

type Props = { params: { locale: string } };

function resolveLocale(value: string): Locale {
  return isLocale(value) ? value : defaultLocale;
}

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolveLocale(params.locale);
  const { legal } = await getDictionary(locale);
  return legalMetadata(
    locale,
    "/contact",
    legal.contact.title,
    legal.contact.description
  );
}

export default async function ContactPage({ params }: Props) {
  const { legal } = await getDictionary(resolveLocale(params.locale));
  const { contact } = legal;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-8 pt-12 sm:pt-16">
      <h1 className="text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">
        {contact.title}
      </h1>
      <p className="mt-6 text-sm leading-relaxed text-zinc-400 sm:text-base">
        {contact.intro}
      </p>

      <div className="glass mt-8 rounded-2xl p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {contact.emailLabel}
        </p>
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="mt-1 inline-block break-all rounded text-lg font-semibold text-brand-300 outline-none hover:text-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {CONTACT_EMAIL}
        </a>
        <p className="mt-3 text-xs text-zinc-500">{contact.responseTime}</p>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-bold text-zinc-100">{contact.topicsHeading}</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-zinc-400 sm:text-base">
          {contact.topics.map((topic) => (
            <li key={topic}>{topic}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
