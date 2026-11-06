import { BADMINTON, type CatalogVenue } from "./client.ts";

/** Lowercase and strip Vietnamese diacritics, so "an khanh" matches "An Khánh". */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const x =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}

export function parseLatLng(value: string): { lat: number; lng: number } {
  const [lat, lng] = value.split(",").map((part) => Number(part.trim()));
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`expected LAT,LNG, got "${value}"`);
  }
  return { lat, lng };
}

const tokens = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** True when the query words appear in order as consecutive whole words, or each appears as a whole word. */
function matchesWords(text: string[], words: string[]): boolean {
  const joined = ` ${text.join(" ")} `;
  return joined.includes(` ${words.join(" ")} `) || words.every((w) => text.includes(w));
}

export interface VenueQuery {
  query?: string;
  near?: { lat: number; lng: number };
  radiusKm?: number;
  includeInactive?: boolean;
}

export interface VenueResult extends CatalogVenue {
  /** Straight-line distance from `near`, when given. */
  distanceKm?: number;
}

/** Badminton venues matching every given filter, nearest first when `near` is set, else by name. */
export function searchVenues(catalog: CatalogVenue[], q: VenueQuery): VenueResult[] {
  const words = q.query ? tokens(q.query) : [];
  const results: VenueResult[] = [];
  for (const venue of catalog) {
    if (venue.sport !== BADMINTON || (!venue.active && !q.includeInactive)) continue;
    if (words.length && !matchesWords(tokens(`${venue.name} ${venue.address}`), words)) continue;
    if (q.near) {
      if (venue.lat === null || venue.lng === null) continue;
      const d = distanceKm(q.near, { lat: venue.lat, lng: venue.lng });
      if (d > (q.radiusKm ?? 5)) continue;
      results.push({ ...venue, distanceKm: Math.round(d * 10) / 10 });
    } else {
      results.push(venue);
    }
  }
  return results.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0) || a.name.localeCompare(b.name, "vi"));
}

/** [start, end) windows in Vietnam time (UTC+7) for each date, on a `stepMinutes` grid. */
export function windows(
  dates: string[],
  from: string,
  to: string,
  durationMinutes: number,
  stepMinutes: number,
): Array<{ date: string; start: number; end: number }> {
  const out: Array<{ date: string; start: number; end: number }> = [];
  for (const date of dates) {
    const start = Date.parse(`${date}T${from}:00+07:00`);
    const limit = to === "24:00" ? Date.parse(`${date}T00:00:00+07:00`) + 86_400_000 : Date.parse(`${date}T${to}:00+07:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(start) || Number.isNaN(limit)) {
      throw new Error(`invalid date or time: ${date} ${from}-${to}`);
    }
    if (durationMinutes <= 0 || stepMinutes <= 0) throw new Error("duration and step must be positive");
    for (let t = start; t + durationMinutes * 60_000 <= limit; t += stepMinutes * 60_000) {
      out.push({ date, start: t, end: t + durationMinutes * 60_000 });
    }
  }
  return out;
}

/** Epoch ms → "HH:MM" in Vietnam time. */
export const vnTime = (ms: number): string => new Date(ms + 7 * 3_600_000).toISOString().slice(11, 16);
