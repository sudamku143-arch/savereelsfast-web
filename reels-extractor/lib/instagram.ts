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
 * Only Instagram/Facebook CDN hosts may be fetched or proxied. This keeps the
 * download proxy from being used to reach arbitrary or internal addresses.
 */
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
    host.endsWith(".cdninstagram.com") ||
    host.endsWith(".fbcdn.net") ||
    host === "cdninstagram.com"
  );
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
