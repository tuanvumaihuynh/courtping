---
name: alobo
description: Search Alobo (datlich.alobo.vn) for badminton venues in Vietnam and check which courts are free at given dates and times. Use when someone asks where or when they can play badminton, wants venues near a place, asks about a specific venue's courts, or needs Alobo venue IDs for courtping. Read-only; never books.
---

# Alobo

Run from the repo root with Node 26 (`nvm use`). Every command prints JSON on stdout. On failure it prints
`{"error":{"code","message"}}` on stderr and exits 1 (Alobo or network) or 2 (bad arguments).

```sh
node packages/alobo/src/cli.ts venues --near 10.7725,106.6980 --radius 4
node packages/alobo/src/cli.ts venues --query "the b"
node packages/alobo/src/cli.ts courts sport_hoang_van_thu_badminton
node packages/alobo/src/cli.ts availability --venue an-khanh --venue sport_hoc_vien_cau_long_tpro \
  --date 2026-11-09 --date 2026-11-10 --from 19:00 --to 22:00 --duration 120 --step 60
```

`--query` matches every word against name and address, accents optional. `--near` takes `LAT,LNG`;
`--radius` defaults to 5 km. Venue arguments accept an ID (`sport_...`) or an alias from
`VENUE_ALIASES` in `packages/alobo/src/client.ts`.

## Workflow

1. Resolve the place to coordinates. Use ones you are sure of, or ask the user for a nearby landmark or a
   map pin. For example, Ben Thanh Market is `10.7725,106.6980`.
2. Find venues with `venues`. Prefer a small radius and widen only if few results come back.
3. Turn relative dates ("tối thứ 3 tuần sau") into ISO dates in Asia/Ho_Chi_Minh, and state the dates you
   chose in the answer.
4. Run `availability` once for all chosen venues and dates. One request covers every venue, so pass them
   together instead of calling per venue.
5. Answer with venue, day, time, free court names, and `bookingUrl`.

## Reading results

- `distanceKm` is straight-line from coordinates venue owners typed in. Road distance is often 1.5 to 2
  times longer, and a few venues have wrong coordinates.
- Venues take one-time bookings only up to a horizon: some a fixed number of days ahead, most until the end
  of the current month. `bookableUntil` gives each venue's last bookable date, and `notOpenYet` lists the
  venues a window skipped for that reason. Say "not open for booking yet" for those, not "fully booked".
- A venue missing from `venues` and from `notOpenYet` had no court free for the whole duration.
- `venues` returns badminton venues (`sport: 2`) and multi-sport venues (`sport: 8`). A multi-sport venue
  may have no badminton court; check with `courts` (`setting` is `san_thuong` or `cau_long` for badminton).
- Pickleball courts are filtered out of `availability`. `courts` shows them with `setting: "pickleball"`.
- `active: false` venues are hidden unless `--include-inactive` is passed; they cannot be booked.

## Limits

- `availability` makes one request per venue (booking horizon) plus one per time window, spaced 1 s apart,
  with a hard cap of 40 windows per call. Use `--step 60` and few dates.
- On `rate_limited`, `http_error` (401/403), or any other error, stop and report it; do not retry in a loop.
- `frontend_changed` is handled by refreshing the cached key once. If `fetch-runtime` fails, Alobo changed
  its web bundle and `packages/alobo/src/runtime.ts` needs updating.
- Only the endpoints above are used. Never call booking, payment, or account endpoints.

The runtime key is cached in `.cache/alobo-runtime.json` at the repo root (gitignored) for 6 hours.
Delete `.cache/` to clear it.
