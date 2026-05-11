/**
 * start_app_build + finalize_app_build tool tests.
 *
 * Covers:
 *   - Feature flag gating (both tools BLOCKED when PRIMAL_AUTO_BUILD_ENABLED is off)
 *   - start_app_build returns the methodology body + framing
 *   - start_app_build handles empty-seed case (asks the agent to prompt the user)
 *   - finalize_app_build writes the four artifact families atomically
 *   - finalize_app_build refuses to overwrite an existing project_dir
 *   - finalize_app_build rejects path-traversal in scenario/twin filenames
 *   - Required-field validation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_FLAG_ENV } from "../src/primal-auto-build/tool.js";
import { startAppBuildTool, finalizeAppBuildTool } from "../src/primal-auto-build/app-build-tool.js";

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

describe("start_app_build — feature flag", () => {
  it("is BLOCKED when PRIMAL_AUTO_BUILD_ENABLED is off", async () => {
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

  it("reminds Primal to capture facts to memory", async () => {
    const r = await startAppBuildTool.execute({ concept: "a tiny inventory app" });
    expect(r.content).toContain("memory");
  });
});

describe("finalize_app_build — feature flag", () => {
  it("is BLOCKED when PRIMAL_AUTO_BUILD_ENABLED is off", async () => {
    setFlag(false);
    const r = await finalizeAppBuildTool.execute({
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
    const r = await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "TestApp",
      product_md: "# Product\n\nA test app.",
      constitution_md: "# Constitution\n\n1. No silent failures.",
      plan_md: "# Plan\n\n## Phase A\n\n### Chunk 1 — Init\n\n- **Class:** trunk → /senior-engineer\n- **Done when:** boots.",
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
    expect(readme).toContain("primal_run_build_plan");
  });

  it("writes architecture.md when supplied", async () => {
    const projectDir = join(baseDir, "p2");
    await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "P2",
      product_md: "x", constitution_md: "x", plan_md: "x",
      architecture_md: "# Architecture\n\nAdapters everywhere.",
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(existsSync(join(projectDir, "spec", "architecture.md"))).toBe(true);
    expect(readFileSync(join(projectDir, "spec", "architecture.md"), "utf-8")).toContain("Adapters");
  });

  it("writes twins/ when supplied", async () => {
    const projectDir = join(baseDir, "p3");
    await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "P3",
      product_md: "x", constitution_md: "x", plan_md: "x",
      scenarios: [{ filename: "01-x.md", content: "x" }],
      twins: [{ filename: "email-twin.ts", content: "export const sendEmailTwin = () => {};" }],
    });
    expect(existsSync(join(projectDir, "twins", "email-twin.ts"))).toBe(true);
  });

  it("refuses to overwrite an existing project_dir", async () => {
    const projectDir = join(baseDir, "already-there");
    mkdirSync(projectDir, { recursive: true });
    const r = await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x", plan_md: "x",
      scenarios: [{ filename: "01-x.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("already exists");
    expect(r.content).toContain("will not overwrite");
  });

  it("rejects path-traversal in scenario filenames", async () => {
    const projectDir = join(baseDir, "p4");
    const r = await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x", plan_md: "x",
      scenarios: [{ filename: "../escape.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("path traversal");
  });

  it("rejects absolute-path scenario filenames", async () => {
    const projectDir = join(baseDir, "p5");
    const r = await finalizeAppBuildTool.execute({
      project_dir: projectDir,
      project_name: "X", product_md: "x", constitution_md: "x", plan_md: "x",
      scenarios: [{ filename: "/tmp/evil.md", content: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/absolute|traversal/i);
  });
});

describe("finalize_app_build — required-field validation", () => {
  beforeEach(() => setFlag(true));

  it("requires project_dir", async () => {
    const r = await finalizeAppBuildTool.execute({ project_dir: "" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("project_dir");
  });

  it("requires project_name", async () => {
    const r = await finalizeAppBuildTool.execute({
      project_dir: join(tmpdir(), `pdoesnotexist-${Date.now()}`),
      project_name: "",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("project_name");
  });

  it("requires at least one scenario", async () => {
    const r = await finalizeAppBuildTool.execute({
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
    expect(startAppBuildTool.description).toContain("PRIMAL_AUTO_BUILD_ENABLED");
    expect(finalizeAppBuildTool.description).toContain("PRIMAL_AUTO_BUILD_ENABLED");
  });

  it("start_app_build disambiguates loudly from build_app (the apps-builder)", () => {
    // Regression: Primal kept routing /app-build → build_app because of the
    // hyphen flip. Description must explicitly disclaim build_app.
    expect(startAppBuildTool.description).toContain("/app-build");
    expect(startAppBuildTool.description.toLowerCase()).toContain("build_app");
    expect(startAppBuildTool.description.toLowerCase()).toContain("not `build_app`".toLowerCase());
  });
});
