import { describe, expect, it } from "vitest";
import { AloboClient, isPickleballCourt } from "../src/client.ts";

const RUNTIME = { version: "1.0.0", response_key: "k".repeat(32), app_salt: "salt" };

describe("AloboClient", () => {
  it("calls fetch unbound, as workerd requires", async () => {
    function strictFetch(this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }
    await expect(new AloboClient(RUNTIME, strictFetch as typeof fetch).checkVersion()).resolves.toBeUndefined();
  });

  it("drops pickleball courts from availability", async () => {
    const yards = [
      { id: "1", name: "Sân 6", shortName: "6", yardType: 2 },
      { id: "2", name: "Pickleball 2", shortName: "PK2", yardType: 2 },
      { id: "3", name: "C.Lông 5", shortName: "CL5", yardType: 2 },
    ];
    const fetchMock = async () =>
      Response.json({ data: [{ branchInformation: { id: "v", name: "V" }, availableYard: yards }] });
    const [row] = await new AloboClient(RUNTIME, fetchMock as typeof fetch).availability(["v"], 0, 1);
    expect(row!.courts).toEqual(["6", "CL5"]);
  });
});

describe("isPickleballCourt", () => {
  it.each([
    [{ name: "Pickleball 2", shortName: "PK2" }, true],
    [{ name: "Sân pickleball A" }, true],
    [{ name: "X", shortName: "pk 4" }, true],
    [{ name: "Sân 6", shortName: "6" }, false],
    [{ name: "C. Lông 1", shortName: "CL 1" }, false],
    [{ name: "Sân B", shortName: "B" }, false],
    [{ name: "Park side", shortName: "PARK" }, false],
  ])("%j → %s", (court, expected) => {
    expect(isPickleballCourt(court)).toBe(expected);
  });
});
