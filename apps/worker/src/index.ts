import { cleanup, isCleanupCron } from "./cleanup.ts";
import { handleUpdate, type TelegramUpdate } from "./commands.ts";
import { jitterMs, run } from "./run.ts";
import type { Env } from "./types.ts";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Compare without stopping at the first differing character. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(controller: { cron: string; scheduledTime: number }, env: Env, ctx: ExecutionContext): Promise<void> {
    if (isCleanupCron(env.CONFIG, controller.cron)) {
      ctx.waitUntil(cleanup(env).then((log) => console.log(log.join("\n"))));
      return;
    }
    const delay = jitterMs(env.CONFIG);
    const skipIfRanSince = controller.scheduledTime;
    ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, delay)).then(() => run(env, { skipIfRanSince })));
  },

  /**
   * `POST /run` with `Authorization: Bearer <RUN_TOKEN>`: manual trigger; `?dry=1` sends and saves nothing.
   * `POST /telegram`: Telegram webhook for group commands, authenticated by its secret token header.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram" && env.TELEGRAM_WEBHOOK_SECRET) {
      const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!sameSecret(secret, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });
      try {
        console.log(await handleUpdate(env, (await request.json()) as TelegramUpdate, Date.now()));
      } catch (e) {
        // Telegram retries non-2xx responses; a failed reply is not worth retrying.
        console.error("command failed", e);
      }
      return new Response("ok");
    }
    if (request.method !== "POST" || url.pathname !== "/run" || !env.RUN_TOKEN) return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json(await run(env, { dryRun: url.searchParams.has("dry") }));
  },
};
