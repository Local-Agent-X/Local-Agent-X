import { readOp } from "../ops/op-store.js";
import type { Op } from "../ops/types.js";
import type { CanonicalLane, CanonicalState } from "./types.js";
import {
  dependencyWaitersFor,
  evaluateDependencyReadiness,
  rebuildDependencyWaiterIndex,
  registerDependencyWaiter,
  resetDependencyWaiterIndex,
  unregisterDependencyWaiter,
} from "./dependencies.js";
import { transitionOp, IllegalTransitionError } from "./state-machine.js";
import { dependencyBatchAdmissionError } from "./dependency-batch.js";

export type DependencyGateDisposition = "runnable" | "blocked" | "settled";

interface DependencySchedulerCallbacks {
  enqueue(opId: string, lane: CanonicalLane): void;
  pump(): void;
}

export class DependencySchedulerCoordinator {
  constructor(private readonly callbacks: DependencySchedulerCallbacks) {}

  gate(op: Op): DependencyGateDisposition {
    const admissionError = dependencyBatchAdmissionError(op);
    if (admissionError) {
      this.settle(op, { kind: "invalid", prerequisiteId: op.id, reason: admissionError });
      return "settled";
    }
    if (!op.dependsOn?.length) return "runnable";
    const readiness = evaluateDependencyReadiness(op);
    if (readiness.kind === "runnable") {
      unregisterDependencyWaiter(op.id);
      return "runnable";
    }
    if (readiness.kind === "blocked") {
      registerDependencyWaiter(op);
      return "blocked";
    }
    this.settle(op, readiness);
    return "settled";
  }

  terminal(prerequisiteId: string): void {
    rebuildDependencyWaiterIndex();
    for (const dependentId of dependencyWaitersFor(prerequisiteId)) {
      const dependent = readOp(dependentId);
      if (!dependent || dependent.canonical?.state !== "queued") continue;
      const disposition = this.gate(dependent);
      if (disposition === "runnable") {
        this.callbacks.enqueue(dependent.id, dependent.lane as CanonicalLane);
      }
    }
    this.callbacks.pump();
  }

  rebuild(): void {
    const dependents = rebuildDependencyWaiterIndex();
    for (const dependent of dependents) {
      if (dependent.canonical?.state !== "queued") continue;
      const disposition = this.gate(dependent);
      if (disposition === "runnable") {
        this.callbacks.enqueue(dependent.id, dependent.lane as CanonicalLane);
      }
    }
    this.callbacks.pump();
  }

  reset(): void {
    resetDependencyWaiterIndex();
  }

  private settle(
    op: Op,
    readiness: Exclude<ReturnType<typeof evaluateDependencyReadiness>,
      { kind: "runnable" } | { kind: "blocked" }>,
  ): void {
    const to: CanonicalState = readiness.kind === "cancelled" ? "cancelled" : "failed";
    const reason = readiness.kind === "invalid"
      ? `dependency_invalid:${readiness.prerequisiteId}:${readiness.reason}`
      : `dependency_${readiness.kind}:${readiness.prerequisiteId}`;
    try { transitionOp(op, to, reason); }
    catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
    }
    unregisterDependencyWaiter(op.id);
  }
}
