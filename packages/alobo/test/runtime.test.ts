import { describe, expect, it } from "vitest";
import { API_URL } from "../src/client.ts";
import { extractRuntime, validateRuntime } from "../src/runtime.ts";

/** Build a tiny bundle that mimics the obfuscated Flutter env-config layout. */
function fakeBundle(envs: Array<Record<number, string>>): string {
  const parts = ['x=new A.cD3(),p),p.i("ak.E");']; // decoy: the class name the old extractor relied on
  let n = 0;
  for (const env of envs) {
    const getters: string[] = [];
    for (let arg = 0; arg < 24; arg++) {
      const id = n++;
      const value = env[arg] ?? `value-${id}`;
      const left = [...value].map((_, i) => (i * 37 + id) % 251);
      const right = [...value].map((c, i) => c.charCodeAt(0) ^ left[i]!);
      getters.push(`$.g${id}()`);
      parts.push(
        `r($,"g${id}",()=>new A.Cb${id}());`,
        `A.Cb${id}.prototype={$1(a){return B.l${id}[a]^B.r${id}[a]}};`,
        `B.l${id}=s(${JSON.stringify(left)});`,
        `B.r${id}=s(${JSON.stringify(right)});`,
      );
    }
    parts.push(`env=new A.Env${n}(${getters.join(",")});`);
  }
  return parts.join("\n");
}

const KEY = "k".repeat(32);
const SALT = "s".repeat(32);

describe("extractRuntime", () => {
  it("picks the production env config by base URL, ignoring decoys and other envs", () => {
    const bundle = fakeBundle([
      { 5: "staging-key".padEnd(32, "x"), 8: "https://staging.alobo.vn", 18: "staging-salt" },
      { 5: KEY, 8: API_URL, 18: SALT },
    ]);
    const runtime = extractRuntime(bundle);
    expect(runtime).toEqual({ base_url: API_URL, response_key: KEY, app_salt: SALT });
    expect(() => validateRuntime(runtime)).not.toThrow();
  });

  it("fails clearly when no config points to the production API", () => {
    expect(() => extractRuntime(fakeBundle([{ 8: "https://dev.alobo.vn" }]))).toThrow(/no env config points to/);
    expect(() => extractRuntime("nothing here")).toThrow(/structure changed/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => validateRuntime({ base_url: API_URL, response_key: "short", app_salt: SALT })).toThrow(/32 bytes/);
  });
});
