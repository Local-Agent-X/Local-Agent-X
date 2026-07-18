/**
 * start_app_build + finalize_app_build tool tests.
 *
 * Covers:
 *   - Feature flag gating (both tools BLOCKED when LAX_AUTO_BUILD_ENABLED is off)
 *   - start_app_build returns the methodology body + framing
 *   - start_app_build handles empty-seed case (asks the agent to prompt the user)
 *   - finalize_app_build writes the four artifact families atomically
 *   - finalize_app_build refuses to overwrite an existing project_dir
 *   - finalize_app_build rejects path-traversal in scenario/twin filenames
 *   - Required-field validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_FLAG_ENV } from "../src/auto-build/tool.js";
import {
  createFinalizeAppBuildTool,
  startAppBuildTool,
  finalizeAppBuildTool,
} from "../src/auto-build/app-build-tool.js";
import {
  createBuildPlanKickoff,
  type BuildPlanKickoff,
} from "../src/auto-build/kickoff.js";
import { materializeAppBuild } from "../src/auto-build/materialize.js";
import { createAppBuildWorkflowStore } from "../src/auto-build/workflow-state.js";

const originalFlag = process.env[FEATURE_FLAG_ENV];
// Flag is opt-out (default ON). To DISABLE, set to "0"/"false"/etc.
// To ENABLE, unset or set to any other value.
function setFlag(on: boolean) {
  if (on) delete process.env[FEATURE_FLAG_ENV]; // default ON
  else process.env[FEATURE_FLAG_ENV] = "0";     // explicit disable
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FEATURE_FLAG_ENV];
  else process.env[FEATURE_FLAG_ENV] = originalFlag;
});

// Minimal plan that satisfies the canonical plan parser (finalize validates
// plan_md with the same parser run_build_plan uses).
const VALID_PLAN =
  "# Plan\n\n## Phase A\n\n### Chunk 1 — Init\n\n- **Class:** trunk\n- **Slice:** initialize the app.\n- **Done when:** boots.";

const noWorkerKickoff: BuildPlanKickoff = async input => ({
  content: "Build orchestrator started. The chat is free to use.",
  status: "running",
  session_id: "op_test",
  metadata: { op_id: "op_test", project_dir: input.projectDir },
});
const testFinalizeAppBuildTool = createFinalizeAppBuildTool({ kickoff: noWorkerKickoff });

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

  it("returns the /app-build methodology body + framing when given a concept", async () => {
    const r = await startAppBuildTool.execute({ concept: "a calendar booking SaaS for solo coaches" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("/app-build session opened");
    expect(r.content).toContain("calendar booking SaaS for solo coaches");
    // methodology body is inlined — sanity-check a known phrase
    expect(r.content).toMatch(/spec|scenarios|plan/);
    expect(r.content).toContain("finalize_app_build");
  });

  it("handles the no-seed case (user typed bare /app-build)", async () => {
    const r = await startAppBuildTool.execute({ concept: "" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("no seed yet");
    expect(r.content).toContain("ask them for the concept");
  });

  it("reminds the agent to capture facts to memory", async () => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app" });
    expect(r.content).toContain("memory");
  });

  it("persists planning workflow identity for the injected session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "app-build-start-state-"));
    const previousDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const r = await startAppBuildTool.execute({
        concept: "a tiny inventory app",
        _sessionId: "planning-session",
      });
      expect(r.isError).toBeFalsy();
      expect(createAppBuildWorkflowStore(join(dataDir, "app-build-workflows.json"))
        .read("planning-session")).toMatchObject({ phase: "planning" });
    } finally {
      if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // Regression (Jul 2026 food-truck-tracker run): grok announced next steps in
  // prose and waited for the user to say "ok". The open-steps gate only bites
  // on an objective task_create ledger, so the framing must seed one.
  it("seeds the task ledger + forbids ending a turn on an unexecuted promise", async () => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app" });
    expect(r.content).toContain("task_create");
    expect(r.content).toContain("task_update");
    expect(r.content).toContain("Never end a turn on a promise");
  });
});

describe("finalize_app_build — feature flag", () => {
  it("is BLOCKED when LAX_AUTO_BUILD_ENABLED is off", async () => {
    setFlag(false);
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: "/tmp/nope",
      project_name: "X",
      product_md: "x",
      constitution_md: "x",
      plan_md: "x",
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.status).toBe("blocked");
  });
});

describe("finalize_app_build — happy path", () => {
  let baseDir: string;
  beforeEach(() => {
    setFlag(true);
    baseDir = mkdtempSync(join(tmpdir(), "app-build-finalize-"));
  });
  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("writes spec/product, constitution, plan, scenarios, README atomically", async () => {
    const projectDir = join(baseDir, "new-project");
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "TestApp",
      product_md: "# Product\n\nA test app.",
      constitution_md: "# Constitution\n\n1. No silent failures.",
      plan_md: "# Plan\n\n## Phase A\n\n### Chunk 1 — Init\n\n- **Class:** trunk → /senior-engineer\n- **Slice:** initialize the app.\n- **Done when:** boots.",
      scenarios: [
        { filename: "01-happy-path.scenario.md", content: "# Scenario 1\n\nUser does X." },
        { filename: "02-edge.scenario.md", content: "# Scenario 2\n\nEdge case Y." },
      ],
    });

    expect(r.isError).toBeFalsy();
    expect(existsSync(join(projectDir, "spec", "product.md"))).toBe(true);
    expect(existsSync(join(projectDir, "spec", "constitution.md"))).toBe(true);
    expect(existsSync(join(projectDir, "spec", "plan.md"))).toBe(true);
    expect(existsSync(join(projectDir, "scenarios", "01-happy-path.scenario.md"))).toBe(true);
    expect(existsSync(join(projectDir, "scenarios", "02-edge.scenario.md"))).toBe(true);
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);

    const product = readFileSync(join(projectDir, "spec", "product.md"), "utf-8");
    expect(product).toContain("A test app.");

    const readme = readFileSync(join(projectDir, "README.md"), "utf-8");
    expect(readme).toContain("TestApp");
    expect(readme).toContain("Product Build owns orchestration");
    expect(r.status).toBe("running");
    expect(r.metadata?.op_id).toBe("op_test");
  });

  it("writes architecture.md when supplied", async () => {
    const projectDir = join(baseDir, "p2");
    await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "P2",
      product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      architecture_md: "# Architecture\n\nAdapters everywhere.",
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(existsSync(join(projectDir, "spec", "architecture.md"))).toBe(true);
    expect(readFileSync(join(projectDir, "spec", "architecture.md"), "utf-8")).toContain("Adapters");
  });

  it("persists running workflow identity only after kickoff succeeds", async () => {
    const dataDir = join(baseDir, "lax-data");
    const projectDir = join(baseDir, "finalized-project");
    const previousDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const store = createAppBuildWorkflowStore(join(dataDir, "app-build-workflows.json"));
      let phaseAtKickoff: string | undefined;
      const kickoff = vi.fn<BuildPlanKickoff>(async input => {
        phaseAtKickoff = store.read("finalized-session")?.phase;
        return noWorkerKickoff(input);
      });
      const tool = createFinalizeAppBuildTool({ kickoff });
      const r = await tool.execute({
        project_dir: projectDir,
        project_name: "Finalized",
        product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
        scenarios: [{ filename: "01-x.md", content: "x" }],
        _sessionId: "finalized-session",
      });
      expect(r.isError).toBeFalsy();
      expect(kickoff).toHaveBeenCalledWith(expect.objectContaining({
        projectDir,
        sessionId: "finalized-session",
      }));
      expect(phaseAtKickoff).toBe("finalized");
      expect(store.read("finalized-session")).toMatchObject({
        phase: "running",
        projectDir,
        opId: "op_test",
      });
    } finally {
      if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = previousDataDir;
    }
  });

  it("preserves finalized workflow state when kickoff is blocked", async () => {
    const dataDir = join(baseDir, "blocked-lax-data");
    const projectDir = join(baseDir, "blocked-project");
    const previousDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    const blockedKickoff = vi.fn<BuildPlanKickoff>(async () => ({
      content: "Build plan kickoff blocked: an orchestration is already running.",
      isError: true,
      status: "blocked",
      metadata: { recovery: "Use build_plan_status." },
    }));
    try {
      const tool = createFinalizeAppBuildTool({ kickoff: blockedKickoff });
      const r = await tool.execute({
        project_dir: projectDir,
        project_name: "Blocked",
        product_md: "x",
        constitution_md: "x",
        plan_md: VALID_PLAN,
        scenarios: [{ filename: "01-x.md", content: "x" }],
        _sessionId: "blocked-session",
      });

      expect(r.isError).toBe(true);
      expect(r.status).toBe("blocked");
      expect(r.content).toContain("workflow is preserved");
      expect(existsSync(join(projectDir, "spec", "plan.md"))).toBe(true);
      expect(createAppBuildWorkflowStore(join(dataDir, "app-build-workflows.json"))
        .read("blocked-session")).toMatchObject({
          phase: "finalized",
          projectDir,
        });
    } finally {
      if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = previousDataDir;
    }
  });

  it("cancels before materialization without creating a project or starting", async () => {
    const projectDir = join(baseDir, "cancelled-before");
    const kickoff = vi.fn(noWorkerKickoff);
    const tool = createFinalizeAppBuildTool({ kickoff });
    const controller = new AbortController();
    controller.abort();

    const r = await tool.execute({
      project_dir: projectDir,
      project_name: "Cancelled",
      product_md: "x",
      constitution_md: "x",
      plan_md: VALID_PLAN,
      scenarios: [{ filename: "01-x.md", content: "x" }],
    }, controller.signal);

    expect(r.metadata?.cancelled).toBe(true);
    expect(existsSync(projectDir)).toBe(false);
    expect(kickoff).not.toHaveBeenCalled();
  });

  it("propagates cancellation immediately before kickoff and never starts", async () => {
    const projectDir = join(baseDir, "cancelled-before-kickoff");
    const controller = new AbortController();
    const start = vi.fn(() => ({
      opId: "must-not-start",
      initialMessage: "must not start",
    }));
    const tool = createFinalizeAppBuildTool({
      kickoff: createBuildPlanKickoff({ start }),
      materialize(input) {
        const result = materializeAppBuild(input);
        controller.abort();
        return result;
      },
    });

    const r = await tool.execute({
      project_dir: projectDir,
      project_name: "Cancelled",
      product_md: "x",
      constitution_md: "x",
      plan_md: VALID_PLAN,
      scenarios: [{ filename: "01-x.md", content: "x" }],
    }, controller.signal);

    expect(r.metadata?.cancelled).toBe(true);
    expect(existsSync(join(projectDir, "spec", "plan.md"))).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("writes twins/ when supplied", async () => {
    const projectDir = join(baseDir, "p3");
    await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "P3",
      product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      scenarios: [{ filename: "01-x.md", content: "x" }],
      twins: [{ filename: "email-twin.ts", content: "export const sendEmailTwin = () => {};" }],
    });
    expect(existsSync(join(projectDir, "twins", "email-twin.ts"))).toBe(true);
  });

  it("accepts an existing empty project_dir instead of pushing the agent into raw writes", async () => {
    const projectDir = join(baseDir, "already-there");
    mkdirSync(projectDir, { recursive: true });
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir, project_name: "X",
      product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(projectDir, "spec", "plan.md"))).toBe(true);
    expect(existsSync(join(projectDir, "scenarios", "01-x.md"))).toBe(true);
  });

  it("still refuses to overwrite a non-empty project_dir", async () => {
    const projectDir = join(baseDir, "already-has-work");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(projectDir, "src"));
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir, project_name: "X",
      product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("will not overwrite");
    expect(r.content).toContain("Do NOT hand-write");
  });

  // Regression (Jul 2026 food-truck-tracker run): a plan without
  // '### Chunk N — Title' headings sailed through finalize and died at
  // run_build_plan kickoff. finalize must validate with the same parser.
  it("rejects plan_md the build-loop parser cannot chunk", async () => {
    const projectDir = join(baseDir, "bad-plan");
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x",
      plan_md: "# Plan\n\nJust prose, phases described in paragraphs. No chunk headings.",
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("rejected plan_md");
    expect(r.content).toContain("### Chunk N");
    expect(existsSync(projectDir)).toBe(false); // nothing written
  });

  it("rejects path-traversal in scenario filenames", async () => {
    const projectDir = join(baseDir, "p4");
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      scenarios: [{ filename: "../escape.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("path traversal");
  });

  it("rejects absolute-path scenario filenames", async () => {
    const projectDir = join(baseDir, "p5");
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x", plan_md: VALID_PLAN,
      scenarios: [{ filename: "/tmp/evil.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/absolute|traversal/i);
  });
});

describe("finalize_app_build — required-field validation", () => {
  beforeEach(() => setFlag(true));

  it("requires project_dir", async () => {
    const r = await testFinalizeAppBuildTool.execute({ project_dir: "" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("project_dir");
  });

  it("requires project_name", async () => {
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: join(tmpdir(), `pdoesnotexist-${Date.now()}`),
      project_name: "",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("project_name");
  });

  it("requires at least one scenario", async () => {
    const r = await testFinalizeAppBuildTool.execute({
      project_dir: join(tmpdir(), `pnoscen-${Date.now()}`),
      project_name: "X",
      product_md: "x", constitution_md: "x", plan_md: "x",
      scenarios: [],
    });
    expect(r.isError).toBe(true);
    expect(r.content.toLowerCase()).toContain("scenario");
  });
});

describe("Tool registration shape", () => {
  it("both tools have stable names + descriptions mentioning the flag", () => {
    expect(startAppBuildTool.name).toBe("start_app_build");
    expect(finalizeAppBuildTool.name).toBe("finalize_app_build");
    expect(startAppBuildTool.description).toContain("LAX_AUTO_BUILD_ENABLED");
    expect(finalizeAppBuildTool.description).toContain("LAX_AUTO_BUILD_ENABLED");
  });

  it("start_app_build disambiguates loudly from build_app (the apps-builder)", () => {
    // Regression: the chat agent kept routing /app-build → build_app because of the
    // hyphen flip. Description must explicitly disclaim build_app.
    expect(startAppBuildTool.description).toContain("/app-build");
    expect(startAppBuildTool.description.toLowerCase()).toContain("build_app");
    expect(startAppBuildTool.description.toLowerCase()).toContain("not `build_app`".toLowerCase());
  });
});
