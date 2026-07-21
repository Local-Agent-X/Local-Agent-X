import {
  ExecutionBackendRegistry,
  IN_PROCESS_EXECUTION_BACKEND_ID,
  type ExecutionBackend,
} from "./execution-backend.js";
import { InProcessExecutionBackend } from "./in-process-execution-backend.js";
import {
  PROCESS_EXECUTION_BACKEND_ID,
  ProcessExecutionBackend,
} from "./process-execution-backend.js";
import { runWorker } from "./worker.js";
import type { Op } from "../ops/types.js";

const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
registry.register(new InProcessExecutionBackend(runWorker));
registry.register(new ProcessExecutionBackend());

export function resolveRegisteredExecutionBackend(id?: string, op?: Op): ExecutionBackend {
  if (id) return registry.resolve(id);
  if (op && ProcessExecutionBackend.isEligible(op)) return registry.resolve(PROCESS_EXECUTION_BACKEND_ID);
  return registry.resolve();
}
