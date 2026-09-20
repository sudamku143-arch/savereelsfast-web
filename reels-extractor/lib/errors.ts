/** Machine-readable failure codes returned by /api/extract and /api/download. */
export const ERROR_CODES = [
  "LOGIN_REQUIRED", // private, age-restricted or behind a login wall
  "UNSUPPORTED_POST", // valid link, but a photo/text/story post with no video
  "STREAM_EXPIRED_OR_BLOCKED", // CDN returned 403 / link expired / IP mismatch
  "PLATFORM_TIMEOUT", // upstream service unreachable or too slow
  "EXTRACTION_FAILED", // generic: private, deleted, region-restricted, unknown
  "INVALID_URL", // not a supported video link
  "NOT_CONFIGURED", // scraper service needed for this platform isn't set up
  "SERVER_BUSY", // the scraper is at capacity; retry in a few seconds
  "FILE_TOO_LARGE", // a YouTube video bigger than the per-file limit for downloads that cost proxy bandwidth
  "RATE_LIMITED", // this visitor sent too many requests too quickly
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Non-fatal condition attached to a successful result. */
export type ResultWarning = "NO_AUDIO";
