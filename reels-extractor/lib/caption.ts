/**
 * The caption tools on the result card: the whole caption, or just its hashtags, ready to paste.
 */

// A hashtag is "#" followed by letters, marks, digits or "_" in any script (#मुंबई, #café, #2026 ...),
// and not glued to a word before it (so "abc#def" or a URL fragment is not a hashtag).
const HASHTAG = /(^|[^\p{L}\p{M}\p{N}_&/#])#([\p{L}\p{M}\p{N}_]+)/gu;

/** Every distinct hashtag in the text, in order, with its "#" (case kept from its first use). */
export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const match of text.matchAll(HASHTAG)) {
    const tag = `#${match[2]}`;
    const key = tag.toLocaleLowerCase();
    if (/^#\d+$/.test(tag) || seen.has(key)) continue; // "#1" is a number, not a tag
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** Hashtags as one line, the way people paste them into a new post. */
export function hashtagLine(text: string | null | undefined): string {
  return extractHashtags(text).join(" ");
}

/** File extension of a thumbnail URL (jpg when it doesn't say). */
export function imageExtOf(url: string): "jpg" | "webp" | "png" {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".webp")) return "webp";
    if (path.endsWith(".png")) return "png";
  } catch {
    /* fall through */
  }
  return "jpg";
}
