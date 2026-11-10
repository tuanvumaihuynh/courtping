import { describe, expect, it } from "vitest";
import { cleanup } from "../src/cleanup.ts";
import worker from "../src/index.ts";
import { jitterMs, run } from "../src/run.ts";
import { upcomingDates, windowsFor } from "../src/time.ts";
import type { Env } from "../src/types.ts";

type Fetch = typeof fetch;

const KEY = "0123456789abcdef0123456789abcdef";
const RUNTIME = { version: "1.0.0", base_url: "https://user-global.alobo.vn", response_key: KEY, app_salt: "salt" };
const CONFIG = {
  venues: ["an-khanh"],
  sessions: [{ weekdays: ["tue"], from: "18:00", to: "20:00", duration_minutes: 120, courts: 2 }],
  lookahead_days: 7,
  backoff_hours: 6,
};
// Thu 2026-11-05 10:00 in Vietnam → the next Tuesday is 2026-11-10.
const NOW = Date.parse("2026-11-05T10:00:00+07:00");
const HOUR = 3_600_000;

async function encrypt(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(KEY), "AES-CBC", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { enc: true, iv: Buffer.from(iv).toString("base64"), data: Buffer.from(data).toString("base64") };
}

function setup() {
  const kv = new Map<string, string>();
  const sent: string[] = [];
  const requests: string[] = [];
  const telegram: Array<{ method: string; body: Record<string, unknown> }> = [];
  const scenario = {
    version: "1.0.0",
    alobo: "ok" as "ok" | "429" | "429-reset" | "bad-key",
    courts: ["c1", "c2"],
    telegram: "ok" as "ok" | "down",
    bookingRules: { oneTimeBookingBefore: 7, oneTimeBookingEndMonth: false },
  };
  const env: Env = {
    CONFIG: JSON.stringify(CONFIG),
    ALOBO_RUNTIME: JSON.stringify(RUNTIME),
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "1",
    RUN_TOKEN: "secret",
    STATE: {
      get: async (key) => (kv.has(key) ? JSON.parse(kv.get(key)!) : null),
      put: async (key, value) => void kv.set(key, value),
      delete: async (key) => void kv.delete(key),
      list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    },
  };
  const fetchMock: Fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("api.telegram.org")) {
      if (scenario.telegram !== "ok") return Response.json({ ok: false, description: "chat not found" }, { status: 400 });
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init?.body));
      telegram.push({ method, body });
      if (method !== "sendMessage") return Response.json({ ok: true, result: true });
      sent.push(body.text);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    if (url.endsWith("/version.json")) return Response.json({ version: scenario.version });
    if (scenario.alobo === "429") return Response.json({ message: "too many" }, { status: 429 });
    if (scenario.alobo === "429-reset") {
      const reset = String(Math.floor(Date.now() / 1000) + 120);
      return Response.json({ message: "too many" }, { status: 429, headers: { date: new Date().toUTCString(), "x-ratelimit-reset": reset } });
    }
    if (scenario.alobo === "bad-key") return Response.json({ enc: true, iv: btoa("x".repeat(16)), data: btoa("y".repeat(32)) });
    if (url.includes("/get_branch/")) return Response.json(await encrypt(scenario.bookingRules));

    const body = JSON.parse(String(init?.body));
    expect(body.branchIds).toEqual(["sport_clb_cau_long_an_khanh"]);
    expect(body.dateStart).toBe("2026-11-10T11:00:00.000Z");
    expect((init?.headers as Record<string, string>)["x-user-app"]).toMatch(/^[0-9a-f]{64}$/);
    return Response.json(
      await encrypt([
        {
          branchInformation: { id: "sport_clb_cau_long_an_khanh", name: "CLB An Khanh", address: "D2 <HCMC>" },
          availableYard: scenario.courts.map((id) => ({ id, name: `Court ${id}` })),
        },
      ]),
    );
  };
  const tick = (now = NOW) => run(env, { now, fetch: fetchMock });
  const clean = (now: number) => cleanup(env, { now, fetch: fetchMock });
  const edits = () => telegram.filter((c) => c.method !== "sendMessage");
  return { env, kv, sent, requests, telegram, edits, scenario, tick, clean, fetchMock };
}

describe("time", () => {
  it("lists upcoming weekdays in Vietnam time", () => {
    expect(upcomingDates(["tue", "thu"], 7, NOW)).toEqual(["2026-11-05", "2026-11-10", "2026-11-12"]);
    expect(() => upcomingDates(["funday"], 7, NOW)).toThrow(/weekday/);
  });

  it("generates windows on the step grid, including a 24:00 end", () => {
    const windows = windowsFor("2026-11-10", { weekdays: [], from: "18:00", to: "21:00", duration_minutes: 120, courts: 1 });
    expect(windows).toHaveLength(3);
    expect(new Date(windows[0]![0]).toISOString()).toBe("2026-11-10T11:00:00.000Z");
    expect(windowsFor("2026-11-10", { weekdays: [], from: "22:00", to: "24:00", duration_minutes: 120, courts: 1 })).toHaveLength(1);
  });
});

describe("run", () => {
  it("announces a new slot once and again after it frees up again", async () => {
    const t = setup();
    await t.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain("CLB An Khanh");
    expect(t.sent[0]).toContain("T3 10/11");
    expect(t.sent[0]).toContain("18:00–20:00 · 2 sân: Court c1, Court c2");
    expect(t.sent[0]).toContain("D2 &lt;HCMC&gt;");

    await t.tick();
    expect(t.sent).toHaveLength(1);

    t.scenario.courts = ["c1"]; // only one court left → no match
    await t.tick();
    t.scenario.courts = ["c1", "c3"];
    await t.tick();
    expect(t.sent).toHaveLength(2);
  });

  it("on 429 reports once, backs off without requests, then reports recovery", async () => {
    const t = setup();
    t.scenario.alobo = "429";
    await t.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain("rate_limited");
    expect(t.sent[0]).toContain("Tạm dừng tới");

    const before = t.requests.length;
    expect((await t.tick(NOW + HOUR)).skipped).toMatch(/backing off/);
    expect(t.requests).toHaveLength(before);

    t.scenario.alobo = "ok";
    await t.tick(NOW + 7 * HOUR);
    expect(t.sent).toHaveLength(3);
    expect(t.sent[1]).toContain("Có sân trống mới");
    expect(t.sent[2]).toContain("chạy lại bình thường");
  });

  it("pauses only until the window resets when Alobo says when (at least 5 minutes)", async () => {
    const t = setup();
    t.scenario.alobo = "429-reset"; // resets in 2 minutes
    const { state } = await t.tick();
    expect(state.blockedUntil! - NOW).toBe(5 * 60_000);
    expect(t.sent[0]).toContain("rate_limited");
  });

  it("reports the same error only once", async () => {
    const t = setup();
    t.scenario.alobo = "bad-key";
    await t.tick();
    await t.tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain("decode_error");
  });

  it("asks for a redeploy when the Alobo frontend version changes", async () => {
    const t = setup();
    t.scenario.version = "2.0.0";
    await t.tick();
    expect(t.sent[0]).toContain("frontend_changed");
    expect(t.sent[0]).toContain("task deploy");
    expect(t.requests.filter((u) => u.includes("user-global"))).toHaveLength(0);
  });

  it("reports a broken config", async () => {
    const t = setup();
    t.env.CONFIG = "{not json";
    await t.tick();
    expect(t.sent[0]).toContain("config_error");
  });

  it("re-sends slots after Telegram comes back", async () => {
    const t = setup();
    t.scenario.telegram = "down";
    await t.tick();
    t.scenario.telegram = "ok";
    await t.tick();
    expect(t.sent.some((m) => m.includes("Có sân trống mới"))).toBe(true);
  });
});

describe("booking horizon", () => {
  it("skips dates the venue does not take bookings for yet", async () => {
    const t = setup();
    t.scenario.bookingRules = { oneTimeBookingBefore: 2, oneTimeBookingEndMonth: false }; // open through 07/11
    const result = await t.tick();
    expect(t.sent).toHaveLength(0);
    expect(t.requests.filter((u) => u.includes("get_filtered_branch_booking"))).toHaveLength(0);
    expect(result.state.rules?.sport_clb_cau_long_an_khanh).toMatchObject({ daysAhead: 2, untilEndOfMonth: false });
  });

  it("treats untilEndOfMonth as open through the last day of the month", async () => {
    const t = setup();
    t.scenario.bookingRules = { oneTimeBookingBefore: 0, oneTimeBookingEndMonth: true };
    await t.tick();
    expect(t.sent).toHaveLength(1);
  });

  it("reads booking rules once a day", async () => {
    const t = setup();
    await t.tick();
    await t.tick(NOW + 3_600_000);
    expect(t.requests.filter((u) => u.includes("/get_branch/"))).toHaveLength(1);
    await t.tick(NOW + 25 * 3_600_000);
    expect(t.requests.filter((u) => u.includes("/get_branch/"))).toHaveLength(2);
  });
});

describe("http trigger", () => {
  it("requires the run token", async () => {
    const t = setup();
    expect((await worker.fetch(new Request("https://x/run", { method: "POST" }), t.env)).status).toBe(401);
    expect((await worker.fetch(new Request("https://x/"), t.env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://x/run", { method: "POST" }), { ...t.env, RUN_TOKEN: undefined })).status).toBe(404);
  });
});

describe("state for commands", () => {
  it("keeps every free slot, the last run and venue names", async () => {
    const t = setup();
    t.scenario.bookingRules = { ...t.scenario.bookingRules, name: "CLB An Khanh", address: "D2" } as typeof t.scenario.bookingRules;
    const { state } = await t.tick();
    expect(state.free).toHaveLength(1);
    expect(state.free![0]!.courts).toEqual(["Court c1", "Court c2"]);
    expect(state.lastRun).toMatchObject({ ok: true, windows: 1 });
    expect(state.lastSuccessAt).toBe(NOW);
    expect(state.rules!["sport_clb_cau_long_an_khanh"]!.name).toBe("CLB An Khanh");

    const again = await t.tick(NOW + 60_000); // already announced, still listed as free
    expect(again.state.free).toHaveLength(1);
    t.scenario.alobo = "429";
    const failed = await t.tick(NOW + 120_000);
    expect(failed.state.lastRun).toMatchObject({ ok: false });
    expect(failed.state.free).toHaveLength(1);
    expect(failed.state.lastSuccessAt).toBe(NOW + 60_000);
  });
});

describe("cron after jitter", () => {
  it("skips when another run started after the cron fired", async () => {
    const t = setup();
    await t.tick(NOW + 60_000); // manual run during the cron's jitter sleep
    const cron = await run(t.env, { now: NOW + 180_000, fetch: t.fetchMock, skipIfRanSince: NOW });
    expect(cron.skipped).toMatch(/already ran/);
    expect(t.sent).toHaveLength(1);

    const next = await run(t.env, { now: NOW + HOUR, fetch: t.fetchMock, skipIfRanSince: NOW + HOUR });
    expect(next.skipped).toBeUndefined();
  });
});

describe("cleanup", () => {
  const msgKeys = (kv: Map<string, string>) => [...kv.keys()].filter((k) => k.startsWith("msg:"));

  it("deletes a message once its slots are gone", async () => {
    const t = setup();
    await t.tick();
    expect(msgKeys(t.kv)).toEqual(["msg:1"]);
    await t.clean(NOW + 60_000);
    expect(t.edits()).toHaveLength(0); // still free, nothing to change

    t.scenario.courts = ["c1"];
    await t.tick(NOW + HOUR);
    await t.clean(NOW + HOUR + 60_000);
    expect(t.edits()).toEqual([{ method: "deleteMessage", body: { chat_id: "1", message_id: 1 } }]);
    expect(msgKeys(t.kv)).toEqual([]);
  });

  it("strikes a message through when it is too old to delete", async () => {
    const t = setup();
    await t.tick();
    t.scenario.courts = ["c1"];
    await t.tick(NOW + 50 * HOUR);
    await t.clean(NOW + 50 * HOUR + 60_000);
    const [edit] = t.edits();
    expect(edit!.method).toBe("editMessageText");
    expect(edit!.body.text).toContain("<s>CLB An Khanh · T3 10/11</s> · hết sân");
    expect(edit!.body.text).toContain("Có sân trống mới");
    expect(msgKeys(t.kv)).toEqual([]);
  });

  it("updates the courts once, and treats past slots as gone", async () => {
    const t = setup();
    await t.tick();
    t.scenario.courts = ["c1", "c2", "c3"];
    await t.tick(NOW + HOUR);
    await t.clean(NOW + HOUR + 60_000);
    await t.clean(NOW + HOUR + 120_000);
    expect(t.edits()).toHaveLength(1);
    expect(t.edits()[0]!.body.text).toContain("3 sân: Court c1, Court c2, Court c3");
    expect(msgKeys(t.kv)).toEqual(["msg:1"]);

    const afterSlot = Date.parse("2026-11-10T20:30:00+07:00");
    await t.clean(afterSlot); // older than 48 h by then, so struck through
    expect(t.edits()[1]!.body.text).toContain("hết sân");
    expect(msgKeys(t.kv)).toEqual([]);
  });

  it("forgets a message someone already deleted", async () => {
    const t = setup();
    await t.tick();
    t.scenario.courts = ["c1"];
    await t.tick(NOW + HOUR);
    t.fetchMock = (async () => Response.json({ ok: false, description: "Bad Request: message to delete not found" }, { status: 400 })) as Fetch;
    const log = await cleanup(t.env, { now: NOW + HOUR + 60_000, fetch: t.fetchMock });
    expect(log[0]).toMatch(/dropped 1/);
    expect(msgKeys(t.kv)).toEqual([]);
  });

  it("runs on a cleanup cron instead of a check", async () => {
    const t = setup();
    await t.tick();
    t.env.CONFIG = JSON.stringify({ ...CONFIG, cleanup_crons: ["30 * * * *"] });
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron: "30 * * * *", scheduledTime: NOW }, t.env, { waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending);
    expect(t.requests.filter((u) => u.includes("alobo")).length).toBe(3); // only the first check
  });
});

describe("jitterMs", () => {
  it("delays up to jitter_minutes, and not at all when unset or invalid", () => {
    expect(jitterMs(JSON.stringify({ ...CONFIG, jitter_minutes: 5 }), () => 0.5)).toBe(150_000);
    expect(jitterMs(JSON.stringify({ ...CONFIG, jitter_minutes: 5 }), () => 0.999)).toBeLessThan(300_000);
    expect(jitterMs(JSON.stringify(CONFIG), () => 0.5)).toBe(0);
    expect(jitterMs("not json", () => 0.5)).toBe(0);
  });
});
