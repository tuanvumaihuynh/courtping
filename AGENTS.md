# AGENTS.md

courtping polls Alobo for free badminton courts and posts new slots to a Telegram group.
It runs as a Cloudflare Worker on a cron; infrastructure is OpenTofu.

## Layout

- `apps/worker`: the Worker. `src/run.ts` is one check; `src/telegram.ts` holds all user-facing text;
  `scripts/local.ts` runs the same code on a laptop.
- `packages/alobo`: Alobo client (request signing, response decryption, availability) and
  `fetch-runtime`, which extracts the frontend version, response key, and salt from `main.dart.js`.
- `infra/cloudflare`: Worker script, KV namespace, cron trigger, secrets.

## Commands

Use Task from the repo root. Node 26 (`nvm use`) and pnpm are required.

- `task test`: typecheck, unit tests, `tofu validate`. Run before every commit.
- `task dry-run`: one check against live Alobo, prints messages. Needs `infra/cloudflare/terraform.tfvars`.
- `task deploy` / `task destroy`: apply or tear down without prompting.

## Conventions

- Everything in the repo is English, except the Telegram text in `apps/worker/src/telegram.ts`, which is
  Vietnamese because the bot posts to a Vietnamese group.
- TypeScript runs directly on Node: relative imports end in `.ts`, and `erasableSyntaxOnly` is on, so no
  enums, namespaces, or constructor parameter properties.
- Keep comments for things the code cannot say. No filler in docs, commit messages, or PR descriptions.
- Tests must not call Alobo or Telegram. Mock `fetch` as in `apps/worker/test/run.test.ts`.
- Never commit `.env`, `terraform.tfvars`, `*.tfstate`, or `alobo_runtime.auto.tfvars.json`.

## Alobo

There is no public API; the client mimics Alobo's web app. Keep it read-only: no booking, payment, or
account endpoints. Keep request volume low (0.5 s between calls, at most 40 windows per run) and stop on
401, 403, or 429. When Alobo ships a new frontend, `packages/alobo/src/runtime.ts` is the first thing
that breaks; update it against the live bundle and keep `test/runtime.test.ts` offline.
