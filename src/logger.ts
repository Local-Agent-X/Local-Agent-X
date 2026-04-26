/**
 * Structured logger. Replaces ad-hoc console.* calls across the codebase.
 *
 * Output format: `[namespace] [level] message ...extra`
 * Errors and warnings go to stderr; info/debug go to stdout.
 *
 * Level filter via env: LAX_LOG_LEVEL=debug|info|warn|error  (default: info)
 * JSON-line output via env: LAX_LOG_JSON=1                    (default: human-readable)
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (process.env.LAX_LOG_LEVEL as LogLevel | undefined);
const MIN = PRIORITY[envLevel ?? "info"] ?? PRIORITY.info;
const JSON_MODE = process.env.LAX_LOG_JSON === "1";

function fmtArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function emit(level: LogLevel, ns: string, msg: string, extra: unknown[]): void {
  if (PRIORITY[level] < MIN) return;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (JSON_MODE) {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, ns, msg };
    if (extra.length === 1) record.extra = extra[0] instanceof Error ? { message: extra[0].message, stack: extra[0].stack } : extra[0];
    else if (extra.length > 1) record.extra = extra;
    try { stream.write(JSON.stringify(record) + "\n"); } catch { /* writes can't fail the agent */ }
    return;
  }
  const tail = extra.length > 0 ? " " + extra.map(fmtArg).join(" ") : "";
  try { stream.write(`[${ns}] ${msg}${tail}\n`); } catch { /* writes can't fail the agent */ }
}

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
  child(subNs: string): Logger;
}

export function createLogger(namespace: string): Logger {
  return {
    debug: (m, ...e) => emit("debug", namespace, m, e),
    info: (m, ...e) => emit("info", namespace, m, e),
    warn: (m, ...e) => emit("warn", namespace, m, e),
    error: (m, ...e) => emit("error", namespace, m, e),
    child: (subNs) => createLogger(`${namespace}.${subNs}`),
  };
}
