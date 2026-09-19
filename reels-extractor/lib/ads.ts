// Kept free of runtime imports so it can be unit-tested with plain Node.

/**
 * Ad configuration, read from NEXT_PUBLIC_* environment variables.
 *
 *   NEXT_PUBLIC_AD_PROVIDER          adsense | aads | custom   (default: adsense if a client id is set, else none)
 *   NEXT_PUBLIC_AD_CLIENT_ID         AdSense publisher id, e.g. ca-pub-1234567890123456
 *   NEXT_PUBLIC_AD_SLOT_<VARIANT>    AdSense ad-unit id, or A-ADS unit id (VARIANT: LEADERBOARD | NATIVE | STICKY)
 *   NEXT_PUBLIC_AD_SLOT_<VARIANT>_MOBILE   A-ADS: separate 320x50 unit for phones (LEADERBOARD | STICKY)
 *   NEXT_PUBLIC_AD_HTML_<VARIANT>    provider "custom": a raw snippet (e.g. Propeller/Adsterra code)
 *   NEXT_PUBLIC_AD_PLACEHOLDERS      "off" hides the empty placeholder boxes
 *
 * These are inlined at build time, so change them in Vercel and redeploy.
 */
export type AdVariant = "leaderboard" | "native" | "sticky";
export type AdProvider = "adsense" | "aads" | "custom" | "none";
export type AdEnv = Record<string, string | undefined>;

export type AdConfig = {
  provider: AdProvider;
  clientId: string | null;
  showPlaceholders: boolean;
  /** Unit id for a variant (desktop, or mobile when `mobile` is set). */
  unit: (variant: AdVariant, mobile?: boolean) => string | null;
  /** Raw HTML snippet for the "custom" provider. */
  html: (variant: AdVariant) => string | null;
};

const CLIENT_ID = /^ca-pub-\d{10,20}$/;
const UNIT_ID = /^\d{5,20}$/;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveAdConfig(env: AdEnv): AdConfig {
  const rawClient = clean(env.NEXT_PUBLIC_AD_CLIENT_ID);
  const clientId = rawClient && CLIENT_ID.test(rawClient) ? rawClient : null;

  const requested = clean(env.NEXT_PUBLIC_AD_PROVIDER)?.toLowerCase();
  let provider: AdProvider = "none";
  if (requested === "adsense" || requested === "aads" || requested === "custom") {
    provider = requested;
  } else if (!requested && clientId) {
    provider = "adsense";
  }
  // AdSense can't run without a valid publisher id.
  if (provider === "adsense" && !clientId) provider = "none";

  return {
    provider,
    clientId,
    showPlaceholders: clean(env.NEXT_PUBLIC_AD_PLACEHOLDERS)?.toLowerCase() !== "off",
    unit(variant, mobile = false) {
      const key = `NEXT_PUBLIC_AD_SLOT_${variant.toUpperCase()}${mobile ? "_MOBILE" : ""}`;
      const value = clean(env[key]);
      return value && UNIT_ID.test(value) ? value : null;
    },
    html(variant) {
      return clean(env[`NEXT_PUBLIC_AD_HTML_${variant.toUpperCase()}`]);
    },
  };
}

/** Which kind of content a slot renders with the current configuration. */
export type AdPlan =
  | { kind: "adsense"; clientId: string; slot: string }
  | { kind: "aads"; desktopUnit: string; mobileUnit: string | null }
  | { kind: "custom"; html: string }
  | { kind: "placeholder" };

export function planAd(config: AdConfig, variant: AdVariant): AdPlan {
  if (config.provider === "adsense") {
    const slot = config.unit(variant);
    if (config.clientId && slot) return { kind: "adsense", clientId: config.clientId, slot };
  }
  if (config.provider === "aads") {
    const desktopUnit = config.unit(variant);
    if (desktopUnit) return { kind: "aads", desktopUnit, mobileUnit: config.unit(variant, true) };
  }
  if (config.provider === "custom") {
    const html = config.html(variant);
    if (html) return { kind: "custom", html };
  }
  return { kind: "placeholder" };
}

/**
 * The A-ADS embed code, character for character as A-ADS issues it (comments, the
 * #frame wrapper, single-quoted attributes). A-ADS's verification bot reads the raw
 * server HTML looking for this exact text, so it must never be rebuilt from JSX:
 * React drops HTML comments and would re-quote the attributes.
 *
 * `withId` is false for every copy after the first on a page, so `id="frame"` stays unique.
 */
export function aadsSnippet(unit: string, withId = true): string {
  return `<!-- BEGIN AADS AD UNIT ${unit} -->
<div${withId ? ' id="frame"' : ""} style="width: 100%; margin: auto; position: relative; z-index: 99998;">
  <iframe data-aa='${unit}' src='//acceptable.a-ads.com/${unit}/?size=Adaptive' style='border:0px; padding:0; width:100%; height:100%; overflow:hidden; background-color: transparent;'></iframe>
</div>
<!-- END AADS AD UNIT ${unit} -->`;
}
