import {
  ExecutionBackendRegistry,
  IN_PROCESS_EXECUTION_BACKEND_ID,
  type ExecutionBackend,
} from "./execution-backend.js";
import { InProcessExecutionBackend } from "./in-process-execution-backend.js";
import { ProcessExecutionBackend } from "./process-execution-backend.js";
import { runWorker } from "./worker.js";

const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
registry.register(new InProcessExecutionBackend(runWorker));
registry.register(new ProcessExecutionBackend());

/** Resolve only the durable backend identity supplied by placement. Absence
 * intentionally remains in-process until the later routing chunk activates
 * process selection for its narrow eligible operation class. */
export function resolveRegisteredExecutionBackend(id?: string): ExecutionBackend {
  return registry.resolve(id);
}

