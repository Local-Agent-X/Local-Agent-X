/**
 * Single-process canonical-loop scheduler (Issue 03 scope).
 *
 * One in-process queue, lane-keyed concurrency caps, FIFO within lane.
 * `enqueueOp` adds an op for scheduling; `pumpScheduler` drains as much
 * as the current caps allow, spawning an in-process worker per slot.
 *
 * The `interactive` cap is config-driven (maxInteractiveSessions) so chat
 * sessions run concurrently; other lanes use STATIC_LANE_CAPS. Per-session
 * turn ordering is handled upstream by the inject queue, not by this cap.
 *
 * The scheduler holds no DB-level row lease — for Issue 03 the in-process
 * `active` map is the single source of who is driving an op. Issue 08
 * promotes leasing to the DB (heartbeat-driven re-leasing).
 */
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { CanonicalLane } from "./types.js";
import type { LAXConfig } from "../types.js";
import { readOp } from "../ops/op-store.js";
import { resolveAdapterFactory } from "./runtime.js";
import { anyHeld, acquire, release, resetResourceLocks } from "./resource-locks.js";
import type { ExecutionBackend, ExecutionHandle } from "./execution-backend.js";
import { resolveRegisteredExecutionBackend } from "./execution-backend-registry.js";
import { applyPreLeaseCancel } from "./cancel-handler.js";
import {
  ensureExecutionPlacement,
  ExecutionPlacementRetryError,
  markExecutionPlacementReady,
  parseExecutionPlacement,
  type PlacementWakeResult,
} from "./execution-placement.js";
import { emit } from "./event-emitter.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { createLogger } from "../logger.js";
import { recoverRejectedExecutionLaunch } from "./execution-launch-recovery.js";

const logger = createLogger("canonical-loop.scheduler");
const defaultExecutionBackendResolver = resolveRegisteredExecutionBackend;
let resolveExecutionBackend = defaultExecutionBackendResolver;

/** Test-only dependency seat for scheduler parity tests. Production always
 * resolves the registry's default built-in backend. */
export function _setExecutionBackendResolverForTest(
  resolver: ((id?: string, op?: Op) => ExecutionBackend) | null,
): void {
  resolveExecutionBackend = resolver ?? defaultExecutionBackendResolver;
}

// Static fallback caps. The `interactive` lane's cap is config-driven
// (maxInteractiveSessions) when a config reader is wired at boot; these are
// the defaults used in tests and before wiring. Importing config.ts directly
// here would drag its boot-time watchers into this hot module — instead boot
// injects a live reader via setLaneCapConfigReader (mirrors how the rest of
// canonical-loop stays config.ts-free, taking values via env/options).
const STATIC_LANE_CAPS: Record<CanonicalLane, number> = {
  interactive: 10,
  build: 2,
  ide: 1,
  background: 1,
  agent: 5,
};

let capConfigReader: (() => LAXConfig) | null = null;

/** Boot wires the live runtime-config reader so config-driven lane caps
 *  (maxInteractiveSessions) take effect — and track hot-reload. */
export function setLaneCapConfigReader(fn: (() => LAXConfig) | null): void {
  capConfigReader = fn;
}

function laneCap(lane: CanonicalLane): number {
  const cfg = capConfigReader?.();
  if (lane === "interactive") return cfg?.maxInteractiveSessions ?? STATIC_LANE_CAPS.interactive;
  if (lane === "agent") return cfg?.maxSubAgents ?? STATIC_LANE_CAPS.agent;
  return STATIC_LANE_CAPS[lane] ?? 1;
}

// Global stampede ceiling on total in-flight workers across ALL lanes, so a
// runaway fan-out can't launch past the sum of the per-lane caps (~19). Sits
// ABOVE the per-lane maxes (interactive 10, agent 5), so normal per-lane usage
// is NOT throttled — it only bounds a stampede. Config-driven via
// maxConcurrentAgents; production default is intended to become cores−2
// auto-scaling (a follow-up) — NOT implemented here.
const GLOBAL_CAP_FALLBACK = 12;
function globalCap(): number {
  return capConfigReader?.()?.maxConcurrentAgents ?? GLOBAL_CAP_FALLBACK;
}

interface QueuedOp {
  opId: string;
  lane: CanonicalLane;
}

const queue: QueuedOp[] = [];
const active = new Map<string, ExecutionHandle>();
// Ops the scheduler has reserved a lane slot for but whose worker hasn't
// registered in `active` yet — i.e. the window across `await factory()` in
// launch(). Without tracking this, an op is invisible to the `active.has`
// guard during adapter construction, so a re-enqueue (mid-turn inject / a new
// message for the same op) slips past and the op is launched twice: two lane
// increments, one decrement, one permanently leaked slot.
const launching = new Set<string>();
const activeByLane = new Map<CanonicalLane, number>();
// Resource locks held by each committed slot, keyed by opId. The source of
// truth for what to `release` — recorded at the acquire site so a slot's lock
// can be freed WITHOUT re-reading the op from disk. A recovery that deletes the
// op dir mid-flight makes `readOp` return null; releasing off the op in that
// window would silently skip and STRAND the lock forever (a leaked gpu:0 =
// permanent deadlock of every local-model op). Keying release off this map
// instead keeps release independent of the disk re-read.
const activeLocks = new Map<string, string[] | undefined>();
const deferred = new Map<string, NodeJS.Timeout>();
let pumping = false;

/** Re-enter the existing scheduler after a durable retry backoff. The op's
 * retryNotBefore column is the source of truth across restart; this timer is
 * only the current process's wake-up optimization. */
export function scheduleQueuedRetry(opId: string, lane: CanonicalLane, delayMs: number): void {
  if (deferred.has(opId)) return;
  const timer = setTimeout(() => {
    deferred.delete(opId);
    if (active.has(opId) || launching.has(opId)) {
      scheduleQueuedRetry(opId, lane, 5);
      return;
    }
    if (readOp(opId)?.canonical?.state !== "queued") return;
    if (!queue.some(item => item.opId === opId)) queue.push({ opId, lane });
    pumpScheduler();
  }, Math.max(0, delayMs));
  timer.unref?.();
  deferred.set(opId, timer);
}

export function enqueueOp(opId: string, lane: CanonicalLane): void {
  if (active.has(opId) || launching.has(opId)) return;
  if (queue.find(q => q.opId === opId)) return;
  const notBefore = readOp(opId)?.canonical?.retryNotBefore;
  const delay = notBefore ? Date.parse(notBefore) - Date.now() : 0;
  if (Number.isFinite(delay) && delay > 0) {
    scheduleQueuedRetry(opId, lane, delay);
    return;
  }
  const timer = deferred.get(opId);
  if (timer) clearTimeout(timer);
  deferred.delete(opId);
  queue.push({ opId, lane });
}

/** Bypass a retry backoff only to deliver an already-persisted control signal
 * (currently queued cancel). The worker still owns signal precedence and the
 * state transition; this merely wakes it promptly. */
export function wakeQueuedOp(opId: string, lane: CanonicalLane): void {
  const timer = deferred.get(opId);
  if (timer) clearTimeout(timer);
  deferred.delete(opId);
  scheduleQueuedRetry(opId, lane, 0);
}

/** Durable backend wake. Only the exact recorded identity + token can make a
 * waiting placement runnable; stale target owners fail without enqueueing. */
export function wakeExecutionPlacement(
  opId: string,
  identity: { backendId: string; targetId: string },
  expectedRevision: number,
  wakeToken: string,
): PlacementWakeResult {
  const result = markExecutionPlacementReady(opId, identity, expectedRevision, wakeToken);
  if (!result.ok) return result;
  const op = readOp(opId);
  if (!op || op.canonical?.state !== "queued") return { ok: false, reason: "not_queued" };
  const timer = deferred.get(opId);
  if (timer) clearTimeout(timer);
  deferred.delete(opId);
  // Always schedule a fresh task, even when the current pump still contains
  // this op. A synchronous backend wake can land while placement validation is
  // on the stack: enqueueOp would see the old queue row, then the outer pump
  // would remove it using its stale `waiting` snapshot and lose the wake.
  // The deferred task runs after that stack unwinds, re-reads durable state,
  // and re-enters the same queue exactly once.
  scheduleQueuedRetry(opId, op.lane as CanonicalLane, 0);
  return result;
}

export function pumpScheduler(): void {
  if (pumping) return;
  pumping = true;
  try {
    let i = 0;
    while (i < queue.length) {
      // GLOBAL guard: stop launching once total in-flight workers (running +
      // mid-construction) hit the global cap, regardless of which lane is next.
      // This only throttles NEW launches — every in-flight op still completes
      // and releases via launch()'s finally / evictWorker, so it can't deadlock
      // even if the cap is somehow below the current in-flight set. Leaves the
      // remaining ops queued (same as the lane-full path below).
      if (active.size + launching.size >= globalCap()) break;
      const q = queue[i];
      const cap = laneCap(q.lane);
      const inUse = activeByLane.get(q.lane) ?? 0;
      if (inUse >= cap) { i++; continue; }
      const op = readOp(q.opId);
      if (!op) { queue.splice(i, 1); continue; }
      if (applyPreLeaseCancel(op)) { queue.splice(i, 1); continue; }
      let backend: ExecutionBackend;
      let placement;
      try {
        const recorded = parseExecutionPlacement(op.canonical?.executionPlacement);
        backend = resolveExecutionBackend(recorded?.backendId, op);
        placement = ensureExecutionPlacement(op, backend);
      } catch (error) {
        queue.splice(i, 1);
        if (error instanceof ExecutionPlacementRetryError) {
          scheduleQueuedRetry(op.id, q.lane, 50);
          continue;
        }
        failPlacement(op, error as Error);
        continue;
      }
      if (placement.disposition === "waiting") {
        queue.splice(i, 1);
        continue;
      }
      const factory = backend.adapterProvisioning === "backend" ? null : resolveAdapterFactory(op);
      if (backend.adapterProvisioning !== "backend" && !factory) { i++; continue; }
      // Resource guard: an op that declares a singleton resource lock already
      // held by an in-flight op (e.g. two local-GPU ops sharing gpu:0) is
      // SKIPPED and left in the queue — non-blocking, same shape as the
      // lane-full path above, so other launchable ops still go. A release
      // re-pumps and retries it. No-op for every op without resourceLocks.
      if (anyHeld(op.resourceLocks)) { i++; continue; }
      activeByLane.set(q.lane, inUse + 1);
      launching.add(q.opId);
      acquire(op.resourceLocks); // hold the resource for THIS committed slot
      activeLocks.set(op.id, op.resourceLocks); // record for disk-free release
      queue.splice(i, 1);
      void launch(op, factory, backend, placement);
    }
  } finally {
    pumping = false;
  }
}

async function launch(
  op: Op,
  factory: (() => Adapter | Promise<Adapter>) | null,
  backend: ExecutionBackend,
  placement: NonNullable<NonNullable<Op["canonical"]>["executionPlacement"]>,
): Promise<void> {
  const lane = op.lane as CanonicalLane;
  let handle: ExecutionHandle | null = null;
  let launchError: Error | null = null;
  let launchPhase: "factory" | "backend" = "factory";
  try {
    const adapter = factory ? await factory() : null;
    launchPhase = "backend";
    if (backend.adapterProvisioning === "backend") {
      if (!backend.startWithoutAdapter) throw new Error("backend adapter provisioning is not implemented");
      handle = backend.startWithoutAdapter({ op, placement });
    } else {
      if (!adapter) throw new Error("parent adapter provisioning returned no adapter");
      handle = backend.start({ op, adapter, placement });
    }
    active.set(op.id, handle);
    launching.delete(op.id); // now tracked via `active`
    await handle.done;
  } catch (error) {
    launchError = error as Error;
    logger.error(`execution launch failed for ${op.id}: ${launchError.message}`);
  } finally {
    launching.delete(op.id);
    // Match every reserved lane slot unless recovery already evicted this
    // handle and installed a replacement owner.
    const stillOurs = handle !== null && active.get(op.id) === handle;
    const neverRegistered = handle === null;
    if (stillOurs) active.delete(op.id);
    if (stillOurs || neverRegistered) {
      activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1));
      // Release the resource lock paired with THIS slot's lane decrement — but
      // ONLY when the slot was still ours. If a replacement worker took over via
      // recovery's evictWorker (stillOurs=false, neverRegistered=false), it
      // already re-acquired the lock (a fresh activeLocks entry under the same
      // opId) and this stale finally must NOT free it or drop its map entry. The
      // stillOurs guard decides WHETHER to release; releasing the closure's own
      // resourceLocks (exactly what THIS launch acquired) keeps acquire/release
      // balanced regardless of the map.
      release(op.resourceLocks);
      activeLocks.delete(op.id);
    }
    const backendOwnedSettlement = backend.adapterProvisioning === "backend";
    if ((launchError || backendOwnedSettlement) && (stillOurs || neverRegistered)) {
      const recovery = recoverRejectedExecutionLaunch(
        op.id, launchPhase === "backend",
      );
      if (recovery.kind === "retry") scheduleQueuedRetry(op.id, lane, recovery.delayMs);
    }
    pumpScheduler(); // re-pump: an op skipped on this lock (or lane) retries now
  }
}

function failPlacement(op: Op, error: Error): void {
  logger.error(`execution placement failed for ${op.id}: ${error.message}`);
  emit(op.id, "error", {
    code: "execution_placement_invalid",
    message: error.message,
    retryable: false,
  });
  try { transitionOp(op, "failed", "execution_placement_invalid"); }
  catch (transitionError) {
    if (!(transitionError instanceof IllegalTransitionError)) throw transitionError;
  }
}

/**
 * Issue 08: evict a stale worker from the scheduler's bookkeeping so a
 * replacement can launch under the lane cap. Used by `recoverStaleOp`
 * (recovery.ts) — the original worker promise may be permanently
 * pending (true crash / process death simulation), so the scheduler
 * needs an explicit way to forget about it.
 *
 * Idempotent on already-evicted ops. Returns true if the op was evicted
 * here, false if there was no active worker for the op.
 */
export function evictWorker(opId: string): boolean {
  if (!active.has(opId)) return false;
  const op = readOp(opId);
  active.delete(opId);
  // Release the evicted slot's resource lock from the in-memory activeLocks map,
  // INDEPENDENT of the op re-read below. If recovery deleted the op dir mid-flight
  // `readOp` returns null, but the lock must still be freed — sourcing it from the
  // map (not `op.resourceLocks`) means a null re-read can never strand a gpu:0 and
  // deadlock every local-model op. Set.delete is idempotent, so a no-lock evict is
  // a harmless no-op.
  release(activeLocks.get(opId));
  activeLocks.delete(opId);
  if (op) {
    const lane = op.lane as CanonicalLane;
    activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1));
  }
  // Re-pump so an op skipped on the just-released lock (or the freed lane slot)
  // retries. Recovery's relaunch branches pump again after re-enqueue, but its
  // terminal branches (cancelling→cancelled, exhausted→failed) do NOT — so an
  // otherwise-idle system would strand a skipped op without this. pumpScheduler
  // self-guards with `pumping`, so the extra call is safe. The evicted op is
  // not yet re-enqueued here, so this can only launch OTHER queued ops.
  pumpScheduler();
  return true;
}

/**
 * Test helper — resolves once the queue is empty AND every active worker
 * has finished. Worker promises are stored in `active`; we await them in
 * sequence and re-check until both structures drain.
 */
export async function awaitIdle(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active.size > 0 || launching.size > 0 || queue.length > 0 || deferred.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `awaitIdle timed out — ${active.size} active, ${queue.length} queued`,
      );
    }
    if (queue.length > 0) pumpScheduler();
    const next = active.values().next().value;
    if (next) {
      await next.done.catch(() => undefined);
    } else {
      await new Promise(r => setTimeout(r, 5));
    }
  }
}

export function resetScheduler(): void {
  queue.length = 0;
  active.clear();
  launching.clear();
  activeByLane.clear();
  activeLocks.clear();
  for (const timer of deferred.values()) clearTimeout(timer);
  deferred.clear();
  resetResourceLocks();
  pumping = false;
  capConfigReader = null;
  resolveExecutionBackend = defaultExecutionBackendResolver;
}

export function schedulerSnapshot(): { queueDepth: number; activeCount: number } {
  return { queueDepth: queue.length + deferred.size, activeCount: active.size };
}
