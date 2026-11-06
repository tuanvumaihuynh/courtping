import { describe, expect, it } from "vitest";
import { lastBookableDate } from "../src/booking.ts";

// 2026-11-06 16:00 in Vietnam
const NOW = Date.parse("2026-11-06T16:00:00+07:00");

describe("lastBookableDate", () => {
  it("counts days ahead from today in Vietnam time", () => {
    expect(lastBookableDate({ daysAhead: 7, untilEndOfMonth: false }, NOW)).toBe("2026-11-13");
    // 23:30 on the 30th in Vietnam is still the 30th, though UTC says the 30th 16:30
    expect(lastBookableDate({ daysAhead: 0, untilEndOfMonth: false }, Date.parse("2026-11-30T23:30:00+07:00"))).toBe("2026-11-30");
  });

  it("runs to the end of the month when untilEndOfMonth is set, whatever daysAhead is", () => {
    for (const daysAhead of [0, 2, 7]) expect(lastBookableDate({ daysAhead, untilEndOfMonth: true }, NOW)).toBe("2026-11-30");
    expect(lastBookableDate({ daysAhead: 7, untilEndOfMonth: true }, Date.parse("2026-12-31T09:00:00+07:00"))).toBe("2026-12-31");
    expect(lastBookableDate({ daysAhead: 7, untilEndOfMonth: true }, Date.parse("2027-02-03T09:00:00+07:00"))).toBe("2027-02-28");
  });

  it("returns null when the venue sets no limit", () => {
    expect(lastBookableDate({ daysAhead: null, untilEndOfMonth: false }, NOW)).toBeNull();
  });
});
