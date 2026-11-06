import { describe, expect, it } from "vitest";
import type { CatalogVenue } from "../src/client.ts";
import { fold, parseLatLng, searchVenues, vnTime, windows } from "../src/search.ts";

const venue = (id: string, name: string, address: string, lat: number, lng: number, extra: Partial<CatalogVenue> = {}): CatalogVenue => ({
  id, name, address, sport: 2, active: true, lat, lng, opensAt: 5, closesAt: 23, ...extra,
});

const CATALOG = [
  venue("a", "CLB Cầu Lông An Khánh", "7/5A Lương Định Của, P. An Khánh", 10.7857, 106.7309),
  venue("t", "Học Viện Cầu Lông TPro", "1K Ngô Văn Sở, Xóm Chiếu", 10.7609, 106.7066),
  venue("c", "Lavie Q2", "40 Lương Định Của, An Khánh", 10.786, 106.731, { active: false }),
  venue("p", "Pickleball Only", "An Khánh", 10.786, 106.731, { sport: 7 }),
  venue("h", "Sân Hà Nội", "Hoài Đức, Hà Nội", 21.03, 105.75),
  venue("b", "The B Ung Văn Khiêm - Badminton", "155 Ung Văn Khiêm, Bình Thạnh", 10.95, 106.6),
  venue("v", "Câu Lạc Bộ Thể Thao Viettel", "Bình Thạnh", 10.95, 106.6),
];
const BEN_THANH = { lat: 10.7725, lng: 106.698 };

describe("searchVenues", () => {
  it("matches words without diacritics and skips inactive and non-badminton venues", () => {
    expect(searchVenues(CATALOG, { query: "an khanh" }).map((v) => v.id)).toEqual(["a"]);
    expect(searchVenues(CATALOG, { query: "an khanh", includeInactive: true }).map((v) => v.id)).toEqual(["a", "c"]);
  });

  it("matches whole words, so a short word does not match inside longer ones", () => {
    expect(searchVenues(CATALOG, { query: "the b" }).map((v) => v.id)).toEqual(["b"]);
    expect(searchVenues(CATALOG, { query: "tpro" }).map((v) => v.id)).toEqual(["t"]);
    expect(searchVenues(CATALOG, { query: "khanh an" }).map((v) => v.id)).toEqual(["a"]);
  });

  it("filters by radius and sorts nearest first", () => {
    const near = searchVenues(CATALOG, { near: BEN_THANH, radiusKm: 5 });
    expect(near.map((v) => v.id)).toEqual(["t", "a"]);
    expect(near[0]!.distanceKm).toBeCloseTo(1.6, 1);
    expect(searchVenues(CATALOG, { near: BEN_THANH, radiusKm: 2 }).map((v) => v.id)).toEqual(["t"]);
  });
});

describe("helpers", () => {
  it("folds Vietnamese text", () => expect(fold("Đường Lương Định Của")).toBe("duong luong dinh cua"));

  it("parses coordinates", () => {
    expect(parseLatLng("10.78, 106.70")).toEqual({ lat: 10.78, lng: 106.7 });
    expect(() => parseLatLng("10.78")).toThrow(/LAT,LNG/);
  });

  it("builds windows in Vietnam time", () => {
    const w = windows(["2026-11-09", "2026-11-10"], "19:00", "22:00", 120, 60);
    expect(w).toHaveLength(4);
    expect([vnTime(w[0]!.start), vnTime(w[0]!.end), vnTime(w[1]!.start)]).toEqual(["19:00", "21:00", "20:00"]);
    expect(() => windows(["9/11"], "19:00", "22:00", 120, 60)).toThrow(/invalid date/);
  });
});
