/**
 * Point the bot's Telegram webhook at the Worker and publish its command menu, or remove both.
 *
 *   TELEGRAM_BOT_TOKEN=... WEBHOOK_URL=https://<worker>.workers.dev/telegram WEBHOOK_SECRET=... \
 *     node scripts/telegram-webhook.ts set
 *   TELEGRAM_BOT_TOKEN=... node scripts/telegram-webhook.ts delete
 *
 * `task deploy` and `task destroy` run this. With a webhook set, getUpdates returns nothing.
 */
import { COMMANDS } from "../src/telegram.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;
const action = process.argv[2];
if (!token || (action !== "set" && action !== "delete")) {
  console.error("usage: TELEGRAM_BOT_TOKEN=... [WEBHOOK_URL=... WEBHOOK_SECRET=...] node scripts/telegram-webhook.ts set|delete");
  process.exit(2);
}

async function call(method: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) throw new Error(`${method}: HTTP ${res.status} ${json.description ?? ""}`.trim());
  console.log(`${method}: ok`);
}

if (action === "set") {
  const url = process.env.WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!url || !secret) {
    console.error("set needs WEBHOOK_URL and WEBHOOK_SECRET");
    process.exit(2);
  }
  await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
  await call("setMyCommands", { commands: COMMANDS });
} else {
  await call("deleteWebhook", { drop_pending_updates: true });
  await call("deleteMyCommands");
}
