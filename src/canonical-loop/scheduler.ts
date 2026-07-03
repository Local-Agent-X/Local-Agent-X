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
import { runWorker, type WorkerHandle } from "./worker.js";

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
const active = new Map<string, WorkerHandle>();
// Ops the scheduler has reserved a lane slot for but whose worker hasn't
// registered in `active` yet — i.e. the window across `await factory()` in
// launch(). Without tracking this, an op is invisible to the `active.has`
// guard during adapter construction, so a re-enqueue (mid-turn inject / a new
// message for the same op) slips past and the op is launched twice: two lane
// increments, one decrement, one permanently leaked slot.
const launching = new Set<string>();
const activeByLane = new Map<CanonicalLane, number>();
let pumping = false;

export function enqueueOp(opId: string, lane: CanonicalLane): void {
  if (active.has(opId) || launching.has(opId)) return;
  if (queue.find(q => q.opId === opId)) return;
  queue.push({ opId, lane });
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
      const factory = resolveAdapterFactory(op);
      if (!factory) { i++; continue; } // No adapter — leave queued.
      activeByLane.set(q.lane, inUse + 1);
      launching.add(q.opId);
      queue.splice(i, 1);
      void launch(op, factory);
    }
  } finally {
    pumping = false;
  }
}

async function launch(op: Op, factory: () => Adapter | Promise<Adapter>): Promise<void> {
  const lane = op.lane as CanonicalLane;
  let handle: WorkerHandle | null = null;
  try {
    const adapter = await factory();
    handle = runWorker(op, adapter);
    active.set(op.id, handle);
    launching.delete(op.id); // now tracked via `active`
    await handle.done;
  } catch {
    // Worker.done already converts adapter / loop exceptions into canonical
    // `error` events; nothing more to surface here. A throw from `factory()`
    // (adapter construction) also lands here — the slot release below covers
    // it so the lane never leaks.
  } finally {
    launching.delete(op.id);
    // Release the lane slot pumpScheduler reserved for THIS launch. Every
    // increment must be matched by exactly one decrement, or the lane leaks a
    // permanent slot — after `cap` leaks the lane reads "full" and every new
    // op queues forever (interactive chat silently stops dispatching until a
    // server restart clears the in-memory counter).
    //
    //   - handle registered and still ours → normal completion: release.
    //   - handle never registered (factory threw before runWorker) → release;
    //     recovery can't have touched an op that never entered `active`.
    //   - handle registered but no longer ours → a replacement worker took
    //     over via recovery's evictWorker, which already decremented; skip to
    //     avoid a double-release.
    const stillOurs = handle !== null && active.get(op.id) === handle;
    const neverRegistered = handle === null;
    if (stillOurs) active.delete(op.id);
    if (stillOurs || neverRegistered) {
      activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1));
    }
    pumpScheduler();
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
  if (op) {
    const lane = op.lane as CanonicalLane;
    activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1));
  }
  return true;
}

/**
 * Test helper — resolves once the queue is empty AND every active worker
 * has finished. Worker promises are stored in `active`; we await them in
 * sequence and re-check until both structures drain.
 */
export async function awaitIdle(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (active.size > 0 || queue.length > 0) {
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
  pumping = false;
  capConfigReader = null;
}

export function schedulerSnapshot(): { queueDepth: number; activeCount: number } {
  return { queueDepth: queue.length, activeCount: active.size };
}
