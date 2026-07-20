import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import type { ExecutionPlacement } from "./types.js";

export const IN_PROCESS_EXECUTION_BACKEND_ID = "in-process";

export interface ExecutionHandle {
  done: Promise<void>;
}

export interface ExecutionBackendStartRequest {
  op: Op;
  adapter: Adapter;
  placement: ExecutionPlacement;
}

export type ExecutionPlacementDecision =
  | { targetId: string; disposition: "ready" }
  | { targetId: string; disposition: "waiting"; wakeToken: string };

/** Placement boundary around the canonical worker. Backends may choose where
 * execution happens, but they never own the turn loop or tool dispatcher. */
export interface ExecutionBackend {
  readonly id: string;
  /** Select once. The scheduler persists this decision before start; later
   * restarts resolve the exact recorded backend/target instead of re-routing. */
  place(op: Op): ExecutionPlacementDecision;
  /** Pure validation for a persisted target. Restart never re-selects; an
   * implementation/version that no longer recognizes it must fail closed. */
  acceptsPlacement(placement: ExecutionPlacement): boolean;
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
