/**
 * Remembers the last few successful lookups in sessionStorage so re-pasting a
 * link, or coming back to the page, renders instantly with no spinner.
 *
 * Entries expire before the server-side link cache does (download links are
 * signed and eventually die), and every storage call is wrapped because
 * sessionStorage throws in private mode or when storage is blocked.
 */

const RESULTS_KEY = "srf:results:v1";
const LAST_KEY = "srf:last:v1";
const DRAFT_KEY = "srf:draft:v1";
export const MAX_CACHED_RESULTS = 5;
export const RESULT_TTL_MS = 45 * 60 * 1000;

type Entry<T> = { url: string; savedAt: number; result: T };

function read<T>(now: number): Entry<T>[] {
  try {
    const raw = sessionStorage.getItem(RESULTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Entry<T> =>
        !!entry &&
        typeof entry.url === "string" &&
        typeof entry.savedAt === "number" &&
        now - entry.savedAt < RESULT_TTL_MS &&
        typeof entry.result === "object"
    );
  } catch {
    return [];
  }
}

function write<T>(entries: Entry<T>[]): void {
  try {
    sessionStorage.setItem(RESULTS_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable: caching is best-effort.
  }
}

export function getCachedResult<T>(url: string, now = Date.now()): T | null {
  return read<T>(now).find((entry) => entry.url === url)?.result ?? null;
}

/** Stores a result as the most recent one and keeps only the newest MAX_CACHED_RESULTS. */
export function putCachedResult<T>(url: string, result: T, now = Date.now()): void {
  const others = read<T>(now).filter((entry) => entry.url !== url);
  write([{ url, savedAt: now, result }, ...others].slice(0, MAX_CACHED_RESULTS));
}

/** The link whose result is currently on screen (so the page can restore it after navigating back). */
export function setLastViewed(url: string | null): void {
  try {
    if (url) sessionStorage.setItem(LAST_KEY, url);
    else sessionStorage.removeItem(LAST_KEY);
  } catch {
    // ignore
  }
}

export function getLastViewed<T>(now = Date.now()): { url: string; result: T } | null {
  try {
    const url = sessionStorage.getItem(LAST_KEY);
    if (!url) return null;
    const result = getCachedResult<T>(url, now);
    return result ? { url, result } : null;
  } catch {
    return null;
  }
}

/** The text in the input box, so it is still there after switching platform (which loads that platform's page). */
export function setDraft(text: string | null): void {
  try {
    if (text) sessionStorage.setItem(DRAFT_KEY, text.slice(0, 2048));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

export function getDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}
