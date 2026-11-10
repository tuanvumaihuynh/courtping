import { resolveVenue } from "@courtping/alobo";
import { parseConfig, STATE_KEY } from "./run.ts";
import {
  formatBadSlotsArg,
  formatConfigBroken,
  formatHelp,
  formatSchedule,
  formatSlots,
  formatStatus,
  formatVenues,
  sendTelegram,
} from "./telegram.ts";
import { cronTimesOfDay, nextTimeOfDay } from "./time.ts";
import type { Config, Env, State } from "./types.ts";

/** The part of a Telegram Update this bot reads. */
export interface TelegramUpdate {
  message?: { message_id: number; chat: { id: number | string }; text?: string };
}

/** `/slots@courtping_bot 20` → { name: "slots", arg: "20" }. */
export function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/is.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

/** "20" → "20:00", "7:30" → "07:30", "all" → null; undefined when unreadable. */
export function parseTime(arg: string): string | null | undefined {
  if (arg.toLowerCase() === "all") return null;
  const m = /^(\d{1,2})(?:[:h](\d{2}))?$/i.exec(arg);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function reply(name: string, arg: string, config: Config, state: State | null, now: number): string[] | null {
  switch (name) {
    case "start":
    case "help":
      return [formatHelp(config.preferred_start)];
    case "venues":
      return [formatVenues([...new Set(config.venues.map(resolveVenue))], state?.rules)];
    case "slots": {
      const time = arg ? parseTime(arg) : (config.preferred_start ?? null);
      if (time === undefined) return [formatBadSlotsArg(arg)];
      const free = (state?.free ?? []).filter((m) => m.start > now);
      return formatSlots(free, time, state?.lastSuccessAt, config.lookahead_days ?? 7, config.preferred_start);
    }
    case "schedule":
      return [formatSchedule(config, config.crons ? cronTimesOfDay(config.crons) : null)];
    case "status": {
      const times = config.crons ? cronTimesOfDay(config.crons) : null;
      const from = Math.max(now, state?.blockedUntil ?? 0);
      return [formatStatus(state, now, times ? nextTimeOfDay(times, from) : null)];
    }
    default:
      return null; // not ours, or another bot's command
  }
}

/**
 * Answer a command sent in the configured group. Reads only KV and CONFIG, never Alobo, so it is
 * fast and cannot add to Alobo's rate limit. Returns what was done, for logs.
 */
export async function handleUpdate(env: Env, update: TelegramUpdate, now: number, fetchFn: typeof fetch = fetch): Promise<string> {
  const message = update.message;
  if (!message?.text || String(message.chat.id) !== env.TELEGRAM_CHAT_ID) return "ignored: not a text message in the group";
  const command = parseCommand(message.text);
  if (!command) return "ignored: not a command";

  let config: Config;
  try {
    config = parseConfig(env.CONFIG);
  } catch {
    await sendTelegram(env, formatConfigBroken(), fetchFn, message.message_id);
    return "replied: config broken";
  }
  const state = (await env.STATE.get(STATE_KEY, "json")) as State | null;
  const texts = reply(command.name, command.arg, config, state, now);
  if (!texts) return `ignored: unknown command /${command.name}`;
  for (const text of texts) await sendTelegram(env, text, fetchFn, message.message_id);
  return `replied: /${command.name}`;
}
