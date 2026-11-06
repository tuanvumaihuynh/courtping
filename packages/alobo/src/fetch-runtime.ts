/**
 * Fetch the live Alobo frontend and write `{ alobo_runtime: {...} }` as an OpenTofu tfvars JSON file.
 * Runs locally because the ~10MB bundle is too large to scan within a free-plan Worker's 10ms CPU budget.
 *
 *   node src/fetch-runtime.ts --out <file>   (or: task alobo:fetch-runtime)
 */
import { renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WEB_URL } from "./client.ts";
import { extractRuntime, validateRuntime } from "./runtime.ts";

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res;
}

const liveVersion = async () => ((await (await get(`${WEB_URL}/version.json`)).json()) as { version?: string }).version;

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" } } });

  const version = await liveVersion();
  if (!version) throw new Error("version.json has no version");
  const bundle = await (await get(`${WEB_URL}/main.dart.js`)).text();
  if ((await liveVersion()) !== version) throw new Error("Alobo deployed a new frontend while fetching; retry in a few minutes");

  const runtime = { version, ...extractRuntime(bundle) };
  validateRuntime(runtime);

  const json = `${JSON.stringify({ alobo_runtime: runtime }, null, 2)}\n`;
  if (values.out) {
    writeFileSync(`${values.out}.tmp`, json, { mode: 0o600 });
    renameSync(`${values.out}.tmp`, values.out);
  } else {
    process.stdout.write(json);
  }
  console.error(`fetch-runtime: OK, Alobo frontend version ${version}`);
}

main().catch((error: unknown) => {
  console.error(`fetch-runtime: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
