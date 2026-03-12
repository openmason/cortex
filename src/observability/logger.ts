/**
 * Structured JSON logger for Cloudflare Workers.
 *
 * All output goes through console.log(JSON.stringify(...)) so Cloudflare
 * captures it as structured data in Workers Logs / Tail.
 *
 * Supports child loggers for adding context mid-request (e.g., workflowId).
 */

export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  product?: string;
  workflowId?: string;
  [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private module: string;
  private context: LogContext;
  private minLevel: number;

  constructor(module: string, context?: LogContext, level?: LogLevel) {
    this.module = module;
    this.context = context ?? {};
    this.minLevel = LEVEL_ORDER[level ?? "info"];
  }

  /** Access the logger's context (e.g., to extract requestId for correlation headers). */
  getContext(): Readonly<LogContext> {
    return this.context;
  }

  /** Create a child logger with additional context merged in. */
  child(extra: Record<string, unknown>): Logger {
    const child = new Logger(this.module, { ...this.context, ...extra });
    child.minLevel = this.minLevel;
    return child;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data);
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      module: this.module,
      msg,
      ...this.context,
      ...data,
    };

    // Use the matching console method so Cloudflare can classify severity
    switch (level) {
      case "debug":
        console.debug(JSON.stringify(entry));
        break;
      case "warn":
        console.warn(JSON.stringify(entry));
        break;
      case "error":
        console.error(JSON.stringify(entry));
        break;
      default:
        console.log(JSON.stringify(entry));
    }
  }
}
