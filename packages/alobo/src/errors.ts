export type AloboErrorCode =
  | "frontend_changed"
  | "decode_error"
  | "http_error"
  | "rate_limited"
  | "network_error"
  | "missing_data"
  | "schema_changed";

export class AloboError extends Error {
  readonly code: AloboErrorCode;
  readonly status: number | undefined;
  /** For `rate_limited`: how long until Alobo's window resets, when its headers said so. */
  readonly retryAfterMs: number | undefined;

  constructor(code: AloboErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "AloboError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Statuses after which callers should stop sending requests for a while. */
export const BLOCKING_STATUSES = new Set([401, 403, 429]);
