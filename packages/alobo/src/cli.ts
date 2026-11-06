#!/usr/bin/env node
/**
 * Read-only Alobo CLI for people and agents. Prints JSON on stdout; errors go to stderr as JSON.
 *
 *   node packages/alobo/src/cli.ts venues [--query TEXT] [--near LAT,LNG] [--radius KM] [--include-inactive]
 *   node packages/alobo/src/cli.ts courts VENUE
 *   node packages/alobo/src/cli.ts availability --venue VENUE... --date YYYY-MM-DD... --from HH:MM --to HH:MM
 *                                               --duration MIN [--step MIN] [--courts N]
 *
 * VENUE is an Alobo ID (sport_...) or an alias from VENUE_ALIASES. The runtime key is cached in
 * <repo>/.cache/alobo-runtime.json for 6 hours.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lastBookableDate } from "./booking.ts";
import { AloboClient, type AloboRuntime, bookingUrl, resolveVenue } from "./client.ts";
import { AloboError } from "./errors.ts";
import { fetchRuntime } from "./runtime.ts";
import { parseLatLng, searchVenues, vnTime, windows } from "./search.ts";

const MAX_WINDOWS = 40;
const REQUEST_GAP_MS = 1000;
const RUNTIME_TTL_MS = 6 * 3_600_000;
const CACHE_DIR = new URL("../../../.cache/", import.meta.url);
const RUNTIME_CACHE = new URL("alobo-runtime.json", CACHE_DIR);

class UsageError extends Error {}

/** Rethrow input-validation errors from helpers as usage errors. */
function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

async function loadRuntime(refresh = false): Promise<AloboRuntime> {
  if (!refresh) {
    try {
      const cached = JSON.parse(readFileSync(RUNTIME_CACHE, "utf8")) as AloboRuntime & { fetchedAt: number };
      if (Date.now() - cached.fetchedAt < RUNTIME_TTL_MS) return cached;
    } catch {
      // missing or unreadable cache: fetch below
    }
  }
  const runtime = await fetchRuntime();
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = new URL("alobo-runtime.json.tmp", CACHE_DIR);
  writeFileSync(tmp, JSON.stringify({ ...runtime, fetchedAt: Date.now() }), { mode: 0o600 });
  renameSync(tmp, RUNTIME_CACHE);
  return runtime;
}

/** A client whose key matches the live frontend, refreshing the cached key once if needed. */
async function client(): Promise<AloboClient> {
  let alobo = new AloboClient(await loadRuntime(), fetch, { minGapMs: REQUEST_GAP_MS });
  try {
    await alobo.checkVersion();
  } catch (e) {
    if (!(e instanceof AloboError) || e.code !== "frontend_changed") throw e;
    alobo = new AloboClient(await loadRuntime(true), fetch, { minGapMs: REQUEST_GAP_MS });
    await alobo.checkVersion();
  }
  return alobo;
}

const positiveInt = (name: string, value: string | undefined, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return n;
};

async function venues(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: "string" },
      near: { type: "string" },
      radius: { type: "string" },
      "include-inactive": { type: "boolean", default: false },
    },
  });
  if (!values.query && !values.near) throw new UsageError("give --query, --near, or both");
  const near = values.near ? usage(() => parseLatLng(values.near!)) : undefined;
  const radiusKm = values.radius === undefined ? 5 : Number(values.radius);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new UsageError("--radius must be a positive number");

  const alobo = await client();
  const results = searchVenues(await alobo.catalog(), {
    query: values.query,
    near,
    radiusKm,
    includeInactive: values["include-inactive"],
  });
  return {
    count: results.length,
    venues: results.map((v) => ({ ...v, bookingUrl: bookingUrl(v.id) })),
    note: near ? "distanceKm is straight-line from coordinates entered by venue owners" : undefined,
  };
}

async function courts(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length !== 1) throw new UsageError("usage: courts VENUE");
  const venueId = resolveVenue(positionals[0]!);
  const alobo = await client();
  return { venueId, courts: await alobo.courts(venueId) };
}

async function availability(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      venue: { type: "string", multiple: true },
      date: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      duration: { type: "string" },
      step: { type: "string" },
      courts: { type: "string" },
    },
  });
  if (!values.venue?.length || !values.date?.length || !values.from || !values.to) {
    throw new UsageError("availability needs --venue, --date, --from, --to, and --duration");
  }
  const duration = positiveInt("duration", values.duration);
  const step = positiveInt("step", values.step, 60);
  const minCourts = positiveInt("courts", values.courts, 1);
  const venueIds = [...new Set(values.venue.map(resolveVenue))];
  const { date, from, to } = values;
  const spans = usage(() => windows(date, from, to, duration, step)).filter((w) => w.end > Date.now());
  if (spans.length > MAX_WINDOWS) {
    throw new UsageError(`${spans.length} windows requested; the limit is ${MAX_WINDOWS}. Use fewer dates or a larger --step`);
  }

  if (spans.length + venueIds.length > MAX_WINDOWS + 10) {
    throw new UsageError(`${spans.length} windows for ${venueIds.length} venues is too many requests; narrow the query`);
  }

  const alobo = await client();
  // Alobo reports dates a venue does not take bookings for yet as free, so check each venue's horizon.
  const bookableUntil: Record<string, string | null> = {};
  for (const id of venueIds) bookableUntil[id] = lastBookableDate(await alobo.bookingRules(id), Date.now());

  const results = [];
  for (const span of spans) {
    const open = venueIds.filter((id) => bookableUntil[id] == null || span.date <= bookableUntil[id]!);
    const rows = open.length ? await alobo.availability(open, span.start, span.end) : [];
    results.push({
      date: span.date,
      from: vnTime(span.start),
      to: vnTime(span.end),
      venues: rows
        .filter((r) => r.courts.length >= minCourts)
        .map((r) => ({ id: r.venue.id, name: r.venue.name, freeCourts: r.courts, bookingUrl: bookingUrl(r.venue.id) })),
      notOpenYet: venueIds.filter((id) => !open.includes(id)),
    });
  }
  return { timezone: "Asia/Ho_Chi_Minh", minCourts, bookableUntil, windows: results, requests: alobo.requests };
}

const COMMANDS: Record<string, (args: string[]) => Promise<unknown>> = { venues, courts, availability };

const [command, ...rest] = process.argv.slice(2);
const run = command ? COMMANDS[command] : undefined;
try {
  if (!run) throw new UsageError(`usage: cli.ts <${Object.keys(COMMANDS).join("|")}> ...`);
  process.stdout.write(`${JSON.stringify(await run(rest), null, 2)}\n`);
} catch (e) {
  const error =
    e instanceof AloboError
      ? { code: e.code, message: e.message, status: e.status }
      : {
          code: e instanceof UsageError || String((e as { code?: unknown })?.code).startsWith("ERR_PARSE_ARGS") ? "usage" : "error",
          message: String((e as Error)?.message ?? e),
        };
  process.stderr.write(`${JSON.stringify({ error })}\n`);
  process.exit(error.code === "usage" ? 2 : 1);
}
