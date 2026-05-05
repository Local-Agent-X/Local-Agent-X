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
let toolDispatcher: ToolDispatcher = new NotConfiguredToolDispatcher();

/** Register a factory that produces the adapter for a specific op_id. */
export function registerAdapterForOp(opId: string, factory: AdapterFactory): void {
  opAdapters.set(opId, factory);
}

/** Register the default factory used for any op in a given lane that has no per-op override. */
export function setDefaultAdapterForLane(lane: CanonicalLane, factory: AdapterFactory): void {
  laneAdapters.set(lane, factory);
}

/** Inject the tool dispatcher used by the loop's turn_loop when it sees `tool_call_requested`. */
export function setToolDispatcher(d: ToolDispatcher): void {
  toolDispatcher = d;
}

export function getToolDispatcher(): ToolDispatcher {
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
  toolDispatcher = new NotConfiguredToolDispatcher();
}
