/**
 * Event-loop sentinel — process-wide stall detector that makes a stall NAME
 * ITSELF.
 *
 * Why this exists: this server froze its event loop for 90-110 SECONDS at a
 * stretch, 182 times, and not one log line named the blocker. A blocked
 * process emits nothing — by the time anything can be written, the evidence
 * is gone. src/canonical-loop/worker-heartbeat.ts already notices lateness,
 * but it is OP-SCOPED (it only ticks while a canonical op holds a lease) and
 * it reports a NUMBER, never WHAT held the loop. This is the process-wide
 * counterpart: always sampling, and it captures context on the way out.
 *
 * Why a bare `setInterval` and NOT a JobScheduler job (src/server/scheduler.ts,
 * the canonical recurring-job owner): JobScheduler is itself a bare
 * setInterval wrapped in an async try/catch, and a sick loop is exactly when
 * shared infrastructure cannot be trusted — a job whose `run()` awaits is at
 * the mercy of the same starved microtask queue it is trying to measure, and
 * `stopAll()` would silence the sentinel along with everything else. The
 * sentinel owns one dedicated timer, `.unref()`'d so it never holds the
 * process open, and does no async work on the sampling path.
 *
 * Cost when healthy: one performance.now(), two subtractions, one comparison,
 * one assignment. No allocation, no fs, no logging.
 *
 * Overrides:
 *   LAX_LOOP_SENTINEL_WARN_MS      threshold 1, default 5000
 *   LAX_LOOP_SENTINEL_PROFILE_MS   threshold 2, default 30000
 *   LAX_LOOP_SENTINEL_PROFILE=0    disable CPU-profile capture entirely
 * On by default. That is the point.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFile } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import { getLaxDir } from "../lax-data-dir.js";
import { getTurnRegistry } from "../session/turn-lock.js";
import { createLogger, type Logger } from "../logger.js";

const logger = createLogger("server.loop-sentinel");

/** Sampling cadence. Short enough that a 5s threshold has 10 samples of
 *  resolution, cheap enough to be free. */
const SAMPLE_INTERVAL_MS = 500;
const DEFAULT_WARN_MS = 5_000;
const DEFAULT_PROFILE_MS = 30_000;
/** At most one profile per 10 minutes. That alone still allows 144 multi-MB
 *  files a day forever, so it is only half of "must not fill the disk" — see
 *  PROFILE_RETENTION. */
const PROFILE_COOLDOWN_MS = 10 * 60_000;
/** How long the post-stall profile samples for. */
const PROFILE_DURATION_MS = 5_000;
/** Newest N profiles kept; older ones are deleted on the next capture. Nothing
 *  else prunes ~/.lax/logs (src/index.ts rotates server.log only), so a
 *  permanently sick server would otherwise grow that directory without bound. */
const PROFILE_RETENTION = 12;

/** Monotonic wall-clock-independent milliseconds. Date.now() would let a
 *  laptop resume or an NTP step forward fabricate a multi-hour "stall". */
const monotonicNowMs = (): number => Math.round(performance.now());

type StallLogger = Pick<Logger, "warn" | "error">;

/** Node exposes these but does not document them; they are absent under some
 *  runtimes and embeddings, so every use is typeof-guarded. */
interface UndocumentedProcess {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
}

export interface StallSnapshot {
  lagMs: number;
  /** Live handles (sockets, timers, watchers…) counted by constructor name. */
  handles: Record<string, number>;
  /** Live requests (fs, dns, tcp connects…) counted by constructor name. */
  requests: Record<string, number>;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number; external: number };
  /** Turns that were in flight across the stall — the cheapest available
   *  answer to "who was the process working for". Read-only view of the
   *  in-memory turn registry; nothing here reaches disk. */
  activeTurns: Array<{ sessionId: string; elapsedMs: number; iteration: number; lastToolName?: string }>;
}

export interface EventLoopSentinelDeps {
  now?: () => number;
  logger?: StallLogger;
  intervalMs?: number;
  warnMs?: number;
  profileMs?: number;
  profileEnabled?: boolean;
  profileCooldownMs?: number;
  /** Injected in tests so sampling touches no process/fs state. */
  collectSnapshot?: (lagMs: number) => StallSnapshot;
  /** Kicks off an async capture and synchronously returns its target path. */
  captureProfile?: (lagMs: number) => string;
}

export interface EventLoopSentinel {
  /** Sample once. Production drives this from the interval; tests call it
   *  directly with an injected clock so no real time passes. */
  tick(): void;
  start(): void;
  stop(): void;
}

function readMsEnv(name: string, fallback: number): number {
  // Same guard as readIdleTimeoutMs: a malformed override parses to NaN, and
  // every `lag >= NaN` is false — the sentinel would go permanently blind
  // instead of loudly misbehaving. Require finite and positive.
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function countByType(items: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = (item as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function readUndocumented(fn: (() => unknown[]) | undefined): Record<string, number> {
  if (typeof fn !== "function") return {};
  try { return countByType(fn()); } catch { return {}; }
}

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

/**
 * Everything cheaply knowable about the process the instant the loop came
 * back. Only ever called past threshold 1 — never on the healthy path.
 */
export function collectStallSnapshot(lagMs: number): StallSnapshot {
  const proc = process as unknown as UndocumentedProcess;
  const mem = process.memoryUsage();
  let activeTurns: StallSnapshot["activeTurns"] = [];
  try {
    activeTurns = getTurnRegistry().listActive().map((t) => ({
      sessionId: t.sessionId,
      elapsedMs: t.elapsedMs,
      iteration: t.iteration,
      lastToolName: t.lastToolName,
    }));
  } catch { /* diagnostics must never throw over the thing they diagnose */ }
  return {
    lagMs,
    handles: readUndocumented(proc._getActiveHandles),
    requests: readUndocumented(proc._getActiveRequests),
    memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external) },
    activeTurns,
  };
}

/**
 * Delete all but the newest `keep` stall profiles in `dir`. The filenames carry
 * a fixed-width ISO stamp, so a lexicographic sort is a chronological one — no
 * stat() per file. Only ever touches loop-stall-*.cpuprofile; server.log and
 * everything else in the directory is left alone.
 *
 * Best-effort by construction: this runs on the way out of a stall, and failing
 * a diagnostic capture because a housekeeping unlink lost a race would be the
 * wrong trade. Exported so it can be tested against a real directory.
 */
export function pruneOldStallProfiles(dir: string, keep: number = PROFILE_RETENTION): void {
  let stale: string[];
  try {
    const profiles = readdirSync(dir)
      .filter((f) => f.startsWith("loop-stall-") && f.endsWith(".cpuprofile"))
      .sort();
    stale = profiles.slice(0, Math.max(0, profiles.length - keep));
  } catch {
    return; // no logs directory yet, or it is unreadable: nothing to prune
  }
  for (const f of stale) {
    try { unlinkSync(join(dir, f)); } catch { /* already gone, or in use */ }
  }
}

/**
 * Start a CPU profile and write it to ~/.lax/logs/loop-stall-<ts>.cpuprofile.
 *
 * HONEST LIMITATION: a profile can only be started once the loop is running
 * again, so this captures the AFTERMATH, not the stall. It is still worth
 * having — the observed stalls repeated 182 times, so the aftermath of one is
 * very often the run-up to the next, and a blocker that is still on-CPU when
 * the loop briefly surfaces shows up here by name. Do not read the resulting
 * profile as a recording of the freeze itself.
 *
 * Returns the target path synchronously so the caller can name it in the same
 * log line as the stall; the file appears ~PROFILE_DURATION_MS later.
 */
export function captureStallProfile(lagMs: number, log: StallLogger = logger): string {
  const dir = join(getLaxDir(), "logs");
  // Wall clock, deliberately: the sentinel measures with a monotonic clock, but
  // a filename has to be readable next to the server.log lines it explains.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `loop-stall-${stamp}.cpuprofile`);
  let session: Session;
  try {
    mkdirSync(dir, { recursive: true });
    pruneOldStallProfiles(dir);
    session = new Session();
    session.connect();
  } catch (e) {
    log.warn(`[loop-sentinel] could not open an inspector session after a ${lagMs}ms stall: ${(e as Error).message}`);
    return path;
  }
  const done = (err?: Error | null): void => {
    if (err) log.warn(`[loop-sentinel] profile capture failed: ${err.message}`);
    try { session.disconnect(); } catch { /* already gone */ }
  };
  session.post("Profiler.enable", (enableErr) => {
    if (enableErr) return done(enableErr);
    session.post("Profiler.start", (startErr) => {
      if (startErr) return done(startErr);
      const timer = setTimeout(() => {
        session.post("Profiler.stop", (stopErr, res) => {
          if (stopErr) return done(stopErr);
          // Async write: the sentinel must not block the loop it guards.
          writeFile(path, JSON.stringify(res.profile), (writeErr) => {
            if (writeErr) return done(writeErr);
            log.error(`[loop-sentinel] post-stall CPU profile written to ${path} (aftermath of the ${lagMs}ms stall, not the stall itself)`);
            done();
          });
        });
      }, PROFILE_DURATION_MS);
      timer.unref();
    });
  });
  return path;
}

/**
 * Build a sentinel. `tick()` is the whole measurement: lag is how much later
 * than promised this sample arrived, i.e. how long the loop was unavailable.
 */
export function createEventLoopSentinel(deps: EventLoopSentinelDeps = {}): EventLoopSentinel {
  const now = deps.now ?? monotonicNowMs;
  const log = deps.logger ?? logger;
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;
  const warnMs = deps.warnMs ?? readMsEnv("LAX_LOOP_SENTINEL_WARN_MS", DEFAULT_WARN_MS);
  const profileMs = deps.profileMs ?? readMsEnv("LAX_LOOP_SENTINEL_PROFILE_MS", DEFAULT_PROFILE_MS);
  const profileEnabled = deps.profileEnabled ?? process.env.LAX_LOOP_SENTINEL_PROFILE !== "0";
  const profileCooldownMs = deps.profileCooldownMs ?? PROFILE_COOLDOWN_MS;
  const snapshotOf = deps.collectSnapshot ?? collectStallSnapshot;
  const capture = deps.captureProfile ?? ((lagMs: number) => captureStallProfile(lagMs, log));

  let lastTickAt = now();
  let lastProfileAt = Number.NEGATIVE_INFINITY;
  let timer: NodeJS.Timeout | null = null;

  function tick(): void {
    const at = now();
    const lagMs = at - lastTickAt - intervalMs;
    lastTickAt = at;
    if (lagMs < warnMs) return; // healthy: nothing allocated, nothing logged

    const snapshot = snapshotOf(lagMs);
    let profilePath: string | null = null;
    if (profileEnabled && lagMs >= profileMs && at - lastProfileAt >= profileCooldownMs) {
      // Consume the budget BEFORE capturing: a capture that throws must not
      // re-arm itself on the very next tick of a sick server.
      lastProfileAt = at;
      try {
        profilePath = capture(lagMs);
      } catch (e) {
        log.warn(`[loop-sentinel] profile capture threw: ${(e as Error).message}`);
      }
    }
    log.error(
      `[loop-sentinel] event loop blocked for ${lagMs}ms (sample interval ${intervalMs}ms) — nothing could be logged while it was blocked; snapshot taken on resume: ${JSON.stringify(snapshot)}` +
        (profilePath ? ` — post-stall CPU profile (aftermath, not the stall) will be written to ${profilePath}` : ""),
    );
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      lastTickAt = now();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

let singleton: EventLoopSentinel | null = null;

/** Idempotent process-wide start. Called once from bootstrap-services. */
export function startEventLoopSentinel(): EventLoopSentinel {
  if (!singleton) singleton = createEventLoopSentinel();
  singleton.start();
  return singleton;
}

/** Idempotent stop. Exists so a test or a shutdown path can silence it. */
export function stopEventLoopSentinel(): void {
  singleton?.stop();
}
