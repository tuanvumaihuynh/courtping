/** How far ahead a venue accepts one-time bookings, from `get_branch`. */
export interface BookingRules {
  /** Days ahead, counted from today. Ignored when `untilEndOfMonth` is set. */
  daysAhead: number | null;
  /** Bookable through the last day of the current month, whatever `daysAhead` says. */
  untilEndOfMonth: boolean;
}

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Last bookable date (YYYY-MM-DD, Vietnam time), or null when the venue sets no limit.
 * Matches what datlich.alobo.vn shows: TPro (7, false) lists 7 days after today; An Khanh (2, true),
 * The B Hoang Van Thu (0, true) and Binh An (7, true) list every day to the end of the month.
 */
export function lastBookableDate(rules: BookingRules, now: number): string | null {
  const today = new Date(now + VN_OFFSET_MS);
  if (rules.untilEndOfMonth) {
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  if (rules.daysAhead === null) return null;
  return new Date(today.getTime() + rules.daysAhead * DAY_MS).toISOString().slice(0, 10);
}
