import { AloboError } from "./errors.ts";

export const WEB_URL = "https://datlich.alobo.vn";
export const API_URL = "https://user-global.alobo.vn";
const MIN_REQUEST_GAP_MS = 500;

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

export interface Availability {
  venue: Venue;
  /** Court names, naturally sorted. */
  courts: string[];
}

export const resolveVenue = (v: string): string => VENUE_ALIASES[v] ?? v;
export const bookingUrl = (venueId: string): string => `${WEB_URL}/san/${encodeURIComponent(venueId)}`;

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

export class AloboClient {
  private readonly runtime: AloboRuntime;
  private readonly fetchFn: typeof fetch;
  private lastRequestAt = 0;
  requests = 0;

  constructor(runtime: AloboRuntime, fetchFn: typeof fetch = fetch) {
    this.runtime = runtime;
    // workerd throws "Illegal invocation" if fetch is called as a method of another object.
    this.fetchFn = (input, init) => fetchFn(input, init);
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
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
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

    let res: Response;
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
      this.lastRequestAt = Date.now();
    }

    if (!res.ok) {
      const message = await res
        .json()
        .then((j) => (j as Envelope).message ?? "")
        .catch(() => "");
      const code = res.status === 429 ? "rate_limited" : "http_error";
      throw new AloboError(code, `HTTP ${res.status} ${message}`.trim(), res.status);
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
        if (!courts.has(yard.id)) courts.set(yard.id, yard.shortName || yard.name || yard.id);
      }
      return {
        venue: { id: branch.id, name: branch.name ?? branch.id, address: branch.address ?? "" },
        courts: [...courts.values()].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      };
    });
  }
}
