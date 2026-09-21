"use client";

import { useEffect, useRef, useState } from "react";
import { isSlow, stepIndex } from "@/lib/loading";

export type LoaderDict = {
  loading: string;
  processing: string;
  steps: string[];
  slow: string;
};

/**
 * What a visitor sees between pasting a link and getting the result: a spinner with "Processing your link...", a
 * sliding progress bar, a line that says what is happening (it moves on every couple of seconds), and the card the
 * result will fill, so nothing jumps when it arrives. After a few seconds it also says the lookup is still running.
 */
export default function SkeletonLoader({ dict }: { dict: LoaderDict }) {
  const [elapsed, setElapsed] = useState(0);
  const card = useRef<HTMLDivElement>(null);

  // The card sits under the search box and the ad, which on a phone is below the visible screen: bring it into view
  // (the least scrolling that shows all of it) so the visitor sees that something is happening.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, []);

  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - started), 400);
    return () => clearInterval(timer);
  }, []);

  const step = dict.steps[stepIndex(elapsed, dict.steps.length)];

  return (
    <div ref={card} role="status" aria-live="polite" className="glass mt-6 w-full max-w-md scroll-mb-4 rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-7 w-7 shrink-0 text-brand-400 motion-safe:animate-spin">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-zinc-50 sm:text-base">{dict.processing}</p>
          {/* The step line is decoration for sighted visitors: announcing every change would only be noise. */}
          {step && (
            <p aria-hidden="true" className="mt-0.5 truncate text-xs text-zinc-400">
              {step}
            </p>
          )}
        </div>
      </div>

      <div
        role="progressbar"
        aria-label={dict.loading}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div className="animate-indeterminate h-full w-1/4 rounded-full bg-brand-500" />
      </div>

      <div className="mt-4 flex gap-4" aria-hidden="true">
        <div className="skeleton h-32 w-24 shrink-0 animate-shimmer rounded-xl" />
        <div className="flex-1 space-y-3 py-1">
          <div className="skeleton h-4 w-3/4 animate-shimmer rounded" />
          <div className="skeleton h-4 w-1/2 animate-shimmer rounded" />
          <div className="skeleton h-9 w-full animate-shimmer rounded-lg" />
        </div>
      </div>

      {/* Its space is kept from the start (hidden until it is needed), so the card never grows and slides off screen. */}
      <p aria-hidden={!isSlow(elapsed)} className={`mt-3 text-center text-xs text-zinc-400 ${isSlow(elapsed) ? "" : "invisible"}`}>
        {dict.slow}
      </p>
    </div>
  );
}
