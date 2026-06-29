/**
 * Dev-server activity tracking — a dependency-free module so connector-proxy can
 * mark traffic (and wake a scaled-down backend) WITHOUT importing dev-server.ts,
 * which imports connector-proxy.ts (that would be a cycle).
 *
 * `lastActive` drives idle auto-stop: a backend the user isn't touching gets
 * killed by the sweeper. `wake` is registered by dev-server.ts at load and lets
 * connector traffic restart a backend that idle-stop took down while its app was
 * still open — so the lifecycle is "runs while in use, sleeps when idle, wakes on
 * the next request."
 */

const lastActive = new Map<string, number>();
let wake: ((appId: string) => void) | null = null;

/** Mark a backend as just-used (app opened or connector request). */
export function noteDevServerAccess(appId: string): void {
  lastActive.set(appId, Date.now());
}

/** The live activity map (appId → ms epoch of last use). Read-only view. */
export function devServerActivity(): ReadonlyMap<string, number> {
  return lastActive;
}

export function forgetDevServerAccess(appId: string): void {
  lastActive.delete(appId);
}

export function clearDevServerActivity(): void {
  lastActive.clear();
}

/** dev-server.ts registers its ensureDevServerRunning here at load. */
export function setDevServerWake(fn: (appId: string) => void): void {
  wake = fn;
}

/** Connector traffic for dev-<appId> calls this: bumps activity and, if the
 *  backend was idle-stopped, restarts it on demand. */
export function wakeDevServer(appId: string): void {
  noteDevServerAccess(appId);
  try { wake?.(appId); } catch { /* best-effort */ }
}
