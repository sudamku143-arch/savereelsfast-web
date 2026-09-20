// Kept free of runtime imports so it can be unit-tested with plain Node.

export type RateLimitStore = Map<string, { count: number; resetAt: number }>;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const MAX_TRACKED_CLIENTS = 5000;

/**
 * Fixed-window limiter: at most `limit` requests per `windowMs` for each key.
 *
 * The store lives in one server instance's memory. On a serverless host several instances
 * may run side by side, so this stops bursts and scripts hammering one instance, but it is
 * not a hard global cap; put a WAF / edge rate-limit rule in front for that.
 */
export function checkRateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitResult {
  // Keep memory bounded however many distinct clients show up.
  if (store.size >= MAX_TRACKED_CLIENTS) {
    for (const [k, entry] of store) if (entry.resetAt <= now) store.delete(k);
    if (store.size >= MAX_TRACKED_CLIENTS) store.clear();
  }

  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 };
}

/**
 * The visitor's IP. Vercel puts the real address first in x-forwarded-for and overwrites any
 * value a client tries to send, so it can be trusted there. Returns null when there is none.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers.get("x-real-ip")?.trim();
  return ip && ip.length <= 64 ? ip : null;
}
