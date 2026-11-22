/**
 * start_app_build (the /greenfield entry) and run_build_plan's link to its chat.
 *
 * Covers:
 *   - Feature flag gating
 *   - start_app_build returns the /greenfield skill + framing, seeded idea or not
 *   - the framing seeds the task ledger and forbids ending a turn on a promise
 *   - planning workflow identity persisted for the session
 *   - run_build_plan links a started build to the chat that started it, and
 *     leaves no link when the kickoff did not start
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_FLAG_ENV, createRunBuildPlanTool } from "../src/auto-build/tool.js";
import { startAppBuildTool } from "../src/auto-build/app-build-tool.js";
import type { BuildPlanKickoff } from "../src/auto-build/kickoff.js";
import { createAppBuildWorkflowStore } from "../src/auto-build/workflow-state.js";

const originalFlag = process.env[FEATURE_FLAG_ENV];
// Flag is opt-out (default ON). To DISABLE, set to "0"/"false"/etc.
function setFlag(on: boolean) {
  if (on) delete process.env[FEATURE_FLAG_ENV];
  else process.env[FEATURE_FLAG_ENV] = "0";
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FEATURE_FLAG_ENV];
  else process.env[FEATURE_FLAG_ENV] = originalFlag;
});

function withDataDir(run: (dataDir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "app-build-state-"));
    const previous = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    try {
      await run(dataDir);
    } finally {
      if (previous === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

const store = (dataDir: string) => createAppBuildWorkflowStore(join(dataDir, "app-build-workflows.json"));

describe("start_app_build — feature flag", () => {
  it("is BLOCKED when LAX_AUTO_BUILD_ENABLED is off", async () => {
    setFlag(false);
    const r = await startAppBuildTool.execute({ concept: "a coffee shop POS" });
    expect(r.isError).toBe(true);
    expect(r.status).toBe("blocked");
  });
});

describe("start_app_build — happy path", () => {
  beforeEach(() => setFlag(true));

  it("returns the /greenfield skill + framing when given an idea", async () => {
    const r = await startAppBuildTool.execute({ concept: "a calendar booking SaaS for solo coaches" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("/greenfield build opened");
    expect(r.content).toContain("calendar booking SaaS for solo coaches");
    // The skill is inlined, in LAX's terms.
    expect(r.content).toContain("holdout_seal");
    expect(r.content).toContain("run_build_plan");
    expect(r.content).not.toContain("finalize_app_build");
  });

  it("asks for the idea when the user gave none", async () => {
    const r = await startAppBuildTool.execute({ concept: "" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("gave no idea yet");
  });

  it("reminds the agent to capture facts to memory", async () => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app" });
    expect(r.content).toContain("memory");
  });

  // Regression (Jul 2026 food-truck-tracker run): a model announced next steps in
  // prose and waited for the user to say "ok". The open-steps gate only bites
  // on an objective task_create ledger, so the framing must seed one.
  it("seeds the task ledger + forbids ending a turn on an unexecuted promise", async () => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app" });
    expect(r.content).toContain("task_create");
    expect(r.content).toContain("task_update");
    expect(r.content).toContain("Never end a turn on a promise");
  });

  it("persists planning workflow identity for the injected session", withDataDir(async (dataDir) => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app", _sessionId: "planning-session" });
    expect(r.isError).toBeFalsy();
    expect(store(dataDir).read("planning-session")).toMatchObject({ phase: "planning" });
  }));
});

describe("run_build_plan — links the build to its chat", () => {
  const started: BuildPlanKickoff = async (input) => ({
    content: "Build orchestrator started.",
    status: "running",
    session_id: "op_test",
    metadata: { op_id: "op_test", project_dir: String(input.projectDir) },
  });
  const refused: BuildPlanKickoff = async () => ({ content: "plan not found", isError: true });

  it("records the running build for the chat that started it", withDataDir(async (dataDir) => {
    const r = await createRunBuildPlanTool(started).execute({ project_dir: "/p/petbook", _sessionId: "build-chat" });
    expect(r.status).toBe("running");
    expect(store(dataDir).read("build-chat")).toMatchObject({ phase: "running", projectDir: "/p/petbook", opId: "op_test" });
  }));

  it("records nothing when the build did not start", withDataDir(async (dataDir) => {
    const r = await createRunBuildPlanTool(refused).execute({ project_dir: "/p/petbook", _sessionId: "build-chat" });
    expect(r.isError).toBe(true);
    expect(store(dataDir).read("build-chat")).toBeNull();
  }));
});

describe("Tool registration shape", () => {
  it("has a stable name + a description mentioning the flag", () => {
    expect(startAppBuildTool.name).toBe("start_app_build");
    expect(startAppBuildTool.description).toContain("LAX_AUTO_BUILD_ENABLED");
  });

  it("start_app_build disambiguates loudly from build_app (the apps-builder)", () => {
    // Regression: the chat agent kept routing a spec-first build to build_app.
    // The description must explicitly disclaim build_app.
    expect(startAppBuildTool.description).toContain("/greenfield");
    expect(startAppBuildTool.description.toLowerCase()).toContain("not `build_app`");
  });
});
