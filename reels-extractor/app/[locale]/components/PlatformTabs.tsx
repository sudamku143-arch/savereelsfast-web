"use client";

import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import PlatformIcon from "./PlatformIcon";

export default function PlatformTabs({
  label,
  names,
  active,
  onSelect,
}: {
  label: string;
  names: Record<PlatformId, string>;
  active: PlatformId;
  onSelect: (id: PlatformId) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {PLATFORM_IDS.map((id) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={names[id]}
            title={names[id]}
            onClick={() => onSelect(id)}
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
          </button>
        );
      })}
    </div>
  );
}
