"use client";

import { useInstall } from "./InstallProvider";

/** Phone with a download arrow. Drawn inline so it matches the other icons (no emoji fonts). */
export function InstallIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="6" y="2" width="12" height="20" rx="3" />
      <path d="M12 7v7m0 0-3-3m3 3 3-3" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

/**
 * Header pill. Glassmorphism body inside a pink-to-violet gradient border, with a soft glow.
 * Renders nothing when installing isn't possible or the app is already installed.
 */
export default function InstallButton({ label }: { label: string }) {
  const { canInstall, install } = useInstall();
  if (!canInstall) return null;

  return (
    <span className="rounded-full bg-gradient-to-r from-brand-400 to-violet-500 p-px shadow-glow">
      <button
        type="button"
        onClick={() => void install()}
        aria-label={label}
        className="flex items-center gap-1.5 rounded-full bg-zinc-950/90 px-3 py-1.5 text-sm font-semibold text-zinc-50 outline-none backdrop-blur-xl transition hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-brand-300"
      >
        <InstallIcon className="h-4 w-4 text-brand-300" />
        {/* Icon-only on very narrow phones so the header never wraps. */}
        <span className="hidden min-[400px]:inline">{label}</span>
      </button>
    </span>
  );
}
