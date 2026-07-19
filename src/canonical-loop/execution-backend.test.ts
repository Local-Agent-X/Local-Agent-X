import { describe, expect, it, vi } from "vitest";
import type { Op } from "../ops/types.js";
import type { Adapter } from "./adapter-contract.js";
import {
  ExecutionBackendRegistry,
  IN_PROCESS_EXECUTION_BACKEND_ID,
  type ExecutionBackend,
} from "./execution-backend.js";
import { InProcessExecutionBackend, type InProcessWorkerRunner } from "./in-process-execution-backend.js";

const op = { id: "op-backend-parity" } as Op;
const adapter = { name: "parity", version: "1" } as Adapter;

type Outcome = "success" | "failure" | "cancel" | "pause" | "redirect" | "worker-throw";

function runnerFor(outcome: Outcome): InProcessWorkerRunner {
  return vi.fn(() => {
    if (outcome === "worker-throw") throw new Error("worker exploded");
    const done = outcome === "failure"
      ? Promise.reject(new Error("worker failed"))
      : Promise.resolve();
    return { workerId: `worker-${outcome}`, done };
  });
}

async function observe(start: () => { workerId: string; done: Promise<void> }): Promise<string> {
  try {
    const handle = start();
    await handle.done;
    return handle.workerId;
  } catch (error) {
    return `throw:${(error as Error).message}`;
  }
}

describe("in-process execution backend parity", () => {
  it.each<Outcome>(["success", "failure", "cancel", "pause", "redirect", "worker-throw"])(
    "preserves the old direct worker seam for %s",
    async (outcome) => {
      const directRunner = runnerFor(outcome);
      const backendRunner = runnerFor(outcome);
      const backend = new InProcessExecutionBackend(backendRunner);

      const direct = await observe(() => directRunner(op, adapter));
      const throughBackend = await observe(() => backend.start({ op, adapter }));

      expect(throughBackend).toBe(direct);
      expect(directRunner).toHaveBeenCalledOnce();
      expect(backendRunner).toHaveBeenCalledOnce();
      expect(backendRunner).toHaveBeenCalledWith(op, adapter);
    },
  );

});

describe("execution backend registry", () => {
  const backend = new InProcessExecutionBackend(runnerFor("success"));

  it("resolves the same built-in for default and explicit selection", () => {
    const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
    registry.register(backend);
    expect(registry.resolve()).toBe(backend);
    expect(registry.resolve(IN_PROCESS_EXECUTION_BACKEND_ID)).toBe(backend);
  });

  it("rejects unknown ids instead of silently falling back", () => {
    const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
    registry.register(backend);
    expect(() => registry.resolve("missing")).toThrow('Unknown execution backend "missing"');
  });

  it("rejects duplicate ids", () => {
    const registry = new ExecutionBackendRegistry(IN_PROCESS_EXECUTION_BACKEND_ID);
    registry.register(backend);
    const duplicate = { ...backend } as ExecutionBackend;
    expect(() => registry.register(duplicate)).toThrow("already registered");
  });
});
