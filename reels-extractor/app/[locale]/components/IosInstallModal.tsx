"use client";

import { useEffect, useRef } from "react";
import { useInstall } from "./InstallProvider";

type Dict = {
  iosTitle: string;
  iosStep1: string;
  iosStep2: string;
  iosClose: string;
};

function ShareIcon() {
  // The iOS Share glyph: a box with an arrow leaving the top.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
      <path d="M12 15V3m0 0L8 7m4-4 4 4" />
      <path d="M7 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

function AddToHomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

/** Two-step "Add to Home Screen" guide for iOS, where there is no install prompt to trigger. */
export default function IosInstallModal({ dict }: { dict: Dict }) {
  const { iosGuideOpen, closeIosGuide } = useInstall();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!iosGuideOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // no scrolling behind the dialog
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeIosGuide();
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [iosGuideOpen, closeIosGuide]);

  if (!iosGuideOpen) return null;

  const steps = [
    { icon: <ShareIcon />, text: dict.iosStep1 },
    { icon: <AddToHomeIcon />, text: dict.iosStep2 },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10 backdrop-blur-sm sm:items-center"
      onClick={closeIosGuide}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ios-install-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm animate-fade-in-up rounded-3xl bg-gradient-to-b from-brand-400 to-violet-500 p-px shadow-glow-lg"
      >
        <div className="rounded-[23px] bg-zinc-950/95 p-5">
          <h2 id="ios-install-title" className="text-lg font-bold text-zinc-50">
            {dict.iosTitle}
          </h2>

          <ol className="mt-4 space-y-3">
            {steps.map((step, index) => (
              <li key={index} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/15 text-brand-300">
                  {step.icon}
                </span>
                <span className="text-sm leading-snug text-zinc-200">
                  <span className="mr-1.5 font-bold text-brand-300">{index + 1}.</span>
                  {step.text}
                </span>
              </li>
            ))}
          </ol>

          <button
            ref={closeRef}
            type="button"
            onClick={closeIosGuide}
            className="mt-5 w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white shadow-glow outline-none transition hover:bg-brand-400 focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            {dict.iosClose}
          </button>

          {/* Points at the Share button, which lives in the browser bar at the bottom of an iPhone. */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mt-3 h-5 w-5 animate-bounce text-brand-300 motion-reduce:animate-none" aria-hidden="true">
            <path d="M12 5v14m0 0-5-5m5 5 5-5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
