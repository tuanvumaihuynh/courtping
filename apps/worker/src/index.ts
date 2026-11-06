import { run } from "./run.ts";
import type { Env } from "./types.ts";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
  },

  /** Manual trigger: `POST /run` with `Authorization: Bearer <RUN_TOKEN>`. `?dry=1` sends and saves nothing. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") return new Response("not found", { status: 404 });
    if (!env.RUN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.RUN_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json(await run(env, { dryRun: url.searchParams.has("dry") }));
  },
};
