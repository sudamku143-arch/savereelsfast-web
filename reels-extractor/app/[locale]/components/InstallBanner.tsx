"use client";

import { useEffect, useState } from "react";
import { InstallIcon } from "./InstallButton";
import { useInstall } from "./InstallProvider";

type Dict = {
  title: string;
  body: string;
  install: string;
  dismiss: string;
};

const DISMISSED_KEY = "srf:install-banner-dismissed";
const DISMISS_DAYS = 14;

/** Eye-catching card under the downloader. Dismissible; the header button stays available. */
export default function InstallBanner({ dict }: { dict: Dict }) {
  const { canInstall, install } = useInstall();
  const [dismissed, setDismissed] = useState(true); // hidden until we know

  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(DISMISSED_KEY));
      setDismissed(at > 0 && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000);
    } catch {
      setDismissed(false); // storage blocked: still show it, it just can't be remembered
    }
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // ignore
    }
  }

  if (!canInstall || dismissed) return null;

  return (
    <aside
      aria-label={dict.title}
      className="mt-8 w-full max-w-md animate-fade-in-up rounded-2xl bg-gradient-to-r from-brand-400 via-brand-500 to-violet-500 p-px shadow-glow"
    >
      <div className="glass relative flex items-center gap-3 rounded-[15px] bg-zinc-950/85 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/icons/icon-192.png"
          alt=""
          width={48}
          height={48}
          className="h-12 w-12 shrink-0 rounded-xl shadow-glow"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-zinc-50">{dict.title}</p>
          <p className="mt-0.5 text-xs leading-snug text-zinc-400">{dict.body}</p>
          <button
            type="button"
            onClick={() => void install()}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow outline-none transition hover:bg-brand-400 focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            <InstallIcon className="h-3.5 w-3.5" />
            {dict.install}
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={dict.dismiss}
          className="absolute right-2 top-2 rounded-md p-1 text-zinc-500 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
