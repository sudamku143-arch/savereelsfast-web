"use client";

import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n-config";
import { shareUrl, whatsappHref, xHref } from "@/lib/share";

export type ShareDict = {
  heading: string;
  whatsapp: string;
  x: string;
  copy: string;
  copied: string;
  text: string;
};

const CHIP =
  "inline-flex items-center rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500";

/**
 * A small "Share this tool" row, shown once a visitor has saved a video: WhatsApp, X and a copy-the-link button.
 * The first two are ordinary links that open in a new tab; nothing from either service is loaded on this page.
 */
export default function ShareTool({ locale, dict }: { locale: Locale; dict: ShareDict }) {
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clipboard access is checked after the page has loaded, so the server and the browser render the same thing first.
  useEffect(() => {
    setCanCopy(typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl(locale, "copy"));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // permission denied or no clipboard: the two share links above still work
    }
  }

  return (
    <section aria-label={dict.heading} className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="text-xs font-medium text-zinc-400">{dict.heading}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={whatsappHref(dict.text, shareUrl(locale, "whatsapp"))}
          target="_blank"
          rel="noopener noreferrer"
          className={CHIP}
        >
          {dict.whatsapp}
        </a>
        <a
          href={xHref(dict.text, shareUrl(locale, "x"))}
          target="_blank"
          rel="noopener noreferrer"
          className={CHIP}
        >
          {dict.x}
        </a>
        {canCopy && (
          <button type="button" onClick={copyLink} className={CHIP}>
            {copied ? `✓ ${dict.copied}` : dict.copy}
          </button>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? dict.copied : ""}
        </span>
      </div>
    </section>
  );
}
