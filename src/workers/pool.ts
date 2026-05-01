/**
 * Worker pool.
 *
 * Step 1 scope: pool of size 1. Validates the IPC contract + event routing
 * + lifecycle. Pool size N + dynamic burst is Step 9.
 *
 * Responsibilities:
 *   - Spawn worker subprocesses (tsx-loaded src/workers/worker-entry.ts)
 *   - Track which worker is busy with which op
 *   - Route incoming op submissions to a free worker, or queue
 *   - Forward worker events to subscribers (op events bus)
 *   - Restart workers that die unexpectedly
 *   - Reassign in-flight ops if their worker dies (recovery — Step 3 will
 *     add proper heartbeat/lease semantics; for now we just restart)
 *
 * The supervisor (main process) imports submitOp, subscribeOp, etc. from
 * here. The chat agent's tools call submitOp when they want to delegate.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { sendIpc, receiveIpc } from "./ipc.js";
import { ipcEnvelope, type IpcMessage, type Op, type OpEvent, type OpResult } from "./types.js";
import { writeOp, readOp, setOpStatus, pruneOldOps } from "./op-store.js";
import { createHeartbeatState, startHeartbeat, stopHeartbeat, recordPong, decideRecovery, recordFailure, isCircuitOpen, type HeartbeatState } from "./heartbeat.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.pool");

// ── Pool state ─────────────────────────────────────────────────────────────

interface WorkerSlot {
  workerId: string;        // logical id
  proc: ChildProcess;
  busyWith: string | null; // opId currently running, or null
  capabilities: string[];
  spawnedAt: number;
  detachIpc: () => void;
  heartbeat: HeartbeatState;
  stopHeartbeatFn: () => void;
  recyclePending: boolean; // marked when heap pressure says recycle after current op
}

// Step 9: pool size N. Default 3 — comfortably runs three concurrent ops on
// a typical dev machine (3 × 2GB heap = 6GB worst case for the workers
// themselves, plus the chat agent's own process). Override via env if you
// want more/fewer based on your hardware. Min 1, max 16 (above which the
// chat agent process can't usefully orchestrate that many concurrent
// streams without context-switching dominating).
const POOL_SIZE = (() => {
  const env = parseInt(process.env.LAX_WORKER_POOL_SIZE || "", 10);
  if (Number.isFinite(env) && env >= 1 && env <= 16) return env;
  return 3;
})();
const slots: WorkerSlot[] = [];
const opQueue: Op[] = [];
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// Op-specific completion promises (so submitOp() can return a result)
const pendingResults = new Map<string, { resolve: (r: OpResult) => void; reject: (e: Error) => void }>();

// Recently-completed results, retained briefly so late subscribers (e.g. an
// op_wait call that fires AFTER the op has already finished) can still get
// the answer without having to re-read disk. TTL = 30 min.
const completedResultCache = new Map<string, { result: OpResult; ts: number }>();
const COMPLETED_RESULT_TTL_MS = 30 * 60 * 1000;

let started = false;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the worker pool. Idempotent — call once at server startup.
 * Spawns the warm pool of workers.
 */
const OP_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OP_STORE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let pruneTimer: NodeJS.Timeout | null = null;

function runPrune(): void {
  try {
    const r = pruneOldOps(OP_STORE_TTL_MS);
    if (r.pruned > 0 || r.errors > 0) {
      logger.info(`[pool] op-store prune: pruned=${r.pruned} kept=${r.kept} errors=${r.errors}`);
    }
  } catch (e) {
    logger.warn(`[pool] op-store prune threw: ${(e as Error).message}`);
  }
}

export function startWorkerPool(): void {
  if (started) return;
  started = true;
  logger.info(`[pool] starting worker pool (size=${POOL_SIZE})`);
  for (let i = 0; i < POOL_SIZE; i++) {
    spawnWorker();
  }
  setTimeout(runPrune, 5000);
  pruneTimer = setInterval(runPrune, OP_STORE_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
  process.on("exit", shutdownAll);
  process.on("SIGINT", () => { shutdownAll(); process.exit(130); });
  process.on("SIGTERM", () => { shutdownAll(); process.exit(143); });
}

/**
 * Submit an op for execution. Returns a promise that resolves with the
 * OpResult when the op finishes. The op metadata is persisted to disk
 * before assignment so it survives restart.
 *
 * Per spec §21.4 circuit breaker: if the op's type has failed too many
 * times in a row recently, the submission is rejected with a clear error
 * before consuming any worker resources.
 */
export function submitOp(op: Op): Promise<OpResult> {
  if (!started) startWorkerPool();
  if (isCircuitOpen(op.type)) {
    return Promise.resolve({
      opId: op.id,
      status: "failed",
      finalSummary: `Op type "${op.type}" circuit breaker is open — too many recent failures. Wait or investigate root cause.`,
      filesChanged: [],
      error: { message: "circuit-open", recoverable: false },
    });
  }
  writeOp(op);
  return new Promise((resolve, reject) => {
    pendingResults.set(op.id, { resolve, reject });
    if (!tryDispatch(op)) {
      logger.info(`[pool] op ${op.id} queued (all workers busy)`);
      // Snapshot prior queue order so we can detect shifts after the
      // priority-sort below — a higher-lane op submitted last must
      // report its TRUE post-sort position (not the back-of-array
      // position), and any previously-queued ops bumped down need
      // their "queued #N" labels refreshed without waiting for the
      // next dispatch.
      const priorOrder = opQueue.map(o => o.id);
      opQueue.push(op);
      sortQueueByLane(opQueue);
      eventBus.emit("queue-changed", { queueLength: opQueue.length });
      // Tell subscribers this op is queued (not yet running) so the
      // frontend can render a "queued" sidebar card with its position.
      const queuePos = opQueue.findIndex(o => o.id === op.id) + 1;
      eventBus.emit("op-queued", { opId: op.id, task: op.task, lane: op.lane, queuePosition: queuePos });
      // If the priority-insert bumped any earlier op down, broadcast
      // new positions so existing sidebar cards update without a refetch.
      const shifted = opQueue.some((o, i) => o.id !== op.id && priorOrder[i] !== o.id);
      if (shifted) {
        eventBus.emit("op-queue-reordered", {
          entries: opQueue.map((q, i) => ({ opId: q.id, queuePosition: i + 1 })),
        });
      }
    } else {
      // Dispatched immediately — fire op-dispatched so the bridge can
      // forward bg_op_started without going through the queue path.
      eventBus.emit("op-dispatched", { opId: op.id, task: op.task, lane: op.lane });
    }
  });
}

/**
 * Subscribe to events for a specific op. Returns an unsubscribe function.
 * Used by routes/chat-ws to forward op events to the WS session that
 * started the op (and any other sessions watching it).
 */
export function subscribeOp(opId: string, listener: (event: OpEvent) => void): () => void {
  const handler = (event: OpEvent) => { if (event.opId === opId) listener(event); };
  eventBus.on("op-event", handler);
  return () => eventBus.off("op-event", handler);
}

/** Subscribe to all op events (for the global "live ops" panel). */
export function subscribeAllOps(listener: (event: OpEvent) => void): () => void {
  eventBus.on("op-event", listener);
  return () => eventBus.off("op-event", listener);
}

/**
 * Subscribe to op terminal results (completed / failed / cancelled).
 * Used by the session bridge to forward completion notifications to the
 * chat session that originally submitted the op.
 */
export function subscribeAllOpResults(listener: (result: OpResult) => void): () => void {
  eventBus.on("op-result", listener);
  return () => eventBus.off("op-result", listener);
}

/**
 * Subscribe to op-queued events — fires when an op is submitted while all
 * workers are busy and goes into the queue. Used by the session bridge to
 * surface a "queued" card in the AGENTS sidebar with its queue position.
 */
export function subscribeAllOpQueued(listener: (info: { opId: string; task: string; lane: string; queuePosition: number }) => void): () => void {
  eventBus.on("op-queued", listener);
  return () => eventBus.off("op-queued", listener);
}

/**
 * Subscribe to op-dispatched events — fires when an op transitions from
 * pending/queued to actually running on a worker. Used by the session
 * bridge to flip the sidebar card's status from queued → working.
 */
export function subscribeAllOpDispatched(listener: (info: { opId: string; task: string; lane: string }) => void): () => void {
  eventBus.on("op-dispatched", listener);
  return () => eventBus.off("op-dispatched", listener);
}

/**
 * Subscribe to op-queue-reordered events — fires after every queue mutation
 * (dispatch or new submit) so the sidebar can update each card's "queued
 * #N" label without a periodic refetch.
 */
export function subscribeAllOpQueueReordered(listener: (info: { entries: { opId: string; queuePosition: number }[] }) => void): () => void {
  eventBus.on("op-queue-reordered", listener);
  return () => eventBus.off("op-queue-reordered", listener);
}

/**
 * Wait for an op's terminal result. Used by op_wait + by the sync op_submit
 * sugar wrapper.
 *
 * Resolution order:
 *   1. If the op is currently in-flight (pendingResults entry), piggy-back
 *      on that promise so we don't double-create.
 *   2. If the op finished recently (cache hit), resolve immediately.
 *   3. Otherwise read the persisted op_store entry from disk; if it shows
 *      a terminal status, synthesize an OpResult from it.
 *   4. If the op exists but is still pending in the store (unlikely race),
 *      register a one-shot subscriber on op-result.
 *
 * Returns null if the op truly cannot be found anywhere.
 */
export function awaitOpResult(opId: string, timeoutMs = 30 * 60 * 1000): Promise<OpResult | null> {
  // 1. Currently in-flight
  const inFlight = pendingResults.get(opId);
  if (inFlight) {
    return new Promise((resolve) => {
      const origResolve = inFlight.resolve;
      inFlight.resolve = (r: OpResult) => { origResolve(r); resolve(r); };
    });
  }
  // 2. Recently completed (cache)
  const cached = completedResultCache.get(opId);
  if (cached && Date.now() - cached.ts < COMPLETED_RESULT_TTL_MS) {
    return Promise.resolve(cached.result);
  }
  // 3. Persisted as terminal on disk
  const op = readOp(opId);
  if (op && (op.status === "completed" || op.status === "failed" || op.status === "cancelled")) {
    return Promise.resolve({
      opId,
      status: op.status as OpResult["status"],
      finalSummary: op.lastFailureReason || `op ${opId} ${op.status}`,
      filesChanged: [],
      error: op.lastFailureReason ? { message: op.lastFailureReason, recoverable: false } : undefined,
    });
  }
  // 4. Still pending — wait for op-result event
  if (op && (op.status === "pending" || op.status === "running")) {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const handler = (r: OpResult) => {
        if (r.opId !== opId) return;
        if (timer) clearTimeout(timer);
        eventBus.off("op-result", handler);
        resolve(r);
      };
      eventBus.on("op-result", handler);
      timer = setTimeout(() => {
        eventBus.off("op-result", handler);
        resolve(null);
      }, timeoutMs);
    });
  }
  // 5. Truly not found
  return Promise.resolve(null);
}

/** Inspect pool state. */
export function getPoolStatus(): { workers: { id: string; busyWith: string | null; uptimeS: number }[]; queueLength: number } {
  return {
    workers: slots.map(s => ({
      id: s.workerId,
      busyWith: s.busyWith,
      uptimeS: Math.floor((Date.now() - s.spawnedAt) / 1000),
    })),
    queueLength: opQueue.length,
  };
}

/** Send a kill to the worker running this op. The op will fail with `cancelled`. */
export function killOp(opId: string): boolean {
  const slot = slots.find(s => s.busyWith === opId);
  if (!slot) return false;
  sendIpc(slot.proc.stdin!, ipcEnvelope("kill", { opId }));
  return true;
}

/**
 * Cancel an op that's still waiting in the queue (not yet running). Removes
 * it from the queue, marks it cancelled, resolves any pending awaitOpResult
 * promise, and broadcasts both op-result (so the sidebar card flips to
 * cancelled) and op-queue-reordered (so trailing cards' "queued #N" labels
 * shift up). Returns true if a queued op was cancelled.
 *
 * Pairs with killOp: chat-ws.ts cancel button tries killOp first (running
 * op) and falls back to this for queued ops, so the user can cancel before
 * the worker ever picks it up.
 */
export function cancelQueuedOp(opId: string): boolean {
  const idx = opQueue.findIndex(o => o.id === opId);
  if (idx < 0) return false;
  opQueue.splice(idx, 1);
  setOpStatus(opId, "cancelled", { lastFailureReason: "cancelled while queued" });
  const result: OpResult = {
    opId,
    status: "cancelled",
    finalSummary: "Cancelled before it started running.",
    filesChanged: [],
    error: { message: "cancelled while queued", recoverable: false },
  };
  completedResultCache.set(opId, { result, ts: Date.now() });
  pendingResults.get(opId)?.resolve(result);
  pendingResults.delete(opId);
  eventBus.emit("queue-changed", { queueLength: opQueue.length });
  eventBus.emit("op-result", result);
  if (opQueue.length > 0) {
    eventBus.emit("op-queue-reordered", {
      entries: opQueue.map((q, i) => ({ opId: q.id, queuePosition: i + 1 })),
    });
  }
  return true;
}

/** Send a redirect to the worker running this op. Cooperative — applied at next safe boundary. */
export function redirectOp(opId: string, instruction: string): boolean {
  const slot = slots.find(s => s.busyWith === opId);
  if (!slot) return false;
  sendIpc(slot.proc.stdin!, ipcEnvelope("redirect", { opId, instruction }));
  return true;
}

// ── Internal: spawn + lifecycle ────────────────────────────────────────────

function spawnWorker(): void {
  // Mode-aware spawn: in dev (npm run dev, tsx-watch from src/) we load the
  // .ts source via --import=tsx; in prod (npm start, plain node from dist/)
  // we load the compiled .js without tsx. Detection via import.meta.url —
  // if the loader's own URL contains /dist/ we're compiled.
  const compiled = import.meta.url.includes("/dist/");
  const entryName = compiled ? "./worker-entry.js" : "./worker-entry.ts";
  const entry = fileURLToPath(new URL(entryName, import.meta.url));
  const args = compiled
    ? ["--max-old-space-size=2048", entry]
    : ["--max-old-space-size=2048", "--import=tsx", entry];
  const proc = spawn("node", args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  // Worker's stderr → our log (worker uses stderr for its own logging since stdout is IPC)
  proc.stderr?.on("data", (c: Buffer) => {
    const lines = c.toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) logger.info(`[worker:${proc.pid}] ${line}`);
  });

  let workerId = `pending-${proc.pid}`;
  const heartbeat = createHeartbeatState(workerId);
  const slot: WorkerSlot = {
    workerId,
    proc,
    busyWith: null,
    capabilities: [],
    spawnedAt: Date.now(),
    detachIpc: () => {},
    heartbeat,
    stopHeartbeatFn: () => {},
    recyclePending: false,
  };
  slots.push(slot);

  slot.detachIpc = receiveIpc(proc.stdout!, {
    onMessage: (msg) => handleWorkerMessage(slot, msg),
    onNonIpcLine: (line) => logger.info(`[worker:${proc.pid}] non-ipc: ${line.slice(0, 200)}`),
    onError: (e) => logger.warn(`[worker:${proc.pid}] ipc error: ${e.message}`),
  });

  // Start heartbeat ping/pong + watchdog
  slot.stopHeartbeatFn = startHeartbeat(proc, heartbeat, {
    onSuspect: (id, ms) => logger.warn(`[pool] worker ${id} suspect (silent for ${Math.round(ms / 1000)}s)`),
    onDead: (id, ms) => {
      logger.error(`[pool] worker ${id} dead (silent for ${Math.round(ms / 1000)}s) — killing`);
      try { proc.kill("SIGKILL"); } catch {}
    },
    onHeapPressure: (id, heapMb, limitMb) => {
      logger.warn(`[pool] worker ${id} sustained heap pressure ${heapMb}MB/${limitMb}MB — marking for recycle after current op`);
      slot.recyclePending = true;
      // If idle right now, recycle immediately
      if (slot.busyWith === null) {
        try { proc.kill("SIGTERM"); } catch {}
      }
    },
  });

  proc.on("exit", (code, signal) => {
    logger.warn(`[worker:${proc.pid}] exited (code=${code} signal=${signal}) — was busy with ${slot.busyWith || "nothing"}`);
    stopHeartbeat(heartbeat);
    if (slot.busyWith) {
      // Worker died mid-op. Use proper recovery decision (per spec §18 + §20).
      const opId = slot.busyWith;
      const op = readOp(opId);
      if (op) {
        // We don't yet track per-op committingCallsAlreadyMade here — Step 4
        // will wire that through the event log. For Step 3 we conservatively
        // assume false (allow retry) but cap via op.retryPolicy.
        const decision = decideRecovery(op, { committingCallsAlreadyMade: false, reason: `worker exited (code=${code} signal=${signal})` });
        if (decision.shouldRetry) {
          logger.info(`[pool] op ${opId} retry: ${decision.reason} (delay=${decision.nextDelayMs}ms)`);
          op.workerId = undefined;
          op.status = "pending";
          writeOp(op);
          setTimeout(() => {
            opQueue.unshift(op);
            drainQueue();
          }, decision.nextDelayMs);
        } else {
          logger.warn(`[pool] op ${opId} not retried: ${decision.reason}`);
          const isCircuitNowOpen = recordFailure(op.type);
          if (isCircuitNowOpen) {
            logger.error(`[pool] circuit breaker OPEN for op type "${op.type}" — too many failures`);
          }
          const result: OpResult = {
            opId, status: "failed", finalSummary: `Worker died: ${decision.reason}`,
            filesChanged: [], error: { message: decision.reason, recoverable: false },
          };
          setOpStatus(opId, "failed", { lastFailureReason: decision.reason });
          pendingResults.get(opId)?.resolve(result);
          pendingResults.delete(opId);
        }
      }
    }
    // Remove dead slot, respawn replacement
    const idx = slots.indexOf(slot);
    if (idx >= 0) slots.splice(idx, 1);
    if (started && slots.length < POOL_SIZE) {
      logger.info(`[pool] respawning worker (pool size ${slots.length}/${POOL_SIZE})`);
      setTimeout(spawnWorker, 1000);
    }
    // Try to dispatch any queued ops to the remaining workers
    drainQueue();
  });

  // Worker not yet ready — wait for the 'ready' message before dispatching
}

function handleWorkerMessage(slot: WorkerSlot, msg: IpcMessage): void {
  switch (msg.type) {
    case "ready": {
      slot.workerId = msg.payload.workerId;
      slot.capabilities = msg.payload.capabilities;
      logger.info(`[pool] worker ${slot.workerId} ready (pid=${msg.payload.pid}, caps=${slot.capabilities.join(",")})`);
      drainQueue();
      break;
    }
    case "event": {
      eventBus.emit("op-event", msg.payload.event);
      break;
    }
    case "checkpoint": {
      // For Step 1 we just log; checkpoint-driven recovery is Step 3
      logger.debug(`[pool] checkpoint for op ${msg.payload.checkpoint.opId}: ${msg.payload.checkpoint.lastSafeBoundary.label}`);
      break;
    }
    case "result": {
      const opId = msg.payload.result.opId;
      const result = msg.payload.result;
      logger.info(`[pool] op ${opId} finished: ${result.status}`);
      slot.busyWith = null;
      setOpStatus(opId, result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed", {
        lastFailureReason: result.error?.message,
      });
      // Track failures for the circuit breaker
      if (result.status === "failed") {
        const isOpen = recordFailure(readOp(opId)?.type ?? "unknown");
        if (isOpen) logger.error(`[pool] circuit breaker OPEN for op type — too many recent failures`);
      }
      // Cache the result briefly so late op_wait calls (e.g. an async op
      // that finished BEFORE the agent decided to wait on it) still succeed.
      completedResultCache.set(opId, { result, ts: Date.now() });
      pruneCompletedCache();
      pendingResults.get(opId)?.resolve(result);
      pendingResults.delete(opId);
      // Fire the global op-result event so the session bridge can forward
      // the completion notification back to whichever chat session submitted
      // this op (if any).
      eventBus.emit("op-result", result);
      // If this slot was marked recyclePending due to heap pressure, recycle now
      if (slot.recyclePending) {
        logger.info(`[pool] recycling worker ${slot.workerId} (heap pressure flag)`);
        try { slot.proc.kill("SIGTERM"); } catch {}
      }
      drainQueue();
      break;
    }
    case "log": {
      logger.info(`[worker:${slot.workerId}] ${msg.payload.line}`);
      break;
    }
    case "pong":
      // Heartbeat reply — record receipt + heap snapshot
      recordPong(slot.heartbeat, msg.payload.heapMb);
      break;
    default:
      logger.warn(`[pool] unknown message from worker: ${(msg as { type: string }).type}`);
  }
}

// ── Internal: dispatch ────────────────────────────────────────────────────

function tryDispatch(op: Op): boolean {
  const slot = slots.find(s => s.busyWith === null && s.workerId !== `pending-${s.proc.pid}`);
  if (!slot) return false;
  slot.busyWith = op.id;
  op.workerId = slot.workerId;
  op.attemptCount = (op.attemptCount ?? 0) + 1;
  setOpStatus(op.id, "running", { workerId: slot.workerId, attemptCount: op.attemptCount });
  sendIpc(slot.proc.stdin!, ipcEnvelope("assign-op", { op }));
  logger.info(`[pool] op ${op.id} dispatched to ${slot.workerId} (attempt ${op.attemptCount})`);
  return true;
}

// Step 6: lane priority — interactive (user is waiting) > build (user-
// initiated background work) > background (cron / idle). Higher number
// dispatches first; FIFO within same lane preserves submission order.
const LANE_PRIORITY: Record<string, number> = {
  interactive: 3,
  build: 2,
  background: 1,
};

function sortQueueByLane(queue: Op[]): void {
  // Sort by lane priority (desc). Array.sort is stable in modern V8,
  // so FIFO order is preserved within the same priority lane.
  queue.sort((a, b) => (LANE_PRIORITY[b.lane] || 2) - (LANE_PRIORITY[a.lane] || 2));
}

function drainQueue(): void {
  let dispatchedAny = false;
  while (opQueue.length > 0) {
    sortQueueByLane(opQueue);
    const op = opQueue[0];
    if (!tryDispatch(op)) break;
    opQueue.shift();
    dispatchedAny = true;
    eventBus.emit("queue-changed", { queueLength: opQueue.length });
    // Notify subscribers that this op transitioned queued → running so
    // the frontend sidebar card flips its status indicator.
    eventBus.emit("op-dispatched", { opId: op.id, task: op.task, lane: op.lane });
  }
  // After a dispatch round, every still-queued op has shifted up. Tell
  // subscribers the new positions so sidebar cards update their "queued
  // #N" label live without a poll.
  if (dispatchedAny && opQueue.length > 0) {
    eventBus.emit("op-queue-reordered", {
      entries: opQueue.map((q, i) => ({ opId: q.id, queuePosition: i + 1 })),
    });
  }
}

function shutdownAll(): void {
  for (const s of slots) {
    try { stopHeartbeat(s.heartbeat); } catch {}
    try { s.detachIpc(); } catch {}
    try { s.proc.kill("SIGTERM"); } catch {}
  }
}

function pruneCompletedCache(): void {
  if (completedResultCache.size < 200) return;
  const cutoff = Date.now() - COMPLETED_RESULT_TTL_MS;
  for (const [id, entry] of completedResultCache) {
    if (entry.ts < cutoff) completedResultCache.delete(id);
  }
}
