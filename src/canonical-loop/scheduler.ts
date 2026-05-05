/**
 * Single-process canonical-loop scheduler (Issue 03 scope).
 *
 * One in-process queue, lane-keyed concurrency caps, FIFO within lane.
 * `enqueueOp` adds an op for scheduling; `pumpScheduler` drains as much
 * as the current caps allow, spawning an in-process worker per slot.
 *
 * Issue 03 only exercises the `interactive` lane (cap = 1). Build / IDE
 * caps land in v1.2 / v1.3 but are listed here so the cap table matches
 * PRD §14.
 *
 * The scheduler holds no DB-level row lease — for Issue 03 the in-process
 * `active` map is the single source of who is driving an op. Issue 08
 * promotes leasing to the DB (heartbeat-driven re-leasing).
 */
import type { Op } from "../workers/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { CanonicalLane } from "./types.js";
import { readOp } from "../workers/op-store.js";
import { resolveAdapterFactory } from "./runtime.js";
import { runWorker, type WorkerHandle } from "./worker.js";

const LANE_CAPS: Record<CanonicalLane, number> = {
  interactive: 1,
  build: 2,
  ide: 1,
  background: 1,
};

interface QueuedOp {
  opId: string;
  lane: CanonicalLane;
}

const queue: QueuedOp[] = [];
const active = new Map<string, WorkerHandle>();
const activeByLane = new Map<CanonicalLane, number>();
let pumping = false;

export function enqueueOp(opId: string, lane: CanonicalLane): void {
  if (active.has(opId)) return;
  if (queue.find(q => q.opId === opId)) return;
  queue.push({ opId, lane });
}

export function pumpScheduler(): void {
  if (pumping) return;
  pumping = true;
  try {
    let i = 0;
    while (i < queue.length) {
      const q = queue[i];
      const cap = LANE_CAPS[q.lane] ?? 1;
      const inUse = activeByLane.get(q.lane) ?? 0;
      if (inUse >= cap) { i++; continue; }
      const op = readOp(q.opId);
      if (!op) { queue.splice(i, 1); continue; }
      const factory = resolveAdapterFactory(op);
      if (!factory) { i++; continue; } // No adapter — leave queued.
      activeByLane.set(q.lane, inUse + 1);
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
    await handle.done;
  } catch {
    // Worker.done already converts adapter / loop exceptions into canonical
    // `error` events; nothing more to surface here.
  } finally {
    active.delete(op.id);
    activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1));
    pumpScheduler();
  }
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
  activeByLane.clear();
  pumping = false;
}

export function schedulerSnapshot(): { queueDepth: number; activeCount: number } {
  return { queueDepth: queue.length, activeCount: active.size };
}
