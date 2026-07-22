import { listOps, readOp } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import type { CanonicalState } from "./types.js";

export type DependencyReadiness =
  | { kind: "runnable" }
  | { kind: "blocked" }
  | { kind: "failed"; prerequisiteId: string }
  | { kind: "cancelled"; prerequisiteId: string }
  | { kind: "invalid"; prerequisiteId: string; reason: string };

export class InvalidOpDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpDependencyError";
  }
}

const waitersByPrerequisite = new Map<string, Set<string>>();
const SAFE_OP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function normalizedDependencyIds(op: Op): string[] {
  if (op.dependsOn === undefined) return [];
  if (!Array.isArray(op.dependsOn)) {
    throw new InvalidOpDependencyError(`op ${op.id} dependencies must be an array`);
  }
  const ids = op.dependsOn.map((value) => typeof value === "string" ? value.trim() : "");
  if (ids.some((id) => id.length === 0)) {
    throw new InvalidOpDependencyError(`op ${op.id} has an empty dependency id`);
  }
  if (ids.some((id) => !SAFE_OP_ID.test(id))) {
    throw new InvalidOpDependencyError(`op ${op.id} has an invalid dependency id`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new InvalidOpDependencyError(`op ${op.id} has duplicate dependency ids`);
  }
  if (ids.includes(op.id)) {
    throw new InvalidOpDependencyError(`op ${op.id} cannot depend on itself`);
  }
  return ids;
}

function assertAuthorized(op: Op, prerequisite: Op, allowUnpersisted = false): void {
  if (prerequisite.ownerId !== op.ownerId) {
    throw new InvalidOpDependencyError(
      `op ${op.id} is not authorized to depend on ${prerequisite.id}`,
    );
  }
  if (!allowUnpersisted
    && (prerequisite.canonical?.flagValue !== true || !prerequisite.canonical.state)) {
    throw new InvalidOpDependencyError(
      `op ${op.id} prerequisite ${prerequisite.id} is not a canonical operation`,
    );
  }
}

export function validateOpDependencies(
  op: Op,
  prospective: ReadonlyMap<string, Op> = new Map(),
): string[] {
  const ids = normalizedDependencyIds(op);
  const resolve = (id: string): Op | null => prospective.get(id) ?? readOp(id);
  for (const id of ids) {
    const prerequisite = resolve(id);
    if (!prerequisite) {
      throw new InvalidOpDependencyError(`op ${op.id} prerequisite ${id} does not exist`);
    }
    assertAuthorized(op, prerequisite, prospective.has(id));
  }

  const visited = new Set<string>();
  const active = new Set<string>([op.id]);
  const walk = (id: string): void => {
    if (active.has(id)) {
      throw new InvalidOpDependencyError(`op ${op.id} dependency graph contains a cycle at ${id}`);
    }
    if (visited.has(id)) return;
    const candidate = resolve(id);
    if (!candidate) {
      throw new InvalidOpDependencyError(`op ${op.id} prerequisite ${id} does not exist`);
    }
    active.add(id);
    for (const childId of normalizedDependencyIds(candidate)) walk(childId);
    active.delete(id);
    visited.add(id);
  };
  for (const id of ids) walk(id);
  return ids;
}

export function validateDependencyBatch(ops: readonly Op[]): void {
  const prospective = new Map(ops.map((op) => [op.id, op]));
  for (const op of ops) validateOpDependencies(op, prospective);
}

export function registerDependencyWaiter(op: Op): void {
  unregisterDependencyWaiter(op.id);
  for (const prerequisiteId of normalizedDependencyIds(op)) {
    let waiters = waitersByPrerequisite.get(prerequisiteId);
    if (!waiters) {
      waiters = new Set();
      waitersByPrerequisite.set(prerequisiteId, waiters);
    }
    waiters.add(op.id);
  }
}

export function unregisterDependencyWaiter(opId: string): void {
  for (const [prerequisiteId, waiters] of waitersByPrerequisite) {
    waiters.delete(opId);
    if (waiters.size === 0) waitersByPrerequisite.delete(prerequisiteId);
  }
}

export function rebuildDependencyWaiterIndex(): Op[] {
  waitersByPrerequisite.clear();
  const dependents: Op[] = [];
  for (const op of listOps()) {
    const state = op.canonical?.state;
    if (!op.dependsOn?.length || state === "succeeded" || state === "failed" || state === "cancelled") {
      continue;
    }
    dependents.push(op);
    try { registerDependencyWaiter(op); }
    catch { /* coordinator fails malformed rows individually */ }
  }
  return dependents;
}

export function dependencyWaitersFor(prerequisiteId: string): string[] {
  return [...(waitersByPrerequisite.get(prerequisiteId) ?? [])];
}

export function evaluateDependencyReadiness(op: Op): DependencyReadiness {
  let ids: string[];
  try { ids = normalizedDependencyIds(op); }
  catch (error) {
    return { kind: "invalid", prerequisiteId: op.id, reason: (error as Error).message };
  }
  if (ids.length === 0) return { kind: "runnable" };

  let blocked = false;
  let cancelledId: string | null = null;
  for (const id of ids) {
    const prerequisite = readOp(id);
    if (!prerequisite) {
      return { kind: "invalid", prerequisiteId: id, reason: "missing or corrupt prerequisite" };
    }
    try { assertAuthorized(op, prerequisite); }
    catch (error) {
      return { kind: "invalid", prerequisiteId: id, reason: (error as Error).message };
    }
    const state = prerequisite.canonical!.state as CanonicalState;
    if (state === "failed") return { kind: "failed", prerequisiteId: id };
    if (state === "cancelled") cancelledId ??= id;
    else if (state !== "succeeded") blocked = true;
  }
  if (cancelledId) return { kind: "cancelled", prerequisiteId: cancelledId };
  return blocked ? { kind: "blocked" } : { kind: "runnable" };
}

export function resetDependencyWaiterIndex(): void {
  waitersByPrerequisite.clear();
}
