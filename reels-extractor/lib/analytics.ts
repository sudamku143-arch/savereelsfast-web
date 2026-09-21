// Google Analytics 4, only with consent. Nothing in this file talks to Google: it is the small, testable part (which
// measurement ID is configured, how the visitor's choice is stored, which cookies to remove when it is withdrawn).
// The component that reads the banner's answer and loads Google's script is app/[locale]/components/AnalyticsConsent.tsx.
//
// Set the measurement ID in NEXT_PUBLIC_GA_MEASUREMENT_ID (a public value, like the ad settings). Without one, no
// banner is shown and no analytics code exists on the page.

export type Choice = "granted" | "denied";

/**
 * Key in the browser's local storage that remembers the visitor's answer. The answer now covers analytics AND
 * advertising, so the key changed (v2): nobody who only agreed to analytics is treated as having agreed to ads.
 */
export const CONSENT_KEY = "srf_consent_v2";

/** The footer's "Cookie settings" button announces itself on window with this event to reopen the banner. */
export const CONSENT_EVENT = "srf:open-consent";

/** A GA4 measurement ID looks like G-XXXXXXXXXX. Anything else is treated as "not configured". */
export function parseMeasurementId(value: string | undefined | null): string | null {
  const id = (value ?? "").trim();
  return /^G-[A-Z0-9]{6,14}$/.test(id) ? id : null;
}

export function analyticsId(): string | null {
  return parseMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** The saved answer, or null when the visitor has not answered (or storage is unavailable: then we ask each time). */
export function readChoice(store: Store | null | undefined): Choice | null {
  try {
    const value = store?.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

export function saveChoice(store: Store | null | undefined, choice: Choice): void {
  try {
    store?.setItem(CONSENT_KEY, choice);
  } catch {
    // private mode or blocked storage: the banner simply asks again next visit
  }
}

/** Names of Google Analytics cookies in a `document.cookie` string (_ga, _ga_XXXXXXXXXX, _gid, _gat). */
export function analyticsCookieNames(cookie: string): string[] {
  return cookie
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter((name) => /^_ga($|_)|^_gid$|^_gat($|_)/.test(name));
}

/** Domains a cookie may have been set on, most specific first: "www.example.com" -> www.example.com, example.com, and the dotted forms. */
export function cookieDomains(hostname: string): string[] {
  const labels = hostname.split(".");
  const domains = new Set<string>([hostname, `.${hostname}`]);
  for (let i = 1; i <= labels.length - 2; i += 1) {
    const parent = labels.slice(i).join(".");
    domains.add(parent);
    domains.add(`.${parent}`);
  }
  return [...domains];
}
