import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, LogLevel, LogStatus } from "../shared/logs";

export function redact(value: string): string {
  let result = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/key|token|secret|password|database_url|redis_url/i.test(key) && secret && secret.length >= 4) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        return url.origin + url.pathname;
      } catch { return "[URL]"; }
    })
    .slice(0, 2000);
}

// Preserve the short diagnostic line, never child process stdout/stderr or prompts.
export function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: "UnknownError" };
  const cause = error.cause instanceof Error ? error.cause : undefined;
  const code = (cause ?? error) as Error & { code?: string };
  return {
    error: error.name,
    message: redact(error.message.split(/\r?\n/)[0]),
    ...(cause ? { cause: redact(cause.message.split(/\r?\n/)[0]) } : {}),
    ...(code.code !== undefined ? { code: redact(String(code.code)) } : {}),
  };
}

export class RunLogger {
  readonly startedAt = Date.now();
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();
  private storageWarning = false;
  constructor(
    readonly requestId: string,
    private readonly directory: string,
    private readonly publish: (entry: LogEntry) => void,
  ) {}

  log(stage: string, status: LogStatus, message: string, details?: Record<string, unknown>, level: LogLevel = "info") {
    const safeDetails = details ? JSON.parse(JSON.stringify(details, (key, value) =>
      /key|password|secret|authorization|cookie/i.test(key) ? "[REDACTED]" :
      typeof value === "string" ? redact(value) : value,
    )) : undefined;
    const entry: LogEntry = {
      requestId: this.requestId, sequence: ++this.sequence, timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt, stage, status, level, message: redact(message),
      ...(safeDetails ? { details: safeDetails } : {}),
    };
    const line = JSON.stringify(entry);
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    this.publish(entry);
    this.writes = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(path.join(this.directory, this.requestId + ".jsonl"), line + "\n", { encoding: "utf8", mode: 0o600 });
    }).catch(() => {
      if (this.storageWarning) return;
      this.storageWarning = true;
      const warning: LogEntry = {
        requestId: this.requestId, sequence: ++this.sequence, timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - this.startedAt, stage: "logging", status: "failed", level: "warn",
        message: "ذخیرهٔ فایل لاگ ناموفق بود؛ گزارش زنده و ترمینال همچنان فعال‌اند.",
      };
      console.warn(JSON.stringify(warning));
      this.publish(warning);
    });
    return entry;
  }

  async stage<T>(name: string, label: string, action: () => Promise<T> | T): Promise<T> {
    const started = Date.now();
    this.log(name, "started", label);
    try {
      const result = await action();
      this.log(name, "completed", label + " — انجام شد", { durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const details = errorDetails(error);
      this.log(name, "failed", label + " — خطا", { durationMs: Date.now() - started, ...details }, "error");
      throw new StageError(name, String(details.message ?? details.error), { cause: error });
    }
  }

  async flush() { await this.writes; }
}

export class StageError extends Error {
  constructor(readonly stage: string, message: string, options?: ErrorOptions) { super(message, options); }
}
