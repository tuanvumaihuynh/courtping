export type AppErrorCode = "config_error" | "telegram_error" | "bug";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number | undefined = undefined;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
