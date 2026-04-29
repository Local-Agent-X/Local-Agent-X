/**
 * DAG scheduler — turns single ops into composable workflows.
 *
 * Per spec §20: multi-step workflows are NOT one big op with internal
 * phases. They're a DAG of atomic ops managed by the supervisor. Each
 * op = one task, one worker, one outcome — composable, retryable in
 * isolation, parallelizable where deps allow.
 *
 * Scheduler responsibilities:
 *   - Track DAG state (which ops are pending / running / completed)
 *   - Determine eligibility (op is eligible when all dependsOn complete)
 *   - Submit eligible ops to the worker pool
 *   - Chain upstream results into downstream context packs
 *   - Cancel propagation (kill op A → all transitive descendants cancel)
 *   - Surface partial-failure to user (op A failed → downstream get
 *     "cancelled-upstream-failed")
 *
 * Step 5 scope: the scheduler primitive + ops-with-deps. Templates
 * (research-then-build, audit-then-patch-then-verify) and supervisor-
 * decomposed plans are layered on top.
 */

import { EventEmitter } from "node:events";
import { submitOp } from "./pool.js";
import { writeOp, readOp, setOpStatus } from "./op-store.js";
import { appendEvent } from "./event-log.js";
import type { Op, OpResult } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.scheduler");

// ── DAG types ──────────────────────────────────────────────────────────────

export interface DagSpec {
  /** All ops in the DAG. The scheduler honors their dependsOn fields. */
  ops: Op[];
  /** Optional human-friendly DAG name (template name, or freeform). */
  name?: string;
}

export interface DagResult {
  ok: boolean;
  /** All op results, keyed by opId. */
  results: Record<string, OpResult>;
  /** ops that completed successfully. */
  completedOps: string[];
  /** ops that failed (after retry caps). */
  failedOps: string[];
  /** ops that were cancelled because an upstream failed. */
  cancelledOps: string[];
  /** Total wall-clock time. */
  durationMs: number;
}

interface DagState {
  spec: DagSpec;
  startedAt: number;
  pendingIds: Set<string>;
  runningIds: Set<string>;
  completedResults: Map<string, OpResult>;
  failedIds: Set<string>;
  cancelledIds: Set<string>;
}

// ── Public API ─────────────────────────────────────────────────────────────

const events = new EventEmitter();
events.setMaxListeners(50);

/**
 * Submit a DAG of ops. Returns a promise that resolves with the full
 * DagResult when every op has completed (success, failure, or cancellation).
 *
 * The DAG is validated before any op is submitted: if dependsOn references
 * an opId not in the DAG, or if there's a cycle, the call rejects.
 */
export async function submitDag(spec: DagSpec): Promise<DagResult> {
  validateDag(spec);
  const state: DagState = {
    spec,
    startedAt: Date.now(),
    pendingIds: new Set(spec.ops.map(o => o.id)),
    runningIds: new Set(),
    completedResults: new Map(),
    failedIds: new Set(),
    cancelledIds: new Set(),
  };

  // Persist all ops up front so they're visible in op-store immediately
  for (const op of spec.ops) {
    op.status = "pending";
    writeOp(op);
  }

  logger.info(`[scheduler] submitting DAG ${spec.name || "(unnamed)"} with ${spec.ops.length} ops`);

  return new Promise((resolve) => {
    // Kick off all initially-eligible ops (no deps, or deps already satisfied
    // by being absent from the DAG — though validateDag would've caught that).
    dispatchEligible(state, resolve);
  });
}

/**
 * Cancel a DAG (kill all running + cancel all pending). Subscribers see
 * cancellation events propagate through dependent ops.
 */
export function cancelDag(opIds: string[]): void {
  // For Step 5, just mark cancelled in op-store; integrating with pool's
  // kill is a refinement (currently the pool exposes killOp per opId).
  for (const id of opIds) {
    const op = readOp(id);
    if (op && (op.status === "pending" || op.status === "running")) {
      setOpStatus(id, "cancelled", { lastFailureReason: "DAG cancelled" });
    }
  }
}

// ── Dispatch loop ──────────────────────────────────────────────────────────

function dispatchEligible(state: DagState, resolveFn: (r: DagResult) => void): void {
  const eligible = [...state.pendingIds].filter(id => isEligible(state, id));

  for (const id of eligible) {
    const op = state.spec.ops.find(o => o.id === id)!;
    state.pendingIds.delete(id);
    state.runningIds.add(id);

    // Inject upstream results into this op's context pack
    augmentContextPackWithUpstreamResults(op, state);

    logger.info(`[scheduler] dispatching op ${id} (deps: ${(op.dependsOn || []).join(",") || "none"})`);

    submitOp(op).then((result) => {
      state.runningIds.delete(id);
      state.completedResults.set(id, result);

      if (result.status === "completed") {
        // Eligible-cascade: a downstream op may now be runnable
        dispatchEligible(state, resolveFn);
      } else if (result.status === "failed" || result.status === "cancelled") {
        state.failedIds.add(id);
        // Cascade cancellation to all transitive descendants
        const descendants = transitiveDescendants(state.spec, id);
        for (const desc of descendants) {
          if (state.pendingIds.has(desc)) {
            state.pendingIds.delete(desc);
            state.cancelledIds.add(desc);
            const cancelOp = state.spec.ops.find(o => o.id === desc)!;
            const cancelResult: OpResult = {
              opId: desc,
              status: "cancelled",
              finalSummary: `Cancelled — upstream op ${id} failed`,
              filesChanged: [],
            };
            state.completedResults.set(desc, cancelResult);
            setOpStatus(desc, "cancelled", { lastFailureReason: `upstream ${id} failed` });
            appendEvent({
              opId: desc,
              type: "cancelled",
              ts: new Date().toISOString(),
              payload: { reason: "upstream-failed", upstream: id },
            });
            logger.info(`[scheduler] cancelled downstream ${desc} (upstream ${id} failed)`);
            void cancelOp;
          }
        }
      }

      maybeFinalize(state, resolveFn);
    });
  }

  maybeFinalize(state, resolveFn);
}

function maybeFinalize(state: DagState, resolveFn: (r: DagResult) => void): void {
  if (state.runningIds.size > 0 || state.pendingIds.size > 0) return;
  // All ops accounted for
  const completedOps: string[] = [];
  for (const [id, result] of state.completedResults) {
    if (result.status === "completed") completedOps.push(id);
  }
  const result: DagResult = {
    ok: state.failedIds.size === 0 && state.cancelledIds.size === 0,
    results: Object.fromEntries(state.completedResults),
    completedOps,
    failedOps: [...state.failedIds],
    cancelledOps: [...state.cancelledIds],
    durationMs: Date.now() - state.startedAt,
  };
  logger.info(`[scheduler] DAG finished in ${Math.round(result.durationMs / 1000)}s — ok=${result.ok}, completed=${completedOps.length}, failed=${state.failedIds.size}, cancelled=${state.cancelledIds.size}`);
  events.emit("dag-done", result);
  resolveFn(result);
}

// ── Eligibility + result chaining ──────────────────────────────────────────

function isEligible(state: DagState, opId: string): boolean {
  const op = state.spec.ops.find(o => o.id === opId);
  if (!op) return false;
  const deps = op.dependsOn || [];
  for (const depId of deps) {
    const depResult = state.completedResults.get(depId);
    if (!depResult) return false;                 // not done yet
    if (depResult.status !== "completed") return false; // upstream failed/cancelled — caller will cascade
  }
  return true;
}

/**
 * Pull each upstream op's result into THIS op's context pack as
 * `upstreamResults` keyed by inputBindings. The downstream worker spawns
 * with the deliverables already in its pack — no re-fetching.
 */
function augmentContextPackWithUpstreamResults(op: Op, state: DagState): void {
  const bindings = op.inputBindings || {};
  if (Object.keys(bindings).length === 0) return;

  const upstreamResults: Record<string, { summary: string; status: string; filesChanged: string[] }> = {};
  for (const [name, upstreamId] of Object.entries(bindings)) {
    const r = state.completedResults.get(upstreamId);
    if (r) {
      upstreamResults[name] = {
        summary: r.finalSummary,
        status: r.status,
        filesChanged: r.filesChanged,
      };
    }
  }

  // Stash in the context pack's `notWhatToRedo` (most semantic fit) AND in
  // a dedicated upstreamResults field. Worker reads both via system prompt.
  const upstreamLines = Object.entries(upstreamResults).map(
    ([name, r]) => `- ${name} (from ${state.spec.ops.find(o => Object.values(bindings).includes(o.id))?.id || "upstream"}): ${r.summary.slice(0, 400)}`
  );
  if (upstreamLines.length > 0) {
    // Prepend as a section in constraints (the worker's system prompt
    // includes these). Won't double-append because we set on the in-memory
    // op only, which gets sent fresh via assign-op IPC.
    op.contextPack.task.constraints = [
      `## Upstream results (already produced — use them, don't re-derive)\n${upstreamLines.join("\n")}`,
      ...op.contextPack.task.constraints,
    ];
  }
  writeOp(op);
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateDag(spec: DagSpec): void {
  const ids = new Set(spec.ops.map(o => o.id));
  for (const op of spec.ops) {
    for (const dep of op.dependsOn || []) {
      if (!ids.has(dep)) {
        throw new Error(`DAG validation: op ${op.id} depends on ${dep}, which is not in the DAG`);
      }
    }
  }
  // Cycle detection (DFS with visited + stack)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  for (const op of spec.ops) colors.set(op.id, WHITE);
  function dfs(id: string, path: string[]): void {
    if (colors.get(id) === BLACK) return;
    if (colors.get(id) === GRAY) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(" -> ");
      throw new Error(`DAG validation: cycle detected: ${cycle}`);
    }
    colors.set(id, GRAY);
    const op = spec.ops.find(o => o.id === id)!;
    for (const dep of op.dependsOn || []) dfs(dep, [...path, id]);
    colors.set(id, BLACK);
  }
  for (const op of spec.ops) dfs(op.id, []);
}

// ── Transitive descendants ────────────────────────────────────────────────

function transitiveDescendants(spec: DagSpec, opId: string): string[] {
  const out: string[] = [];
  const queue = [opId];
  const seen = new Set<string>([opId]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const op of spec.ops) {
      if ((op.dependsOn || []).includes(cur) && !seen.has(op.id)) {
        seen.add(op.id);
        out.push(op.id);
        queue.push(op.id);
      }
    }
  }
  return out;
}

// ── Subscription (for UI / supervisor) ────────────────────────────────────

export function onDagDone(cb: (result: DagResult) => void): () => void {
  events.on("dag-done", cb);
  return () => events.off("dag-done", cb);
}
