/**
 * Unit tests for run_build_plan tool.
 *
 * Chunk 1 scope: tool registration, feature-flag gating, arg validation.
 * Does NOT spawn a real Claude Code subprocess — that's an integration
 * test for later. Chunk 2+ tests cover plan-parser, classifier, review.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the global active-orchestrators registry. The tool's execute()
// calls startOrchestration → registry.register which writes to
// ~/.lax/active-orchestrators.json. Without this mock, every test run
// leaks a stale entry into a file shared by real builds — the
// auto-resume scanner cleans them up on the next boot, but it's noisy
// and crosses the test/prod isolation boundary.
vi.mock("../src/auto-build/orchestrator/registry.js", () => ({
  register: vi.fn(),
  unregister: vi.fn(),
  listAll: vi.fn(() => []),
}));

import {
  createRunBuildPlanTool,
  runBuildPlanTool,
  isFeatureEnabled,
  FEATURE_FLAG_ENV,
} from "../src/auto-build/tool.js";
import { createBuildPlanKickoff } from "../src/auto-build/kickoff.js";
import { STATE_FILENAME } from "../src/auto-build/failure-recovery.js";

const startSpy = vi.fn(() => ({
  opId: "op_test",
  initialMessage: "Build orchestrator started. The chat is free to use.",
}));
const testKickoff = createBuildPlanKickoff({ start: startSpy });
const testRunBuildPlanTool = createRunBuildPlanTool(testKickoff);

describe("run_build_plan — feature flag", () => {
  const originalEnv = process.env[FEATURE_FLAG_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[FEATURE_FLAG_ENV];
    else process.env[FEATURE_FLAG_ENV] = originalEnv;
  });

  // The flag was flipped from opt-in to opt-out — default ON, only the
  // explicit disable strings ("0" / "false" / "no" / "off") turn it off.
  // Tests cover the opt-out semantics.

  it("is ON by default (no env var set)", () => {
    delete process.env[FEATURE_FLAG_ENV];
    expect(isFeatureEnabled()).toBe(true);
  });

  it("stays ON for any non-disabling value", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", "anything", " "]) {
      process.env[FEATURE_FLAG_ENV] = v;
      expect(isFeatureEnabled()).toBe(true);
    }
  });

  it("turns OFF only on explicit disable strings", () => {
    for (const v of ["0", "false", "FALSE", "no", "off"]) {
      process.env[FEATURE_FLAG_ENV] = v;
      expect(isFeatureEnabled()).toBe(false);
    }
  });

  // Back-compat: the flag was renamed from PRIMAL_AUTO_BUILD_ENABLED —
  // environments still setting the old name must keep working.
  it("honors the legacy flag name when the new one is unset", () => {
    delete process.env[FEATURE_FLAG_ENV];
    process.env.PRIMAL_AUTO_BUILD_ENABLED = "0";
    try {
      expect(isFeatureEnabled()).toBe(false);
      process.env[FEATURE_FLAG_ENV] = "1"; // new name wins over legacy
      expect(isFeatureEnabled()).toBe(true);
    } finally {
      delete process.env.PRIMAL_AUTO_BUILD_ENABLED;
    }
  });

  it("returns BLOCKED when explicitly disabled, even with a valid project_dir", async () => {
    process.env[FEATURE_FLAG_ENV] = "0";
    const res = await testRunBuildPlanTool.execute({ project_dir: tmpdir() });
    expect(res.isError).toBe(true);
    expect(res.status).toBe("blocked");
    expect(res.content).toContain("BLOCKED");
    expect(res.content).toContain(FEATURE_FLAG_ENV);
  });
});

describe("run_build_plan — arg validation", () => {
  let tmp: string;

  beforeEach(() => {
    process.env[FEATURE_FLAG_ENV] = "1";
    startSpy.mockClear();
    // realpathSync: on macOS tmpdir() is /var/... — a symlink to /private/var/...
    // The tool canonicalizes project_dir via realpathDeep (the establishment
    // chokepoint in auto-build/project-paths.ts), so compare against the same
    // canonical spelling.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "auto-build-test-")));
  });

  afterEach(() => {
    delete process.env[FEATURE_FLAG_ENV];
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("rejects empty project_dir", async () => {
    const res = await testRunBuildPlanTool.execute({ project_dir: "" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("project_dir");
  });

  it("rejects non-existent project_dir", async () => {
    const res = await testRunBuildPlanTool.execute({ project_dir: join(tmp, "nope") });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not exist");
  });

  it("rejects when plan.md is missing", async () => {
    const res = await testRunBuildPlanTool.execute({ project_dir: tmp });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("plan not found");
    expect(res.content).toContain("/app-build");
  });

  // Minimal valid plan: parser requires at least one chunk to parse.
  const MIN_PLAN = [
    "# Test",
    "",
    "## Phase A",
    "",
    "### Chunk 1 — Stub",
    "- **Class:** trunk → `/senior-engineer`",
    "- **Slice:** nothing.",
    "- **Depends on:** —",
    "- **Scenarios:** —",
    "- **Done when:** nothing.",
  ].join("\n");

  it("accepts a plan_path override", async () => {
    const altPlan = join(tmp, "custom-plan.md");
    writeFileSync(altPlan, MIN_PLAN);
    const res = await testRunBuildPlanTool.execute({
      project_dir: tmp,
      plan_path: "custom-plan.md",
      _sessionId: "test-sess-1",
    });
    // The shared kickoff returns immediately with status:running + opId.
    // Validate the custom plan reaches that seam without a real worker.
    expect(res.content).not.toContain("plan not found");
    expect(res.content).not.toContain("no chunks found");
    expect(res.status).toBe("running");
    expect(res.metadata?.op_id).toBeTruthy();
  }, 60_000);

  it("resolves spec/plan.md as the default", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    const res = await testRunBuildPlanTool.execute({
      project_dir: tmp,
      _sessionId: "test-sess-2",
    });
    expect(res.status).toBe("running");
    expect(res.metadata?.project_dir).toBe(tmp);
    expect(res.metadata?.op_id).toBeTruthy();
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "test-sess-2",
      projectDir: tmp,
      planPath: join(tmp, "spec", "plan.md"),
      startingChunk: 1,
      maxChunks: undefined,
      judgmentHook: expect.any(Function),
    }));
  }, 60_000);

  it("runs without _sessionId by generating a synthetic id (non-chat callers)", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    const res = await testRunBuildPlanTool.execute({ project_dir: tmp });
    // No _sessionId injected (direct API call, scheduled trigger, test). Tool
    // should still kick off — bg_op events route through a synthetic session.
    expect(res.isError).toBeFalsy();
    expect(res.status).toBe("running");
    expect(res.metadata?.op_id).toBeTruthy();
  }, 60_000);

  it("returns a blocked result when orchestration is already running", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    const duplicateTool = createRunBuildPlanTool(createBuildPlanKickoff({
      start: () => {
        throw new Error(`An orchestration is already running for ${tmp} (op op_existing).`);
      },
    }));

    const res = await duplicateTool.execute({
      project_dir: tmp,
      _sessionId: "test-sess-duplicate",
    });

    expect(res.isError).toBe(true);
    expect(res.status).toBe("blocked");
    expect(res.content).toContain("already running");
    expect(res.metadata?.recovery).toContain("build_plan_status");
  });

  it("runs the shared systemic preflight before starting orchestration", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    writeFileSync(join(tmp, STATE_FILENAME), JSON.stringify({
      haltHistory: [1, 2, 3].map(chunk => ({
        at: new Date().toISOString(),
        chunk,
        gate: "done-when",
        reason: "same gate",
      })),
    }));
    const kickoff = createBuildPlanKickoff({
      start: startSpy,
      diagnoseSystemic: async () => "",
    });

    const res = await createRunBuildPlanTool(kickoff).execute({ project_dir: tmp });

    expect(res.status).toBe("blocked");
    expect(res.metadata?.systemic_gate).toBe("done-when");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("propagates cancellation through the public tool before orchestration", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    const controller = new AbortController();
    controller.abort();

    const res = await testRunBuildPlanTool.execute(
      { project_dir: tmp, _sessionId: "cancelled-session" },
      controller.signal,
    );

    expect(res.metadata?.cancelled).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe("run_build_plan — tool definition", () => {
  it("has the expected name and required parameters", () => {
    expect(runBuildPlanTool.name).toBe("run_build_plan");
    const params = runBuildPlanTool.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toEqual(["project_dir"]);
    expect(params.properties).toHaveProperty("plan_path");
    expect(params.properties).toHaveProperty("starting_chunk");
    expect(params.properties).toHaveProperty("max_chunks");
  });

  it("description mentions the feature flag", () => {
    expect(runBuildPlanTool.description).toContain("LAX_AUTO_BUILD_ENABLED");
  });
});
