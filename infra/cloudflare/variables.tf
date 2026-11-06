variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID (dashboard → Workers & Pages, right sidebar)."
}

variable "name" {
  type        = string
  default     = "courtping"
  description = "Worker script name; also prefixes the KV namespace title."
}

variable "telegram_bot_token" {
  type      = string
  sensitive = true
}

variable "telegram_chat_id" {
  type        = string
  sensitive   = true
  description = "Group chat id, usually negative (-100...)."
}

variable "alobo_runtime" {
  type = object({
    version      = string
    base_url     = string
    response_key = string
    app_salt     = string
  })
  sensitive   = true
  default     = null # lets `task destroy` run before the runtime file exists
  description = "Written by `task alobo:fetch-runtime`; `task deploy` refreshes it."
}

variable "venues" {
  type        = list(string)
  description = "Venue aliases (an-khanh, level-up, lavie, khanh-hong, binh-an) or Alobo IDs (sport_...)."
}

variable "sessions" {
  type = list(object({
    weekdays         = list(string)
    from             = string
    to               = string
    duration_minutes = number
    courts           = number
    step_minutes     = optional(number, 30)
  }))
  description = "Practice sessions to watch. Times are Asia/Ho_Chi_Minh, HH:MM (`to` may be 24:00)."
}

variable "lookahead_days" {
  type    = number
  default = 7
}

variable "backoff_hours" {
  type        = number
  default     = 6
  description = "How long to pause after Alobo answers 401/403/429."
}

variable "crons" {
  type        = list(string)
  description = "Cron expressions in UTC. Default: every 30 minutes, 07:00–23:00 Vietnam time."
  default     = ["*/30 0-16 * * *"]
}

variable "enable_http_trigger" {
  type        = bool
  default     = true
  description = "Expose POST /run on workers.dev for `task run`."
}
