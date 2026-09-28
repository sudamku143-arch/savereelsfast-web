"use client";

import Link from "next/link";
import { useEffect, useRef, type MouseEvent } from "react";
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

  // One swipeable row at every width (all ten platforms stay one tap away), fading out at both edges so it
  // reads as "there's more this way". The active pill scrolls itself into view.
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [active]);

  return (
    <nav
      aria-label={label}
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 py-2 [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {PLATFORM_IDS.map((id) => {
        const isActive = id === active;
        return (
          <Link
            key={id}
            ref={isActive ? activeRef : undefined}
            href={hrefs[id]}
            scroll={false}
            prefetch={isActive ? undefined : false}
            aria-current={isActive ? "true" : undefined}
            aria-label={names[id]}
            title={names[id]}
            onClick={(event) => handleClick(event, id)}
            className={`flex shrink-0 snap-center items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium outline-none transition duration-200 focus-visible:ring-2 focus-visible:ring-brand-400 ${
              isActive
                ? "btn-primary border-white/20"
                : "border-white/10 bg-white/[0.03] text-zinc-400 backdrop-blur-xl hover:border-white/20 hover:bg-white/[0.06] hover:text-zinc-100"
            }`}
          >
            <PlatformIcon id={id} className="h-4 w-4" />
            <span>{names[id]}</span>
          </Link>
        );
      })}
    </nav>
  );
}
