import { describe, expect, it } from "vitest";
import { AloboClient } from "../src/client.ts";
import { AloboError } from "../src/errors.ts";
import { readRateLimit } from "../src/ratelimit.ts";

const RUNTIME = { version: "1.0.0", response_key: "k".repeat(32), app_salt: "salt" };
const T0 = Date.parse("2026-11-06T13:00:00Z");

/** A fake clock whose sleep advances time instantly, plus a scripted Alobo. */
function harness(responses: Array<{ status: number; remaining?: number; resetIn?: number }>) {
  let now = T0;
  const sleeps: number[] = [];
  const calls: number[] = [];
  const fetchMock = async () => {
    calls.push(now);
    const r = responses.shift() ?? { status: 200 };
    const headers = new Headers({ date: new Date(now).toUTCString() });
    if (r.remaining !== undefined) headers.set("x-ratelimit-remaining", String(r.remaining));
    if (r.resetIn !== undefined) headers.set("x-ratelimit-reset", String(Math.floor(now / 1000) + r.resetIn));
    const body = r.status === 200 ? { data: [] } : { message: "Quá nhiều yêu cầu" };
    return Response.json(body, { status: r.status, headers });
  };
  const client = new AloboClient(RUNTIME, fetchMock as typeof fetch, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { client, sleeps, calls, at: () => now };
}

describe("readRateLimit", () => {
  it("converts the reset time to the local clock using the Date header", () => {
    const server = Date.parse("2026-11-06T13:00:00Z");
    const headers = new Headers({
      date: new Date(server).toUTCString(),
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "3",
      "x-ratelimit-reset": String(server / 1000 + 8),
    });
    // local clock 2 s ahead of the server
    expect(readRateLimit(headers, server + 2000)).toEqual({ limit: 10, remaining: 3, resetAt: server + 10_000 });
  });

  it("prefers Retry-After", () => {
    const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset": "1" });
    expect(readRateLimit(headers, T0).resetAt).toBe(T0 + 5000);
  });
});

describe("AloboClient pacing", () => {
  it("spaces availability requests at least 1.2 s apart", async () => {
    const h = harness([]);
    for (let i = 0; i < 3; i++) await h.client.availability(["v"], 0, 1);
    expect(h.calls[1]! - h.calls[0]!).toBeGreaterThanOrEqual(1200);
    expect(h.calls[2]! - h.calls[1]!).toBeGreaterThanOrEqual(1200);
  });

  it("waits for the window to reset once remaining runs out", async () => {
    const h = harness([{ status: 200, remaining: 0, resetIn: 9 }, { status: 200 }]);
    await h.client.availability(["v"], 0, 1);
    await h.client.availability(["v"], 0, 1);
    expect(h.calls[1]! - h.calls[0]!).toBeGreaterThanOrEqual(9000);
  });

  it("retries once after a 429 that resets soon", async () => {
    const h = harness([{ status: 429, remaining: 0, resetIn: 7 }, { status: 200 }]);
    await expect(h.client.availability(["v"], 0, 1)).resolves.toEqual([]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]! - h.calls[0]!).toBeGreaterThanOrEqual(7000);
  });

  it("reports a 429 with its reset time when retrying would take too long or fails again", async () => {
    const far = harness([{ status: 429, remaining: 0, resetIn: 600 }]);
    const e1 = await far.client.availability(["v"], 0, 1).catch((e) => e);
    expect(e1).toBeInstanceOf(AloboError);
    expect(e1).toMatchObject({ code: "rate_limited", status: 429 });
    expect(e1.retryAfterMs).toBeGreaterThanOrEqual(600_000);
    expect(far.calls).toHaveLength(1);

    const twice = harness([{ status: 429, resetIn: 5 }, { status: 429, resetIn: 5 }]);
    await expect(twice.client.availability(["v"], 0, 1)).rejects.toMatchObject({ code: "rate_limited" });
    expect(twice.calls).toHaveLength(2);
  });
});
