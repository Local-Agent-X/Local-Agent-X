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
  // Route through console.log / console.warn / console.error so the
  // file-mirror override installed in src/index.ts (which wraps all
  // three to also write to ~/.lax/logs/server.log) picks up every
  // logger call. Old direct `process.stdout.write` bypassed that
  // override entirely — any logger.info / .warn / .error never landed
  // on disk, only in the Electron-captured stdout of the child server
  // process. Symptom: developer-side stress test couldn't grep
  // server.log for boot audits, chat traces, or post-mortem logs.
  // Stderr split preserved: warn + error → console.error (stderr-mirrored),
  // info + debug → console.log (stdout-mirrored).
  const useStderr = level === "error" || level === "warn";
  if (JSON_MODE) {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, ns, msg };
    if (extra.length === 1) record.extra = extra[0] instanceof Error ? { message: extra[0].message, stack: extra[0].stack } : extra[0];
    else if (extra.length > 1) record.extra = extra;
    const line = JSON.stringify(record);
    try { useStderr ? console.error(line) : console.log(line); } catch { /* writes can't fail the agent */ }
    return;
  }
  const tail = extra.length > 0 ? " " + extra.map(fmtArg).join(" ") : "";
  const line = `[${ns}] ${msg}${tail}`;
  try { useStderr ? console.error(line) : console.log(line); } catch { /* writes can't fail the agent */ }
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
