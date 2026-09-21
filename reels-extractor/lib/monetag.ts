// Monetag's "Vignette banner" ad. Nothing here touches the page: it only says which zone and script address are
// configured. The loader lives in app/[locale]/components/AnalyticsConsent.tsx and runs only after a visitor accepts the
// cookie banner, because the ad network sets cookies and processes personal data.
//
// Set NEXT_PUBLIC_MONETAG_ZONE (the zone number from Monetag's dashboard) to switch it on; leave it out to switch it
// off. NEXT_PUBLIC_MONETAG_SCRIPT_SRC overrides the script address if Monetag hands out a different one later.

/** The script address Monetag gave for this zone. */
export const DEFAULT_SCRIPT_SRC = "https://n6wxm.com/vignette.min.js";

/** A zone id is a plain number (digits only), so it can never carry markup or a quote into a data attribute. */
export function parseZone(value: string | undefined | null): string | null {
  const zone = (value ?? "").trim();
  return /^\d{4,12}$/.test(zone) ? zone : null;
}

/** Only a plain https address (no login, no odd characters) may be loaded as a script. */
export function parseScriptSrc(value: string | undefined | null): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || /[\s"'<>]/.test(raw)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type MonetagConfig = { zone: string; src: string };

/** The configured ad, or null when there is none (no zone, or an unusable script address). */
export function monetagConfig(): MonetagConfig | null {
  const zone = parseZone(process.env.NEXT_PUBLIC_MONETAG_ZONE);
  if (!zone) return null;
  const override = process.env.NEXT_PUBLIC_MONETAG_SCRIPT_SRC;
  const src = override ? parseScriptSrc(override) : DEFAULT_SCRIPT_SRC;
  return src ? { zone, src } : null;
}
