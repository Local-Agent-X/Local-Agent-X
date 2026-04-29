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
import { resolve as resolvePath } from "node:path";
import { EventEmitter } from "node:events";
import { sendIpc, receiveIpc } from "./ipc.js";
import { ipcEnvelope, type IpcMessage, type Op, type OpEvent, type OpResult } from "./types.js";
import { writeOp, readOp, setOpStatus } from "./op-store.js";

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
}

const POOL_SIZE = 1;       // Step 1 — single worker for validation
const slots: WorkerSlot[] = [];
const opQueue: Op[] = [];
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// Op-specific completion promises (so submitOp() can return a result)
const pendingResults = new Map<string, { resolve: (r: OpResult) => void; reject: (e: Error) => void }>();

let started = false;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the worker pool. Idempotent — call once at server startup.
 * Spawns the warm pool of workers.
 */
export function startWorkerPool(): void {
  if (started) return;
  started = true;
  logger.info(`[pool] starting worker pool (size=${POOL_SIZE})`);
  for (let i = 0; i < POOL_SIZE; i++) {
    spawnWorker();
  }
  process.on("exit", shutdownAll);
  process.on("SIGINT", () => { shutdownAll(); process.exit(130); });
  process.on("SIGTERM", () => { shutdownAll(); process.exit(143); });
}

/**
 * Submit an op for execution. Returns a promise that resolves with the
 * OpResult when the op finishes. The op metadata is persisted to disk
 * before assignment so it survives restart.
 */
export function submitOp(op: Op): Promise<OpResult> {
  if (!started) startWorkerPool();
  writeOp(op);
  return new Promise((resolve, reject) => {
    pendingResults.set(op.id, { resolve, reject });
    if (!tryDispatch(op)) {
      logger.info(`[pool] op ${op.id} queued (all workers busy)`);
      opQueue.push(op);
      eventBus.emit("queue-changed", { queueLength: opQueue.length });
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

/** Send a redirect to the worker running this op. Cooperative — applied at next safe boundary. */
export function redirectOp(opId: string, instruction: string): boolean {
  const slot = slots.find(s => s.busyWith === opId);
  if (!slot) return false;
  sendIpc(slot.proc.stdin!, ipcEnvelope("redirect", { opId, instruction }));
  return true;
}

// ── Internal: spawn + lifecycle ────────────────────────────────────────────

function spawnWorker(): void {
  const entry = resolvePath(new URL("./worker-entry.ts", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, ""));
  const proc = spawn("node", ["--max-old-space-size=2048", "--import=tsx", entry], {
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
  const slot: WorkerSlot = {
    workerId,
    proc,
    busyWith: null,
    capabilities: [],
    spawnedAt: Date.now(),
    detachIpc: () => {},
  };
  slots.push(slot);

  slot.detachIpc = receiveIpc(proc.stdout!, {
    onMessage: (msg) => handleWorkerMessage(slot, msg),
    onNonIpcLine: (line) => logger.info(`[worker:${proc.pid}] non-ipc: ${line.slice(0, 200)}`),
    onError: (e) => logger.warn(`[worker:${proc.pid}] ipc error: ${e.message}`),
  });

  proc.on("exit", (code, signal) => {
    logger.warn(`[worker:${proc.pid}] exited (code=${code} signal=${signal}) — was busy with ${slot.busyWith || "nothing"}`);
    if (slot.busyWith) {
      // The op died with the worker. For Step 1, mark it failed-recoverable;
      // Step 3 will add proper lease reassignment.
      const opId = slot.busyWith;
      const op = readOp(opId);
      if (op && (op.attemptCount ?? 0) < op.retryPolicy.maxRecoveryAttempts) {
        logger.info(`[pool] reassigning op ${opId} (attempt ${(op.attemptCount ?? 0) + 1}/${op.retryPolicy.maxRecoveryAttempts})`);
        op.attemptCount = (op.attemptCount ?? 0) + 1;
        op.workerId = undefined;
        op.status = "pending";
        writeOp(op);
        opQueue.unshift(op);
      } else {
        logger.warn(`[pool] op ${opId} exhausted retries`);
        const result: OpResult = {
          opId, status: "failed", finalSummary: "Worker died and retry budget exhausted",
          filesChanged: [], error: { message: "worker died, no retries left", recoverable: false },
        };
        setOpStatus(opId, "failed", { lastFailureReason: "worker died" });
        pendingResults.get(opId)?.resolve(result);
        pendingResults.delete(opId);
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
      pendingResults.get(opId)?.resolve(result);
      pendingResults.delete(opId);
      drainQueue();
      break;
    }
    case "log": {
      logger.info(`[worker:${slot.workerId}] ${msg.payload.line}`);
      break;
    }
    case "pong":
      // Heartbeat reply — Step 3
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

function drainQueue(): void {
  while (opQueue.length > 0) {
    const op = opQueue[0];
    if (!tryDispatch(op)) break;
    opQueue.shift();
    eventBus.emit("queue-changed", { queueLength: opQueue.length });
  }
}

function shutdownAll(): void {
  for (const s of slots) {
    try { s.detachIpc(); } catch {}
    try { s.proc.kill("SIGTERM"); } catch {}
  }
}
