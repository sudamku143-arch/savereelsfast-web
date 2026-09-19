"use client";

import { useEffect, useRef, useState } from "react";
import {
  aadsSnippet,
  planAd,
  resolveAdConfig,
  type AdPlan,
  type AdVariant,
} from "@/lib/ads";

// NEXT_PUBLIC_* variables are only inlined when written out literally.
const CONFIG = resolveAdConfig({
  NEXT_PUBLIC_AD_PROVIDER: process.env.NEXT_PUBLIC_AD_PROVIDER,
  NEXT_PUBLIC_AD_CLIENT_ID: process.env.NEXT_PUBLIC_AD_CLIENT_ID,
  NEXT_PUBLIC_AD_PLACEHOLDERS: process.env.NEXT_PUBLIC_AD_PLACEHOLDERS,
  NEXT_PUBLIC_AD_SLOT_LEADERBOARD: process.env.NEXT_PUBLIC_AD_SLOT_LEADERBOARD,
  NEXT_PUBLIC_AD_SLOT_LEADERBOARD_MOBILE: process.env.NEXT_PUBLIC_AD_SLOT_LEADERBOARD_MOBILE,
  NEXT_PUBLIC_AD_SLOT_NATIVE: process.env.NEXT_PUBLIC_AD_SLOT_NATIVE,
  NEXT_PUBLIC_AD_SLOT_STICKY: process.env.NEXT_PUBLIC_AD_SLOT_STICKY,
  NEXT_PUBLIC_AD_SLOT_STICKY_MOBILE: process.env.NEXT_PUBLIC_AD_SLOT_STICKY_MOBILE,
  NEXT_PUBLIC_AD_HTML_LEADERBOARD: process.env.NEXT_PUBLIC_AD_HTML_LEADERBOARD,
  NEXT_PUBLIC_AD_HTML_NATIVE: process.env.NEXT_PUBLIC_AD_HTML_NATIVE,
  NEXT_PUBLIC_AD_HTML_STICKY: process.env.NEXT_PUBLIC_AD_HTML_STICKY,
});

export type AdDict = {
  label: string;
  close: string;
  collapse: string;
  expand: string;
};

// Fixed sizes reserve the space before the ad loads, so nothing jumps when it arrives.
const BANNER_BOX = "h-[50px] w-[320px] max-w-full md:h-[90px] md:w-[728px]"; // 320x50 phone, 728x90 desktop
const NATIVE_BOX = "min-h-[160px] w-full";

/** True from 768px up (Tailwind's `md`); null until the browser has been measured. */
function useIsDesktop(): boolean | null {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
}

type AdsByGoogleWindow = Window & { adsbygoogle?: unknown[] };

function AdSenseUnit({ clientId, slot }: { clientId: string; slot: string }) {
  const ref = useRef<HTMLModElement>(null);

  useEffect(() => {
    if (!document.querySelector("script[data-srf-adsense]")) {
      const script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
      script.dataset.srfAdsense = "1";
      document.head.appendChild(script);
    }
    // React strict mode runs effects twice; AdSense throws if the same <ins> is filled twice.
    if (ref.current && !ref.current.dataset.adsbygoogleStatus) {
      try {
        const w = window as AdsByGoogleWindow;
        (w.adsbygoogle = w.adsbygoogle ?? []).push({});
      } catch {
        // Blocked by an ad blocker or a consent tool: the placeholder area simply stays empty.
      }
    }
  }, [clientId, slot]);

  return (
    <ins
      ref={ref}
      className="adsbygoogle block h-full w-full"
      data-ad-client={clientId}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
}

function AAdsUnit({
  desktopUnit,
  mobileUnit,
  size,
  primary,
}: {
  desktopUnit: string;
  mobileUnit: string | null;
  size: "banner" | "native";
  /** The first A-ADS copy on the page keeps id="frame"; later copies drop it. */
  primary: boolean;
}) {
  const desktop = useIsDesktop();

  // One Adaptive unit needs no device check, so A-ADS's embed code goes into the server-rendered
  // HTML as-is, with no client-side delay. That is what its verification bot looks for.
  // `isolate` keeps the snippet's z-index: 99998 from climbing above our sticky header and dialogs;
  // `[&>div]:h-full` makes its #frame wrapper fill the fixed-size ad box.
  if (mobileUnit === null) {
    return (
      <div
        className="isolate h-full w-full [&>div]:h-full"
        dangerouslySetInnerHTML={{ __html: aadsSnippet(desktopUnit, primary) }}
      />
    );
  }

  if (desktop === null) return null; // wait until we know which unit to load (never load both)
  const unit = desktop ? desktopUnit : (mobileUnit ?? desktopUnit);
  // "Adaptive" is what A-ADS's own embed code requests: the unit sizes itself to the space it gets
  // (a 728x90 box on desktop, 320x50 on phones), and it works for units created as Adaptive.
  const dimension = "Adaptive";
  void size;
  return (
    <iframe
      key={unit}
      title="Advertisement"
      data-aa={unit}
      src={`https://acceptable.a-ads.com/${unit}/?size=${dimension}`}
      loading="lazy"
      className="h-full w-full border-0 p-0"
      style={{ overflow: "hidden", backgroundColor: "transparent" }}
    />
  );
}

/** Runs an ad network's raw snippet, including its <script> tags (innerHTML alone would not execute them). */
function CustomUnit({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.innerHTML = html;
    host.querySelectorAll("script").forEach((old) => {
      const script = document.createElement("script");
      for (const { name, value } of Array.from(old.attributes)) script.setAttribute(name, value);
      script.text = old.text;
      old.replaceWith(script);
    });
    return () => {
      host.innerHTML = "";
    };
  }, [html]);

  return <div ref={ref} className="flex h-full w-full items-center justify-center overflow-hidden" />;
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
      <span className="text-[10px] font-medium uppercase tracking-widest text-zinc-600">{label}</span>
    </div>
  );
}

function Unit({
  plan,
  size,
  label,
  primary = false,
}: {
  plan: AdPlan;
  size: "banner" | "native";
  label: string;
  primary?: boolean;
}) {
  switch (plan.kind) {
    case "adsense":
      return <AdSenseUnit clientId={plan.clientId} slot={plan.slot} />;
    case "aads":
      return (
        <AAdsUnit
          desktopUnit={plan.desktopUnit}
          mobileUnit={plan.mobileUnit}
          size={size}
          primary={primary}
        />
      );
    case "custom":
      return <CustomUnit html={plan.html} />;
    default:
      return <Placeholder label={label} />;
  }
}

const STICKY_KEY = "srf:sticky-ad";
type StickyState = "open" | "collapsed" | "closed";

function StickyAd({ dict }: { dict: AdDict }) {
  const plan = planAd(CONFIG, "sticky");
  const [state, setState] = useState<StickyState>("closed"); // hidden until we know

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STICKY_KEY);
      setState(saved === "closed" || saved === "collapsed" ? saved : "open");
    } catch {
      setState("open"); // storage blocked: still show it, it just won't be remembered
    }
  }, []);

  function update(next: StickyState) {
    setState(next);
    try {
      sessionStorage.setItem(STICKY_KEY, next);
    } catch {
      // ignore
    }
  }

  if (plan.kind === "placeholder" && !CONFIG.showPlaceholders) return null;
  if (state === "closed") return null;

  if (state === "collapsed") {
    return (
      <button
        type="button"
        onClick={() => update("open")}
        aria-label={dict.expand}
        className="fixed bottom-3 right-3 z-40 rounded-full border border-white/10 bg-zinc-900/90 px-3 py-1.5 text-[11px] font-medium text-zinc-300 shadow-lg outline-none backdrop-blur transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {dict.label} ▴
      </button>
    );
  }

  return (
    <>
      {/* Keeps the footer from ending up underneath the fixed banner. */}
      <div aria-hidden="true" className="h-[86px] md:h-[126px]" />
      <aside
        aria-label={dict.label}
        className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-2 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="relative rounded-t-xl border border-b-0 border-white/10 bg-zinc-950/95 px-2 pb-2 pt-6 shadow-[0_-8px_30px_rgba(0,0,0,0.5)] backdrop-blur-xl">
          {plan.kind !== "placeholder" && (
            <span className="absolute left-3 top-1.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
              {dict.label}
            </span>
          )}
          <div className="absolute right-1.5 top-1 flex gap-0.5">
            <button
              type="button"
              onClick={() => update("collapsed")}
              aria-label={dict.collapse}
              className="rounded p-1 text-zinc-500 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => update("closed")}
              aria-label={dict.close}
              className="rounded p-1 text-zinc-500 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className={BANNER_BOX}>
            <Unit plan={plan} size="banner" label={dict.label} />
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * One component for the three ad slots.
 *
 *   leaderboard  728x90 desktop / 320x50 phone, top of the tool pages
 *   native       card-sized unit, directly under the download result
 *   sticky       fixed bottom banner with collapse and close buttons
 *
 * Pages opt in by rendering the slots they want, which is why ads never appear on the
 * legal pages. (The URL is deliberately not inspected: middleware rewrites "/" to "/en",
 * so the server and the browser disagree about the path and hydration breaks.)
 *
 * With no ad network configured (see lib/ads.ts) each slot shows a quiet
 * "Advertisement" placeholder of the same size.
 */
export default function AdBanner({
  variant,
  dict,
  className = "",
}: {
  variant: AdVariant;
  dict: AdDict;
  className?: string;
}) {
  if (variant === "sticky") return <StickyAd dict={dict} />;

  const plan = planAd(CONFIG, variant);
  if (plan.kind === "placeholder" && !CONFIG.showPlaceholders) return null;

  const box = variant === "native" ? NATIVE_BOX : BANNER_BOX;

  return (
    <aside
      aria-label={dict.label}
      className={`flex w-full flex-col items-center ${variant === "native" ? "max-w-md" : ""} ${className}`}
    >
      {/* A placeholder already says "Advertisement" inside its box, so the tag is only for real ads. */}
      {plan.kind !== "placeholder" && (
        <span className="mb-1 self-center text-[10px] font-medium uppercase tracking-widest text-zinc-600">
          {dict.label}
        </span>
      )}
      <div className={box}>
        <Unit
          plan={plan}
          size={variant === "native" ? "native" : "banner"}
          label={dict.label}
          primary={variant === "leaderboard"}
        />
      </div>
    </aside>
  );
}
