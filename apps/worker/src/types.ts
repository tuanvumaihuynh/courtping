import type { Availability, BookingRules } from "@courtping/alobo";

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
  /** HH:MM; slots starting at this time are listed first and highlighted. */
  preferred_start?: string | null;
}

/** The part of the Workers KV API this worker uses. */
export interface KV {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  STATE: KV;
  CONFIG: string;
  ALOBO_RUNTIME: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  RUN_TOKEN?: string;
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
  /** Per-venue booking horizon, refreshed daily. */
  rules?: Record<string, BookingRules & { fetchedAt: number }>;
}
