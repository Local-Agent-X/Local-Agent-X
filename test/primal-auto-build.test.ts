/**
 * Unit tests for primal_run_build_plan tool.
 *
 * Chunk 1 scope: tool registration, feature-flag gating, arg validation.
 * Does NOT spawn a real Claude Code subprocess — that's an integration
 * test for later. Chunk 2+ tests cover plan-parser, classifier, review.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  primalRunBuildPlanTool,
  isFeatureEnabled,
  FEATURE_FLAG_ENV,
} from "../src/primal-auto-build/tool.js";

describe("primal_run_build_plan — feature flag", () => {
  const originalEnv = process.env[FEATURE_FLAG_ENV];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[FEATURE_FLAG_ENV];
    else process.env[FEATURE_FLAG_ENV] = originalEnv;
  });

  it("is OFF by default (no env var set)", () => {
    delete process.env[FEATURE_FLAG_ENV];
    expect(isFeatureEnabled()).toBe(false);
  });

  it("accepts '1' / 'true' / 'yes' / 'on' as ON", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env[FEATURE_FLAG_ENV] = v;
      expect(isFeatureEnabled()).toBe(true);
    }
  });

  it("treats '0' / 'false' / empty as OFF", () => {
    for (const v of ["0", "false", "", " "]) {
      process.env[FEATURE_FLAG_ENV] = v;
      expect(isFeatureEnabled()).toBe(false);
    }
  });

  it("returns BLOCKED when flag is OFF, even with a valid project_dir", async () => {
    delete process.env[FEATURE_FLAG_ENV];
    const res = await primalRunBuildPlanTool.execute({ project_dir: tmpdir() });
    expect(res.isError).toBe(true);
    expect(res.status).toBe("blocked");
    expect(res.content).toContain("BLOCKED");
    expect(res.content).toContain(FEATURE_FLAG_ENV);
  });
});

describe("primal_run_build_plan — arg validation", () => {
  let tmp: string;

  beforeEach(() => {
    process.env[FEATURE_FLAG_ENV] = "1";
    tmp = mkdtempSync(join(tmpdir(), "primal-auto-build-test-"));
  });

  afterEach(() => {
    delete process.env[FEATURE_FLAG_ENV];
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("rejects empty project_dir", async () => {
    const res = await primalRunBuildPlanTool.execute({ project_dir: "" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("project_dir");
  });

  it("rejects non-existent project_dir", async () => {
    const res = await primalRunBuildPlanTool.execute({ project_dir: join(tmp, "nope") });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("does not exist");
  });

  it("rejects when plan.md is missing", async () => {
    const res = await primalRunBuildPlanTool.execute({ project_dir: tmp });
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
    const res = await primalRunBuildPlanTool.execute({
      project_dir: tmp,
      plan_path: "custom-plan.md",
    });
    // The loop will attempt to spawn claude (no CLI in test env) and
    // halt — but we should NOT see the "plan not found" or "no chunks"
    // errors. The header should reference the custom plan path.
    expect(res.content).not.toContain("plan not found");
    expect(res.content).not.toContain("no chunks found");
    expect(res.content).toContain("custom-plan.md");
  }, 60_000);

  it("resolves spec/plan.md as the default", async () => {
    mkdirSync(join(tmp, "spec"));
    writeFileSync(join(tmp, "spec", "plan.md"), MIN_PLAN);
    const res = await primalRunBuildPlanTool.execute({ project_dir: tmp });
    expect(res.content).toContain("spec");
    expect(res.content).toContain("plan.md");
  }, 60_000);
});

describe("primal_run_build_plan — tool definition", () => {
  it("has the expected name and required parameters", () => {
    expect(primalRunBuildPlanTool.name).toBe("primal_run_build_plan");
    const params = primalRunBuildPlanTool.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toEqual(["project_dir"]);
    expect(params.properties).toHaveProperty("plan_path");
    expect(params.properties).toHaveProperty("starting_chunk");
    expect(params.properties).toHaveProperty("max_chunks");
  });

  it("description mentions the feature flag", () => {
    expect(primalRunBuildPlanTool.description).toContain("PRIMAL_AUTO_BUILD_ENABLED");
  });
});
