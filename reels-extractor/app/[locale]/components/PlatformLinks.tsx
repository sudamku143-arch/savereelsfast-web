import { localePath, type Locale } from "@/lib/i18n-config";
import { landingPath, LANDING_PLATFORMS } from "@/lib/landing";
import type { PlatformId } from "@/lib/platforms";
import PlatformIcon from "./PlatformIcon";

/** Grid of links to every platform's landing page: the internal-linking backbone for SEO. */
export default function PlatformLinks({
  locale,
  names,
  heading,
  lead,
  currentId,
  currentLabel,
}: {
  locale: Locale;
  names: Record<PlatformId, string>;
  heading: string;
  lead: string;
  currentId?: PlatformId;
  currentLabel?: string;
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
      </ul>
    </nav>
  );
}
