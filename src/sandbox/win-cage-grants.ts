// Grants: what the caged shell may touch. Split from win-cage.ts (400-LOC cap).
//
// The sandbox user sees nothing under the real user's profile, and LAX's
// own tooling lives there: the portable Git it ships as the shell, the node
// it runs on, its own code (NODE_PATH points at it). Without read access to
// those, the cage refuses to start bash at all (2026-09-28, the first live
// run). So, once per process: read grants on those roots when they are under
// the profile, a write grant on the workspace, refcounted by the helper under
// this pid and revoked at exit.
//
// Never made on a spawn, and never on the event loop: a grant stamps every
// file under the workspace, node_modules included, and the synchronous grant
// the first dev-server start after a restart used to make froze every chat and
// page request until it finished. The server starts it in the background when
// a fence proof lands (restartWinCageGrants); a spawn that can wait awaits it,
// and the one that cannot (startSession, through the wrap) is refused,
// retryably, until it is done. A failure is latched with its reason instead of
// being retried by every command (the same slow call each time): the next
// proof, after the cage is reinstalled, or a restart retries it.

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path/win32";
import { beginApprovalWait } from "../approval-wait.js";
import { workspaceRoot } from "../config.js";
import { createLogger } from "../logger.js";
import { resolveWindowsShell, windowsShellInstallRoot } from "../tools/shell-env.js";
import { parseHelperStatus, resolveWinCageHelper, underUserProfile, WIN_CAGE_SUBLAYER_GUID } from "./win-cage.js";

const logger = createLogger("sandbox.win-cage");

/** Directories the caged shell must read that sit under the real user's
 *  profile, deduplicated (a root covers its subpaths). Elsewhere is readable. */
export function winCageReadGrants(shell: string, execPath = process.execPath, projectRoot = process.cwd(), home = homedir()): string[] {
  const out: string[] = [];
  // Not the app's own code: NODE_PATH points at it for the agent's scripts,
  // but its node_modules is the largest tree on the machine and the ACE
  // propagation over it took 12 seconds on the first live run. A script that
  // needs a package installs it in the workspace.
  void projectRoot;
  for (const candidate of [windowsShellInstallRoot(shell), dirname(resolve(execPath))]) {
    if (!underUserProfile(candidate, home)) continue;
    const c = candidate.toLowerCase();
    if (out.some((o) => c === o.toLowerCase() || c.startsWith(o.toLowerCase() + sep))) continue;
    out.push(candidate);
  }
  return out;
}

/** What a spawn refused while the grants are still being made says. */
export const WIN_CAGE_GRANT_PENDING_RETRY = "The Windows shell cage is still giving its sandbox user access to the workspace (once after each start); try again shortly.";

/** Thrown by the spawn that cannot wait while the grants are being made. Retryable. */
export class WinCageGrantPendingError extends Error {
  constructor() {
    super(`${WIN_CAGE_GRANT_PENDING_RETRY} Nothing was started.`);
    this.name = "WinCageGrantPendingError";
  }
}

/** Thrown by every caged spawn once the grant has failed in this process. */
export class WinCageGrantFailedError extends Error {
  constructor(reason: string) {
    super(`The Windows shell cage could not give its sandbox user access to the workspace and the shell's own files (${reason}), so it cannot run commands. Remove and reinstall the Windows network cage in Settings → Security to try again; restarting the app also retries it.`);
    this.name = "WinCageGrantFailedError";
  }
}

// The helper rescans its holder ledger on every call (about 8 seconds here
// even when nothing is new), and a grant stamps every file under the
// workspace. Off the event loop this bounds a hung helper, not a slow grant:
// one killed midway is left half made and latched as failed.
const GRANT_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;

const granted = { read: [] as string[], write: [] as string[] };
/** Whom the helper holds this pid's grants for, revoked at exit. */
let holder: { helper: string; sid: string } | null = null;
let revokeRegistered = false;
let warming: Promise<void> | null = null;
let failure: string | null = null;
// Bumped when a fence proof lands: a grant started before it is about the
// cage as it was, and the one started since owns the answer.
let generation = 0;

function covered(path: string, roots: string[]): boolean {
  // underUserProfile is the plain containment test: the root itself or below
  // it. The ACEs are inherited, so a granted root covers its subpaths.
  return roots.some((root) => underUserProfile(path, root));
}

function grantsNeeded(shell: string): { read: string[]; write: string[] } | null {
  const read = winCageReadGrants(shell).filter((p) => !covered(p, granted.read));
  const write = [workspaceRoot()].filter((p) => !covered(p, granted.write));
  return read.length === 0 && write.length === 0 ? null : { read, write };
}

function callHelper(helper: string, args: string[], timeoutMs: number, input?: string): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((done) => {
    const child = execFile(helper, args, { windowsHide: true, timeout: timeoutMs, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (!error) { done({ ok: true, stdout }); return; }
      const e = error as Error & { code?: number | string; killed?: boolean };
      const why = e.killed ? `the helper did not answer within ${Math.round(timeoutMs / 1000)} s` : `the helper exited with ${e.code ?? "an error"}`;
      const said = String(stderr ?? "").trim().split("\n")[0].trim();
      done({ ok: false, reason: said ? `${why}: ${said}` : why });
    });
    child.stdin?.end(input);
  });
}

async function grantOnce(req: { read: string[]; write: string[] }): Promise<{ helper: string; sid: string } | { reason: string }> {
  const helper = resolveWinCageHelper();
  if (!helper) return { reason: "the cage helper is no longer present" };
  const status = await callHelper(helper, ["status", "--sublayer-guid", WIN_CAGE_SUBLAYER_GUID], STATUS_TIMEOUT_MS);
  if (!status.ok) return { reason: `its status could not be read: ${status.reason}` };
  let sid: string | undefined;
  try { sid = parseHelperStatus(status.stdout).userSid; } catch { /* unreadable status reads as no sandbox user */ }
  if (!sid) return { reason: "the helper reports no sandbox user" };
  const r = await callHelper(helper, ["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", sid], GRANT_TIMEOUT_MS, JSON.stringify(req));
  return r.ok ? { helper, sid } : { reason: r.reason };
}

function registerRevoke(): void {
  if (revokeRegistered) return;
  revokeRegistered = true;
  process.once("exit", () => {
    const { helper, sid } = holder!;
    try { execFileSync(helper, ["acl", "revoke", "--holder-pid", String(process.pid), "--sandbox-user-sid", sid], { windowsHide: true, timeout: 10_000, stdio: "ignore" }); } catch { /* the helper prunes dead holders on its next acl op */ }
  });
}

async function grant(req: { read: string[]; write: string[] }): Promise<void> {
  const gen = generation;
  const started = Date.now();
  const outcome = await grantOnce(req);
  if (gen !== generation) return;
  if ("reason" in outcome) {
    failure = outcome.reason;
    logger.warn(`[win-cage] grant failed; caged commands are refused until the cage is proven again: ${outcome.reason}`);
    return;
  }
  granted.read.push(...req.read);
  granted.write.push(...req.write);
  holder = outcome;
  registerRevoke();
  logger.info(`[win-cage] sandbox user granted the shell's files and the workspace in ${Math.round((Date.now() - started) / 1000)} s`);
}

/** Grant what `shell` needs, after any grant already running. Never rejects. */
async function warm(shell: string): Promise<void> {
  while (warming) await warming;
  if (failure) return;
  const req = grantsNeeded(shell);
  if (!req) return;
  const run = grant(req);
  warming = run;
  await run;
  if (warming === run) warming = null;
}

/**
 * A fence proof landed: at start, or again after the cage was installed or
 * removed, so what this process granted, and a failure it latched, are about
 * the cage as it was. Starts over and, when the cage is in use, grants again
 * in the background so the first command finds it done.
 */
export function restartWinCageGrants(cageInUse: boolean): void {
  generation++;
  granted.read.length = 0;
  granted.write.length = 0;
  failure = null;
  if (cageInUse) void warm(resolveWindowsShell().path);
}

/**
 * Before an async spawn on the Windows cage: wait for what `shell` needs,
 * joining the grant already running (or starting one). An abort ends the wait
 * and the caller reads its signal. The wait is booked as time the tool was not
 * working (approval-wait.ts), as the fence proof's is. Throws
 * WinCageGrantFailedError, having started nothing, once a grant has failed.
 */
export async function ensureWinCageGrants(shell: string, signal?: AbortSignal): Promise<void> {
  if (!grantsNeeded(shell)) return;
  if (!failure && !signal?.aborted) {
    const endWait = beginApprovalWait();
    let release!: () => void;
    const aborted = new Promise<void>((r) => { release = r; });
    signal?.addEventListener("abort", release, { once: true });
    try {
      while (grantsNeeded(shell) && !failure && !signal?.aborted) await Promise.race([warm(shell), aborted]);
    } finally {
      signal?.removeEventListener("abort", release);
      endWait();
    }
  }
  if (failure) throw new WinCageGrantFailedError(failure);
}

/** The same for the spawn that cannot wait (startSession, through the wrap):
 *  it never grants on the event loop. While the grants are still being made it
 *  starts them if nothing has and refuses, retryably (WinCageGrantPendingError). */
export function ensureWinCageGrantsSync(shell: string): void {
  if (!grantsNeeded(shell)) return;
  if (failure) throw new WinCageGrantFailedError(failure);
  void warm(shell);
  throw new WinCageGrantPendingError();
}
