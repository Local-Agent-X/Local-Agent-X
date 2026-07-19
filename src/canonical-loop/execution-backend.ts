import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";

export const IN_PROCESS_EXECUTION_BACKEND_ID = "in-process";

export interface ExecutionHandle {
  done: Promise<void>;
}

export interface ExecutionBackendStartRequest {
  op: Op;
  adapter: Adapter;
}

/** Placement boundary around the canonical worker. Backends may choose where
 * execution happens, but they never own the turn loop or tool dispatcher. */
export interface ExecutionBackend {
  readonly id: string;
  start(request: ExecutionBackendStartRequest): ExecutionHandle;
}

export class ExecutionBackendRegistry {
  private readonly backends = new Map<string, ExecutionBackend>();

  constructor(private readonly defaultBackendId: string) {}

  register(backend: ExecutionBackend): void {
    if (this.backends.has(backend.id)) {
      throw new Error(`Execution backend "${backend.id}" is already registered`);
    }
    this.backends.set(backend.id, backend);
  }

  resolve(id = this.defaultBackendId): ExecutionBackend {
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`Unknown execution backend "${id}"`);
    return backend;
  }
}
