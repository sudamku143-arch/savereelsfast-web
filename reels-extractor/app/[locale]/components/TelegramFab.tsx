"use client";

import { useEffect, useState } from "react";
import { TELEGRAM_BOT_URL } from "@/lib/site";

export type TelegramDict = {
  /** Short link text: header and footer. */
  label: string;
  /** Text of the floating button. */
  fab: string;
  /** Accessible name for the links (says where they go). */
  open: string;
  /** Accessible name of the floating button's close button. */
  hide: string;
};

const HIDDEN_KEY = "srf:telegram-fab";

/**
 * A small floating button in the bottom corner (the start side: left, or right in Arabic) that opens the Telegram
 * bot. It sits below every other layer (ads, cookie banner, header), moves up above the sticky ad banner while
 * that is showing (see globals.css) so it never covers an ad, and can be closed for the rest of the visit.
 */
export default function TelegramFab({ dict }: { dict: TelegramDict }) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(HIDDEN_KEY) === "1") setHidden(true);
    } catch {
      // storage blocked: just show it
    }
  }, []);

  if (hidden) return null;

  return (
    <div className="telegram-fab fixed bottom-3 start-3 z-30 flex items-center rounded-full border border-white/10 bg-zinc-900/85 shadow-lg backdrop-blur">
      <a
        href={TELEGRAM_BOT_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={dict.open}
        className="flex items-center gap-1.5 rounded-full py-1.5 ps-3 pe-2 text-xs font-medium text-zinc-200 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span aria-hidden="true">🤖</span>
        <span>{dict.fab}</span>
      </a>
      <button
        type="button"
        aria-label={dict.hide}
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(HIDDEN_KEY, "1");
          } catch {
            // ignore
          }
        }}
        className="me-1 rounded-full p-1.5 text-zinc-500 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="h-3 w-3">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
