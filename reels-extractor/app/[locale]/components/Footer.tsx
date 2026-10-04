import { localePath, type Locale } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS, PHOTO_DOWNLOADER_PATH } from "@/lib/landing";
import type { PlatformId } from "@/lib/platforms";
import { CONTACT_EMAIL, SITE_NAME, TELEGRAM_BOT_URL } from "@/lib/site";
import CookieSettingsButton from "./CookieSettingsButton";
import TelegramIcon from "./TelegramIcon";
import type { TelegramDict } from "./TelegramFab";

type Dict = {
  disclaimer: string;
  rights: string;
  trust: string;
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
              className="rounded text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-400"
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
  telegram,
  audioDownloaderLabel,
  photoDownloaderLabel,
  toolLinks = [],
}: {
  locale: Locale;
  dict: Dict;
  platformNames: Record<PlatformId, string>;
  /** Only languages that have posts link to a blog (the others would 404). */
  hasBlog?: boolean;
  /** Label of the footer's "Cookie settings" button; leave out when analytics is not configured. */
  cookieLabel?: string;
  telegram: TelegramDict;
  /** Short label for the audio-downloader link, alongside the platform tools. */
  audioDownloaderLabel: string;
  /** Short label for the Instagram photo & carousel downloader link. */
  photoDownloaderLabel: string;
  /** The feature pages (caption copier, thumbnail downloader...). */
  toolLinks?: { path: string; label: string }[];
}) {
  const tools = [
    ...LANDING_PLATFORMS.map((id) => ({
      href: localePath(locale, landingPath(id)),
      label: platformNames[id],
    })),
    { href: localePath(locale, PHOTO_DOWNLOADER_PATH), label: photoDownloaderLabel },
    { href: localePath(locale, "/audio-downloader"), label: audioDownloaderLabel },
    ...toolLinks.map((tool) => ({ href: localePath(locale, tool.path), label: tool.label })),
  ];

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
    <footer className="mt-8 border-t border-white/10 bg-ink/40 px-4 py-10 backdrop-blur-xl">
      <div className="mx-auto max-w-5xl">
        <p className="mb-10 text-center text-sm text-zinc-500">{dict.trust}</p>
        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3"
        >
          <div className="col-span-2 sm:col-span-1">
            <h2 className="text-sm font-semibold text-zinc-200">{dict.columns.tools}</h2>
            {/* Eleven links would be a long single column, so they flow into two on small screens. */}
            <ul className="mt-3 columns-2 gap-x-6 space-y-2 text-sm sm:columns-1">
              {tools.map((link) => (
                <li key={link.href} className="break-inside-avoid">
                  <a
                    href={link.href}
                    className="rounded text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-400"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <Column heading={dict.columns.legal} links={legal} />
          <div>
            <Column heading={dict.columns.company} links={company} cookieLabel={cookieLabel} />
            <a
              href={TELEGRAM_BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={telegram.open}
              className="mt-2 inline-flex items-center gap-1.5 rounded text-sm text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <TelegramIcon className="h-4 w-4 text-sky-400" />
              {telegram.label}
            </a>
          </div>
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
