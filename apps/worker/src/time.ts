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

function cronField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out];
}

/**
 * Minutes after midnight, Vietnam time and sorted, at which daily cron expressions (UTC) fire.
 * Null when any expression restricts day of month, month or weekday, or cannot be read.
 */
export function cronTimesOfDay(crons: string[]): number[] | null {
  const out = new Set<number>();
  for (const cron of crons) {
    const [minute, hour, ...rest] = cron.trim().split(/\s+/);
    if (rest.length !== 3 || rest.some((f) => f !== "*")) return null;
    const minutes = cronField(minute!, 0, 59);
    const hours = cronField(hour!, 0, 23);
    if (!minutes || !hours) return null;
    for (const h of hours) for (const m of minutes) out.add((h * 60 + m + VN_OFFSET_MS / 60_000) % 1440);
  }
  return [...out].sort((a, b) => a - b);
}

/** The first time after `now` that falls on one of `timesOfDay` (minutes after midnight, Vietnam). */
export function nextTimeOfDay(timesOfDay: number[], now: number): number | null {
  if (timesOfDay.length === 0) return null;
  const midnight = Date.parse(`${isoDay(now)}T00:00:00+07:00`);
  for (const day of [0, 1]) {
    for (const t of timesOfDay) {
      const at = midnight + day * DAY_MS + t * 60_000;
      if (at > now) return at;
    }
  }
  return null;
}
