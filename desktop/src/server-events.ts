// Event contract between the server child lifecycle (server-process.ts) and
// the app shell (main.ts): every way the child can refuse to start or die,
// and what the caller is expected to do about each.

import type { NodeFloorStatus } from "./node-floor";

export interface ServerEventHandlers {
  /** Fired when the server process exits uncleanly (non-zero code or
   *  signal). Caller usually forwards to the renderer to clear the
   *  "typing" indicator + surface a banner. */
  onCrash?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Fired when startServer() refuses to spawn — e.g. PROJECT_ROOT is
   *  unset, or src/index.ts is missing. Without this the failure used
   *  to be a console.error to a /dev/null stdout and the splash hung
   *  forever. Caller surfaces this on the splash so the user sees what
   *  went wrong and how to fix it. */
  onStartupFailure?: (info: { reason: string }) => void;
  /** Fired when the server child exits with code 75 (EX_TEMPFAIL),
   *  which src/lifecycle.ts uses to signal "another LAX server already
   *  owns the pidfile — refuse to start". This is NOT a crash; the
   *  default 3s-restart loop would hit the same refusal forever. The
   *  splash should ask the user to kill the stale server. */
  onAlreadyRunning?: (info: { competingPid?: number; pidfilePath: string }) => void;
  /** Fired when the PATH-resolved `node` is below the project's
   *  engines.node floor (or missing). The spawn is refused — updated app
   *  code on an outdated runtime fails confusingly mid-boot. Caller offers
   *  the one-click upgrade (node-floor.ts promptAndUpgradeNode) and retries
   *  startServer() on success. */
  onNodeTooOld?: (status: NodeFloorStatus) => void;
  /** Fired when the server child exits with a native-addon ABI mismatch
   *  (NODE_MODULE_VERSION in its stderr) — better-sqlite3 was built against a
   *  different Node major than the one we spawn. Caller rebuilds the addon
   *  against the runtime node (native-rebuild.ts) and retries startServer().
   *  Fired at most once per app session so a still-broken rebuild falls
   *  through to the normal crash-loop → repair path instead of looping. */
  onNativeAbiMismatch?: () => void;
}
