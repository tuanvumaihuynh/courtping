import { bookingUrl } from "@courtping/alobo";
import { AppError } from "./errors.ts";
import { ddmm, hhmm, weekday } from "./time.ts";
import type { Env, Match } from "./types.ts";

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

export async function sendTelegram(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID">,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) throw new AppError("telegram_error", `Telegram ${res.status}: ${body.description ?? ""}`);
}

const startsAt = (m: Match, time: string | null | undefined) => time != null && hhmm(m.start) === time;

/** One block per venue and day, listing every newly free window. Windows at `preferredStart` are highlighted. */
export function formatVenueDay(matches: Match[], preferredStart?: string | null): string {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const { venue, start } = sorted[0]!;
  const lines = [`🏸 <b>${escapeHtml(venue.name)}</b> · ${WEEKDAY_NAMES[weekday(start)]} ${ddmm(start)}`];
  for (const m of sorted) {
    const line = `${hhmm(m.start)}–${hhmm(m.end)} · ${m.courts.length} sân: ${escapeHtml(m.courts.join(", "))}`;
    lines.push(startsAt(m, preferredStart) ? `⭐ <b>${line}</b>` : line);
  }
  if (venue.address) lines.push(escapeHtml(venue.address));
  lines.push(`<a href="${bookingUrl(venue.id)}">Đặt trên Alobo</a>`);
  return lines.join("\n");
}

/**
 * Messages for newly free slots, one block per venue and day (`groups` in day order).
 * With `preferredStart`, venue-days that have a window starting then come first under their own heading.
 */
export function formatNewSlots(groups: Match[][], checkedAt: number, preferredStart?: string | null): string[] {
  const preferred = groups.filter((g) => g.some((m) => startsAt(m, preferredStart)));
  const others = groups.filter((g) => !preferred.includes(g));

  const blocks: string[] = [];
  const addSection = (heading: string | null, section: Match[][]) =>
    section.forEach((g, i) => {
      const block = formatVenueDay(g, preferredStart);
      blocks.push(i === 0 && heading ? `${heading}\n\n${block}` : block);
    });
  if (preferred.length) {
    addSection(`⭐ <b>Có slot ${preferredStart}</b>`, preferred);
    addSection("<b>Giờ khác</b>", others);
  } else {
    addSection(null, others);
  }

  const messages: string[] = [];
  for (let i = 0; i < blocks.length; i += BLOCKS_PER_MESSAGE) {
    const header = i === 0 ? `<b>Có sân trống mới</b> (check lúc ${hhmm(checkedAt)} ${ddmm(checkedAt)})\n\n` : "";
    messages.push(header + blocks.slice(i, i + BLOCKS_PER_MESSAGE).join("\n\n"));
  }
  return messages;
}

export function formatError(code: string, message: string, pausedUntil: number | null): string {
  const lines = [`⚠️ <b>Bot báo sân bị lỗi</b>: <code>${escapeHtml(code)}</code>`];
  if (HINTS[code]) lines.push(HINTS[code]);
  lines.push(`<code>${escapeHtml(message.slice(0, 500))}</code>`);
  if (pausedUntil) lines.push(`Tạm dừng tới ${hhmm(pausedUntil)} ${ddmm(pausedUntil)}.`);
  return lines.join("\n");
}

export const formatRecovered = (previousCode: string): string =>
  `✅ Bot báo sân chạy lại bình thường (lỗi trước: <code>${escapeHtml(previousCode)}</code>).`;
