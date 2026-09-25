"use client";

import { useEffect, useState } from "react";
import { localePath, type Locale } from "@/lib/i18n-config";
import {
  CONSENT_EVENT,
  CONSENT_KEY,
  analyticsCookieNames,
  analyticsId,
  cookieDomains,
  readChoice,
  saveChoice,
  type Choice,
} from "@/lib/analytics";
import { monetagConfig, type MonetagConfig } from "@/lib/monetag";

type Dict = { title: string; text: string; accept: string; decline: string; privacy: string };

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void } & Record<string, unknown>;

const SCRIPT_ID = "srf-ga4";
const ADS_SCRIPT_ID = "srf-monetag";

/**
 * Loads Google Analytics. Called only after the visitor accepted, so before that nothing is requested from Google and
 * no cookie is set. Consent Mode is set up as well (everything denied except analytics), and Google signals and ad
 * personalisation stay off.
 */
function loadAnalytics(id: string): void {
  const w = window as unknown as GtagWindow;
  w[`ga-disable-${id}`] = false;
  w.dataLayer = w.dataLayer || [];
  if (!w.gtag) {
    w.gtag = function gtag() {
      // Google's snippet pushes the `arguments` object itself, not an array.
      // eslint-disable-next-line prefer-rest-params
      (w.dataLayer as unknown[]).push(arguments);
    };
  }
  const gtag = w.gtag;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
  });
  gtag("js", new Date());
  gtag("consent", "update", { analytics_storage: "granted" });
  gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });

  if (!document.getElementById(SCRIPT_ID)) {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(script);
  }
}

/**
 * Loads the Monetag Vignette ad: the same thing Monetag's own snippet does (a script tag with the zone in data-zone,
 * added at the end of the page), but only after the visitor accepted. It runs after hydration, from an effect, so it can
 * never cause a hydration mismatch. The zone is a plain number and the address a plain https URL (see lib/monetag.ts).
 */
function loadAds(ads: MonetagConfig): void {
  if (document.getElementById(ADS_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = ADS_SCRIPT_ID;
  script.dataset.zone = ads.zone;
  script.src = ads.src;
  (document.body ?? document.documentElement).appendChild(script);
}

/** Withdrawing consent: stop measuring right away and remove the cookies Google set. */
function stopAnalytics(id: string): void {
  const w = window as unknown as GtagWindow;
  w[`ga-disable-${id}`] = true;
  w.gtag?.("consent", "update", { analytics_storage: "denied" });
  const expired = "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  for (const name of analyticsCookieNames(document.cookie)) {
    document.cookie = `${name}${expired}`;
    for (const domain of cookieDomains(window.location.hostname)) document.cookie = `${name}${expired}; domain=${domain}`;
  }
}

/**
 * The banner is in the server HTML so a first-time visitor sees it with the first paint (it is often the largest
 * text on a phone screen, so waiting for JavaScript to draw it made it the page's slow LCP). For a visitor who
 * already answered, this runs as the parser reaches it, before anything is painted, and marks <html> so the CSS in
 * globals.css hides the banner until React removes it: no flash.
 */
const HIDE_IF_ANSWERED = `try{var v=localStorage.getItem(${JSON.stringify(CONSENT_KEY)});if(v==="granted"||v==="denied")document.documentElement.setAttribute("data-srf-consent","")}catch(e){}`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function AnalyticsConsent({ locale, dict }: { locale: Locale; dict: Dict }) {
  const id = analyticsId();
  const ads = monetagConfig();
  const active = Boolean(id || ads); // the banner exists only when there is something to ask about
  const [choice, setChoice] = useState<Choice | null | undefined>(undefined); // undefined: not read yet
  const [open, setOpen] = useState(active); // drawn by the server; closed below if an answer is already saved

  // Read the saved answer once, after the page has loaded (never during the server render).
  useEffect(() => {
    if (!active) return;
    const saved = readChoice(storage());
    setChoice(saved);
    setOpen(saved === null);
  }, [active]);

  // The footer's "Cookie settings" button reopens the banner.
  useEffect(() => {
    if (!active) return;
    const reopen = () => {
      document.documentElement.removeAttribute("data-srf-consent"); // otherwise the CSS would keep it hidden
      setOpen(true);
    };
    window.addEventListener(CONSENT_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_EVENT, reopen);
  }, [active]);

  // Accepting switches on whatever is configured: analytics, the ad, or both. Nothing loads before that.
  useEffect(() => {
    if (choice !== "granted") return;
    if (id) loadAnalytics(id);
    if (ads) loadAds(ads);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, choice]);

  if (!active || !open) return null;

  function answer(next: Choice) {
    saveChoice(storage(), next);
    setChoice(next);
    setOpen(false);
    if (next === "denied") {
      if (id) stopAnalytics(id);
      // An ad script that is already running cannot be taken back out of the page: reload it without the script.
      if (document.getElementById(ADS_SCRIPT_ID)) window.location.reload();
    }
  }

  const button =
    "min-w-[6.5rem] flex-1 rounded-xl px-4 py-2 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand-300 sm:flex-none";

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: HIDE_IF_ANSWERED }} />
      <div
        data-consent-banner=""
        role="region"
        aria-label={dict.title}
        className="glass fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-xl rounded-2xl p-4 shadow-xl sm:inset-x-auto sm:end-4 sm:bottom-4 sm:mx-0"
      >
        <p className="text-sm font-semibold text-zinc-50">{dict.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-300">
          {dict.text}{" "}
          <a href={localePath(locale, "/privacy-policy")} className="text-brand-300 underline underline-offset-2 hover:text-brand-400">
            {dict.privacy}
          </a>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Equal size and weight: declining must be as easy as accepting. */}
          <button type="button" onClick={() => answer("granted")} className={`${button} bg-brand-500 text-white hover:bg-brand-600`}>
            {dict.accept}
          </button>
          <button type="button" onClick={() => answer("denied")} className={`${button} bg-white/10 text-zinc-100 hover:bg-white/20`}>
            {dict.decline}
          </button>
        </div>
      </div>
    </>
  );
}
