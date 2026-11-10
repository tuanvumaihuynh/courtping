import {
  AloboClient,
  AloboError,
  type AloboRuntime,
  BLOCKING_STATUSES,
  lastBookableDate,
  resolveVenue,
} from "@courtping/alobo";
import { AppError } from "./errors.ts";
import { formatError, formatNewSlots, formatRecovered, sendTelegram } from "./telegram.ts";
import { isoDay, upcomingDates, windowsFor } from "./time.ts";
import type { Config, Env, Match, State } from "./types.ts";

/** The free plan allows 50 subrequests per invocation; leave room for version.json and Telegram. */
export const MAX_WINDOWS = 40;
const SUBREQUEST_BUDGET = 45;
const RULES_TTL_MS = 24 * 3_600_000;
const DEFAULT_BACKOFF_HOURS = 1;
/** Shortest pause after a 429 whose reset time Alobo told us, so a busy window is not hit again at once. */
const MIN_RATE_LIMIT_PAUSE_MS = 5 * 60_000;
export const STATE_KEY = "state";

export interface RunOptions {
  /** Log messages instead of sending them, and do not persist state. */
  dryRun?: boolean;
  now?: number;
  fetch?: typeof fetch;
  /**
   * Skip if a run started at or after this time. A cron run sleeps through its jitter first, and a
   * manual run or a newer deploy in that gap would otherwise race it and lose its saved state.
   */
  skipIfRanSince?: number;
}

export interface RunResult {
  log: string[];
  state: State;
  skipped?: string;
}

export function parseConfig(raw: string): Config {
  try {
    return JSON.parse(raw) as Config;
  } catch (e) {
    throw new AppError("config_error", `CONFIG is not valid JSON: ${e}`);
  }
}

/** Random delay before a cron run, from `jitter_minutes`. Bad config gives 0; `run` reports it. */
export function jitterMs(rawConfig: string, random: () => number = Math.random): number {
  let minutes: unknown;
  try {
    minutes = (JSON.parse(rawConfig) as Config).jitter_minutes;
  } catch {
    return 0;
  }
  return typeof minutes === "number" && minutes > 0 ? Math.floor(random() * minutes * 60_000) : 0;
}

/**
 * One check: find free windows, announce those not announced before, and report each new error once.
 * Errors are reported, never thrown; only a Telegram failure cannot reach the chat.
 */
export async function run(env: Env, opts: RunOptions = {}): Promise<RunResult> {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const log: string[] = [];
  const notify = async (text: string) => {
    log.push(text);
    if (!opts.dryRun) await sendTelegram(env, text, fetchFn);
  };

  const state = ((await env.STATE.get(STATE_KEY, "json")) as State | null) ?? {
    seen: {},
    blockedUntil: null,
    error: null,
  };
  const before = JSON.stringify(state);
  const seenBefore = { ...state.seen };

  if (opts.skipIfRanSince !== undefined && state.lastRun && state.lastRun.at >= opts.skipIfRanSince) {
    return { log, state, skipped: `already ran at ${new Date(state.lastRun.at).toISOString()}` };
  }
  if (state.blockedUntil && state.blockedUntil > now) {
    return { log, state, skipped: `backing off until ${new Date(state.blockedUntil).toISOString()}` };
  }

  let backoffHours = DEFAULT_BACKOFF_HOURS;
  try {
    const config = parseConfig(env.CONFIG);
    backoffHours = config.backoff_hours ?? DEFAULT_BACKOFF_HOURS;
    const alobo = new AloboClient(JSON.parse(env.ALOBO_RUNTIME) as AloboRuntime, fetchFn);
    await alobo.checkVersion();

    const jobs = config.sessions
      .flatMap((session) =>
        upcomingDates(session.weekdays, config.lookahead_days ?? 7, now).flatMap((day) =>
          windowsFor(day, session).map(([start, end]) => ({ session, start, end })),
        ),
      )
      .filter((job) => job.start > now);
    if (jobs.length > MAX_WINDOWS) {
      throw new AppError(
        "config_error",
        `config produces ${jobs.length} windows (limit ${MAX_WINDOWS}); lower lookahead_days or raise step_minutes`,
      );
    }

    const venueIds = [...new Set(config.venues.map(resolveVenue))];

    // Venues only take bookings a few days or until month end; Alobo still reports later dates as free.
    state.rules ??= {};
    const stale = venueIds.filter((id) => !state.rules![id]?.name || !(now - state.rules![id]!.fetchedAt < RULES_TTL_MS));
    for (const id of stale.slice(0, Math.max(0, SUBREQUEST_BUDGET - 1 - jobs.length))) {
      state.rules[id] = { ...(await alobo.bookingRules(id)), fetchedAt: now };
    }
    state.rules = Object.fromEntries(Object.entries(state.rules).filter(([id]) => venueIds.includes(id)));
    const lastDay = new Map(venueIds.map((id) => [id, state.rules![id] ? lastBookableDate(state.rules![id], now) : null]));

    const fresh = new Map<string, Match[]>(); // "day|venueId" → newly free windows
    const current = new Set<string>();
    const free: Match[] = [];
    for (const { session, start, end } of jobs) {
      const day = isoDay(start);
      const open = venueIds.filter((id) => {
        const last = lastDay.get(id);
        return last == null || day <= last;
      });
      if (open.length === 0) continue;
      for (const row of await alobo.availability(open, start, end)) {
        if (row.courts.length < session.courts) continue;
        const key = `${row.venue.id}|${start}|${end}|${session.courts}`;
        current.add(key);
        free.push({ ...row, start, end });
        if (state.seen[key]) continue;
        state.seen[key] = start;
        const group = `${day}|${row.venue.id}`;
        fresh.set(group, [...(fresh.get(group) ?? []), { ...row, start, end }]);
      }
    }
    // Forget slots that are no longer free, so they are announced again if they free up later.
    state.seen = Object.fromEntries(Object.entries(state.seen).filter(([key]) => current.has(key)));

    const groups = [...fresh.keys()].sort().map((group) => fresh.get(group)!);
    for (const message of formatNewSlots(groups, now, config.preferred_start)) await notify(message);

    if (state.error) {
      await notify(formatRecovered(state.error.code));
      state.error = null;
    }
    state.blockedUntil = null;
    state.free = free;
    state.lastRun = { at: now, ok: true, windows: jobs.length, requests: alobo.requests };
    state.lastSuccessAt = now;
    log.push(`checked ${jobs.length} windows with ${alobo.requests} requests; ${fresh.size} new venue-days`);
  } catch (err) {
    state.seen = seenBefore; // nothing from a failed run counts as announced
    const error =
      err instanceof AppError || err instanceof AloboError
        ? err
        : new AppError("bug", String((err as Error | undefined)?.stack ?? err));
    console.error("run failed", error.code, error.message);

    if (error.status && BLOCKING_STATUSES.has(error.status)) {
      const maxPause = backoffHours * 3_600_000;
      const retryAfter = error instanceof AloboError ? error.retryAfterMs : undefined;
      // A 429 with a known reset only needs a short pause; 401/403 or an unknown reset get the full backoff.
      const pause = retryAfter === undefined ? maxPause : Math.min(maxPause, Math.max(MIN_RATE_LIMIT_PAUSE_MS, retryAfter));
      state.blockedUntil = now + pause;
    }
    if (state.error?.code !== error.code && error.code !== "telegram_error") {
      try {
        await notify(formatError(error.code, error.message, state.blockedUntil));
      } catch (notifyError) {
        console.error("cannot notify", notifyError);
      }
    }
    state.error = { code: error.code, since: state.error?.since ?? now };
    state.lastRun = { at: now, ok: false, windows: 0, requests: 0 };
    log.push(`error ${error.code}: ${error.message}`);
  }

  if (!opts.dryRun && JSON.stringify(state) !== before) await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return { log, state };
}
