import { localePath, type Locale } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import type { PlatformId } from "@/lib/platforms";
import { CONTACT_EMAIL, SITE_NAME } from "@/lib/site";
import CookieSettingsButton from "./CookieSettingsButton";

type Dict = {
  disclaimer: string;
  rights: string;
  columns: { tools: string; legal: string; company: string };
  links: {
    privacy: string;
    terms: string;
    dmca: string;
    disclaimer: string;
    contact: string;
    report: string;
    blog: string;
  };
  reportSubject: string;
};

function Column({
  heading,
  links,
  cookieLabel,
}: {
  heading: string;
  links: { href: string; label: string }[];
  /** When set, a "Cookie settings" button closes the list (analytics is only configured on some deployments). */
  cookieLabel?: string;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-zinc-200">{heading}</h2>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className="rounded text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {link.label}
            </a>
          </li>
        ))}
        {cookieLabel ? (
          <li>
            <CookieSettingsButton label={cookieLabel} />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export default function Footer({
  locale,
  dict,
  platformNames,
  hasBlog = false,
  cookieLabel,
}: {
  locale: Locale;
  dict: Dict;
  platformNames: Record<PlatformId, string>;
  /** Only languages that have posts link to a blog (the others would 404). */
  hasBlog?: boolean;
  /** Label of the footer's "Cookie settings" button; leave out when analytics is not configured. */
  cookieLabel?: string;
}) {
  const tools = LANDING_PLATFORMS.map((id) => ({
    href: localePath(locale, landingPath(id)),
    label: platformNames[id],
  }));

  const legal = [
    { href: localePath(locale, "/privacy-policy"), label: dict.links.privacy },
    { href: localePath(locale, "/terms-of-service"), label: dict.links.terms },
    { href: localePath(locale, "/dmca"), label: dict.links.dmca },
    { href: localePath(locale, "/disclaimer"), label: dict.links.disclaimer },
  ];

  const company = [
    ...(hasBlog ? [{ href: localePath(locale, "/blog"), label: dict.links.blog }] : []),
    { href: localePath(locale, "/contact"), label: dict.links.contact },
    {
      href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(dict.reportSubject)}`,
      label: dict.links.report,
    },
  ];

  return (
    <footer className="mt-8 border-t border-white/10 px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3"
        >
          <div className="col-span-2 sm:col-span-1">
            <h2 className="text-sm font-semibold text-zinc-200">{dict.columns.tools}</h2>
            {/* Ten links would be a long single column, so they flow into two on small screens. */}
            <ul className="mt-3 columns-2 gap-x-6 space-y-2 text-sm sm:columns-1">
              {tools.map((link) => (
                <li key={link.href} className="break-inside-avoid">
                  <a
                    href={link.href}
                    className="rounded text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <Column heading={dict.columns.legal} links={legal} />
          <Column heading={dict.columns.company} links={company} cookieLabel={cookieLabel} />
        </nav>

        <div className="mt-10 border-t border-white/5 pt-6 text-center">
          <p className="mx-auto max-w-2xl text-xs leading-relaxed text-zinc-500">{dict.disclaimer}</p>
          <p className="mt-3 text-xs text-zinc-600">
            © {new Date().getFullYear()} {SITE_NAME}. {dict.rights}
          </p>
        </div>
      </div>
    </footer>
  );
}
