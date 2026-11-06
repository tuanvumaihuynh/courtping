/**
 * Write the live Alobo runtime as an OpenTofu tfvars JSON file (`{ alobo_runtime: {...} }`).
 * Runs locally because the ~10MB bundle is too large to scan within a free-plan Worker's 10ms CPU budget.
 *
 *   node src/fetch-runtime.ts --out <file>   (or: task alobo:fetch-runtime)
 */
import { renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchRuntime } from "./runtime.ts";

try {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const runtime = await fetchRuntime();
  const json = `${JSON.stringify({ alobo_runtime: runtime }, null, 2)}\n`;
  if (values.out) {
    writeFileSync(`${values.out}.tmp`, json, { mode: 0o600 });
    renameSync(`${values.out}.tmp`, values.out);
  } else {
    process.stdout.write(json);
  }
  console.error(`fetch-runtime: OK, Alobo frontend version ${runtime.version}`);
} catch (error) {
  console.error(`fetch-runtime: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
