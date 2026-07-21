import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionPlacement } from "./types.js";
import {
  IN_PROCESS_EXECUTION_BACKEND_ID,
  type ExecutionBackend,
  type ExecutionHandle,
  type ExecutionBackendStartRequest,
} from "./execution-backend.js";

export interface InProcessExecutionHandle extends ExecutionHandle {
  workerId: string;
}

export type InProcessWorkerRunner = (op: Op, adapter: Adapter) => InProcessExecutionHandle;

/** The built-in backend is deliberately a thin adapter over the one canonical
 * worker. It adds placement selection without adding another execution loop. */
export class InProcessExecutionBackend implements ExecutionBackend {
  readonly id = IN_PROCESS_EXECUTION_BACKEND_ID;
  readonly adapterProvisioning = "parent" as const;
  private readonly targetId = "canonical-worker";

  constructor(private readonly runner: InProcessWorkerRunner) {}

  place(_op: Op): { targetId: string; disposition: "ready" } {
    return { targetId: this.targetId, disposition: "ready" };
  }

  acceptsPlacement(placement: ExecutionPlacement): boolean {
    return placement.backendId === this.id && placement.targetId === this.targetId;
  }

  start({ op, adapter, placement }: ExecutionBackendStartRequest): InProcessExecutionHandle {
    if (placement.backendId !== this.id || placement.targetId !== this.targetId) {
      throw new Error("in-process execution placement identity mismatch");
    }
    if (!adapter) throw new Error("in-process execution requires a live adapter");
    return this.runner(op, adapter);
  }
}
