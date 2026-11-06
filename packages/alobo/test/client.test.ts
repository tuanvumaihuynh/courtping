import { describe, expect, it } from "vitest";
import { AloboClient } from "../src/client.ts";

const RUNTIME = { version: "1.0.0", response_key: "k".repeat(32), app_salt: "salt" };

describe("AloboClient", () => {
  it("calls fetch unbound, as workerd requires", async () => {
    function strictFetch(this: unknown, _input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }
    await expect(new AloboClient(RUNTIME, strictFetch as typeof fetch).checkVersion()).resolves.toBeUndefined();
  });
});
