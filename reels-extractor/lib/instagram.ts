export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SHORTCODE_REGEX =
  /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;

/**
 * Reduces any Instagram post link to its canonical form, dropping tracking
 * parameters (igsh, utm_*, …), fragments and username prefixes:
 *   https://www.instagram.com/reel/SHORTCODE/  or  /p/SHORTCODE/  or  /tv/SHORTCODE/
 * Returns null when the input is not an Instagram post link.
 */
export function normalizeInstagramUrl(raw: string): string | null {
  // /share/reel/CODE links carry a share code, not the post's shortcode.
  if (/instagram\.com\/share\//i.test(raw)) return null;
  const match =
    /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i.exec(
      raw
    );
  if (!match) return null;
  const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
  return `https://www.instagram.com/${kind}/${match[2]}/`;
}

export function parseShortcode(url: string): string | null {
  return SHORTCODE_REGEX.exec(url)?.[1] ?? null;
}

/**
 * CDN hosts we are willing to fetch or proxy. Everything else is refused, which
 * keeps the download proxy from being used to reach arbitrary or internal addresses.
 */
const MEDIA_HOST_SUFFIXES = [
  // Instagram / Facebook / Threads
  "cdninstagram.com",
  "fbcdn.net",
  // YouTube
  "googlevideo.com",
  "ytimg.com",
  // X / Twitter
  "twimg.com",
  // Pinterest
  "pinimg.com",
  // TikTok
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokv.com",
  "tiktokv.us",
  "tiktok.com",
  "byteoversea.com",
  "ibytedtos.com",
  "muscdn.com",
  // Reddit (v.redd.it videos, preview.redd.it / external-preview thumbnails)
  "redd.it",
  "redditmedia.com",
  // Snapchat
  "sc-cdn.net",
];

/**
 * Hosts of the optional Cobalt fallback (YouTube, when yt-dlp is blocked). The same COBALT_API_URL setting the
 * scraper reads; empty when the fallback is off. Only https instance hosts count.
 */
export function cobaltHosts(env: string | undefined = process.env.COBALT_API_URL): string[] {
  const hosts: string[] = [];
  for (const part of (env ?? "").split(",")) {
    try {
      const url = new URL(part.trim());
      if (url.protocol === "https:" && !url.username && !url.password && !url.port) hosts.push(url.hostname.toLowerCase());
    } catch {
      // not a URL: ignore it
    }
  }
  return hosts;
}

export function isCobaltUrl(raw: string, env?: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !parsed.port && cobaltHosts(env).includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isAllowedMediaUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  return (
    MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
    cobaltHosts().includes(host)
  );
}

/** Referer that the CDN for `mediaUrl` expects. */
export function refererFor(mediaUrl: string): string {
  try {
    const host = new URL(mediaUrl).hostname.toLowerCase();
    if (/tiktok|byteoversea|ibytedtos|muscdn/.test(host)) return "https://www.tiktok.com/";
    if (host.endsWith("googlevideo.com") || host.endsWith("ytimg.com")) return "https://www.youtube.com/";
    if (host.endsWith("twimg.com")) return "https://x.com/";
    if (host.endsWith("redd.it") || host.endsWith("redditmedia.com")) return "https://www.reddit.com/";
    if (host.endsWith("sc-cdn.net")) return "https://www.snapchat.com/";
    if (host.endsWith("pinimg.com")) return "https://www.pinterest.com/";
  } catch {
    // fall through
  }
  return "https://www.instagram.com/";
}

/** Turns a JSON-escaped fragment such as `https:\/\/a.com\/x?y=1&z=2` into a plain string. */
export function unescapeJsonFragment(value: string): string {
  return value
    .replace(/\\+u0026/gi, "&")
    .replace(/\\+u002f/gi, "/")
    .replace(/\\+\//g, "/")
    .replace(/\\+$/g, "");
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    );
}

/** Depth-limited search for the first value stored under `key` anywhere in a JSON tree. */
export function findFirst(node: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirst(item, key, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (key in record && record[key] !== null && record[key] !== undefined) {
    return record[key];
  }
  for (const value of Object.values(record)) {
    const hit = findFirst(value, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}
