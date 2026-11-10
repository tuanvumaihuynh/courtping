import type { BookingRules } from "./booking.ts";
import { AloboError } from "./errors.ts";
import { type RateLimit, readRateLimit } from "./ratelimit.ts";

export const WEB_URL = "https://datlich.alobo.vn";
export const API_URL = "https://user-global.alobo.vn";
const MIN_REQUEST_GAP_MS = 500;
/** Availability allows 10 requests per ~10 s; stay under it even when `remaining` is unreliable. */
const ENDPOINT_GAP_MS: Record<string, number> = { get_filtered_branch_booking_v2: 1200 };
/** Wait out a 429 in place when the window resets this soon; otherwise give up and report it. */
const MAX_RETRY_WAIT_MS = 30_000;
const RESET_MARGIN_MS = 250;

export const VENUE_ALIASES: Record<string, string> = {
  "an-khanh": "sport_clb_cau_long_an_khanh",
  "level-up": "sport_level_up_badminton_tran_nao",
  lavie: "sport_lavie_q2_badminton",
  "khanh-hong": "sport_san_cau_long_khanh_hong",
  "binh-an": "sport_san_cau_long_binh_an",
};

export interface AloboRuntime {
  version: string;
  base_url?: string;
  response_key: string;
  app_salt: string;
}

export interface Venue {
  id: string;
  name: string;
  address: string;
}

/** Catalog `type` for badminton venues. */
export const BADMINTON = 2;
/** Catalog `type` for multi-sport venues, many of which have badminton courts (e.g. Railway Đầu Máy). */
export const MULTI_SPORT = 8;

export interface CatalogVenue {
  id: string;
  name: string;
  address: string;
  sport: number | null;
  active: boolean;
  lat: number | null;
  lng: number | null;
  /** Opening hours as decimal hours, e.g. 5.5 = 05:30. */
  opensAt: number | null;
  closesAt: number | null;
}

export interface Court {
  id: string;
  name: string;
  shortName: string;
  setting: string;
  active: boolean;
}

export interface Availability {
  venue: Venue;
  /** Court names, naturally sorted. */
  courts: string[];
}

export const resolveVenue = (v: string): string => VENUE_ALIASES[v] ?? v;

/**
 * Mixed venues return pickleball courts as free badminton courts (both have yardType 2), and only the
 * court list endpoint marks them. Venues name them "Pickleball N" / "PKN", so filter by name.
 */
export const isPickleballCourt = (court: { name?: string; shortName?: string }): boolean =>
  /pickle/i.test(court.name ?? "") || /^pk\s*\d*$/i.test((court.shortName ?? "").trim());
export const bookingUrl = (venueId: string): string => `${WEB_URL}/san/${encodeURIComponent(venueId)}`;

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pad = (n: number) => String(n).padStart(2, "0");
const base64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `x-user-app` header: sha256("MM/DD/YYYY, HH:MM@salt") with the current UTC minute. */
export function signature(salt: string, now = new Date()): Promise<string> {
  const minute =
    `${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}/${now.getUTCFullYear()}, ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  return sha256Hex(`${minute}@${salt}`);
}

interface Envelope {
  enc?: boolean;
  iv?: string;
  data?: unknown;
  message?: string;
}

/** Encrypted responses are `{enc: true, iv, data}` where data is AES-256-CBC/PKCS7 with the response key. */
export async function decryptEnvelope(envelope: Envelope, key: string): Promise<Envelope> {
  if (envelope.enc !== true) return envelope;
  try {
    if (typeof envelope.iv !== "string" || typeof envelope.data !== "string") throw new Error("missing iv/data");
    const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), "AES-CBC", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: base64(envelope.iv) }, cryptoKey, base64(envelope.data));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ...envelope, data, enc: false };
  } catch (e) {
    throw new AloboError("decode_error", `cannot decrypt response, the key may have changed: ${e}`);
  }
}

export interface ClientOptions {
  /** Minimum gap between any two requests. */
  minGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AloboClient {
  private readonly runtime: AloboRuntime;
  private readonly fetchFn: typeof fetch;
  private readonly minGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastRequestAt = 0;
  private readonly lastByEndpoint = new Map<string, number>();
  private readonly limits = new Map<string, RateLimit>();
  requests = 0;

  constructor(runtime: AloboRuntime, fetchFn: typeof fetch = fetch, options: ClientOptions = {}) {
    this.runtime = runtime;
    // workerd throws "Illegal invocation" if fetch is called as a method of another object.
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.minGapMs = options.minGapMs ?? MIN_REQUEST_GAP_MS;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
  }

  /** How long to wait before the next request to `bucket`, from pacing and the last rate-limit headers. */
  private waitFor(bucket: string): number {
    const now = this.now();
    const gap = Math.max(
      this.minGapMs - (now - this.lastRequestAt),
      (ENDPOINT_GAP_MS[bucket] ?? 0) - (now - (this.lastByEndpoint.get(bucket) ?? 0)),
    );
    const limit = this.limits.get(bucket);
    const exhausted =
      limit?.remaining != null && limit.remaining <= 1 && limit.resetAt != null && limit.resetAt > now
        ? limit.resetAt - now + RESET_MARGIN_MS
        : 0;
    return Math.max(0, gap, exhausted);
  }

  /** Throws `frontend_changed` when the live frontend no longer matches the runtime's version. */
  async checkVersion(): Promise<void> {
    this.requests++;
    const res = await this.fetchFn(`${WEB_URL}/version.json`, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new AloboError("http_error", `version.json returned HTTP ${res.status}`, res.status);
    const live = ((await res.json()) as { version?: string }).version;
    if (live !== this.runtime.version) {
      throw new AloboError("frontend_changed", `frontend changed from ${this.runtime.version} to ${live}`);
    }
  }

  private async call(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<unknown> {
    const bucket = endpoint.split("/")[0]!;
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      const wait = this.waitFor(bucket);
      if (wait > 0) await this.sleep(wait);
      const headers: Record<string, string> = {
        "x-user-app": await signature(this.runtime.app_salt),
        "x-version-app": this.runtime.version,
        "x-name-app": "alobo-user",
        "x-platform": "web",
        "x-custom-lang": "vi",
        Origin: WEB_URL,
        Referer: `${WEB_URL}/`,
        "User-Agent": "courtping",
      };
      if (body !== undefined) headers["content-type"] = "application/json";

      try {
        res = await this.fetchFn(`${API_URL}/v2/user/branch/${endpoint}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw new AloboError("network_error", `request failed: ${e}`);
      } finally {
        this.requests++;
        this.lastRequestAt = this.now();
        this.lastByEndpoint.set(bucket, this.lastRequestAt);
      }
      const limit = readRateLimit(res.headers, this.now());
      this.limits.set(bucket, limit);

      if (res.status !== 429) break;
      const retryInMs = limit.resetAt === null ? null : Math.max(0, limit.resetAt - this.now()) + RESET_MARGIN_MS;
      if (attempt === 0 && retryInMs !== null && retryInMs <= MAX_RETRY_WAIT_MS) {
        await this.sleep(retryInMs);
        continue;
      }
      const message = await res
        .json()
        .then((j) => (j as Envelope).message ?? "")
        .catch(() => "");
      throw new AloboError("rate_limited", `HTTP 429 ${message}`.trim(), 429, retryInMs ?? undefined);
    }

    if (!res.ok) {
      const message = await res
        .json()
        .then((j) => (j as Envelope).message ?? "")
        .catch(() => "");
      throw new AloboError("http_error", `HTTP ${res.status} ${message}`.trim(), res.status);
    }

    let envelope: Envelope;
    try {
      envelope = (await res.json()) as Envelope;
    } catch {
      throw new AloboError("decode_error", "response is not JSON");
    }
    const { data } = await decryptEnvelope(envelope, this.runtime.response_key);
    if (data == null) throw new AloboError("missing_data", "response has no data");
    if (typeof data !== "string") return data;
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  /** Every venue in the catalog, all sports and statuses. One request (~3000 rows). */
  async catalog(): Promise<CatalogVenue[]> {
    const data = (await this.call("GET", "branches")) as { branches?: unknown };
    if (!Array.isArray(data?.branches)) throw new AloboError("schema_changed", "branches response has no list");
    return (data.branches as Array<Record<string, unknown>>).flatMap((b): CatalogVenue[] => {
      if (typeof b.id !== "string") return [];
      const loc = (b.location ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
      return [
        {
          id: b.id,
          name: String(b.name ?? b.id),
          address: String(b.address ?? ""),
          sport: num(b.type),
          active: num(b.status) === 1,
          lat: num(loc._latitude ?? loc.latitude),
          lng: num(loc._longitude ?? loc.longitude),
          opensAt: num(b.morningStartWorkingTime),
          closesAt: num(b.afternoonEndWorkingTime),
        },
      ];
    });
  }

  /** How far ahead the venue takes one-time bookings. */
  async bookingRules(venueId: string): Promise<BookingRules> {
    const data = (await this.call("GET", `get_branch/${encodeURIComponent(venueId)}`)) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) throw new AloboError("schema_changed", "venue response is not an object");
    const days = Number(data.oneTimeBookingBefore);
    return {
      daysAhead: data.oneTimeBookingBefore == null || !Number.isFinite(days) ? null : days,
      untilEndOfMonth: data.oneTimeBookingEndMonth === true,
    };
  }

  /** Courts of one venue. `setting` distinguishes badminton ("san_thuong") from pickleball. */
  async courts(venueId: string): Promise<Court[]> {
    const data = (await this.call("GET", `get_cores/${encodeURIComponent(venueId)}`)) as { cores?: unknown };
    if (!Array.isArray(data?.cores)) throw new AloboError("schema_changed", "courts response has no list");
    return (data.cores as Array<Record<string, unknown>>)
      .filter((c) => typeof c.id === "string")
      .map((c) => ({
        id: c.id as string,
        name: String(c.name ?? c.id),
        shortName: String(c.shortName ?? ""),
        setting: String(c.setting ?? ""),
        active: c.status === 1 || c.status === "1",
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  }

  /** Venues with free courts for the whole [start, end) window (epoch ms). */
  async availability(venueIds: string[], start: number, end: number): Promise<Availability[]> {
    const data = await this.call("POST", "get_filtered_branch_booking_v2", {
      bookingType: "oneTime",
      types: [2],
      branchIds: venueIds,
      dateStart: new Date(start).toISOString(),
      dateEnd: new Date(end).toISOString(),
    });
    if (!Array.isArray(data)) throw new AloboError("schema_changed", "availability response is not a list");

    return data.map((row: unknown): Availability => {
      const { branchInformation: branch, availableYard: yards } = (row ?? {}) as {
        branchInformation?: { id?: string; name?: string; address?: string };
        availableYard?: unknown;
      };
      if (!branch?.id || !Array.isArray(yards)) {
        throw new AloboError("schema_changed", "availability row has no branchInformation/availableYard");
      }
      const courts = new Map<string, string>();
      for (const yard of yards as Array<{ id?: string; name?: string; shortName?: string }>) {
        if (!yard?.id) throw new AloboError("schema_changed", "available court has no id");
        if (isPickleballCourt(yard)) continue;
        if (!courts.has(yard.id)) courts.set(yard.id, yard.shortName || yard.name || yard.id);
      }
      return {
        venue: { id: branch.id, name: branch.name ?? branch.id, address: branch.address ?? "" },
        courts: [...courts.values()].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      };
    });
  }
}
