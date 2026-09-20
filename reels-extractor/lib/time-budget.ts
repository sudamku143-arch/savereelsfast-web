// Kept free of runtime imports so it can be unit-tested with plain Node.

/**
 * One lookup gets one time budget, shared by every step it takes (the scraper first, then the built-in
 * strategies). Each step may use at most its own limit, and never more than what is left, so the steps
 * cannot add up to a long hang.
 */

/** Milliseconds a step may still use: its own `cap`, but never more than what is left of the budget. */
export function remainingMs(deadline: number, cap: number, now: number = Date.now()): number {
  return Math.max(0, Math.min(cap, deadline - now));
}

/** Below this, starting another request is pointless: it could not finish. */
export const MIN_USEFUL_MS = 400;

export function hasTimeFor(deadline: number, now: number = Date.now()): boolean {
  return deadline - now >= MIN_USEFUL_MS;
}
