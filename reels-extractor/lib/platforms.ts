import { normalizeInstagramUrl } from "@/lib/instagram";

export const PLATFORM_IDS = [
  "instagram",
  "youtube",
  "facebook",
  "threads",
  "x",
  "pinterest",
  "tiktok",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

const HOSTS: Record<PlatformId, string[]> = {
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be"],
  facebook: ["facebook.com", "fb.watch"],
  threads: ["threads.net", "threads.com"],
  x: ["twitter.com", "x.com"],
  pinterest: ["pinterest.com", "pin.it"],
  tiktok: ["tiktok.com"],
};

// Pinterest also serves from country domains (pinterest.co.uk, pinterest.fr, …).
const PINTEREST_COUNTRY_HOST = /(^|\.)pinterest\.[a-z]{2,3}(\.[a-z]{2})?$/;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function platformForHost(host: string): PlatformId | null {
  for (const id of PLATFORM_IDS) {
    if (HOSTS[id].some((domain) => hostMatches(host, domain))) return id;
  }
  return PINTEREST_COUNTRY_HOST.test(host) ? "pinterest" : null;
}

/** Light per-platform check that the link points at a single post/video, not a profile or home page. */
function looksLikeVideoLink(platform: PlatformId, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  switch (platform) {
    case "instagram":
      return /(?:^|\/)(reel|reels|p|tv)\/[A-Za-z0-9_-]+/i.test(path);
    case "youtube":
      if (hostMatches(host, "youtu.be")) return /^\/[A-Za-z0-9_-]{6,}/.test(path);
      return (
        (path === "/watch" && url.searchParams.has("v")) ||
        /^\/(shorts|live|embed|v)\/[A-Za-z0-9_-]+/.test(path)
      );
    case "facebook":
      if (hostMatches(host, "fb.watch")) return /^\/[A-Za-z0-9_-]+/.test(path);
      return (
        /\/(reel|reels|videos|share\/(v|r|p))\/[A-Za-z0-9_.-]+/.test(path) ||
        path.startsWith("/watch") ||
        path.startsWith("/video.php")
      );
    case "threads":
      return /\/(post|t)\/[A-Za-z0-9_-]+/.test(path);
    case "x":
      return /\/status(es)?\/\d+/.test(path);
    case "pinterest":
      if (hostMatches(host, "pin.it")) return /^\/[A-Za-z0-9_-]+/.test(path);
      return /\/pin\/[A-Za-z0-9_-]+/.test(path);
    case "tiktok":
      return (
        /\/video\/\d+/.test(path) ||
        /^\/t\/[A-Za-z0-9_-]+/.test(path) ||
        (/^(vm|vt)\./.test(host) && /^\/[A-Za-z0-9_-]+/.test(path))
      );
  }
}

const TRACKING_PARAMS = new Set([
  "igsh",
  "igshid",
  "si",
  "feature",
  "fbclid",
  "gclid",
  "s",
  "t",
  "ref",
  "ref_src",
  "ref_url",
  "mibextid",
  "share_id",
  "is_from_webapp",
  "sender_device",
  "_r",
  "_t",
]);

function stripTracking(url: URL): URL {
  const cleaned = new URL(url.toString());
  cleaned.hash = "";
  for (const key of [...cleaned.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      cleaned.searchParams.delete(key);
    }
  }
  return cleaned;
}

export type ParsedVideoUrl = {
  platform: PlatformId;
  /** Canonical link with tracking parameters removed. */
  url: string;
};

/**
 * Detects the platform of a pasted link and returns a cleaned URL, or null
 * when it isn't a supported video/post link. Accepts links without a scheme.
 */
export function parseSupportedUrl(raw: string): ParsedVideoUrl | null {
  let text = raw.trim();
  if (!text || text.length > 500 || /\s/.test(text)) return null;
  if (!/^https?:\/\//i.test(text)) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(text)) return null;
    text = `https://${text}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const platform = platformForHost(parsed.hostname.toLowerCase());
  if (!platform || !looksLikeVideoLink(platform, parsed)) return null;

  if (platform === "instagram") {
    const canonical = normalizeInstagramUrl(parsed.toString());
    return canonical ? { platform, url: canonical } : null;
  }
  return { platform, url: stripTracking(parsed).toString() };
}

/** Platform of any supported-host link, even one that isn't a video link yet. */
export function detectPlatform(raw: string): PlatformId | null {
  return parseSupportedUrl(raw)?.platform ?? null;
}
