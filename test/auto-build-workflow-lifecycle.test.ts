import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripted = vi.hoisted(() => ({
  status: "halted" as "halted" | "complete",
}));

vi.mock("../src/auto-build/loop.js", () => ({
  runBuildLoop: vi.fn(async () => ({
    status: scripted.status,
    lastChunk: 1,
    chunksCommitted: scripted.status === "complete" ? 1 : 0,
    haltReason: scripted.status === "halted" ? "phase gate" : "",
    outcomes: [],
    events: [],
  })),
}));

vi.mock("../src/auto-build/orchestrator/registry.js", () => ({
  register: vi.fn(() => true),
  unregister: vi.fn(() => true),
}));

vi.mock("../src/ops/session-bridge.js", () => ({
  broadcastToSession: vi.fn(),
}));

import { startOrchestration } from "../src/auto-build/orchestrator/manager.js";
import { createAppBuildWorkflowStore } from "../src/auto-build/workflow-state.js";

const originalDataDir = process.env.LAX_DATA_DIR;
let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "auto-build-workflow-data-"));
  projectDir = mkdtempSync(join(tmpdir(), "auto-build-workflow-project-"));
  process.env.LAX_DATA_DIR = dataDir;
  scripted.status = "halted";
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function startLinkedWorkflow(): ReturnType<typeof createAppBuildWorkflowStore> {
  const store = createAppBuildWorkflowStore(join(dataDir, "app-build-workflows.json"));
  store.upsert({
    sessionId: "workflow-session",
    phase: "finalized",
    projectDir,
  });
  startOrchestration({
    sessionId: "workflow-session",
    projectDir,
    planPath: join(projectDir, "spec", "plan.md"),
    plan: { chunks: [{ number: 1 }] } as never,
    startingChunk: 1,
  });
  return store;
}

describe("Product Build workflow lifecycle bridge", () => {
  it("moves a linked workflow through running to halted", async () => {
    const store = startLinkedWorkflow();

    await vi.waitFor(() => expect(store.read("workflow-session")?.phase).toBe("halted"));
    expect(store.read("workflow-session")).toMatchObject({
      projectDir,
      opId: expect.stringMatching(/^op_/),
    });
  });

  it("marks a clean orchestration complete", async () => {
    scripted.status = "complete";
    const store = startLinkedWorkflow();

    await vi.waitFor(() => expect(store.read("workflow-session")?.phase).toBe("complete"));
    expect(store.read("workflow-session")?.projectDir).toBe(projectDir);
  });
});
