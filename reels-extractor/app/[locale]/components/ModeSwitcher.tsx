"use client";

import { usePathname } from "next/navigation";
import { localePath, type Locale } from "@/lib/i18n-config";

export type ModeSwitcherDict = {
  toAudioLabel: string;
  toAudioBadge: string;
  toAudioAria: string;
  toVideoLabel: string;
  toVideoBadge: string;
  toVideoAria: string;
};

function HeadphonesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="2.5" y="14" width="4" height="6" rx="2" />
      <rect x="17.5" y="14" width="4" height="6" rx="2" />
    </svg>
  );
}

function ClapperboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M3 8.5 5 4h3l-2 4.5M9 8.5 11 4h3l-2 4.5M15 8.5 17 4h3l-2 4.5" />
      <rect x="3" y="8.5" width="18" height="11.5" rx="2" />
    </svg>
  );
}

/**
 * A small pill above the tool that jumps between the video downloader and the audio-only one, so a visitor who
 * only wants the sound (or only the video) doesn't have to hunt for the other tool. Which way it points is read
 * straight from the URL (the path always ends in "/audio-downloader" on that page, in every language), so
 * nothing needs to be threaded down from each page beyond the dictionary strings.
 */
export default function ModeSwitcher({ locale, dict }: { locale: Locale; dict: ModeSwitcherDict }) {
  const pathname = usePathname() ?? "";
  const onAudioPage = /\/audio-downloader\/?$/.test(pathname);

  const href = onAudioPage ? localePath(locale) : localePath(locale, "/audio-downloader");
  const label = onAudioPage ? dict.toVideoLabel : dict.toAudioLabel;
  const badge = onAudioPage ? dict.toVideoBadge : dict.toAudioBadge;
  const aria = onAudioPage ? dict.toVideoAria : dict.toAudioAria;
  const gradient = onAudioPage
    ? "from-rose-500 via-pink-500 to-orange-400"
    : "from-violet-600 via-purple-500 to-pink-500";

  return (
    <a
      href={href}
      aria-label={aria}
      className={`group mt-5 inline-flex shrink-0 items-center gap-2 self-center rounded-full bg-gradient-to-r ${gradient} py-1.5 pl-3 pr-2 text-xs font-semibold text-white shadow-lg shadow-purple-500/20 outline-none transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-purple-500/30 focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
    >
      <span className="flex h-5 w-5 items-center justify-center motion-safe:animate-pulse">
        {onAudioPage ? <ClapperboardIcon /> : <HeadphonesIcon />}
      </span>
      <span className="whitespace-nowrap">{label}</span>
      <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
        {badge}
      </span>
    </a>
  );
}
