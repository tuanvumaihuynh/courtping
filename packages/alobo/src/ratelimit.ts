/**
 * Alobo's API (Express) sends `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`
 * (unix seconds) on every response. Seen on 2026-11-06: availability allows 10 requests per ~10 s,
 * get_branch 30 per ~2 s. Counters look per backend instance, so `remaining` is a hint, not a promise.
 */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  /** When the window resets, on the local clock (ms). */
  resetAt: number | null;
}

const num = (v: string | null): number | null => (v === null || v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Read rate-limit headers, converting server timestamps to the local clock using the `Date` header. */
export function readRateLimit(headers: Headers, localNow: number): RateLimit {
  const serverNow = Date.parse(headers.get("date") ?? "");
  const skew = Number.isNaN(serverNow) ? 0 : localNow - serverNow;
  const reset = num(headers.get("x-ratelimit-reset"));
  let resetAt = reset === null ? null : reset * 1000 + skew;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = num(retryAfter);
    const date = Date.parse(retryAfter);
    if (seconds !== null) resetAt = localNow + seconds * 1000;
    else if (!Number.isNaN(date)) resetAt = date + skew;
  }
  return { limit: num(headers.get("x-ratelimit-limit")), remaining: num(headers.get("x-ratelimit-remaining")), resetAt };
}
