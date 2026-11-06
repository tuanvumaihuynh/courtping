import { describe, expect, it } from "vitest";
import { formatNewSlots } from "../src/telegram.ts";
import type { Match } from "../src/types.ts";

const at = (iso: string) => Date.parse(`${iso}+07:00`);
const match = (venue: string, day: string, hour: number): Match => ({
  venue: { id: venue, name: venue, address: "" },
  courts: ["1"],
  start: at(`${day}T${String(hour).padStart(2, "0")}:00:00`),
  end: at(`${day}T${String(hour + 2).padStart(2, "0")}:00:00`),
});

// Groups arrive in day order, as run.ts builds them.
const groups = [
  [match("A", "2026-11-09", 20)],
  [match("B", "2026-11-09", 19), match("B", "2026-11-09", 20)],
  [match("C", "2026-11-10", 20)],
  [match("D", "2026-11-11", 19)],
];
const NOW = at("2026-11-06T15:00:00");

describe("formatNewSlots", () => {
  it("lists venue-days with a preferred-start window first and highlights that window", () => {
    const [text] = formatNewSlots(groups, NOW, "19:00");
    const order = ["<b>B</b>", "<b>D</b>", "<b>A</b>", "<b>C</b>"].map((name) => text!.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text!.indexOf("Có slot 19:00")).toBeLessThan(text!.indexOf("<b>B</b>"));
    expect(text!.indexOf("Giờ khác")).toBeLessThan(text!.indexOf("<b>A</b>"));
    expect(text).toContain("⭐ <b>19:00–21:00 · 1 sân: 1</b>");
    expect(text).toContain("\n20:00–22:00 · 1 sân: 1");
  });

  it("keeps day order and adds no headings without a preferred start", () => {
    const [text] = formatNewSlots(groups, NOW);
    expect(text).not.toContain("⭐");
    expect(text).not.toContain("Giờ khác");
    expect(text!.indexOf("<b>A</b>")).toBeLessThan(text!.indexOf("<b>B</b>"));
  });

  it("adds no 'other' heading when every venue-day has the preferred start", () => {
    const [text] = formatNewSlots([groups[1]!, groups[3]!], NOW, "19:00");
    expect(text).toContain("Có slot 19:00");
    expect(text).not.toContain("Giờ khác");
  });
});
