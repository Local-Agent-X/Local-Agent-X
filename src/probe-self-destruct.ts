// A self_edit/update bind probe (src/self-edit-sandbox-gates.ts) boots a real
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
