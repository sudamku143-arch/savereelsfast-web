import { localePath, type Locale } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import type { PlatformId } from "@/lib/platforms";
import PlatformIcon from "./PlatformIcon";

function HeadphonesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="14" width="4" height="6" rx="2" />
      <rect x="17.5" y="14" width="4" height="6" rx="2" />
    </svg>
  );
}

/** Grid of links to every platform's landing page: the internal-linking backbone for SEO. */
export default function PlatformLinks({
  locale,
  names,
  heading,
  lead,
  currentId,
  currentLabel,
  audioLabel,
}: {
  locale: Locale;
  names: Record<PlatformId, string>;
  heading: string;
  lead: string;
  currentId?: PlatformId;
  currentLabel?: string;
  /**
   * Label for an extra "Audio Downloader" card appended after the 10 platforms, so every platform page and
   * the home page cross-links the audio tool by name, not just from the footer. Omitted on the audio page
   * itself (linking a page to itself here would be redundant, not helpful).
   */
  audioLabel?: string;
}) {
  return (
    <nav aria-label={heading} className="mt-16 w-full max-w-2xl">
      <h2 className="text-xl font-bold text-zinc-50">{heading}</h2>
      <p className="mt-1 text-sm text-zinc-400">{lead}</p>

      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {LANDING_PLATFORMS.map((id) => {
          const current = id === currentId;
          return (
            <li key={id}>
              <a
                href={localePath(locale, landingPath(id))}
                aria-current={current ? "page" : undefined}
                title={current ? currentLabel : undefined}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-brand-500 ${
                  current
                    ? "border-brand-500/60 bg-brand-500/10 text-zinc-50"
                    : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-zinc-50"
                }`}
              >
                <PlatformIcon
                  id={id}
                  className={`h-4 w-4 shrink-0 ${current ? "text-brand-300" : "text-zinc-400"}`}
                />
                <span className="truncate">{names[id]}</span>
              </a>
            </li>
          );
        })}
        {audioLabel && (
          <li>
            <a
              href={localePath(locale, "/audio-downloader")}
              className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-medium text-zinc-300 outline-none transition hover:bg-white/10 hover:text-zinc-50 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <HeadphonesIcon />
              <span className="truncate">{audioLabel}</span>
            </a>
          </li>
        )}
      </ul>
    </nav>
  );
}
