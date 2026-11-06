import { AloboClient, AloboError, type AloboRuntime, BLOCKING_STATUSES, resolveVenue } from "@courtping/alobo";
import { AppError } from "./errors.ts";
import { formatError, formatNewSlots, formatRecovered, formatVenueDay, sendTelegram } from "./telegram.ts";
import { isoDay, upcomingDates, windowsFor } from "./time.ts";
import type { Config, Env, Match, State } from "./types.ts";

/** The free plan allows 50 subrequests per invocation; leave room for version.json and Telegram. */
export const MAX_WINDOWS = 40;
const DEFAULT_BACKOFF_HOURS = 6;
const STATE_KEY = "state";

export interface RunOptions {
  /** Log messages instead of sending them, and do not persist state. */
  dryRun?: boolean;
  now?: number;
  fetch?: typeof fetch;
}

export interface RunResult {
  log: string[];
  state: State;
  skipped?: string;
}

function parseConfig(raw: string): Config {
  try {
    return JSON.parse(raw) as Config;
  } catch (e) {
    throw new AppError("config_error", `CONFIG is not valid JSON: ${e}`);
  }
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

    const venueIds = config.venues.map(resolveVenue);
    const fresh = new Map<string, Match[]>(); // "day|venueId" → newly free windows
    const current = new Set<string>();
    for (const { session, start, end } of jobs) {
      for (const row of await alobo.availability(venueIds, start, end)) {
        if (row.courts.length < session.courts) continue;
        const key = `${row.venue.id}|${start}|${end}|${session.courts}`;
        current.add(key);
        if (state.seen[key]) continue;
        state.seen[key] = start;
        const group = `${isoDay(start)}|${row.venue.id}`;
        fresh.set(group, [...(fresh.get(group) ?? []), { ...row, start, end }]);
      }
    }
    // Forget slots that are no longer free, so they are announced again if they free up later.
    state.seen = Object.fromEntries(Object.entries(state.seen).filter(([key]) => current.has(key)));

    const blocks = [...fresh.keys()].sort().map((group) => formatVenueDay(fresh.get(group)!));
    for (const message of formatNewSlots(blocks, now)) await notify(message);

    if (state.error) {
      await notify(formatRecovered(state.error.code));
      state.error = null;
    }
    state.blockedUntil = null;
    log.push(`checked ${jobs.length} windows with ${alobo.requests} requests; ${fresh.size} new venue-days`);
  } catch (err) {
    state.seen = seenBefore; // nothing from a failed run counts as announced
    const error =
      err instanceof AppError || err instanceof AloboError
        ? err
        : new AppError("bug", String((err as Error | undefined)?.stack ?? err));
    console.error("run failed", error.code, error.message);

    if (error.status && BLOCKING_STATUSES.has(error.status)) {
      state.blockedUntil = now + backoffHours * 3_600_000;
    }
    if (state.error?.code !== error.code && error.code !== "telegram_error") {
      try {
        await notify(formatError(error.code, error.message, state.blockedUntil));
      } catch (notifyError) {
        console.error("cannot notify", notifyError);
      }
    }
    state.error = { code: error.code, since: state.error?.since ?? now };
    log.push(`error ${error.code}: ${error.message}`);
  }

  if (!opts.dryRun && JSON.stringify(state) !== before) await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return { log, state };
}
