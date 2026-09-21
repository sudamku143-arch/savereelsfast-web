"use client";

import { CONSENT_EVENT } from "@/lib/analytics";

/** Footer link that reopens the analytics banner, so a choice can be changed or withdrawn at any time. */
export default function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(CONSENT_EVENT))}
      className="rounded text-start text-zinc-400 outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {label}
    </button>
  );
}
