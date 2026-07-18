import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { parsePlanText } from "../src/auto-build/plan-parser.js";

const mocks = vi.hoisted(() => ({
  stateWrite: vi.fn(),
  stateClear: vi.fn(),
  registryRegister: vi.fn(),
  registryUnregister: vi.fn(),
  runBuildLoop: vi.fn(),
  updateWorkflow: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("../src/auto-build/orchestrator/state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/auto-build/orchestrator/state.js")>();
  return {
    ...actual,
    write: mocks.stateWrite,
    clear: mocks.stateClear,
  };
});

vi.mock("../src/auto-build/orchestrator/registry.js", () => ({
  register: mocks.registryRegister,
  unregister: mocks.registryUnregister,
}));

vi.mock("../src/auto-build/loop.js", () => ({
  runBuildLoop: mocks.runBuildLoop,
}));

vi.mock("../src/ops/session-bridge.js", () => ({
  broadcastToSession: mocks.broadcast,
}));

vi.mock("../src/auto-build/workflow-state.js", () => ({
  updateAppBuildWorkflow: mocks.updateWorkflow,
}));

import {
  listActive,
  startOrchestration,
} from "../src/auto-build/orchestrator/manager.js";

const PLAN = parsePlanText(
  "# Plan\n\n## Phase A\n\n### Chunk 1 — Init\n\n" +
  "- **Class:** trunk\n- **Slice:** initialize.\n- **Done when:** boots.",
);

function options(projectDir: string) {
  return {
    sessionId: "durability-session",
    projectDir,
    planPath: resolve(projectDir, "spec", "plan.md"),
    plan: PLAN,
    startingChunk: 1,
  };
}

describe("orchestrator startup durability gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stateWrite.mockReturnValue(true);
    mocks.stateClear.mockReturnValue(true);
    mocks.registryRegister.mockReturnValue(true);
    mocks.registryUnregister.mockReturnValue(true);
    mocks.runBuildLoop.mockReturnValue(new Promise(() => {}));
  });

  it("does not register, activate, or run when initial state persistence fails", () => {
    const projectDir = resolve("state-write-failure");
    mocks.stateWrite.mockReturnValueOnce(false);

    expect(() => startOrchestration(options(projectDir)))
      .toThrow("failed to persist .lax-build-run.json");
    expect(mocks.registryRegister).not.toHaveBeenCalled();
    expect(mocks.runBuildLoop).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(listActive().some(active => active.projectDir === projectDir)).toBe(false);
  });

  it("rolls back state and never activates when registry persistence fails", () => {
    const projectDir = resolve("registry-write-failure");
    mocks.registryRegister.mockReturnValueOnce(false);

    expect(() => startOrchestration(options(projectDir)))
      .toThrow("failed to persist the active-orchestrator registry");
    expect(mocks.stateClear).toHaveBeenCalledWith(projectDir);
    expect(mocks.runBuildLoop).not.toHaveBeenCalled();
    expect(listActive().some(active => active.projectDir === projectDir)).toBe(false);
    expect(mocks.updateWorkflow).not.toHaveBeenCalled();
  });

  it("links a persisted Product Build only after startup durability gates pass", () => {
    const projectDir = resolve("durable-start");

    const started = startOrchestration(options(projectDir));

    expect(mocks.updateWorkflow).toHaveBeenCalledWith("durability-session", {
      phase: "running",
      projectDir,
      opId: started.opId,
    });
  });

  it("rolls back state and registry before launch when the running workflow transition fails", () => {
    const projectDir = resolve("workflow-running-failure");
    mocks.updateWorkflow.mockImplementationOnce(() => {
      throw new Error("workflow store unavailable");
    });

    expect(() => startOrchestration(options(projectDir)))
      .toThrow("failed to persist Product Build running state");
    expect(mocks.registryUnregister).toHaveBeenCalledWith(projectDir);
    expect(mocks.stateClear).toHaveBeenCalledWith(projectDir);
    expect(mocks.runBuildLoop).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(listActive().some(active => active.projectDir === projectDir)).toBe(false);
  });

  it("retains complete state and registry when the complete workflow transition fails", async () => {
    const projectDir = resolve("workflow-complete-failure");
    mocks.updateWorkflow
      .mockReturnValueOnce({ phase: "running" })
      .mockImplementationOnce(() => {
        throw new Error("workflow store unavailable");
      });
    mocks.runBuildLoop.mockResolvedValueOnce({
      status: "complete",
      lastChunk: 1,
      chunksCommitted: 1,
      haltReason: "",
      outcomes: [],
      events: [],
    });

    startOrchestration(options(projectDir));

    await vi.waitFor(() => {
      expect(mocks.updateWorkflow).toHaveBeenCalledTimes(2);
    });
    expect(mocks.stateWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "complete",
      projectDir,
    }));
    expect(mocks.stateClear).not.toHaveBeenCalled();
    expect(mocks.registryUnregister).not.toHaveBeenCalled();
  });

  it.each([
    ["halted", () => Promise.resolve({
      status: "halted" as const,
      lastChunk: 1,
      chunksCommitted: 0,
      haltReason: "gate failed",
      outcomes: [],
      events: [],
    })],
    ["crash", () => Promise.reject(new Error("boom"))],
  ])("retains authoritative state and registry when the %s workflow transition fails", async (_kind, outcome) => {
    const projectDir = resolve(`workflow-${_kind}-failure`);
    mocks.updateWorkflow
      .mockReturnValueOnce({ phase: "running" })
      .mockImplementationOnce(() => {
        throw new Error("workflow store unavailable");
      });
    mocks.runBuildLoop.mockReturnValueOnce(outcome());

    startOrchestration(options(projectDir));

    await vi.waitFor(() => {
      expect(mocks.updateWorkflow).toHaveBeenCalledTimes(2);
    });
    expect(mocks.stateWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "halted",
      projectDir,
    }));
    expect(mocks.stateClear).not.toHaveBeenCalled();
    expect(mocks.registryUnregister).not.toHaveBeenCalled();
  });

  it.each([
    ["complete", "complete", ""],
    ["halted", "halted", "gate failed"],
  ] as const)("persists the %s terminal workflow phase", async (status, phase, haltReason) => {
    const projectDir = resolve(`terminal-${status}`);
    mocks.runBuildLoop.mockResolvedValueOnce({
      status,
      lastChunk: 1,
      chunksCommitted: status === "complete" ? 1 : 0,
      haltReason,
      outcomes: [],
      events: [],
    });

    const started = startOrchestration(options(projectDir));

    await vi.waitFor(() => {
      expect(mocks.updateWorkflow).toHaveBeenCalledWith("durability-session", {
        phase,
        projectDir,
        opId: started.opId,
      });
    });
  });

  it("marks the Product Build halted when the loop crashes", async () => {
    const projectDir = resolve("terminal-crash");
    mocks.runBuildLoop.mockRejectedValueOnce(new Error("boom"));

    const started = startOrchestration(options(projectDir));

    await vi.waitFor(() => {
      expect(mocks.updateWorkflow).toHaveBeenCalledWith("durability-session", {
        phase: "halted",
        projectDir,
        opId: started.opId,
      });
    });
  });
});
