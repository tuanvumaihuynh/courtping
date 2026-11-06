terraform {
  required_version = ">= 1.8"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

# Auth: export CLOUDFLARE_API_TOKEN (Workers Scripts:Edit + Workers KV Storage:Edit).
provider "cloudflare" {}

resource "cloudflare_workers_kv_namespace" "state" {
  account_id = var.cloudflare_account_id
  title      = "${var.name}-state"
}

resource "random_password" "run_token" {
  length  = 32
  special = false
}

resource "cloudflare_workers_script" "bot" {
  account_id         = var.cloudflare_account_id
  script_name        = var.name
  main_module        = "index.js"
  content            = file("${path.module}/../../apps/worker/dist/index.js") # built by `task worker:build`
  compatibility_date = "2025-09-01"

  observability = { enabled = true }

  bindings = [
    { name = "STATE", type = "kv_namespace", namespace_id = cloudflare_workers_kv_namespace.state.id },
    {
      name = "CONFIG"
      type = "plain_text"
      text = jsonencode({
        venues          = var.venues
        sessions        = var.sessions
        lookahead_days  = var.lookahead_days
        backoff_hours   = var.backoff_hours
        preferred_start = var.preferred_start
      })
    },
    { name = "ALOBO_RUNTIME", type = "secret_text", text = jsonencode(var.alobo_runtime) },
    { name = "TELEGRAM_BOT_TOKEN", type = "secret_text", text = var.telegram_bot_token },
    { name = "TELEGRAM_CHAT_ID", type = "secret_text", text = var.telegram_chat_id },
    { name = "RUN_TOKEN", type = "secret_text", text = random_password.run_token.result },
  ]
}

resource "cloudflare_workers_cron_trigger" "bot" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.bot.script_name
  schedules   = [for c in var.crons : { cron = c }]
}

# Exposes https://<name>.<account-subdomain>.workers.dev/run for manual runs (needs RUN_TOKEN).
resource "cloudflare_workers_script_subdomain" "bot" {
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.bot.script_name
  enabled          = var.enable_http_trigger
  previews_enabled = false
}
