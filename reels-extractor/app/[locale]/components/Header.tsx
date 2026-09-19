"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { locales, defaultLocale, type Locale } from "@/lib/i18n-config";
import InstallButton from "./InstallButton";

type Dict = {
  language: string;
  homeLabel: string;
  install: string;
};

const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  pt: "Português",
};

function localeHref(locale: Locale): string {
  return locale === defaultLocale ? "/" : `/${locale}`;
}

function Logo() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="srf-logo-grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stopColor="#f2609a" />
          <stop offset="1" stopColor="#813cff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#srf-logo-grad)" />
      <path
        d="M12 8.5v9.2a1 1 0 0 0 1.5.86l7.6-4.6a1 1 0 0 0 0-1.72l-7.6-4.6A1 1 0 0 0 12 8.5Z"
        fill="#fff"
      />
      <path d="M10 23h12" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function Header({
  locale,
  dict,
}: {
  locale: Locale;
  dict: Dict;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(next: Locale) {
    setOpen(false);
    if (next === locale) return;
    // Remember the explicit choice so the middleware stops auto-redirecting
    // based on the Accept-Language header.
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000; SameSite=Lax`;
    router.push(localeHref(next));
  }

  return (
    <header className="glass sticky top-0 z-50 border-x-0 border-t-0">
      <nav className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
        <a
          href={localeHref(locale)}
          aria-label={dict.homeLabel}
          className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Logo />
          <span className="text-base font-bold tracking-tight text-zinc-50">
            SaveReels<span className="text-brand-400">Fast</span>
          </span>
        </a>

        <div className="flex items-center gap-2">
        <InstallButton label={dict.install} />
        <div ref={rootRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={dict.language}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm font-medium text-zinc-200 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
            </svg>
            <span className="uppercase">{locale}</span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          {open && (
            <ul
              role="listbox"
              aria-label={dict.language}
              className="absolute right-0 mt-2 w-44 animate-fade-in-up overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 py-1 shadow-xl backdrop-blur-xl"
            >
              {locales.map((l) => (
                <li key={l} role="option" aria-selected={l === locale}>
                  <button
                    type="button"
                    onClick={() => choose(l)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-white/10 ${
                      l === locale ? "font-semibold text-brand-300" : "text-zinc-300"
                    }`}
                  >
                    <span>{LOCALE_LABELS[l]}</span>
                    <span className="text-xs uppercase text-zinc-500">{l}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>
      </nav>
    </header>
  );
}
