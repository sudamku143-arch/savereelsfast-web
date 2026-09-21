// Timing for the "Processing your link..." loader. Kept free of React so plain Node can test it.
//
// The steps are a guide to what is happening, not a measurement: they advance with time and stop on the last one
// (nothing here pretends to know a percentage). After SLOW_AFTER_MS a short note says the lookup is still running,
// which is when visitors are most likely to give up.

/** How long each step is shown before the next one. */
export const STEP_MS = 2400;

/** After this long, add "still working" so a slow lookup does not look stuck. */
export const SLOW_AFTER_MS = 8000;

/** Which of `count` steps to show after `elapsedMs`: it advances every STEP_MS and stays on the last one. */
export function stepIndex(elapsedMs: number, count: number): number {
  if (count <= 0) return 0;
  const step = Math.floor(Math.max(0, elapsedMs) / STEP_MS);
  return Math.min(step, count - 1);
}

export function isSlow(elapsedMs: number): boolean {
  return elapsedMs >= SLOW_AFTER_MS;
}
