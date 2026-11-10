import type { Availability, BookingRules } from "@courtping/alobo";
import type { SlotMessage } from "./telegram.ts";

export interface Session {
  weekdays: string[];
  /** HH:MM, Asia/Ho_Chi_Minh */
  from: string;
  /** HH:MM or 24:00 */
  to: string;
  duration_minutes: number;
  courts: number;
  step_minutes?: number;
}

export interface Config {
  venues: string[];
  sessions: Session[];
  lookahead_days?: number;
  backoff_hours?: number;
  /** Cron runs start after a random delay of up to this many minutes. */
  jitter_minutes?: number;
  /** HH:MM; slots starting at this time are listed first and highlighted. */
  preferred_start?: string | null;
  /** The Worker's cron expressions (UTC), shown by /schedule and /status. */
  crons?: string[];
  /** Cron expressions (UTC) that update or delete slot messages instead of checking Alobo. */
  cleanup_crons?: string[];
}

/** The part of the Workers KV API this worker uses. */
export interface KV {
  get(key: string, type: "json"): Promise<unknown>;
  /** `expiration` is in seconds since the epoch. */
  put(key: string, value: string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  STATE: KV;
  CONFIG: string;
  ALOBO_RUNTIME: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RUN_TOKEN?: string;
  /** Telegram sends it in X-Telegram-Bot-Api-Secret-Token; unset disables /telegram. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}

/** A sent slot message, kept in KV under `msg:<message_id>` until all its slots are gone. */
export interface SentMessage extends SlotMessage {
  sentAt: number;
  /** The text Telegram shows now. */
  text: string;
  /** KV expiration (seconds since the epoch), kept when the record is rewritten. */
  expiration: number;
}

export interface Match extends Availability {
  start: number;
  end: number;
}

export interface State {
  /** Slot key → slot start (ms) for every slot already announced and still free. */
  seen: Record<string, number>;
  blockedUntil: number | null;
  error: { code: string; since: number } | null;
  /** Per-venue booking horizon, name and address, refreshed daily. */
  rules?: Record<string, BookingRules & { name?: string; address?: string; fetchedAt: number }>;
  /** Every slot free at the last successful check, announced or not. Read by /slots. */
  free?: Match[];
  lastRun?: { at: number; ok: boolean; windows: number; requests: number };
  lastSuccessAt?: number;
}
