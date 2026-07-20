import type { Op } from "../ops/types.js";
import { readOp, tryWithOpLock, writeOpStrict } from "../ops/op-store.js";
import type { ExecutionBackend, ExecutionPlacementDecision } from "./execution-backend.js";
import type { ExecutionPlacement } from "./types.js";

export class ExecutionPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPlacementError";
  }
}

export class ExecutionPlacementRetryError extends ExecutionPlacementError {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionPlacementRetryError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseExecutionPlacement(value: unknown): ExecutionPlacement | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionPlacementError("ambiguous execution placement record");
  }
  const p = value as Partial<ExecutionPlacement>;
  if (
    p.schemaVersion !== 1
    || !nonEmpty(p.backendId)
    || !nonEmpty(p.targetId)
    || (p.disposition !== "ready" && p.disposition !== "waiting")
    || !Number.isSafeInteger(p.revision)
    || (p.revision as number) < 1
    || (p.wakeRequestedAt !== null && !nonEmpty(p.wakeRequestedAt))
    || (nonEmpty(p.wakeRequestedAt) && !Number.isFinite(Date.parse(p.wakeRequestedAt)))
    || (p.disposition === "waiting" && !nonEmpty(p.wakeToken))
    || (p.disposition === "ready" && p.wakeToken !== null)
  ) {
    throw new ExecutionPlacementError("ambiguous execution placement record");
  }
  return p as ExecutionPlacement;
}

function fromDecision(backend: ExecutionBackend, decision: ExecutionPlacementDecision): ExecutionPlacement {
  if (!nonEmpty(decision.targetId)) {
    throw new ExecutionPlacementError(`backend ${backend.id} returned an invalid target identity`);
  }
  if (decision.disposition === "waiting" && !nonEmpty(decision.wakeToken)) {
    throw new ExecutionPlacementError(`backend ${backend.id} returned a waiting placement without a wake token`);
  }
  return {
    schemaVersion: 1,
    backendId: backend.id,
    targetId: decision.targetId,
    disposition: decision.disposition,
    wakeToken: decision.disposition === "waiting" ? decision.wakeToken : null,
    wakeRequestedAt: null,
    revision: 1,
  };
}

/** Resolve a legacy op once, then preserve its exact durable identity forever. */
export function ensureExecutionPlacement(op: Op, backend: ExecutionBackend): ExecutionPlacement {
  const existing = parseExecutionPlacement(op.canonical?.executionPlacement);
  if (existing) {
    if (existing.backendId !== backend.id) {
      throw new ExecutionPlacementError(
        `execution placement backend drift: recorded=${existing.backendId} resolved=${backend.id}`,
      );
    }
    if (!backend.acceptsPlacement(existing)) {
      throw new ExecutionPlacementError(
        `execution placement target drift: backend=${backend.id} target=${existing.targetId}`,
      );
    }
    return existing;
  }

  const selected = fromDecision(backend, backend.place(op));
  const stored = tryWithOpLock(op.id, () => {
    const fresh = readOp(op.id);
    if (!fresh?.canonical) throw new ExecutionPlacementError(`operation ${op.id} disappeared during placement`);
    const concurrent = parseExecutionPlacement(fresh.canonical.executionPlacement);
    if (concurrent) return concurrent;
    fresh.canonical.executionPlacement = selected;
    if (!writeOpStrict(fresh)) throw new ExecutionPlacementRetryError(`failed to persist execution placement for ${op.id}`);
    return selected;
  });
  if (!stored.acquired) throw new ExecutionPlacementRetryError(`failed to lock execution placement for ${op.id}`);
  if (stored.value.backendId !== backend.id) {
    throw new ExecutionPlacementError(
      `execution placement backend drift: recorded=${stored.value.backendId} resolved=${backend.id}`,
    );
  }
  if (!backend.acceptsPlacement(stored.value)) {
    throw new ExecutionPlacementError(
      `execution placement target drift: backend=${backend.id} target=${stored.value.targetId}`,
    );
  }
  if (!op.canonical) op.canonical = {};
  op.canonical.executionPlacement = stored.value;
  return stored.value;
}

export type PlacementWakeResult =
  | { ok: true; placement: ExecutionPlacement }
  | { ok: false; reason: "unknown_op" | "not_queued" | "ambiguous" | "identity_mismatch" | "revision_mismatch" | "token_mismatch" | "not_waiting" | "persistence_failed" };

/** Exact-token wake. Stale owners cannot make a newer/different placement runnable. */
export function markExecutionPlacementReady(
  opId: string,
  identity: { backendId: string; targetId: string },
  expectedRevision: number,
  wakeToken: string,
  now = new Date().toISOString(),
): PlacementWakeResult {
  const result = tryWithOpLock(opId, () => {
    const op = readOp(opId);
    if (!op?.canonical) return { ok: false, reason: "unknown_op" } as const;
    if (op.canonical.state !== "queued") return { ok: false, reason: "not_queued" } as const;
    let placement: ExecutionPlacement | null;
    try { placement = parseExecutionPlacement(op.canonical.executionPlacement); }
    catch { return { ok: false, reason: "ambiguous" } as const; }
    if (!placement) return { ok: false, reason: "ambiguous" } as const;
    if (placement.backendId !== identity.backendId || placement.targetId !== identity.targetId) {
      return { ok: false, reason: "identity_mismatch" } as const;
    }
    if (placement.revision !== expectedRevision) return { ok: false, reason: "revision_mismatch" } as const;
    if (placement.disposition !== "waiting") return { ok: false, reason: "not_waiting" } as const;
    if (placement.wakeToken !== wakeToken) return { ok: false, reason: "token_mismatch" } as const;
    const ready: ExecutionPlacement = {
      ...placement,
      disposition: "ready",
      wakeToken: null,
      wakeRequestedAt: now,
      revision: placement.revision + 1,
    };
    op.canonical.executionPlacement = ready;
    if (!writeOpStrict(op)) return { ok: false, reason: "persistence_failed" } as const;
    return { ok: true, placement: ready } as const;
  });
  return result.acquired ? result.value : { ok: false, reason: "persistence_failed" };
}
