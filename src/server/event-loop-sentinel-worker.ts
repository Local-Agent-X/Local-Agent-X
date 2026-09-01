/**
 * Event-loop sentinel, off-thread half — the observer that is NOT hostage to
 * the main thread.
 *
 * WHY THIS EXISTS: event-loop-sentinel.ts measures a stall by noticing that its
 * own sample arrived late, which it can only do ONCE THE LOOP COMES BACK. A
 * block that never ends therefore produces NO report at all — and that is the
 * case that matters, because it is the one where the user force-quits. Proven
 * live: the loop wedged at 15:29:21 and the process was killed minutes later,
 * leaving zero sentinel lines and no .cpuprofile for that session, while the
 * stalls that DID end (435133ms, 31450ms, 6189ms) were all reported with
 * profiles. The instrument worked exactly until the moment it mattered most.
 *
 * A worker_thread has its own event loop and keeps running while the main
 * thread is wedged. The main thread publishes a liveness beat; this worker
 * notices the beats stopped and logs the stall IN PROGRESS, repeatedly, while
 * it is still happening.
 *
 * THE TWO HALVES SEE DIFFERENT THINGS — that is why both are kept:
 *   worker (here)      — that the loop is blocked RIGHT NOW and roughly for how
 *                        long so far. It CANNOT see handles, requests, active
 *                        turns, memory or stacks: those live in the main
 *                        thread's isolate and reading them needs the very loop
 *                        that is stuck. It also cannot say WHAT is blocking.
 *   main thread (there) — the handle/request/turn snapshot and the CPU profile
 *                        (that snapshot is what identified the ChildProcess
 *                        behind the 435s stall) — but only after the loop
 *                        resumes, if it ever does.
 *
 * BEAT TRANSPORT is a SharedArrayBuffer counter, not postMessage: a message has
 * to be queued, delivered and drained through the ports and it allocates, while
 * Atomics.add on a shared cell is one uncontended instruction on the main
 * thread's hot path that needs nothing from anyone's message queue. It also
 * keeps the observation clock-independent — the worker never compares its own
 * performance.now() against the main thread's (worker timeOrigins differ); it
 * only notices that the counter CHANGED and stamps that with its own clock.
 * The second slot runs the other way: the worker bumps CHECKS_INDEX on every
 * look, and the main thread reads that count to tell a stall from a SYSTEM
 * SUSPENSION — through a block this thread keeps looking; through a sleep it is
 * frozen too, so the count moves by 0 or 1 whichever overdue timer wakes first.
 * The verdict lives in event-loop-sentinel.ts (isSuspension); createStallWatch
 * strikes its own self-gap so the wake check is not a "STILL BLOCKED" line.
 *
 * LOGGING is appendFileSync straight to server.log, not console.error: a
 * worker's stdout/stderr is piped to the parent thread and delivered by the
 * PARENT's event loop, so every console line written during a stall would sit
 * in a queue until the loop it is reporting on comes back — exactly the failure
 * this file exists to fix. The append goes to the same ~/.lax/logs/server.log
 * that src/index.ts mirrors console into, in the same `[iso] LEVEL …` shape, so
 * both halves read as one timeline; small O_APPEND writes from two threads do
 * not tear.
 *
 * LIFETIME: a worker_thread cannot outlive its process, so a main thread that
 * is killed while wedged takes this thread with it; the host unref()s the
 * worker so a healthy process still exits on schedule, and the parentPort
 * "close" handler ends the thread if the channel is torn down on its own.
 *
 * NO PROJECT IMPORTS: a worker entry loaded under tsx cannot resolve the
 * project's relative ".js" specifiers back to ".ts" sources (see
 * vector-search-worker.ts's header for the full reason). Only bare packages,
 * node builtins and erased `import type` may appear here — everything the
 * worker needs (log path, thresholds, the shared cell) arrives via workerData.
 * createWorkerStallObserver, the MAIN-THREAD half that spawns this file, lives
 * here too: it needs only builtins, and keeping it next to the entry it spawns
 * is what keeps the tsx/dist path split honest.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker, parentPort, workerData } from "node:worker_threads";

/** The shared cell: two Int32 slots, one written by each thread. */
export const BEAT_INDEX = 0; // the main thread's liveness beat
export const CHECKS_INDEX = 1; // the worker's check count, read back via StallObserver.checks()
const CELL_BYTES = 8;

/** How often the worker looks at the beat counter. One wakeup a second on an
 *  otherwise idle thread; it also bounds how much of a stall's head we miss. */
const DEFAULT_CHECK_INTERVAL_MS = 1_000;
/** Self-gap, in check intervals, past which this thread was frozen too — the
 *  process was suspended. A slipped timer is fractions; a sleep is seconds+. */
const SUSPEND_GAP_FACTOR = 4;
/** Longest gap between two in-progress reports of the SAME stall. Reports back
 *  off exponentially from warnMs up to this cap, so a 7-minute wedge costs ~10
 *  lines instead of 400 while still showing the number grow. */
const DEFAULT_REPEAT_CAP_MS = 60_000;

/** Everything the worker is told at spawn. Nothing else is knowable to it. */
export interface SentinelWorkerData {
  role: "lax-loop-sentinel";
  beats: SharedArrayBuffer;
  logPath: string;
  warnMs: number;
  checkIntervalMs: number;
  repeatCapMs: number;
}

/** Worker → host post. The only thing the worker ever sends, and only when its
 *  own log sink is broken — the host owns saying so through the real logger. */
export interface SentinelWorkerPost {
  kind: "log-failed";
  message: string;
}

export interface StallWatchDeps {
  /** This thread's monotonic clock. */
  now: () => number;
  /** Current value of the main thread's beat counter. */
  readBeat: () => number;
  /** Publish that a check happened — this thread's beat(), called first in check(). */
  publishCheck: () => void;
  /** The cadence check() is driven on; the suspension threshold scales off it. */
  checkIntervalMs: number;
  warnMs: number;
  repeatCapMs: number;
  emit: (line: string) => void;
}

export interface StallWatch {
  /** Look once. Production drives this from the worker's own interval; tests
   *  call it directly with an injected clock so no real time passes. */
  check(): void;
}

/**
 * The whole off-thread measurement: beats that stop arriving mean the main
 * thread is blocked, and the elapsed-so-far is reported WITHOUT waiting for it
 * to come back.
 *
 * Reported durations are "at least" values on purpose. The last beat can land
 * anywhere inside a check window, so the worker's stamp for it is up to one
 * check interval LATE — which shortens the measured block. It never inflates.
 *
 * Time this thread was not running either is not time the main thread was
 * blocked: a self-gap that dwarfs the cadence means the process was suspended
 * and is struck from the stall's timeline (a wedged loop is reported net of it).
 */
export function createStallWatch(deps: StallWatchDeps): StallWatch {
  const { now, readBeat, publishCheck, checkIntervalMs, warnMs, repeatCapMs, emit } = deps;
  const suspendGapMs = checkIntervalMs * SUSPEND_GAP_FACTOR;
  let lastBeat = readBeat();
  let lastBeatAt = now();
  let lastCheckAt = lastBeatAt;
  /** In-progress reports emitted for the CURRENT stall; 0 when healthy. */
  let reports = 0;
  let nextReportAt = Number.NEGATIVE_INFINITY;

  return {
    check(): void {
      publishCheck(); // FIRST: emit() appends synchronously and can wedge on a sick volume; this look is already counted
      const at = now();
      const sinceLastCheck = at - lastCheckAt;
      lastCheckAt = at;
      if (sinceLastCheck >= suspendGapMs) {
        // Strike the FULL self-gap, not gap-minus-one-cadence: crediting any of
        // the sleep to the block would inflate; shortening ≤1 interval is "at least".
        lastBeatAt += sinceLastCheck;
        if (Number.isFinite(nextReportAt)) nextReportAt += sinceLastCheck;
      }
      const beat = readBeat();
      if (beat !== lastBeat) {
        lastBeat = beat;
        const blockedMs = Math.round(at - lastBeatAt);
        lastBeatAt = at;
        if (reports > 0) {
          // Close the bracket: a reader must be able to tell "the loop came
          // back" from "the process was killed still wedged", and the main
          // thread's own on-resume line may not exist (it can be killed
          // between the resume and its next sample).
          emit(
            `main thread beat again after roughly ${blockedMs}ms blocked (${reports} in-progress report${reports === 1 ? "" : "s"}); the main thread's own snapshot follows if it got one`,
          );
          reports = 0;
          nextReportAt = Number.NEGATIVE_INFINITY;
        }
        return;
      }
      const blockedMs = Math.round(at - lastBeatAt);
      if (blockedMs < warnMs || at < nextReportAt) return;
      reports += 1;
      emit(
        `main thread STILL BLOCKED — no liveness beat for at least ${blockedMs}ms (in-progress report ${reports}, written from a worker thread WHILE the loop is wedged; handles, requests and active turns are unreadable until it resumes)`,
      );
      // Exponential back-off from warnMs, capped: the log shows the number
      // growing without one line per check for the length of the freeze.
      nextReportAt = at + Math.min(warnMs * 2 ** reports, repeatCapMs);
    },
  };
}

/** Publishes beats and owns the worker's lifetime. */
export interface StallObserver {
  /** Publish one liveness beat. O(1), allocation-free, safe before start(). */
  beat(): void;
  /** Looks taken by the off-thread watch so far; null while no worker is live.
   *  Monotonic (int32 wrap — compare two readings), clock-independent. */
  checks(): number | null;
  /** The cadence behind checks(): one look per this many ms while running. */
  readonly checkIntervalMs: number;
  start(): void;
  stop(): void;
}

/** The slice of node:worker_threads.Worker the observer uses. Tests inject a
 *  stand-in through `spawn` so no thread is created. */
export interface SentinelWorkerHandle {
  unref(): void;
  terminate(): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "message", listener: (msg: unknown) => void): unknown;
}

export interface WorkerStallObserverDeps {
  /** Absolute path of the log the WORKER appends to (the host resolves it —
   *  the worker cannot import getLaxDir). */
  logPath: string;
  warnMs: number;
  checkIntervalMs?: number;
  repeatCapMs?: number;
  /** Observer-level problems (spawn failure, worker death, a worker that
   *  cannot write its log) reported through the caller's logger. */
  onIssue: (message: string) => void;
  spawn?: (data: SentinelWorkerData) => SentinelWorkerHandle;
}

// Under tsx/vitest this module's URL ends in .ts and the worker source must be
// loaded through tsx; the compiled dist tree spawns the plain .js file. Same
// split as vector-search.ts workerSpawnSpec — here the host and the worker are
// one file, so the sibling it names is itself.
const IS_TS_RUNTIME = import.meta.url.endsWith(".ts");

function spawnSentinelWorker(data: SentinelWorkerData): SentinelWorkerHandle {
  const workerUrl = new URL(
    IS_TS_RUNTIME ? "./event-loop-sentinel-worker.ts" : "./event-loop-sentinel-worker.js",
    import.meta.url,
  );
  return new Worker(fileURLToPath(workerUrl), {
    workerData: data,
    execArgv: IS_TS_RUNTIME ? ["--import", "tsx"] : undefined,
  });
}

/**
 * Main-thread half: owns the shared beat cell and the worker that watches it.
 *
 * A dead observer is announced, not silently replaced. There is deliberately no
 * respawn loop — the worker does nothing but load an int and read a clock, so
 * an exit means something is badly wrong with the process, and a supervisor
 * that quietly re-armed would leave the operator believing the in-progress half
 * is healthy when the log says otherwise. The on-resume half keeps working.
 */
export function createWorkerStallObserver(deps: WorkerStallObserverDeps): StallObserver {
  const cell = new SharedArrayBuffer(CELL_BYTES);
  const slots = new Int32Array(cell);
  const data: SentinelWorkerData = {
    role: "lax-loop-sentinel",
    beats: cell,
    logPath: deps.logPath,
    warnMs: deps.warnMs,
    checkIntervalMs: deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    repeatCapMs: deps.repeatCapMs ?? DEFAULT_REPEAT_CAP_MS,
  };
  const spawn = deps.spawn ?? spawnSentinelWorker;
  /** The live worker, or null while stopped. Handle IDENTITY — not a separate
   *  "stopped" flag — decides whether an event may speak for the observer:
   *  terminate() settles asynchronously, so a worker that stop() already
   *  replaced can report its exit long after start() installed its successor. */
  let worker: SentinelWorkerHandle | null = null;

  return {
    beat(): void {
      // Wraps through int32 after ~68 years at two beats a second, and the
      // worker only ever compares for INEQUALITY, so a wrap is not a missed
      // beat. Nothing is allocated and nobody is woken.
      Atomics.add(slots, BEAT_INDEX, 1);
    },
    checks(): number | null {
      // Null, not 0, without a live worker: a standing-still count would read
      // as "frozen" and turn every real stall into a suspension. Report instead.
      return worker ? Atomics.load(slots, CHECKS_INDEX) : null;
    },
    checkIntervalMs: data.checkIntervalMs,
    start(): void {
      if (worker) return;
      let spawned: SentinelWorkerHandle;
      try {
        spawned = spawn(data);
      } catch (e) {
        deps.onIssue(`could not start the in-progress stall observer: ${(e as Error).message}`);
        return;
      }
      // Adopt it BEFORE wiring the handlers, so `isLive` answers correctly no
      // matter when the first event lands.
      worker = spawned;
      const isLive = (): boolean => worker === spawned;
      spawned.on("message", (msg: unknown) => {
        if (!isLive()) return;
        const post = msg as Partial<SentinelWorkerPost> | null;
        if (post?.kind === "log-failed") {
          deps.onIssue(`in-progress stall observer cannot write ${data.logPath}: ${post.message}`);
        }
      });
      spawned.on("error", (err: Error) => {
        if (!isLive()) return;
        deps.onIssue(`in-progress stall observer errored: ${err.message}`);
      });
      spawned.on("exit", (code: number) => {
        // A worker stop() already discarded says nothing about the observer
        // running now: crediting its exit here would drop the live worker's
        // handle and announce a lapse that never happened.
        if (!isLive()) return;
        worker = null;
        deps.onIssue(
          `in-progress stall observer exited (code ${code}) — stalls are now reported ONLY once the loop resumes, never while it is wedged`,
        );
      });
      // A diagnostic must never keep an otherwise-finished process alive, and
      // this MUST be the last thing start() does. Worker.unref() unrefs the
      // thread handle AND the public MessagePort, but node re-ref()s that port
      // the moment a "message" listener is added (setupPortReferencing's
      // newListener hook) — so unref'ing before the on("message") above silently
      // undoes itself and the process can then never exit on its own. Ordering
      // is load-bearing here; event-loop-sentinel.test.ts pins it with a real
      // child process, because no stub can observe a re-ref.
      spawned.unref();
    },
    stop(): void {
      const running = worker;
      worker = null; // disowned first: its pending exit is no longer our news
      try {
        running?.terminate();
      } catch { /* already gone */ }
    },
  };
}

function isSentinelWorkerData(data: unknown): data is SentinelWorkerData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.role === "lax-loop-sentinel" &&
    d.beats instanceof SharedArrayBuffer &&
    typeof d.logPath === "string" &&
    typeof d.warnMs === "number" &&
    typeof d.checkIntervalMs === "number" &&
    typeof d.repeatCapMs === "number"
  );
}

/** One line, in src/index.ts's console-mirror shape so both halves of the
 *  sentinel interleave readably in server.log. */
function appendStallLine(logPath: string, line: string): void {
  appendFileSync(logPath, `[${new Date().toISOString()}] ERROR [loop-sentinel:worker] ${line}\n`);
}

// Bootstrap. The workerData shape check matters: the main thread imports this
// module for createWorkerStallObserver, and under a threads-based test pool
// that "main thread" is itself a worker with a live parentPort — the watch must
// only run for OUR spawn, never on plain import (vector-search-worker precedent).
if (parentPort && isSentinelWorkerData(workerData)) {
  const config = workerData;
  const port = parentPort;
  const slots = new Int32Array(config.beats);
  let sinkFailure: string | null = null;
  const watch = createStallWatch({
    now: () => performance.now(),
    readBeat: () => Atomics.load(slots, BEAT_INDEX),
    publishCheck: () => { Atomics.add(slots, CHECKS_INDEX, 1); },
    checkIntervalMs: config.checkIntervalMs,
    warnMs: config.warnMs,
    repeatCapMs: config.repeatCapMs,
    emit: (line) => {
      try {
        appendStallLine(config.logPath, line);
      } catch (e) {
        // The parent's queue is the only channel left, and it drains late by
        // definition — but a blind observer that says nothing is worse. Once
        // per distinct failure, so a broken path cannot flood the host.
        const message = (e as Error).message;
        if (message === sinkFailure) return;
        sinkFailure = message;
        const post: SentinelWorkerPost = { kind: "log-failed", message };
        port.postMessage(post);
      }
    },
  });
  try {
    mkdirSync(dirname(config.logPath), { recursive: true });
  } catch { /* src/index.ts already created it; a failure surfaces on append */ }
  // Deliberately NOT unref'd: this timer is the worker's reason to live. The
  // HOST unref()s the worker itself, which is what keeps the process free to
  // exit — unref'ing here as well would let the thread fall out of its own
  // loop and die immediately.
  setInterval(() => watch.check(), config.checkIntervalMs);
  // Belt and braces for "must not linger": worker threads already die with the
  // process, and process.exit() inside a worker ends this THREAD only.
  port.on("close", () => process.exit(0));
}
