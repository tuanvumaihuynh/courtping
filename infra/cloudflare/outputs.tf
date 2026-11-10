output "worker_name" {
  value = cloudflare_workers_script.bot.script_name
}

output "run_token" {
  value     = random_password.run_token.result
  sensitive = true
}

output "alobo_frontend_version" {
  value     = try(var.alobo_runtime.version, null)
  sensitive = true
}

output "telegram_commands_enabled" {
  value = var.enable_telegram_commands
}

output "telegram_webhook_secret" {
  value     = random_password.telegram_webhook_secret.result
  sensitive = true
}
