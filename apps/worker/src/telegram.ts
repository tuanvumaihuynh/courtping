import { type BookingRules, bookingUrl } from "@courtping/alobo";
import { AppError } from "./errors.ts";
import { ddmm, hhmm, isoDay, weekday, windowsFor } from "./time.ts";
import type { Config, Env, Match, State } from "./types.ts";

// User-facing text is Vietnamese: the bot posts to a Vietnamese group chat.
const WEEKDAY_NAMES = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const BLOCKS_PER_MESSAGE = 8; // keeps messages well under Telegram's 4096-char limit

const HINTS: Record<string, string> = {
  frontend_changed: "Alobo vừa cập nhật web, cần chạy `task deploy` để lấy key mới.",
  decode_error: "Không giải mã được dữ liệu Alobo, chạy `task deploy` để lấy key mới.",
  rate_limited: "Alobo đang giới hạn request.",
  config_error: "Cấu hình bot bị sai.",
};

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Call a Bot API method; returns its `result`. */
export async function telegramCall<T = unknown>(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  method: string,
  params: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: T };
  if (!res.ok || !body.ok) throw new AppError("telegram_error", `Telegram ${res.status}: ${body.description ?? ""}`);
  return body.result as T;
}

/** Send to the group; returns the new message's id. */
export async function sendTelegram(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">,
  text: string,
  fetchFn: typeof fetch = fetch,
  replyTo?: number,
): Promise<number> {
  const message = await telegramCall<{ message_id: number }>(
    env,
    "sendMessage",
    {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    },
    fetchFn,
  );
  return message?.message_id;
}

const startsAt = (m: Match, time: string | null | undefined) => time != null && hhmm(m.start) === time;

/** Returns the slot as it is free now (courts may have changed), or null once it is gone. */
export type CurrentSlot = (m: Match) => Match | null;

/**
 * One block per venue and day, listing every newly free window. Windows at `preferredStart` are highlighted.
 * With `current`, windows that are gone are struck through, and a block whose windows are all gone shrinks to one line.
 */
export function formatVenueDay(matches: Match[], preferredStart?: string | null, current?: CurrentSlot): string {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const { venue, start } = sorted[0]!;
  const name = escapeHtml(venue.name);
  const day = `${WEEKDAY_NAMES[weekday(start)]} ${ddmm(start)}`;
  const now = sorted.map((m) => (current ? current(m) : m));
  if (now.every((m) => m === null)) return `🏸 <s>${name} · ${day}</s> · hết sân`;
  const lines = [`🏸 <b>${name}</b> · ${day}`];
  sorted.forEach((m, i) => {
    const time = `${hhmm(m.start)}–${hhmm(m.end)}`;
    const live = now[i];
    if (!live) return void lines.push(`<s>${time}</s> · hết sân`);
    const line = `${time} · ${live.courts.length} sân: ${escapeHtml(live.courts.join(", "))}`;
    lines.push(startsAt(m, preferredStart) ? `⭐ <b>${line}</b>` : line);
  });
  if (venue.address) lines.push(escapeHtml(venue.address));
  lines.push(`<a href="${bookingUrl(venue.id)}">Đặt trên Alobo</a>`);
  return lines.join("\n");
}

/** A block of a slot message: one venue-day, optionally under a section heading. */
export interface SlotBlock {
  heading: string | null;
  matches: Match[];
}

/** What a slot message was built from, so it can be rendered again once slots are gone. */
export interface SlotMessage {
  header: string | null;
  preferredStart: string | null;
  blocks: SlotBlock[];
}

/**
 * Messages for newly free slots, one block per venue and day (`groups` in day order).
 * With `preferredStart`, venue-days that have a window starting then come first under their own heading.
 */
export function newSlotMessages(groups: Match[][], checkedAt: number, preferredStart?: string | null): SlotMessage[] {
  const header = `<b>Có sân trống mới</b> (check lúc ${hhmm(checkedAt)} ${ddmm(checkedAt)})`;
  return pages(slotBlocks(groups, preferredStart)).map((blocks, i) => ({
    header: i === 0 ? header : null,
    preferredStart: preferredStart ?? null,
    blocks,
  }));
}

export function renderSlotMessage(message: SlotMessage, current?: CurrentSlot): string {
  const parts = message.blocks.map((b) => {
    const block = formatVenueDay(b.matches, message.preferredStart, current);
    return b.heading ? `${b.heading}\n\n${block}` : block;
  });
  if (message.header) parts.unshift(message.header);
  return parts.join("\n\n");
}

export function formatNewSlots(groups: Match[][], checkedAt: number, preferredStart?: string | null): string[] {
  return newSlotMessages(groups, checkedAt, preferredStart).map((m) => renderSlotMessage(m));
}

function pages<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BLOCKS_PER_MESSAGE) out.push(items.slice(i, i + BLOCKS_PER_MESSAGE));
  return out;
}

function paginate(blocks: string[], header: string, footer?: string): string[] {
  return pages(blocks).map((parts, i, all) =>
    [...(i === 0 ? [header] : []), ...parts, ...(footer && i === all.length - 1 ? [footer] : [])].join("\n\n"),
  );
}

/** Venue-days, those with a window at `preferredStart` first under their own heading. */
function slotBlocks(groups: Match[][], preferredStart?: string | null): SlotBlock[] {
  const preferred = groups.filter((g) => g.some((m) => startsAt(m, preferredStart)));
  const others = groups.filter((g) => !preferred.includes(g));
  const section = (heading: string | null, section: Match[][]) =>
    section.map((matches, i) => ({ heading: i === 0 ? heading : null, matches }));
  return preferred.length
    ? [...section(`⭐ <b>Có slot ${preferredStart}</b>`, preferred), ...section("<b>Giờ khác</b>", others)]
    : section(null, others);
}

const renderBlocks = (blocks: SlotBlock[], preferredStart?: string | null): string[] =>
  blocks.map((b) => {
    const block = formatVenueDay(b.matches, preferredStart);
    return b.heading ? `${b.heading}\n\n${block}` : block;
  });

export function formatError(code: string, message: string, pausedUntil: number | null): string {
  const lines = [`⚠️ <b>Bot báo sân bị lỗi</b>: <code>${escapeHtml(code)}</code>`];
  if (HINTS[code]) lines.push(HINTS[code]);
  lines.push(`<code>${escapeHtml(message.slice(0, 500))}</code>`);
  if (pausedUntil) lines.push(`Tạm dừng tới ${hhmm(pausedUntil)} ${ddmm(pausedUntil)}.`);
  return lines.join("\n");
}

export const formatRecovered = (previousCode: string): string =>
  `✅ Bot báo sân chạy lại bình thường (lỗi trước: <code>${escapeHtml(previousCode)}</code>).`;

// Replies to group commands (/help, /venues, /slots, /schedule, /status).

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: "slots", description: "Slot còn trống (/slots 20, /slots all)" },
  { command: "venues", description: "Các sân đang theo dõi" },
  { command: "schedule", description: "Bot đang tìm ngày nào, giờ nào" },
  { command: "status", description: "Lần check gần nhất, lỗi nếu có" },
  { command: "help", description: "Danh sách lệnh" },
];

export function formatHelp(preferredStart?: string | null): string {
  return [
    "🏸 <b>courtping</b>: báo sân cầu lông trống trên Alobo",
    "",
    preferredStart ? `/slots: slot ${preferredStart} còn trống` : "/slots: mọi slot còn trống",
    "/slots 20: slot bắt đầu lúc 20:00",
    "/slots all: mọi slot còn trống",
    "/venues: các sân đang theo dõi",
    "/schedule: bot đang tìm giờ nào, ngày nào",
    "/status: lần check gần nhất, lỗi nếu có",
    "",
    "Dữ liệu cập nhật mỗi lần bot check. Đặt sân trên Alobo trước khi người khác lấy mất.",
  ].join("\n");
}

function horizon(rules: BookingRules | undefined): string {
  if (!rules) return "chưa rõ lịch mở đặt";
  if (rules.untilEndOfMonth) return "đặt được đến hết tháng";
  if (rules.daysAhead === null) return "không giới hạn ngày đặt";
  return rules.daysAhead === 0 ? "chỉ đặt trong ngày" : `đặt trước ${rules.daysAhead} ngày`;
}

export function formatVenues(venueIds: string[], rules: State["rules"]): string {
  const lines = [`🏸 <b>Đang theo dõi ${venueIds.length} sân</b>`, ""];
  for (const id of venueIds) {
    const r = rules?.[id];
    lines.push(`• <a href="${bookingUrl(id)}">${escapeHtml(r?.name ?? id)}</a> · ${horizon(r)}`);
  }
  return lines.join("\n");
}

const updated = (at: number) => `cập nhật ${hhmm(at)} ${ddmm(at)}`;

/** Free slots from the last check; `time` (HH:MM) keeps only windows starting then, null keeps all. */
export function formatSlots(
  free: Match[],
  time: string | null,
  checkedAt: number | undefined,
  lookaheadDays: number,
  preferredStart?: string | null,
): string[] {
  if (checkedAt === undefined) return ["Bot chưa check xong lần nào. Thử lại sau ít phút."];
  const matches = free.filter((m) => time === null || hhmm(m.start) === time).sort((a, b) => a.start - b.start);
  const what = time ? `slot ${time}` : "slot";
  if (matches.length === 0) {
    const more = time ? "\nGõ /slots all để xem giờ khác." : "";
    return [`Không còn ${what} nào trống trong ${lookaheadDays} ngày tới · ${updated(checkedAt)}${more}`];
  }
  const byGroup = new Map<string, Match[]>();
  for (const m of matches) {
    const key = `${isoDay(m.start)}|${m.venue.id}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), m]);
  }
  const groups = [...byGroup.keys()].sort().map((k) => byGroup.get(k)!);
  const header = time ? `⭐ <b>Slot ${time} còn trống</b> · ${updated(checkedAt)}` : `<b>Slot còn trống</b> · ${updated(checkedAt)}`;
  const blocks = time ? groups.map((g) => formatVenueDay(g, time)) : renderBlocks(slotBlocks(groups, preferredStart), preferredStart);
  return paginate(blocks, header, time ? "Gõ /slots all để xem mọi giờ." : undefined);
}

function weekdays(names: string[]): string {
  const days = new Set(names.map((n) => WEEKDAY_INDEX[n.toLowerCase().slice(0, 3)]));
  const ordered = DAY_ORDER.filter((d) => days.has(d));
  const runs: number[][] = [];
  for (const d of ordered) {
    const last = runs.at(-1);
    if (last && DAY_ORDER.indexOf(d) === DAY_ORDER.indexOf(last.at(-1)!) + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length >= 3 ? `${WEEKDAY_NAMES[r[0]!]}–${WEEKDAY_NAMES[r.at(-1)!]}` : r.map((d) => WEEKDAY_NAMES[d]).join(", ")))
    .join(", ");
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} phút` : m === 0 ? `${h} tiếng` : `${h} tiếng ${m} phút`;
}

const clock = (minutesOfDay: number) => `${String(Math.floor(minutesOfDay / 60)).padStart(2, "0")}:${String(minutesOfDay % 60).padStart(2, "0")}`;

/** "mỗi giờ từ 07:00 đến 22:00", or null when the times are not evenly spaced. */
function cadence(times: number[]): string {
  if (times.length === 1) return `mỗi ngày lúc ${clock(times[0]!)}`;
  const gaps = new Set(times.slice(1).map((t, i) => t - times[i]!));
  const range = `từ ${clock(times[0]!)} đến ${clock(times.at(-1)!)}`;
  if (gaps.size !== 1) return `${times.length} lần mỗi ngày, ${range}`;
  const gap = [...gaps][0]!;
  const every = gap === 60 ? "mỗi giờ" : gap % 60 === 0 ? `mỗi ${gap / 60} giờ` : `mỗi ${gap} phút`;
  return `${every} ${range}`;
}

export function formatSchedule(config: Config, cronTimes: number[] | null): string {
  const lines = ["🗓 <b>Bot đang tìm</b>", ""];
  for (const s of config.sessions) {
    const starts = windowsFor("2026-01-05", s).map(([start]) => hhmm(start));
    const preferred = config.preferred_start && starts.includes(config.preferred_start) ? ` (ưu tiên ${config.preferred_start})` : "";
    lines.push(`• ${weekdays(s.weekdays)}, ${s.from}–${s.to}`);
    lines.push(`• Chơi ${duration(s.duration_minutes)}, cần ${s.courts} sân`);
    lines.push(`• Giờ bắt đầu: ${starts.join(", ")}${preferred}`);
  }
  lines.push(`• Xem trước ${config.lookahead_days ?? 7} ngày`);
  if (config.crons?.length) {
    const jitter = config.jitter_minutes ? `, lệch ngẫu nhiên 0–${config.jitter_minutes} phút` : "";
    lines.push(cronTimes ? `• Check ${cadence(cronTimes)}${jitter}` : `• Check theo cron <code>${escapeHtml(config.crons.join("; "))}</code> (UTC)${jitter}`);
  }
  return lines.join("\n");
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} giờ trước`;
  return `ngày ${ddmm(at)}`;
}

export function formatStatus(state: State | null, now: number, nextRun: number | null): string {
  if (!state?.lastRun) return "Bot chưa check lần nào.";
  const next = nextRun ? [`• Lần check tiếp theo: khoảng ${hhmm(nextRun)}`] : [];
  const success = state.lastSuccessAt;
  if (!state.error) {
    const free = (state.free ?? []).filter((m) => m.start > now).length;
    return [
      "✅ <b>Bot chạy bình thường</b>",
      "",
      `• Check gần nhất: ${hhmm(state.lastRun.at)} (${ago(state.lastRun.at, now)})`,
      `• ${state.lastRun.windows} khung giờ, ${state.lastRun.requests} request tới Alobo`,
      `• Đang có ${free} slot trống`,
      ...next,
    ].join("\n");
  }
  const paused = state.blockedUntil && state.blockedUntil > now;
  return [
    paused ? "⚠️ <b>Bot đang tạm dừng</b>" : "⚠️ <b>Bot đang lỗi</b>",
    "",
    `• Lỗi: <code>${escapeHtml(state.error.code)}</code> từ ${hhmm(state.error.since)} ${ddmm(state.error.since)}`,
    ...(paused ? [`• Chạy lại lúc ${hhmm(state.blockedUntil!)}`] : []),
    `• Check thành công gần nhất: ${success ? `${hhmm(success)} ${ddmm(success)}` : "chưa có"}`,
    ...next,
  ].join("\n");
}

export const formatBadSlotsArg = (arg: string): string =>
  `Không hiểu giờ "${escapeHtml(arg)}". Ví dụ: /slots 20, /slots 19:30, /slots all`;

export const formatConfigBroken = (): string => "Cấu hình bot bị sai, không trả lời được lệnh này.";
