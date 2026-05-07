/**
 * Canonical-loop runtime registry (Issue 03).
 *
 * Singleton state for:
 *   - adapter factories keyed by op_id (test-fixture style) or by lane
 *     (production default — Issue 09 wires Anthropic for `interactive`)
 *   - the active tool dispatcher
 *
 * No business logic lives here — it's the dependency-injection seat the
 * scheduler/worker pull from when driving an op. Test cleanup calls
 * resetCanonicalRuntime() to drop registrations between tests.
 */
import type { Op } from "../workers/types.js";
import type { Adapter } from "./adapter-contract.js";
import { NotConfiguredToolDispatcher, type ToolDispatcher } from "./tool-dispatch.js";
import type { CanonicalLane } from "./types.js";

export type AdapterFactory = () => Adapter | Promise<Adapter>;

const opAdapters = new Map<string, AdapterFactory>();
const laneAdapters = new Map<CanonicalLane, AdapterFactory>();
const opDispatchers = new Map<string, ToolDispatcher>();
let toolDispatcher: ToolDispatcher = new NotConfiguredToolDispatcher();

/** Register a factory that produces the adapter for a specific op_id. */
export function registerAdapterForOp(opId: string, factory: AdapterFactory): void {
  opAdapters.set(opId, factory);
}

/** Register the default factory used for any op in a given lane that has no per-op override. */
export function setDefaultAdapterForLane(lane: CanonicalLane, factory: AdapterFactory): void {
  laneAdapters.set(lane, factory);
}

/**
 * Register a per-op tool dispatcher. Per-op dispatchers take precedence over
 * the global one — needed for chat ops where each session has its own tool
 * registry, security context, and event-emit callback.
 *
 * Lifetime: caller is responsible for removing the entry when the op
 * terminates (call `unregisterToolDispatcherForOp(opId)`). The runtime
 * doesn't auto-clean because it has no terminal-state hook today.
 */
export function registerToolDispatcherForOp(opId: string, d: ToolDispatcher): void {
  opDispatchers.set(opId, d);
}

export function unregisterToolDispatcherForOp(opId: string): void {
  opDispatchers.delete(opId);
}

/** Inject the global tool dispatcher used when no per-op dispatcher is registered. */
export function setToolDispatcher(d: ToolDispatcher): void {
  toolDispatcher = d;
}

/**
 * Resolve the dispatcher for an op. Per-op override wins; falls back to the
 * global dispatcher (default `NotConfiguredToolDispatcher`).
 *
 * The legacy zero-arg signature stays valid for callers that don't have an
 * opId in scope — they get the global dispatcher.
 */
export function getToolDispatcher(opId?: string): ToolDispatcher {
  if (opId) {
    const d = opDispatchers.get(opId);
    if (d) return d;
  }
  return toolDispatcher;
}

/** Resolve the adapter factory for `op` (per-op override wins over lane default). */
export function resolveAdapterFactory(op: Op): AdapterFactory | null {
  const f = opAdapters.get(op.id);
  if (f) return f;
  const lane = op.lane as CanonicalLane;
  return laneAdapters.get(lane) ?? null;
}

/** Drop adapter registrations and restore the no-op tool dispatcher. */
export function resetCanonicalRuntime(): void {
  opAdapters.clear();
  laneAdapters.clear();
  opDispatchers.clear();
  toolDispatcher = new NotConfiguredToolDispatcher();
}
