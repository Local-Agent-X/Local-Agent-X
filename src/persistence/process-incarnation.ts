import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The OS's record of when `pid` started, or null when it can't be read (gone,
 *  denied, or the lookup timed out). The same text for the same process every
 *  time, different for a later process that reuses the pid. */
function queryProcessStart(pid: number): string | null {
  try {
    process.kill(pid, 0);
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", startTimeArgs(pid), { encoding: "utf-8", timeout: 5_000, windowsHide: true }).trim();
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8", timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function startTimeArgs(pid: number): string[] {
  return [
    "-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
  ];
}

// This process's own start, read once. Read in the background as the module
// loads, so the first caller rarely waits on the lookup (a synchronous one held
// the event loop ~0.6 s, longer under load); a caller before it lands reads it
// synchronously once.
let selfStart: string | undefined;
function readSelfStartInBackground(): void {
  const done = (out: string | null) => { if (selfStart === undefined) selfStart = out || fallbackSelfStart(); };
  try {
    if (process.platform === "win32") {
      execFile("powershell.exe", startTimeArgs(process.pid), { encoding: "utf-8", timeout: 5_000, windowsHide: true }, (err, out) => done(err ? null : out.trim()));
    } else {
      execFile("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf-8", timeout: 5_000 }, (err, out) => done(err ? null : out.trim()));
    }
  } catch { done(null); }
}
readSelfStartInBackground();

function fallbackSelfStart(): string {
  return `fallback-${Math.round(Date.now() - process.uptime() * 1000)}`;
}

function processStart(pid: number): string | null {
  if (pid !== process.pid) return queryProcessStart(pid);
  if (selfStart === undefined) selfStart = queryProcessStart(process.pid) ?? fallbackSelfStart();
  return selfStart;
}

export function currentProcessIncarnation(): string {
  return `${process.pid}:${processStart(process.pid)}`;
}

/**
 * Whether the process at `pid` is the one `incarnation` names: true when its
 * start time matches, false when the pid is gone or now belongs to a later
 * process (Windows reuses pids quickly), null when its start time can't be
 * read. A caller that must never let two runs act at once treats null as
 * alive; a caller cleaning up after the dead may treat it as gone.
 */
export function processIncarnationMatches(pid: number, incarnation: string): boolean | null {
  try { process.kill(pid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; }
  const started = processStart(pid);
  if (started === null) return null;
  return incarnation === `${pid}:${started}`;
}

export function processIncarnationIsLive(pid: number, incarnation: string): boolean {
  return processIncarnationMatches(pid, incarnation) === true;
}

/**
 * Whether the process that wrote an owner record still runs: the one check
 * every lock and claim makes before taking over from a holder. With the
 * incarnation the record kept, a pid Windows has since given to another
 * process reads as gone, and one whose start time cannot be read reads as
 * alive, so two owners never act at once. Without one (a record written
 * before incarnations were kept), the pid alone answers.
 */
export function processAlive(pid: number, incarnation?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (incarnation) return processIncarnationMatches(pid, incarnation) !== false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Whether no process has `pid` at all. The one proof of a dead owner that costs
 * nothing and cannot be wrong: a pid that still exists may be the owner or a
 * later process that reused it, and telling those apart reads the start time
 * (a process spawn on Windows), which is processAlive's question, not this one.
 */
export function processGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

/**
 * Whether every owner record in a lock directory names a process that is gone:
 * the lock was left by a crash or a kill, and nothing is coming back for it, so
 * a taker need not wait out the age that covers a holder it cannot judge. False
 * for an empty directory, a record that does not parse (its writer may be
 * between creating the file and filling it) and any pid that still exists.
 */
export function lockOwnersGone(lockDir: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    try {
      const owner = JSON.parse(readFileSync(join(lockDir, token), "utf-8")) as { pid?: unknown };
      if (typeof owner.pid !== "number" || !processGone(owner.pid)) return false;
    } catch { return false; }
  }
  return true;
}
