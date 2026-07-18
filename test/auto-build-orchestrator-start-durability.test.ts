import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { parsePlanText } from "../src/auto-build/plan-parser.js";

const mocks = vi.hoisted(() => ({
  stateWrite: vi.fn(),
  stateClear: vi.fn(),
  registryRegister: vi.fn(),
  registryUnregister: vi.fn(),
  runBuildLoop: vi.fn(),
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
  broadcastToSession: vi.fn(),
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
  });

  it("does not register, activate, or run when initial state persistence fails", () => {
    const projectDir = resolve("state-write-failure");
    mocks.stateWrite.mockReturnValueOnce(false);

    expect(() => startOrchestration(options(projectDir)))
      .toThrow("failed to persist .lax-build-run.json");
    expect(mocks.registryRegister).not.toHaveBeenCalled();
    expect(mocks.runBuildLoop).not.toHaveBeenCalled();
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
  });
});
