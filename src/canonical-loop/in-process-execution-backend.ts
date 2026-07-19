import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
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

  constructor(private readonly runner: InProcessWorkerRunner) {}

  start({ op, adapter }: ExecutionBackendStartRequest): InProcessExecutionHandle {
    return this.runner(op, adapter);
  }
}
