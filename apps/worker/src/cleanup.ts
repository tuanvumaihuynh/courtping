import { MESSAGE_PREFIX, STATE_KEY } from "./run.ts";
import { type CurrentSlot, renderSlotMessage, telegramCall } from "./telegram.ts";
import type { Config, Env, Match, SentMessage, State } from "./types.ts";

/** Telegram lets a bot delete its messages for 48 hours; older ones can only be edited. */
const DELETE_WINDOW_MS = 47 * 3_600_000;
/** Subrequests to Telegram per run, under the free plan's 50. */
const TELEGRAM_BUDGET = 45;

/** True when `cron` is one of the configured cleanup crons. */
export function isCleanupCron(rawConfig: string, cron: string): boolean {
  try {
    return ((JSON.parse(rawConfig) as Config).cleanup_crons ?? []).includes(cron);
  } catch {
    return false;
  }
}

/**
 * Bring sent slot messages in line with the last check: strike through slots that are gone, update
 * court lists, and delete a message once none of its slots is left (or strike all of it after 48 hours).
 * Reads the check's state but never writes it, so it cannot race a check.
 */
export async function cleanup(env: Env, opts: { now?: number; fetch?: typeof fetch } = {}): Promise<string[]> {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const log: string[] = [];
  const state = (await env.STATE.get(STATE_KEY, "json")) as State | null;
  if (!state?.free || state.lastSuccessAt === undefined) return ["skipped: no successful check yet"];
  const checkedAt = state.lastSuccessAt;

  const free = new Map<string, Match>();
  for (const m of state.free) {
    const key = `${m.venue.id}|${m.start}|${m.end}`;
    if ((free.get(key)?.courts.length ?? -1) < m.courts.length) free.set(key, m);
  }
  const current: CurrentSlot = (m) => (m.start > now ? (free.get(`${m.venue.id}|${m.start}|${m.end}`) ?? null) : null);

  const keys: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await env.STATE.list({ prefix: MESSAGE_PREFIX, cursor });
    keys.push(...page.keys.map((k) => k.name));
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }

  let calls = 0;
  const call = async (method: string, params: Record<string, unknown>) => {
    calls++;
    try {
      await telegramCall(env, method, params, fetchFn);
    } catch (e) {
      if (!/not modified/i.test(String((e as Error).message))) throw e;
    }
  };
  for (const key of keys) {
    if (calls >= TELEGRAM_BUDGET) {
      log.push("budget used up; the rest waits for the next run");
      break;
    }
    const record = (await env.STATE.get(key, "json")) as SentMessage | null;
    if (!record || record.sentAt > checkedAt) continue; // sent after the check this would compare against
    const messageId = Number(key.slice(MESSAGE_PREFIX.length));
    const alive = record.blocks.some((b) => b.matches.some((m) => current(m) !== null));
    const text = renderSlotMessage(record, current);
    const chat = { chat_id: env.TELEGRAM_CHAT_ID, message_id: messageId };
    try {
      if (!alive && now - record.sentAt < DELETE_WINDOW_MS) {
        await call("deleteMessage", chat);
        await env.STATE.delete(key);
        log.push(`deleted ${messageId}`);
        continue;
      }
      if (text !== record.text) {
        await call("editMessageText", { ...chat, text, parse_mode: "HTML", disable_web_page_preview: true });
        log.push(`edited ${messageId}`);
      }
      if (alive) {
        if (text !== record.text) await env.STATE.put(key, JSON.stringify({ ...record, text }), { expiration: record.expiration });
      } else {
        await env.STATE.delete(key);
      }
    } catch (e) {
      const message = String((e as Error).message);
      if (/not found|can't be (deleted|edited)/i.test(message)) {
        await env.STATE.delete(key); // removed by hand, or too old: nothing left to keep in sync
        log.push(`dropped ${messageId}: ${message}`);
        continue;
      }
      log.push(`failed ${messageId}: ${message}`);
      if (/Telegram 429/.test(message)) break;
    }
  }
  return log;
}
