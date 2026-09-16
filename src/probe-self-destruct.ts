// A self_edit/update bind probe (src/self-edit/sandbox-gates.ts) boots a real
// server on an isolated temp data-dir to smoke-test a candidate build, then is
// torn down by killProbe in the gate's finally. If the gate-running process
// dies abnormally before that finally runs, Windows never reaps the orphaned
// probe — it lives forever, holding the repo's loaded native modules (vec0.dll)
// and blocking the next `npm ci`. No external reaper catches it: an isolated
// data-dir makes it invisible to the datadir-lock and the ~/.lax pidfile
// reclaim. So the probe must end itself — exit when the parent that spawned it
// is gone, with a hard max-lifetime backstop for when the parent PID is unknown
// (env unset) or has been reused.

import { createLogger } from "./logger.js";

const logger = createLogger("probe");

function parentAlive(pid: number): boolean {
  // kill(pid, 0) throws ESRCH when the process is gone and EPERM when it exists
  // but we can't signal it — EPERM still means "alive".
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The bind-probe backstop: the self_edit gate's BIND/BUILD timeout is 5min,
 *  so a probe alive at 10min is provably orphaned. */
export const DEFAULT_PROBE_MAX_LIFETIME_MS = 10 * 60_000;

/**
 * The backstop any probe-flagged server uses. Read from the environment because
 * the flag is not only the bind probe's: the op-outcomes eval boots real
 * servers with LAX_SELF_EDIT_PROBE=1 (to read credentials in place), and the
 * 10-minute cap sized for a 5-minute bind check silently killed them
 * MID-TURN. The eval then waited out its own ceiling and scored the case as a
 * model failure — a harness artifact recorded as evidence about a model
 * (2026-09-16). Malformed values fall back to the default rather than
 * disabling the backstop: an orphan that never dies is the failure this whole
 * module exists to prevent.
 */
export function readProbeMaxLifetimeMs(): number {
  const raw = parseInt(process.env.LAX_PROBE_MAX_LIFETIME_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROBE_MAX_LIFETIME_MS;
}

export interface ProbeSelfDestructOpts {
  parentPid: number;
  maxLifetimeMs: number;
  intervalMs?: number;
  /** Injectable for tests; defaults to a real process.kill(pid, 0) probe. */
  isParentAlive?: (pid: number) => boolean;
  /** Injectable for tests; defaults to logging + process.exit(0). */
  onTerminate?: (reason: string) => void;
}

/** Make a probe end itself when its parent dies or it outlives any plausible
 *  gate run. Returns a canceller (used by tests; the probe itself never
 *  cancels). */
export function installProbeSelfDestruct(opts: ProbeSelfDestructOpts): () => void {
  const isAlive = opts.isParentAlive ?? parentAlive;
  const onTerminate = opts.onTerminate ?? ((reason: string) => { logger.warn(`self-terminating — ${reason}`); process.exit(0); });
  const intervalMs = opts.intervalMs ?? 5000;
  let fired = false;
  const fire = (reason: string): void => {
    if (fired) return;
    fired = true;
    clearInterval(watch);
    clearTimeout(cap);
    onTerminate(reason);
  };
  const watch = setInterval(() => {
    if (Number.isInteger(opts.parentPid) && opts.parentPid > 0 && !isAlive(opts.parentPid)) {
      fire(`parent ${opts.parentPid} gone`);
    }
  }, intervalMs);
  watch.unref?.();
  const cap = setTimeout(() => fire("max lifetime reached"), opts.maxLifetimeMs);
  cap.unref?.();
  return () => { clearInterval(watch); clearTimeout(cap); };
}
