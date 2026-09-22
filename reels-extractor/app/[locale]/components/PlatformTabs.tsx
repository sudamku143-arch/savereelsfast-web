"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import PlatformIcon from "./PlatformIcon";

/**
 * The platform switcher. Each tab is a real link to that platform's page (so it can be opened in a new tab
 * and is crawlable). A plain click is handled by `onSelect`, which updates the form at once and then
 * navigates without a reload.
 *
 * Only the active tab prefetches (there is nothing to prefetch: it is the current page). All 10 tabs sit
 * above the fold, so Next's default viewport prefetch would fire a background RSC fetch for every other
 * platform the moment this loads - 9 extra requests competing with the page's own critical resources, worst
 * felt on a throttled mobile connection. The pages are edge-cached (see next.config.js), so an unprefetched
 * click still lands on a warm cache instead of a cold one.
 */
export default function PlatformTabs({
  label,
  names,
  hrefs,
  active,
  onSelect,
}: {
  label: string;
  names: Record<PlatformId, string>;
  hrefs: Record<PlatformId, string>;
  active: PlatformId;
  onSelect: (id: PlatformId) => void;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>, id: PlatformId) {
    // Let "open in new tab", "download link" and friends behave as usual.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(id);
  }

  return (
    <nav
      aria-label={label}
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {PLATFORM_IDS.map((id) => {
        const isActive = id === active;
        return (
          <Link
            key={id}
            href={hrefs[id]}
            scroll={false}
            prefetch={isActive ? undefined : false}
            aria-current={isActive ? "true" : undefined}
            aria-label={names[id]}
            title={names[id]}
            onClick={(event) => handleClick(event, id)}
            className={`flex shrink-0 snap-start items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium outline-none transition duration-200 focus-visible:ring-2 focus-visible:ring-brand-500 ${
              isActive
                ? "border-brand-500 bg-brand-500/15 text-white shadow-glow"
                : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
            }`}
          >
            <PlatformIcon
              id={id}
              className={`h-4 w-4 transition-colors ${isActive ? "text-brand-300" : ""}`}
            />
            <span>{names[id]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
