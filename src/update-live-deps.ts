/**
 * The update paths' shared steps that touch the live install or git: the
 * dependency install on the live tree and the git commands both git-route
 * halves (prepare, land) run. Every one runs off the event loop.
 */
import { composeGitArgs, execGit } from "./git-safety.js";
import { createLogger } from "./logger.js";
import { runNpmAt } from "./self-edit/sandbox-gates.js";

const logger = createLogger("update-pipeline");
const GIT_TIMEOUT_MS = 60_000;

/** A `git ...` command in `cwd`, off the event loop (the fetch waits on the network). */
export async function updateGit(cmd: string, cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return (await execGit(composeGitArgs(cmd.replace(/^git\s+/, "")), { cwd, timeout: timeoutMs })).trim();
}

/** How many commits on the fetched origin/main bring a change this checkout lacks —
 *  whether there is an update at all. Counted by change, not by commit id: a
 *  developer_mode install whose own commit reached origin as a copy (cherry-picked
 *  or rebased, so a new id) already has that change, and an id count offered it
 *  as an update that would only merge in what was already there. */
export async function upstreamChangesMissing(cwd: string): Promise<number> {
  return parseInt(await updateGit("git rev-list --count --right-only --cherry-pick HEAD...origin/main", cwd), 10) || 0;
}

/** A Windows file lock (a loaded native module, AV, or the file indexer), as
 *  opposed to a real dependency error. The update can DEFER these to next-launch
 *  reconcile; it must NOT revert over them. */
export function isDeferrableFileLock(msg: string): boolean {
  return /EBUSY|EPERM|EACCES|resource busy or locked/i.test(msg);
}

/**
 * Sync the LIVE install's node_modules to the just-applied lockfile.
 *
 * `npm install` (incremental), NEVER `npm ci`: ci wipes node_modules and so must
 * unlink EVERY native module — including ones the running server holds loaded
 * (sqlite-vec's vec0.dll) — which Windows refuses with EPERM. install touches
 * only what changed.
 *
 * Returns deferred=true when the ONLY failure was a Windows file lock on a
 * loaded native module the update bumped: the lockfile on disk is already
 * current, and the next launch's pre-server reconcile (desktop/src/reconcile.ts)
 * reinstalls deps BEFORE the server child loads any native module, where the
 * in-place swap is safe. Rethrows any other npm error (a real dependency
 * problem). Shared by the git and rolling paths so both defer identically
 * instead of one reverting where the other defers.
 */
export async function syncLiveDeps(installDir: string): Promise<{ deferred: boolean }> {
  // Async: a synchronous install held the server for its whole run (19-28 s
  // freezes logged during one update).
  // --no-save: the lockfile stays as committed. A plain install under another
  // npm major rewrites it, and a git install then refuses the next update over
  // a "local change" it made itself (desktop/src/reconcile.ts NPM_INSTALL_ARGS).
  const r = await runNpmAt(installDir, ["install", "--no-save"]);
  if (r.ok) return { deferred: false };
  const msg = r.stderr || r.stdout || "npm install failed";
  if (!isDeferrableFileLock(msg)) throw new Error(msg.slice(-1500));
  logger.warn(`[update] live npm install hit a file lock; deferring deps to next-launch reconcile: ${msg.split("\n")[0]}`);
  return { deferred: true };
}
