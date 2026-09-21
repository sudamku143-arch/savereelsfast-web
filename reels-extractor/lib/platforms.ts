import { normalizeInstagramUrl } from "@/lib/instagram";

export const PLATFORM_IDS = [
  "instagram",
  "youtube",
  "facebook",
  "threads",
  "x",
  "pinterest",
  "tiktok",
  "reddit",
  "snapchat",
  "linkedin",
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
  reddit: ["reddit.com", "redd.it"],
  snapchat: ["snapchat.com"],
  linkedin: ["linkedin.com"],
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
      return (
        /(?:^|\/)(reel|reels|p|tv)\/[A-Za-z0-9_-]+/i.test(path) ||
        /^\/share\/[A-Za-z0-9_/-]+/i.test(path)
      );
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
      // /share/… links are redirects that the scraper follows.
      return /\/(post|t|share)\/[A-Za-z0-9_-]+/.test(path);
    case "x":
      return /\/status(es)?\/\d+/.test(path);
    case "pinterest":
      if (hostMatches(host, "pin.it")) return /^\/[A-Za-z0-9_-]+/.test(path);
      return /\/pin\/[A-Za-z0-9_-]+/.test(path);
    case "reddit":
      if (host === "v.redd.it" || host === "redd.it") return /^\/[A-Za-z0-9]+/.test(path);
      return /\/comments\/[A-Za-z0-9]+/.test(path) || /\/s\/[A-Za-z0-9]+/.test(path);
    case "snapchat":
      if (host === "t.snapchat.com") return /^\/[A-Za-z0-9_-]+/.test(path);
      return /^\/(spotlight|story|t)\/[A-Za-z0-9_-]+/.test(path);
    case "linkedin":
      // A public post: /posts/<slug>-<id>-<code>, or /feed/update/urn:li:<activity|ugcPost|share>:<id>.
      return /^\/posts\/[^/]+-\d+-\w{4}\/?$/.test(path) || /^\/feed\/update\/urn:li:(activity|ugcPost|share):\d+/.test(path);
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
  "u_code",
  "xmt",
  "rcm",
  "trk",
  "trackingid",
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
  // Whitespace and control characters (newlines, NUL, ...) never belong in a video link.
  if (!text || text.length > 500 || /[\s\u0000-\u001f\u007f]/.test(text)) return null;
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
  // No embedded credentials (https://user:pass@youtube.com/...) and no custom ports: neither
  // belongs in a video link, and both are classic tricks for smuggling a request elsewhere.
  if (parsed.username || parsed.password || parsed.port) return null;

  const platform = platformForHost(parsed.hostname.toLowerCase());
  if (!platform || !looksLikeVideoLink(platform, parsed)) return null;

  if (platform === "instagram") {
    const canonical = normalizeInstagramUrl(parsed.toString());
    // Share links (/share/reel/…) can't be canonicalised here; the scraper resolves them.
    return { platform, url: canonical ?? stripTracking(parsed).toString() };
  }
  return { platform, url: stripTracking(parsed).toString() };
}

/** Platform of any supported-host link, even one that isn't a video link yet. */
export function detectPlatform(raw: string): PlatformId | null {
  return parseSupportedUrl(raw)?.platform ?? null;
}
