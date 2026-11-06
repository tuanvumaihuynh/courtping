import type { Session } from "./types.ts";

const VN_OFFSET_MS = 7 * 3600 * 1000; // Asia/Ho_Chi_Minh, no DST
const DAY_MS = 86_400_000;
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Date shifted so that getUTC* returns Vietnam local fields. */
export const vn = (ms: number): Date => new Date(ms + VN_OFFSET_MS);
const pad = (n: number): string => String(n).padStart(2, "0");
export const hhmm = (ms: number): string => `${pad(vn(ms).getUTCHours())}:${pad(vn(ms).getUTCMinutes())}`;
export const ddmm = (ms: number): string => `${pad(vn(ms).getUTCDate())}/${pad(vn(ms).getUTCMonth() + 1)}`;
export const isoDay = (ms: number): string => vn(ms).toISOString().slice(0, 10);
export const weekday = (ms: number): number => vn(ms).getUTCDay();

/** Local ISO dates in [today, today + lookahead] that fall on one of `weekdays`. */
export function upcomingDates(weekdays: string[], lookahead: number, now: number): string[] {
  const wanted = new Set(
    weekdays.map((w) => {
      const day = WEEKDAYS[w.toLowerCase().slice(0, 3)];
      if (day === undefined) throw new Error(`unknown weekday "${w}"`);
      return day;
    }),
  );
  const out: string[] = [];
  for (let i = 0; i <= lookahead; i++) {
    const d = now + i * DAY_MS;
    if (wanted.has(weekday(d))) out.push(isoDay(d));
  }
  return out;
}

/** Candidate [start, end) windows (epoch ms) for one session on one local date. */
export function windowsFor(day: string, s: Session): Array<[number, number]> {
  const step = (s.step_minutes ?? 30) * 60_000;
  const duration = s.duration_minutes * 60_000;
  const start = Date.parse(`${day}T${s.from}:00+07:00`);
  const limit = s.to === "24:00" ? Date.parse(`${day}T00:00:00+07:00`) + DAY_MS : Date.parse(`${day}T${s.to}:00+07:00`);
  if (Number.isNaN(start) || Number.isNaN(limit) || step <= 0 || duration <= 0) {
    throw new Error(`invalid session ${JSON.stringify(s)}`);
  }
  const out: Array<[number, number]> = [];
  for (let t = start; t + duration <= limit; t += step) out.push([t, t + duration]);
  return out;
}
