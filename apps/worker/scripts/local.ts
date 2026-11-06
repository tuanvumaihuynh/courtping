/**
 * Run one check on this machine with the same code as the deployed worker.
 *
 *   LOCAL_INPUT='{"config":{...},"telegram":{"token":"...","chat_id":"..."}}' \
 *     node scripts/local.ts --runtime <alobo_runtime.auto.tfvars.json> [--dry-run] [--state <file>]
 *
 * `task dry-run` and `task local` build LOCAL_INPUT from infra/cloudflare/terraform.tfvars.
 * With --dry-run messages are printed and state stays in memory; otherwise messages go to Telegram
 * and state is kept in --state (default .state/local.json).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { run } from "../src/run.ts";
import type { Env, KV } from "../src/types.ts";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    state: { type: "string", default: ".state/local.json" },
    "dry-run": { type: "boolean", default: false },
  },
});

const input = process.env.LOCAL_INPUT;
if (!values.runtime || !input) {
  console.error("usage: LOCAL_INPUT='<json>' node scripts/local.ts --runtime <file> [--dry-run] [--state <file>]");
  process.exit(2);
}

const { config, telegram } = JSON.parse(input) as { config: unknown; telegram?: { token?: string; chat_id?: string } };
const { alobo_runtime } = JSON.parse(readFileSync(values.runtime, "utf8")) as { alobo_runtime: unknown };
const dryRun = values["dry-run"];

function fileKv(path: string): KV {
  const read = (): Record<string, string> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  return {
    get: async (key) => {
      const value = read()[key];
      return value === undefined ? null : JSON.parse(value);
    },
    put: async (key, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify({ ...read(), [key]: value }, null, 2));
      renameSync(`${path}.tmp`, path);
    },
  };
}

function memoryKv(): KV {
  const data = new Map<string, string>();
  return {
    get: async (key) => (data.has(key) ? JSON.parse(data.get(key)!) : null),
    put: async (key, value) => void data.set(key, value),
  };
}

if (!dryRun && (!telegram?.token || !telegram.chat_id)) {
  console.error("Missing telegram_bot_token / telegram_chat_id in terraform.tfvars");
  process.exit(2);
}

const env: Env = {
  CONFIG: JSON.stringify(config),
  ALOBO_RUNTIME: JSON.stringify(alobo_runtime),
  TELEGRAM_BOT_TOKEN: telegram?.token ?? "",
  TELEGRAM_CHAT_ID: telegram?.chat_id ?? "",
  STATE: dryRun ? memoryKv() : fileKv(values.state),
};

const startedAt = performance.now();
const { log, skipped } = await run(env, { dryRun });
for (const line of log) console.log(`${dryRun ? line.replace(/<[^>]+>/g, "") : line}\n`);
if (skipped) console.log(skipped);
console.error(`(done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s${dryRun ? ", dry run" : ""})`);
