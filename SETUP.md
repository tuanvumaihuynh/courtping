# Setup

From nothing to a bot that posts free courts to your Telegram group. Takes about 20 minutes.

## 1. Tools

Install [nvm](https://github.com/nvm-sh/nvm), then:

```sh
brew install go-task opentofu
nvm install 26 && nvm use   # the repo pins Node in .nvmrc
npm install -g pnpm@11
```

Check: `node -v` prints `v26.x`, and `task --version`, `tofu version`, `pnpm -v` all work.

## 2. Telegram bot

1. Open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a display name and a
   username ending in `bot`. BotFather replies with a token like `123456789:AA...`. Treat it like a
   password: anyone with it can post as the bot.
2. Create a group for the people who play together (or use an existing one) and add the bot as a member.
   The bot only sends messages, so it does not need admin rights, and privacy mode can stay on (the group
   member list will say "has no access to messages"; that is fine).
3. Find the group's chat id. In the group, send `/start@<your_bot_username>`. Then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and look for
   `"chat":{"id":-1234567890,"title":"...","type":"group"}`. Use `chat.id`, not `from.id` (that one is you).

If `getUpdates` returns `"result":[]`:

- With privacy mode on, the bot only sees commands. Send the `/start@...` command, not a normal message.
- Updates are kept for 24 hours and only cover messages sent after the bot joined.
- A bot with a webhook gets no updates here. Call `https://api.telegram.org/bot<TOKEN>/deleteWebhook`.

If Telegram later upgrades the group to a supergroup, the chat id changes to `-100...` and sending fails
with `telegram_error` in the Worker logs. Repeat step 3 and redeploy.

## 3. Cloudflare

You need a Cloudflare account on the free Workers plan. The free plan never bills: past its limits,
requests fail instead.

1. **Account ID.** In the [dashboard](https://dash.cloudflare.com), open Workers & Pages. The account ID
   is in the right sidebar and in the URL (`dash.cloudflare.com/<account-id>/...`). It is 32 hex
   characters.
2. **workers.dev subdomain.** On the Workers & Pages overview, set up your `<name>.workers.dev`
   subdomain if you have not already. `task run` calls the Worker through it.
3. **API token.** Go to My Profile → API Tokens → Create Token → Create Custom Token, and grant:
   - Account → Workers Scripts → Edit
   - Account → Workers KV Storage → Edit

   Limit it to your account. The token starts with `cfut_` (newer tokens) and is only shown once.

## 4. Configure

```sh
cp .env.example .env
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars
```

`.env`:

```sh
CLOUDFLARE_API_TOKEN=cfut_...
```

`infra/cloudflare/terraform.tfvars`:

```hcl
cloudflare_account_id = "0123456789abcdef0123456789abcdef"  # the account ID, not the API token
telegram_bot_token    = "123456789:AA..."
telegram_chat_id      = "-1234567890"

venues = ["an-khanh", "level-up"]  # aliases or Alobo IDs (sport_...)

sessions = [
  { weekdays = ["mon", "tue", "wed", "thu", "fri"], from = "19:00", to = "22:00", duration_minutes = 120, courts = 1, step_minutes = 60 },
]

lookahead_days  = 7
preferred_start = "19:00"           # optional: list and highlight these slots first
jitter_minutes  = 5                 # optional: start each cron run 0-5 minutes late
crons           = ["0 0-15 * * *"]  # UTC; hourly, 07:00-22:00 in Vietnam
```

Both files are gitignored. Venue IDs come from Alobo; see "Finding venues" below.

Keep the request volume low. Each run makes one request per time window (all venues share it), plus one
for `version.json`. `weekdays × starts per day × lookahead` should stay well under 40; the config above
is about 12.

## 5. Deploy

```sh
task dry-run   # one check against live Alobo; prints the messages it would send
task deploy    # extracts the Alobo key, builds the worker, tofu apply (no prompt)
task run       # runs the deployed Worker once; sends to the group
task status    # prints the bot state stored in KV
```

A run with no new free slots sends nothing. To confirm the bot can post, look at the group after
`task run` when `task dry-run` showed slots.

After testing you can turn off the public `/run` endpoint by adding `enable_http_trigger = false` to
`terraform.tfvars` and running `task deploy`. `task local` still runs a real check from your machine.

To change venues or times, edit `terraform.tfvars` and run `task deploy` again.

## 6. Tear down

```sh
task destroy
```

OpenTofu state is in `infra/cloudflare/terraform.tfstate`. It holds the bot token and Alobo key in plain
text, and `task destroy` needs it, so back it up somewhere private and do not delete it while the Worker
exists. After destroying, check the dashboard once: the provider says it cannot delete cron triggers
itself; they go away with the Worker script.

## Finding venues

Venue IDs look like `sport_hoc_vien_cau_long_tpro`. The Alobo booking page of a venue has the ID in its
URL: `https://datlich.alobo.vn/san/<id>`. Aliases for a few District 2 venues are in
`packages/alobo/src/client.ts` (`VENUE_ALIASES`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `task run`: `SSL routines ... handshake failure` | A new workers.dev hostname has no certificate yet. Wait a few minutes. |
| `tofu apply`: `Provider produced inconsistent result after apply` | Known Cloudflare provider v5 issue. Run `task deploy` again. |
| `tofu plan` always shows the Worker script "will be updated" | Same provider issue; harmless. |
| Group message: `frontend_changed` or `decode_error` | Alobo shipped a new web app. Run `task deploy` to extract the new key. |
| Group message: `rate_limited` | Alobo returned 429. The bot pauses until the rate-limit window resets (at least 5 minutes, at most `backoff_hours`). If it keeps happening, reduce windows or run less often. |
| `task deploy`: `fetch-runtime: frontend config structure changed` | Alobo changed its bundle layout. `packages/alobo/src/runtime.ts` needs an update. |
| Nothing in the group, `task status` shows `telegram_error` | Wrong token or chat id, or the bot was removed from the group. |
| `Node 26+ required` | Run `nvm use` in the repo root. |
