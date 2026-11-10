import { describe, expect, it } from "vitest";
import { handleUpdate, parseCommand, parseTime } from "../src/commands.ts";
import worker from "../src/index.ts";
import { formatSchedule } from "../src/telegram.ts";
import { cronTimesOfDay, nextTimeOfDay } from "../src/time.ts";
import type { Config, Env, Match, State } from "../src/types.ts";

const at = (iso: string) => Date.parse(`${iso}+07:00`);
const NOW = at("2026-11-10T14:00:00");
const CONFIG: Config = {
  venues: ["an-khanh", "sport_hoc_vien_cau_long_tpro"],
  sessions: [{ weekdays: ["mon", "tue", "wed", "thu", "fri"], from: "19:00", to: "22:00", duration_minutes: 120, courts: 1, step_minutes: 60 }],
  lookahead_days: 7,
  preferred_start: "19:00",
  jitter_minutes: 5,
  crons: ["0 0-15 * * *"],
};
const slot = (venue: string, day: string, hour: number): Match => ({
  venue: { id: venue, name: `Venue ${venue}`, address: "Q2" },
  courts: ["CL1"],
  start: at(`${day}T${hour}:00:00`),
  end: at(`${day}T${hour + 2}:00:00`),
});
const STATE: State = {
  seen: {},
  blockedUntil: null,
  error: null,
  rules: { sport_clb_cau_long_an_khanh: { daysAhead: 2, untilEndOfMonth: true, name: "CLB An Khánh", address: "Q2", fetchedAt: NOW } },
  free: [slot("a", "2026-11-12", 19), slot("b", "2026-11-12", 20), slot("a", "2026-11-09", 19)],
  lastRun: { at: NOW - 12 * 60_000, ok: true, windows: 12, requests: 13 },
  lastSuccessAt: NOW - 12 * 60_000,
};

function setup(state: State | null = STATE, config: unknown = CONFIG) {
  const sent: Array<{ text: string; reply_parameters?: { message_id: number } }> = [];
  const env: Env = {
    CONFIG: JSON.stringify(config),
    ALOBO_RUNTIME: "{}",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "-100",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    STATE: { get: async () => state, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
  };
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("api.telegram.org")) throw new Error(`unexpected request to ${input}`);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const say = (text: string, chat: number | string = -100) =>
    handleUpdate(env, { message: { message_id: 7, chat: { id: chat }, text } }, NOW, fetchMock);
  return { env, sent, say };
}

describe("parsing", () => {
  it("reads commands with or without the bot name", () => {
    expect(parseCommand("/slots@courtping_bot 20")).toEqual({ name: "slots", arg: "20" });
    expect(parseCommand("/Venues")).toEqual({ name: "venues", arg: "" });
    expect(parseCommand("hello /slots")).toBeNull();
  });

  it("reads times", () => {
    expect(parseTime("20")).toBe("20:00");
    expect(parseTime("7:30")).toBe("07:30");
    expect(parseTime("19h30")).toBe("19:30");
    expect(parseTime("all")).toBeNull();
    expect(parseTime("25")).toBeUndefined();
    expect(parseTime("tối")).toBeUndefined();
  });
});

describe("handleUpdate", () => {
  it("answers only in the configured group and only its own commands", async () => {
    const t = setup();
    expect(await t.say("/slots", -999)).toMatch(/^ignored/);
    expect(await t.say("just chatting")).toMatch(/^ignored/);
    expect(await t.say("/start_game")).toMatch(/^ignored/);
    expect(t.sent).toHaveLength(0);
  });

  it("/slots lists future slots at the preferred start, replying to the command", async () => {
    const t = setup();
    await t.say("/slots");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.reply_parameters?.message_id).toBe(7);
    const text = t.sent[0]!.text;
    expect(text).toContain("Slot 19:00 còn trống");
    expect(text).toContain("Venue a");
    expect(text).not.toContain("Venue b"); // 20:00
    expect(text).not.toContain("09/11"); // already past
    expect(text).toContain("/slots all");
  });

  it("/slots 20 and /slots all filter by start time", async () => {
    const t = setup();
    await t.say("/slots 20");
    expect(t.sent[0]!.text).toContain("Venue b");
    expect(t.sent[0]!.text).not.toContain("Venue a");
    await t.say("/slots all");
    expect(t.sent[1]!.text).toContain("Venue a");
    expect(t.sent[1]!.text).toContain("Venue b");
    await t.say("/slots tối");
    expect(t.sent[2]!.text).toContain("Không hiểu giờ");
  });

  it("/slots says when nothing is free or the bot has not checked yet", async () => {
    const t = setup({ ...STATE, free: [] });
    await t.say("/slots");
    expect(t.sent[0]!.text).toContain("Không còn slot 19:00 nào trống trong 7 ngày tới");
    const fresh = setup(null);
    await fresh.say("/slots");
    expect(fresh.sent[0]!.text).toContain("chưa check");
  });

  it("/venues lists tracked venues with names, falling back to IDs", async () => {
    const t = setup();
    await t.say("/venues");
    const text = t.sent[0]!.text;
    expect(text).toContain("Đang theo dõi 2 sân");
    expect(text).toContain("CLB An Khánh</a> · đặt được đến hết tháng");
    expect(text).toContain("sport_hoc_vien_cau_long_tpro</a> · chưa rõ lịch mở đặt");
  });

  it("/schedule describes sessions and the cron", async () => {
    const t = setup();
    await t.say("/schedule");
    const text = t.sent[0]!.text;
    expect(text).toContain("T2–T6, 19:00–22:00");
    expect(text).toContain("Chơi 2 tiếng, cần 1 sân");
    expect(text).toContain("Giờ bắt đầu: 19:00, 20:00 (ưu tiên 19:00)");
    expect(text).toContain("Check mỗi giờ từ 07:00 đến 22:00, lệch ngẫu nhiên 0–5 phút");
  });

  it("/status reports the last run, or the error and pause", async () => {
    const t = setup();
    await t.say("/status");
    expect(t.sent[0]!.text).toContain("Bot chạy bình thường");
    expect(t.sent[0]!.text).toContain("13:48 (12 phút trước)");
    expect(t.sent[0]!.text).toContain("Đang có 2 slot trống");
    expect(t.sent[0]!.text).toContain("Lần check tiếp theo: khoảng 15:00");

    const blocked = setup({ ...STATE, error: { code: "rate_limited", since: NOW - 60_000 }, blockedUntil: NOW + 90 * 60_000 });
    await blocked.say("/status");
    expect(blocked.sent[0]!.text).toContain("Bot đang tạm dừng");
    expect(blocked.sent[0]!.text).toContain("Chạy lại lúc 15:30");
    expect(blocked.sent[0]!.text).toContain("Lần check tiếp theo: khoảng 16:00");
  });

  it("replies even when CONFIG is broken", async () => {
    const t = setup(STATE, undefined);
    t.env.CONFIG = "{";
    await t.say("/help");
    expect(t.sent[0]!.text).toContain("Cấu hình bot bị sai");
  });
});

describe("POST /telegram", () => {
  const request = (secret?: string) =>
    new Request("https://x/telegram", {
      method: "POST",
      headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
      body: JSON.stringify({ message: { message_id: 1, chat: { id: -999 }, text: "/help" } }),
    });

  it("checks the secret token and is off without one", async () => {
    const t = setup();
    expect((await worker.fetch(request(), t.env)).status).toBe(401);
    expect((await worker.fetch(request("wrong-secret"), t.env)).status).toBe(401);
    expect((await worker.fetch(request("hook-secret"), t.env)).status).toBe(200); // other chat: ignored, no fetch
    expect((await worker.fetch(request("hook-secret"), { ...t.env, TELEGRAM_WEBHOOK_SECRET: undefined })).status).toBe(404);
  });
});

describe("cron times", () => {
  it("converts daily UTC crons to Vietnam times of day", () => {
    const hourly = cronTimesOfDay(["0 0-15 * * *"])!;
    expect(hourly).toHaveLength(16);
    expect(hourly[0]).toBe(7 * 60);
    expect(hourly.at(-1)).toBe(22 * 60);
    expect(cronTimesOfDay(["*/30 23 * * *"])).toEqual([6 * 60, 6 * 60 + 30]);
    expect(cronTimesOfDay(["0 1 * * 1"])).toBeNull();
  });

  it("finds the next run, wrapping to the next day", () => {
    const times = cronTimesOfDay(["0 0-15 * * *"])!;
    expect(nextTimeOfDay(times, NOW - 1)).toBe(at("2026-11-10T14:00:00"));
    expect(nextTimeOfDay(times, NOW)).toBe(at("2026-11-10T15:00:00"));
    expect(nextTimeOfDay(times, at("2026-11-10T22:30:00"))).toBe(at("2026-11-11T07:00:00"));
  });

  it("describes uneven or unreadable crons plainly", () => {
    expect(formatSchedule({ ...CONFIG, crons: ["0 1,5 * * *"] }, cronTimesOfDay(["0 1,5 * * *"]))).toContain("mỗi 4 giờ từ 08:00 đến 12:00");
    expect(formatSchedule({ ...CONFIG, crons: ["0 1 * * 1"] }, null)).toContain("<code>0 1 * * 1</code> (UTC)");
  });
});
