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
import {
  CONTAINER_EXECUTION_BACKEND_ID,
  ContainerExecutionBackend,
} from "./container-execution-backend.js";
import {
  createContainerRuntimeProjection,
  createProductionContainerRuntime,
  reopenContainerRuntimeProjection,
} from "./container-runtime-projection.js";

const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
registry.register(new InProcessExecutionBackend(runWorker));
registry.register(new ProcessExecutionBackend());
registry.register(new ContainerExecutionBackend({
  runtime: createProductionContainerRuntime(),
  projectionFactory: createContainerRuntimeProjection,
  projectionRecovery: reopenContainerRuntimeProjection,
}));

export function resolveRegisteredExecutionBackend(id?: string, op?: Op): ExecutionBackend {
  if (id) return registry.resolve(id);
  const selected = configuredExecutionBackend();
  if (selected) return registry.resolve(selected);
  if (op && ProcessExecutionBackend.isEligible(op)) return registry.resolve(PROCESS_EXECUTION_BACKEND_ID);
  return registry.resolve();
}

function configuredExecutionBackend(): string | null {
  const selected = process.env.LAX_CANONICAL_EXECUTION_BACKEND?.trim();
  if (!selected) return null;
  if (selected === "container" || selected === CONTAINER_EXECUTION_BACKEND_ID) {
    return CONTAINER_EXECUTION_BACKEND_ID;
  }
  if (selected === "process" || selected === PROCESS_EXECUTION_BACKEND_ID) {
    return PROCESS_EXECUTION_BACKEND_ID;
  }
  if (selected === "in-process" || selected === IN_PROCESS_EXECUTION_BACKEND_ID) {
    return IN_PROCESS_EXECUTION_BACKEND_ID;
  }
  throw new Error(`Unknown configured execution backend "${selected}"`);
}
