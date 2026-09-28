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
 * The header's call to action: the gradient pill. Renders nothing when installing isn't possible or the app is
 * already installed.
 */
export default function InstallButton({ label }: { label: string }) {
  const { canInstall, install } = useInstall();
  if (!canInstall) return null;

  return (
    <button
      type="button"
      onClick={() => void install()}
      aria-label={label}
      className="btn-primary flex items-center whitespace-nowrap gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
    >
      <InstallIcon className="h-4 w-4" />
      {/* Icon-only on very narrow phones so the header never wraps. */}
      <span className="hidden min-[400px]:inline">{label}</span>
    </button>
  );
}
